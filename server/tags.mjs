// Ledger's shared tags on journal entries (Ledger ≥ 0.23.0, ctx.tags). Sales
// keeps them true on the entry of every issued invoice:
//
//   customer  the customer's entity, while the invoice has one in Ledger's list.
//             On Ledger ≥ 0.31.0 an invoice is posted to the customer's own
//             account under accounts receivable, and Ledger reads this tag
//             from that account: Sales then sets none, and only records
//             ("customer:<entity id>" in documents.entry_tags, at issue) that
//             the entry says whose it is. Ledger's update did the same for
//             the invoices already there (line moved, tag deleted), which
//             entry_tags still describes, so nothing is set or removed for
//             them. The tag is still set where Sales doesn't know the entry
//             to say so: there Ledger moves a line left in accounts
//             receivable to the customer's account, or keeps a real tag when
//             the entry has no such line (a receivables account of the
//             user's own that Ledger hasn't tagged; an older Ledger);
//   billed    while the invoice is issued (open or paid), not once it is void;
//   paid      while it is paid in full;
//   overdue   while it is open, unpaid and past its due date.
//
// and tags the entries of the billable costs an invoice bills "billed" while
// that invoice stands, and "paid" while it is paid. documents.entry_tags holds what Sales knows to be on
// each entry, so a sync only calls Ledger where something should change; the
// same sync brings invoices from before 0.16.0 in line the first time it runs.
//
// A tag belongs to the entry: a person or another module may set or remove
// it. Sales listens (onChange) and follows: an open invoice whose entry gets
// tagged "paid" elsewhere is shown as paid (documents.paid_by_tag), without a
// payment and without posting anything; taking the tag off opens it again.
// On a Ledger without ctx.tags none of this runs.
//
// The same goes for the tags on files (Ledger ≥ 0.27.0, ctx.documents.tags):
// the PDF of an invoice that Sales filed in Ledger's Documents carries
// "billed", "paid" and "overdue" exactly as its entry does (who it is with is
// the document's entity, not a tag), an invoice without an entry too.
// documents.file_tags holds what Sales knows to be on the file, and a person
// tagging the PDF "paid" on the Documents page is followed like a tag on the
// entry. What the file says is kept with it as well (its extraction, saved
// when the PDF is filed): the sync keeps the status in it current, and saves
// it for invoices filed before Sales did so.

import { today } from "../lib/money.mjs";
import { billableItems } from "./billable.mjs";
import { isNotFound } from "./common.mjs";

const FOLLOWED = ["customer", "billed", "paid", "overdue"];
const FILE_FOLLOWED = ["billed", "paid", "overdue"];
const BATCH = 500;
const MAX_PER_SYNC = 2000;

export function entryTags(ctx, h) {
	const tags = ctx.tags ?? null;
	const fileTags = ctx.documents?.tags ?? null;
	if (!tags && !fileTags) return { enabled: false, async sync() {}, async syncFiles() {}, listen() {}, saveFileDataWith() {} };
	const { T, q } = h;
	// Saves everything Sales knows about a document with its filed PDF (set by documents.mjs).
	let saveFileData = null;
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
		await syncBillablePaid(did, user);
	}

	/**
	 * Links an issued invoice's entry to the entries of the costs and credit
	 * memos it bills (Ledger 0.28.0), so each shows on the other's page, and
	 * takes the links off again when the invoice is void. Also brings invoices
	 * from before 0.21.0 in line the first time it runs.
	 */
	async function syncRelated(did, user) {
		if (typeof ctx.ledger?.relateEntries !== "function") return;
		const { rows } = await q(
			`SELECT * FROM (
				SELECT d.id, d.number, d.journal_entry_id::text AS entry, coalesce(d.related_entry_ids, '{}')::text[] AS have,
				       CASE WHEN d.status IN ('open', 'paid') THEN d.billed_entry_ids ELSE '{}' END::text[] AS want
				  FROM ${T("documents")} d
				 WHERE d.kind = 'invoice' AND d.journal_entry_id IS NOT NULL AND d.billed_entry_ids IS NOT NULL
				   AND ($1::bigint IS NULL OR d.id = $1::bigint)
				   AND (cardinality(d.billed_entry_ids) > 0 OR cardinality(d.related_entry_ids) > 0)
			) x
			WHERE NOT (x.want @> x.have AND x.have @> x.want)
			ORDER BY x.id LIMIT ${MAX_PER_SYNC}`,
			[did],
		);
		for (const r of rows) {
			try {
				for (const entry of r.have) if (!r.want.includes(entry) && entry !== r.entry) await ctx.ledger.unrelateEntries(r.entry, entry);
				for (const entry of r.want) {
					if (!r.have.includes(entry) && entry !== r.entry) await ctx.ledger.relateEntries(r.entry, entry, { note: `Billed on invoice ${r.number}`.slice(0, 200) }, user);
				}
				await q(`UPDATE ${T("documents")} SET related_entry_ids = $2::bigint[] WHERE id = $1`, [String(r.id), r.want]);
			} catch (e) {
				// An entry may be gone for a while (root mode); the next sync tries again.
				warnOnce(`related:${r.id}`, "could not link an invoice's journal entry to the entries it bills", { invoice: r.number, err: e.message });
			}
		}
	}

	/**
	 * Tags the entries of billable items "paid" while the invoice that bills
	 * them is paid (payments in Sales, or its entry tagged paid in Ledger), and
	 * takes it off again when the invoice is unpaid or void.
	 */
	async function syncBillablePaid(did, user) {
		const { rows } = await q(
			`SELECT * FROM (
				SELECT d.id, d.number, d.paid_entry_ids::text[] AS have,
				       CASE WHEN d.status = 'paid' OR (d.status = 'open' AND d.paid_by_tag) THEN coalesce(d.billed_entry_ids, '{}') ELSE '{}' END::text[] AS want
				  FROM ${T("documents")} d
				 WHERE d.kind = 'invoice' AND ($1::bigint IS NULL OR d.id = $1::bigint)
				   AND (cardinality(d.paid_entry_ids) > 0 OR cardinality(d.billed_entry_ids) > 0)
			) x
			WHERE NOT (x.want @> x.have AND x.have @> x.want)
			ORDER BY x.id LIMIT ${MAX_PER_SYNC}`,
			[did],
		);
		for (const r of rows) {
			try {
				for (const entry of r.have) {
					if (r.want.includes(entry)) continue;
					// Another paid invoice may bill the same entry; and only a tag Sales set is Sales' to take off.
					const held = await q(
						`SELECT 1 FROM ${T("documents")} WHERE id <> $2 AND kind = 'invoice' AND $1::bigint = ANY(paid_entry_ids) LIMIT 1`,
						[entry, String(r.id)],
					);
					if (held.rows.length === 0 && (await tags.of(entry)).some((t) => t.tag === "paid" && t.module_id === ctx.id)) await tags.remove(entry, "paid");
				}
				for (const entry of r.want) if (!r.have.includes(entry)) await tags.set(entry, "paid", { note: `Invoice ${r.number}`.slice(0, 200) }, user);
				await q(`UPDATE ${T("documents")} SET paid_entry_ids = $2::bigint[] WHERE id = $1`, [String(r.id), r.want]);
			} catch (e) {
				warnOnce(`billpaid:${r.id}`, "could not tag the billable items of an invoice as paid", { invoice: r.number, err: e.message });
			}
		}
	}

	// ---- the filed PDFs (Ledger's Documents) -------------------------------------------------

	/** Invoices whose filed PDF should carry other tags than Sales knows it to. */
	async function filesOutOfLine(did, after) {
		const { rows } = await q(
			`SELECT * FROM (
				SELECT d.id, d.number, d.pdf_document_id, d.file_tags,
				       array_remove(ARRAY[
				           CASE WHEN d.status IN ('open', 'paid') THEN 'billed' END,
				           CASE WHEN d.status = 'paid' OR (d.status = 'open' AND d.paid_by_tag) THEN 'paid' END,
				           CASE WHEN d.status = 'open' AND NOT d.paid_by_tag AND d.due_date < $1::date THEN 'overdue' END
				       ], NULL) AS file_wanted
				  FROM ${T("documents")} d
				 WHERE d.kind = 'invoice' AND d.pdf_document_id IS NOT NULL
				   AND ($2::bigint IS NULL OR d.id = $2::bigint) AND d.id > $3::bigint
			) x
			WHERE NOT (x.file_wanted @> x.file_tags AND x.file_tags @> x.file_wanted)
			ORDER BY x.id LIMIT ${BATCH}`,
			[today(), did, after],
		);
		return rows;
	}

	/** The PDF was deleted from Ledger's Documents: Sales' pointer to it leads nowhere, so it goes. */
	const forgetFile = (id, file) => q(`UPDATE ${T("documents")} SET pdf_document_id = NULL, file_tags = '{}', file_data_status = NULL WHERE id = $1 AND pdf_document_id = $2::bigint`, [String(id), String(file)]);

	async function bringFileInLine(r, user) {
		const file = Number(r.pdf_document_id);
		const note = { note: `Invoice ${r.number}`.slice(0, 200) };
		try {
			// Off first, then on ("paid" takes "overdue" off by itself).
			for (const tag of r.file_tags) if (!r.file_wanted.includes(tag)) await fileTags.remove(file, tag);
			for (const tag of r.file_wanted) if (!r.file_tags.includes(tag)) await fileTags.set(file, tag, note, user);
			await q(`UPDATE ${T("documents")} SET file_tags = $2::text[] WHERE id = $1 AND pdf_document_id = $3::bigint`, [String(r.id), r.file_wanted, String(file)]);
		} catch (e) {
			if (isNotFound(e)) return void (await forgetFile(r.id, file));
			warnOnce(`file:${r.id}`, "could not tag an invoice's PDF in Ledger's documents", { invoice: r.number, document: file, err: e.message });
		}
	}

	/**
	 * Keeps what is saved with each filed PDF (its extraction) true: the
	 * status in it follows the document's, and an issued invoice whose PDF was
	 * filed before Sales saved any (or whose data someone cleared) gets it now.
	 * An issued invoice doesn't change, so it still says what its PDF says; a
	 * quote or estimate may have been edited since it was filed, so its data
	 * is only saved when it is filed (emailed) again.
	 */
	async function syncFileData(did, user) {
		if (!ctx.documents?.setExtracted) return;
		const { rows } = await q(
			`SELECT d.id, d.kind, d.number, d.status, d.pdf_document_id, d.file_data_status
			   FROM ${T("documents")} d
			  WHERE d.pdf_document_id IS NOT NULL AND d.status <> 'posting' AND ($1::bigint IS NULL OR d.id = $1::bigint)
			    AND ((d.file_data_status IS NULL AND d.kind = 'invoice' AND d.status IN ('open', 'paid', 'void'))
			      OR (d.file_data_status IS NOT NULL AND d.file_data_status <> d.status))
			  ORDER BY d.id LIMIT ${MAX_PER_SYNC}`,
			[did],
		);
		for (const r of rows) {
			const file = Number(r.pdf_document_id);
			try {
				if (r.file_data_status === null) {
					if (saveFileData) await saveFileData(String(r.id), user);
					continue;
				}
				// Only the status: the rest still describes the PDF as it was filed.
				await ctx.documents.setExtracted(file, { data: { sales: { id: Number(r.id), kind: r.kind, status: r.status } } }, user);
				await q(`UPDATE ${T("documents")} SET file_data_status = $2 WHERE id = $1 AND pdf_document_id = $3::bigint`, [String(r.id), r.status, String(file)]);
			} catch (e) {
				if (isNotFound(e)) await forgetFile(r.id, file).catch(() => {});
				else warnOnce(`filedata:${r.id}`, "could not save a document's data with its PDF in Ledger's documents", { number: r.number, document: file, err: e.message });
			}
		}
	}

	/** Brings the tags and the saved data of the filed PDFs in line (one document, or all in these books). Never throws. */
	async function syncFiles(did = null, user = undefined) {
		if (!fileTags) return;
		const one = did === null || did === undefined ? null : String(did);
		try {
			for (let after = "0"; ; ) {
				const rows = await filesOutOfLine(one, after);
				for (const r of rows) await bringFileInLine(r, user);
				if (rows.length < BATCH) break;
				after = String(rows.at(-1).id);
			}
			await syncFileData(one, user);
		} catch (e) {
			ctx.log.warn("could not sync the tags on the PDFs in Ledger's documents", { err: e.message });
		}
	}

	// ---- following what others tag ---------------------------------------------------------

	/** The organization this code runs in: Ledger calls a listener inside the one that changed. */
	const here = async () => {
		try {
			return await ctx.orgs.current();
		} catch {
			return null;
		}
	};

	/**
	 * A person or another module set or took off a tag on an invoice's entry
	 * (`idColumn` "journal_entry_id", remembered in "entry_tags") or on its
	 * filed PDF ("pdf_document_id", "file_tags"). Remembers it, and "paid" on
	 * an open invoice makes it paid by tag (or open again). Runs in the books
	 * the change was made in, and only there: entry and document ids mean
	 * something else in every other organization.
	 */
	async function follow(idColumn, tagsColumn, value, key, set, by, changed) {
		const { rows } = await q(
			`WITH old AS (
				SELECT id, paid_by_tag AS was FROM ${T("documents")}
				 WHERE kind = 'invoice' AND ${idColumn} = $1::bigint AND status IN ('open', 'paid') FOR UPDATE
			)
			UPDATE ${T("documents")} d
			   SET ${tagsColumn} = CASE WHEN $3::boolean THEN array_append(array_remove(d.${tagsColumn}, $2::text), $2::text) ELSE array_remove(d.${tagsColumn}, $2::text) END,
			       paid_by_tag = CASE WHEN $2::text = 'paid' AND d.status = 'open' THEN $3::boolean ELSE d.paid_by_tag END,
			       updated_at = now()
			  FROM old WHERE d.id = old.id
			RETURNING d.id, d.number, d.status, d.paid_by_tag, old.was`,
			[String(value), key, set],
		);
		const on = idColumn === "journal_entry_id" ? "its entry" : "its PDF";
		for (const r of rows) {
			if (r.paid_by_tag !== r.was) {
				ctx.log.info(r.paid_by_tag ? "invoice tagged paid in Ledger; shown as paid" : "paid tag taken off in Ledger; invoice is open again", { invoice: r.number, on, by: by ?? "a person" });
				changed(await here());
			} else if (key === "paid" && !set && r.status === "paid") {
				// Sales holds the payments: it stays paid, and the next sync puts the tag back.
				ctx.log.info("paid tag taken off in Ledger, but Sales has this invoice's payments; it stays paid", { invoice: r.number, on, by: by ?? "a person" });
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
			if (tags) {
				try {
					await syncInvoices(one, user);
					await syncBillable(one, user);
					await syncRelated(one, user);
				} catch (e) {
					ctx.log.warn("could not sync Ledger's tags", { err: e.message });
				}
			}
			await syncFiles(one, user);
		},
		/** The filed PDFs only: their tags and saved data (right after a PDF is filed). Never throws. */
		syncFiles,
		/** documents.mjs hands over how a document's data is saved with its PDF: fn(documentId, user). */
		saveFileDataWith(fn) {
			saveFileData = fn;
		},
		/**
		 * Follows tags that a person or another module changes on an invoice's
		 * entry. `changed(org)` is called when an invoice became paid or open
		 * again because of it. Nothing is ever posted here.
		 */
		listen(changed = () => {}) {
			// Ledger runs a listener inside the organization whose entry or file changed, so this
			// looks in the current books only: the same id is another entry (or file) in every other one.
			tags?.onChange(async (c) => {
				if (!c || c.module_id === ctx.id || !FOLLOWED.includes(c.tag)) return;
				const key = c.tag === "customer" ? `customer:${c.entity_id}` : c.tag;
				await follow("journal_entry_id", "entry_tags", c.entry_id, key, c.action === "set", c.module_id, changed);
			});
			fileTags?.onChange(async (c) => {
				if (!c || c.module_id === ctx.id) return;
				if (c.tag === "extracted") {
					// Someone cleared what was saved with the PDF: an invoice's is saved again by the next sync.
					if (c.action === "removed") await q(`UPDATE ${T("documents")} SET file_data_status = NULL WHERE pdf_document_id = $1::bigint`, [String(c.document_id)]);
					return;
				}
				if (!FILE_FOLLOWED.includes(c.tag)) return;
				await follow("pdf_document_id", "file_tags", c.document_id, c.tag, c.action === "set", c.module_id, changed);
			});
		},
	};
}
