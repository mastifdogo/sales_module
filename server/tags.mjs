// Ledger's shared tags on journal entries (Ledger ≥ 0.23.0, ctx.tags). Sales
// keeps them true on the entry of every issued invoice:
//
//   customer  the customer's entity, while the invoice has one in Ledger's list;
//   billed    while the invoice is issued (open or paid), not once it is void;
//   paid      while it is paid in full;
//   overdue   while it is open, unpaid and past its due date.
//
// and tags the entries of the billable costs an invoice bills "billed" while
// that invoice stands. documents.entry_tags holds what Sales knows to be on
// each entry, so a sync only calls Ledger where something should change; the
// same sync brings invoices from before 0.16.0 in line the first time it runs.
//
// A tag belongs to the entry: a person or another module may set or remove
// it. Sales listens (onChange) and follows: an open invoice whose entry gets
// tagged "paid" elsewhere is shown as paid (documents.paid_by_tag), without a
// payment and without posting anything; taking the tag off opens it again.
// On a Ledger without ctx.tags none of this runs.

import { today } from "../lib/money.mjs";
import { billableItems } from "./billable.mjs";

const FOLLOWED = ["customer", "billed", "paid", "overdue"];
const BATCH = 500;
const MAX_PER_SYNC = 2000;

export function entryTags(ctx, h) {
	const tags = ctx.tags;
	if (!tags) return { enabled: false, async sync() {}, listen() {} };
	const { T, q } = h;
	const billable = billableItems(ctx, h);
	const warned = new Set();
	const warnOnce = (key, msg, data) => {
		if (warned.has(key)) return;
		warned.add(key);
		ctx.log.warn(msg, data);
	};

	/** Brings the tags on issued invoices' entries in line (one invoice, or all in these books). */
	async function syncInvoices(did, user) {
		// In batches, so the first run after an update reaches every invoice.
		for (let after = "0"; ; ) {
			const rows = await outOfLine(did, after);
			for (const r of rows) await bringInLine(r, user);
			if (rows.length < BATCH) break;
			after = String(rows.at(-1).id);
		}
	}

	/** Issued invoices whose entry should carry other tags than Sales knows it to. */
	async function outOfLine(did, after) {
		const { rows } = await q(
			`SELECT * FROM (
				SELECT d.id, d.number, d.journal_entry_id, d.entry_tags,
				       array_remove(ARRAY[
				           CASE WHEN e.id IS NOT NULL THEN 'customer:' || e.id END,
				           CASE WHEN d.status IN ('open', 'paid') THEN 'billed' END,
				           CASE WHEN d.status = 'paid' OR (d.status = 'open' AND d.paid_by_tag) THEN 'paid' END,
				           CASE WHEN d.status = 'open' AND NOT d.paid_by_tag AND d.due_date < $1::date THEN 'overdue' END
				       ], NULL) AS wanted
				  FROM ${T("documents")} d
				  JOIN ${T("customers")} c ON c.id = d.customer_id
				  LEFT JOIN public.entities e ON e.id = c.entity_id AND e.is_customer
				 WHERE d.kind = 'invoice' AND d.journal_entry_id IS NOT NULL AND d.status IN ('open', 'paid', 'void')
				   AND ($2::bigint IS NULL OR d.id = $2::bigint) AND d.id > $3::bigint
			) x
			WHERE NOT (x.wanted @> x.entry_tags AND x.entry_tags @> x.wanted)
			ORDER BY x.id LIMIT ${BATCH}`,
			[today(), did, after],
		);
		return rows;
	}

	async function bringInLine(r, user) {
		const entry = String(r.journal_entry_id);
		const call = (key, set) => {
			const [tag, entity] = key.split(":");
			const opts = entity ? { entity_id: Number(entity) } : {};
			return set ? tags.set(entry, tag, tag === "billed" ? { note: `Invoice ${r.number}`.slice(0, 200) } : opts, user) : tags.remove(entry, tag, opts);
		};
		try {
			// Off first, then on ("paid" takes "overdue" off by itself).
			for (const key of r.entry_tags) if (!r.wanted.includes(key)) await call(key, false);
			for (const key of r.wanted) if (!r.entry_tags.includes(key)) await call(key, true);
			await q(`UPDATE ${T("documents")} SET entry_tags = $2::text[] WHERE id = $1`, [String(r.id), r.wanted]);
		} catch (e) {
			// The entry may be gone for a while (root mode); the next sync tries again.
			warnOnce(`invoice:${r.id}`, "could not tag an invoice's journal entry", { invoice: r.number, entry, err: e.message });
		}
	}

	/** Tags the entries of billable items "billed" while an issued invoice bills them. */
	async function syncBillable(did, user) {
		const one = `($1::bigint IS NULL OR d.id = $1::bigint)`;
		// Nothing billed (or void before any tag was set): nothing to work out.
		await q(
			`UPDATE ${T("documents")} d SET billed_entry_ids = '{}'
			  WHERE d.kind = 'invoice' AND d.billed_entry_ids IS NULL AND d.status IN ('open', 'paid', 'void') AND ${one}
			    AND (d.status = 'void' OR NOT EXISTS (SELECT 1 FROM ${T("document_lines")} l WHERE l.document_id = d.id AND cardinality(l.billed_ledger_line_ids) > 0))`,
			[did],
		);
		const issued = await q(
			`SELECT d.id, d.number, d.customer_id, d.currency,
			        (SELECT array_agg(DISTINCT x::text) FROM ${T("document_lines")} l, unnest(l.billed_ledger_line_ids) x WHERE l.document_id = d.id) AS line_ids
			   FROM ${T("documents")} d
			  WHERE d.kind = 'invoice' AND d.billed_entry_ids IS NULL AND d.status IN ('open', 'paid') AND ${one}
			  ORDER BY d.id LIMIT ${MAX_PER_SYNC}`,
			[did],
		);
		for (const r of issued.rows) {
			try {
				const wanted = new Set((r.line_ids ?? []).map(String));
				const { items } = await billable.forCustomer(String(r.customer_id), r.currency, { exceptDoc: r.id });
				const entries = [...new Set(items.filter((i) => wanted.has(String(i.line_id))).map((i) => String(i.entry_id)))];
				for (const entry of entries) await tags.set(entry, "billed", { note: `Invoice ${r.number}`.slice(0, 200) }, user);
				await q(`UPDATE ${T("documents")} SET billed_entry_ids = $2::bigint[] WHERE id = $1`, [String(r.id), entries]);
			} catch (e) {
				warnOnce(`billable:${r.id}`, "could not tag the billable items of an invoice as billed", { invoice: r.number, err: e.message });
			}
		}
		// Void: its items are free again, unless another issued invoice bills the same entry.
		const voided = await q(
			`SELECT d.id, d.number, d.billed_entry_ids::text[] AS entries FROM ${T("documents")} d
			  WHERE d.kind = 'invoice' AND d.status = 'void' AND cardinality(d.billed_entry_ids) > 0 AND ${one}
			  ORDER BY d.id LIMIT ${MAX_PER_SYNC}`,
			[did],
		);
		for (const r of voided.rows) {
			try {
				for (const entry of r.entries) {
					const held = await q(`SELECT 1 FROM ${T("documents")} WHERE kind = 'invoice' AND status IN ('open', 'paid') AND $1::bigint = ANY(billed_entry_ids) LIMIT 1`, [entry]);
					// Only a tag Sales set itself: the module that posted the cost (e.g. Employees, for hours) may have
					// tagged it billed first, and that tag is its own to take off.
					if (held.rows.length === 0 && (await tags.of(entry)).some((t) => t.tag === "billed" && t.module_id === ctx.id)) await tags.remove(entry, "billed");
				}
				await q(`UPDATE ${T("documents")} SET billed_entry_ids = '{}' WHERE id = $1`, [String(r.id)]);
			} catch (e) {
				warnOnce(`unbill:${r.id}`, "could not take the billed tag off the billable items of a void invoice", { invoice: r.number, err: e.message });
			}
		}
	}

	return {
		enabled: true,
		/**
		 * Brings Ledger's tags in line with Sales' invoices in the current books:
		 * one invoice (right after it changed) or all of them (startup, hourly,
		 * after any change). Only calls Ledger where a tag should change. Never throws.
		 */
		async sync(did = null, user = undefined) {
			const one = did === null || did === undefined ? null : String(did);
			try {
				await syncInvoices(one, user);
				await syncBillable(one, user);
			} catch (e) {
				ctx.log.warn("could not sync Ledger's tags", { err: e.message });
			}
		},
		/**
		 * Follows tags that a person or another module changes on an invoice's
		 * entry. `changed(org)` is called when an invoice became paid or open
		 * again because of it. Nothing is ever posted here.
		 */
		listen(changed = () => {}) {
			tags.onChange(async (c) => {
				if (!c || c.module_id === ctx.id || !FOLLOWED.includes(c.tag)) return;
				const key = c.tag === "customer" ? `customer:${c.entity_id}` : c.tag;
				const set = c.action === "set";
				// Outside a request Ledger is in the main books: look in each organization's.
				await ctx.orgs.forEach(async (org) => {
					const { rows } = await q(
						`WITH old AS (
							SELECT id, paid_by_tag AS was FROM ${T("documents")}
							 WHERE kind = 'invoice' AND journal_entry_id = $1::bigint AND status IN ('open', 'paid') FOR UPDATE
						)
						UPDATE ${T("documents")} d
						   SET entry_tags = CASE WHEN $3::boolean THEN array_append(array_remove(d.entry_tags, $2::text), $2::text) ELSE array_remove(d.entry_tags, $2::text) END,
						       paid_by_tag = CASE WHEN $2::text = 'paid' AND d.status = 'open' THEN $3::boolean ELSE d.paid_by_tag END,
						       updated_at = now()
						  FROM old WHERE d.id = old.id
						RETURNING d.id, d.number, d.status, d.paid_by_tag, old.was`,
						[String(c.entry_id), key, set],
					);
					for (const r of rows) {
						if (r.paid_by_tag !== r.was) {
							ctx.log.info(r.paid_by_tag ? "invoice tagged paid in Ledger; shown as paid" : "paid tag taken off in Ledger; invoice is open again", { invoice: r.number, by: c.module_id ?? "a person" });
							changed(org);
						} else if (c.tag === "paid" && !set && r.status === "paid") {
							// Sales holds the payments: it stays paid, and the next sync puts the tag back.
							ctx.log.info("paid tag taken off in Ledger, but Sales has this invoice's payments; it stays paid", { invoice: r.number, by: c.module_id ?? "a person" });
						}
					}
				});
			});
		},
	};
}
