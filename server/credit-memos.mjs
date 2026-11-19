// Credit memos (0.20.0): an amount credited to a customer against the income
// from them. Creating one posts, straight away,
//
//     Dr revenue (the category's account, or the default revenue account)
//     Cr "Customer credits to apply" (Sales' clearing account, a liability)
//
// with the customer as the entry's entity. That credit is then one of the
// customer's billable items (billable.mjs, `credit: true`, a negative
// amount): an invoice that takes it debits the clearing account back to zero
// and lowers what the customer owes (postingLines() in documents.mjs).
//
//   open → void. A credit memo is "applied" while an invoice that isn't void
//   bills its clearing line (worked out, not stored). Only an unapplied one
//   can be voided, which reverses its entry.

import { MAX_CENTS, today } from "../lib/money.mjs";
import { isNotFound } from "./common.mjs";
import { billableItems } from "./billable.mjs";
import { openLink } from "./search.mjs";

const PREFIX = "CM-";
const MAX_PAGE = 500;
const STATUSES = {
	"": "true",
	open: "m.status = 'open' AND applied.id IS NULL",
	applied: "m.status = 'open' AND applied.id IS NOT NULL",
	void: "m.status = 'void'",
};

export function creditMemoRoutes(ctx, h) {
	const { T, q, bad, notFound, conflict, body, text, dateField, currency, decimal, id, isId, like, loadSettings, CUSTOMERS, CATEGORY_ACCOUNTS } = h;
	const billable = billableItems(ctx, h);

	// The invoice (not void) that applies a credit memo, if any: the one billing its clearing line.
	const APPLIED = `LEFT JOIN LATERAL (
			SELECT d.id, d.number, d.status FROM ${T("documents")} d JOIN ${T("document_lines")} l ON l.document_id = d.id
			 WHERE d.kind = 'invoice' AND d.status <> 'void' AND m.ledger_line_id IS NOT NULL AND m.ledger_line_id = ANY(l.billed_ledger_line_ids)
			 ORDER BY d.id LIMIT 1) applied ON true`;

	const link = (m, what = "Credit memo") => ({
		ref: `credit-memo:${m.id}`,
		label: `${what} ${m.number} · ${m.customer_name ?? ""}`.slice(0, 200),
		href: openLink(`credit-memos/${m.id}`),
	});

	async function getMemo(mid) {
		const { rows } = await q(
			`SELECT m.*, m.memo_date::text, c.name AS customer_name, c.company AS customer_company, cat.name AS category_name,
			        CASE WHEN applied.id IS NULL THEN NULL ELSE jsonb_build_object('id', applied.id, 'number', applied.number, 'status', applied.status) END AS applied_to
			   FROM ${T("credit_memos")} m JOIN ${CUSTOMERS} c ON c.id = m.customer_id
			   LEFT JOIN ${T("categories")} cat ON cat.id = m.category_id
			   ${APPLIED}
			  WHERE m.id = $1`,
			[String(mid)],
		);
		const m = rows[0];
		if (!m) throw notFound("credit memo");
		return m;
	}

	/** Whether its entry still stands (a person may have reversed it, or deleted it in root mode). */
	async function stillInBooks(entryId) {
		try {
			const e = await ctx.ledger.getJournalEntry(entryId);
			return e.reversed_by_id === null || e.reversed_by_id === undefined ? e : null;
		} catch (e) {
			if (isNotFound(e)) return null;
			throw e;
		}
	}

	async function linkEntry(entryId, l, user) {
		try {
			await ctx.ledger.linkJournalEntry(entryId, l, user);
		} catch (e) {
			ctx.log.warn("could not link journal entry", { entry: String(entryId), ref: l.ref, error: e.message });
		}
	}

	/** Inserts the memo, in "posting", with the next number (skipping numbers already taken). */
	async function insertMemo(cols, user) {
		const sql = `
			WITH n AS (
				UPDATE ${T("settings")} SET next_credit_memo_number = next_credit_memo_number + 1 WHERE id = 1
				RETURNING $8::text || lpad((next_credit_memo_number - 1)::text, greatest(4, length((next_credit_memo_number - 1)::text)), '0') AS number
			)
			INSERT INTO ${T("credit_memos")} (number, customer_id, memo_date, currency, amount_cents, category_id, description, created_by)
			SELECT n.number, $1::bigint, $2::date, $3::text, $4::bigint, $5::bigint, $6::text, $7::text FROM n
			RETURNING id`;
		const params = [cols.customer_id, cols.memo_date, cols.currency, cols.amount_cents, cols.category_id, cols.description, user.username, PREFIX];
		for (let attempt = 0; ; attempt++) {
			try {
				return (await q(sql, params)).rows[0].id;
			} catch (e) {
				if (e?.code !== "23505" || attempt >= 100) throw e;
				await q(`UPDATE ${T("settings")} SET next_credit_memo_number = next_credit_memo_number + 1 WHERE id = 1`);
			}
		}
	}

	ctx.route("GET", "/credit-memos", async (req) => {
		const status = req.query.get("status") ?? "";
		if (!Object.hasOwn(STATUSES, status)) throw bad(`status must be one of: ${Object.keys(STATUSES).filter(Boolean).join(", ")}`);
		const customer = req.query.get("customer_id") || null;
		if (customer !== null && !isId(customer)) throw bad("customer_id must be a customer id");
		const search = (req.query.get("q") ?? "").trim().slice(0, 200);
		const limit = req.query.get("limit") ? h.intIn(req.query.get("limit"), "limit", 1, MAX_PAGE) : MAX_PAGE;
		const offset = req.query.get("offset") ? h.intIn(req.query.get("offset"), "offset", 0, 1_000_000_000) : 0;
		const where = `m.status <> 'posting' AND ${STATUSES[status]}
			   AND ($1::bigint IS NULL OR m.customer_id = $1::bigint)
			   AND ($2 = '' OR m.number ILIKE $3 OR c.name ILIKE $3 OR m.description ILIKE $3)`;
		const params = [customer, search, like(search)];
		const [{ rows }, count] = await Promise.all([
			q(
				`SELECT m.id, m.number, m.status, m.memo_date::text, m.currency, m.amount_cents, m.description, m.customer_id,
				        c.name AS customer_name, c.company AS customer_company,
				        CASE WHEN applied.id IS NULL THEN NULL ELSE jsonb_build_object('id', applied.id, 'number', applied.number, 'status', applied.status) END AS applied_to
				   FROM ${T("credit_memos")} m JOIN ${CUSTOMERS} c ON c.id = m.customer_id ${APPLIED}
				  WHERE ${where}
				  ORDER BY m.memo_date DESC, m.id DESC LIMIT $4 OFFSET $5`,
				[...params, limit, offset],
			),
			q(`SELECT count(*)::int AS total FROM ${T("credit_memos")} m JOIN ${CUSTOMERS} c ON c.id = m.customer_id ${APPLIED} WHERE ${where}`, params),
		]);
		const total = Math.max(count.rows[0]?.total ?? 0, offset + rows.length);
		return { data: rows, total, limit, offset, has_more: offset + rows.length < total };
	});

	ctx.route("GET", "/credit-memos/:id", async (req) => getMemo(id(req, "id", "credit memo")));

	ctx.route("POST", "/credit-memos", async (req) => {
		const o = body(req);
		const s = await loadSettings();
		if (!isId(o.customer_id)) throw bad("customer_id is required");
		const { rows } = await q(`SELECT id, name, currency, entity_id, entity_active, archived FROM ${CUSTOMERS} c WHERE id = $1`, [String(o.customer_id)]);
		const cust = rows[0];
		if (!cust) throw bad("customer_id: there is no such customer");
		if (cust.archived) throw bad("customer_id: this customer is archived");
		if (cust.entity_id === null || !cust.entity_active) throw bad("customer_id: this customer isn't in Ledger's customer list yet (Customers → Review the move), so the credit can't be tagged with them");
		const date = o.memo_date === undefined || o.memo_date === "" || o.memo_date === null ? today() : dateField(o.memo_date, "memo_date");
		const cur = o.currency === undefined || o.currency === "" || o.currency === null ? cust.currency : currency(o.currency);
		const amount = decimal(o.amount, 2, "amount");
		if (amount <= 0n) throw bad("amount must be more than 0");
		if (amount > MAX_CENTS) throw bad("amount is too large");
		const description = text(o, "description", 1000, { multiline: true });
		let cat = null;
		if (o.category_id !== undefined && o.category_id !== null && o.category_id !== "") {
			if (!isId(o.category_id)) throw bad("category_id: there is no such category");
			cat = (await q(`SELECT id, name, ${CATEGORY_ACCOUNTS} FROM ${T("categories")} WHERE id = $1`, [String(o.category_id)])).rows[0];
			if (!cat) throw bad("category_id: there is no such category");
		}
		// It is posted when made: the credit lives in the books, in the clearing account.
		if (!s.post_to_ledger) throw bad("credit memos are posted to the books: turn on “Post invoices and payments to the books” first (Settings → Sales → Accounts)");
		const revenue = cat?.accounts?.[cur] || s.accounts?.[cur]?.revenue;
		if (!revenue) throw bad(cat ? `category "${cat.name}" has no ${cur} revenue account, and no default revenue account is set (Settings → Sales → Accounts)` : `set the default ${cur} revenue account first (Settings → Sales → Accounts), or choose a category`);
		const clearing = await billable.credits(cur);
		if (!clearing) throw conflict("credit memos need Ledger 0.20.0 or newer (clearing accounts)");

		const mid = await insertMemo({ customer_id: String(cust.id), memo_date: date, currency: cur, amount_cents: amount.toString(), category_id: cat ? String(cat.id) : null, description }, req.user);
		const memo = await getMemo(mid);
		let entry;
		try {
			entry = await ctx.ledger.createJournalEntry(
				{
					entry_date: date,
					description: `Credit memo ${memo.number} – ${cust.name}${description ? ` – ${description.split("\n")[0]}` : ""}`.slice(0, 500),
					reference: memo.number,
					lines: [
						{ account_code: revenue, debit_cents: amount, memo: `${cat ? cat.name : "Sales"} – Credit memo ${memo.number}` },
						{ account_code: clearing.code, credit_cents: amount, memo: (description.split("\n")[0] || `Credit memo ${memo.number}`).slice(0, 500) },
					],
					links: [link(memo)],
					entity_id: Number(cust.entity_id),
				},
				req.user,
			);
		} catch (e) {
			await q(`DELETE FROM ${T("credit_memos")} WHERE id = $1 AND status = 'posting'`, [String(mid)]);
			throw e;
		}
		const line = entry.lines.find((l) => l.account_code === clearing.code && BigInt(l.credit_cents ?? 0) > 0n);
		await q(`UPDATE ${T("credit_memos")} SET status = 'open', journal_entry_id = $2, ledger_line_id = $3 WHERE id = $1`, [String(mid), String(entry.id), line ? String(line.id) : null]);
		ctx.log.info("credit memo posted", { memo: memo.number, entry: String(entry.id), user: req.user.username });
		return ctx.response(201, await getMemo(mid));
	});

	ctx.route("POST", "/credit-memos/:id/void", async (req) => {
		const mid = id(req, "id", "credit memo");
		const o = body(req);
		const date = o.date === undefined || o.date === "" ? today() : dateField(o.date, "date");
		const before = await getMemo(mid);
		if (before.status === "void") throw conflict("this credit memo is already void");
		if (before.status !== "open") throw conflict("this credit memo is being posted right now");
		if (before.applied_to) throw conflict(`this credit memo is applied on invoice ${before.applied_to.number}; take it off that invoice (or void the invoice) first`);
		// Void it in one statement that also checks no invoice took it meanwhile.
		const { rows } = await q(
			`UPDATE ${T("credit_memos")} m SET status = 'void', voided_at = now()
			  WHERE m.id = $1 AND m.status = 'open'
			    AND NOT EXISTS (SELECT 1 FROM ${T("documents")} d JOIN ${T("document_lines")} l ON l.document_id = d.id
			                     WHERE d.kind = 'invoice' AND d.status <> 'void' AND m.ledger_line_id = ANY(l.billed_ledger_line_ids))
			  RETURNING journal_entry_id`,
			[mid],
		);
		if (!rows[0]) throw conflict("this credit memo changed meanwhile; reload");
		const entryId = rows[0].journal_entry_id;
		if (entryId !== null) {
			try {
				if (await stillInBooks(entryId)) {
					const rev = await ctx.ledger.reverseJournalEntry(entryId, { entry_date: date, description: `Void credit memo ${before.number}` }, req.user);
					await q(`UPDATE ${T("credit_memos")} SET void_entry_id = $2 WHERE id = $1`, [mid, String(rev.id)]);
					await linkEntry(rev.id, link(before, "Void credit memo"), req.user);
				}
			} catch (e) {
				await q(`UPDATE ${T("credit_memos")} SET status = 'open', voided_at = NULL WHERE id = $1 AND status = 'void'`, [mid]);
				throw e;
			}
		}
		ctx.log.info("credit memo voided", { memo: before.number, user: req.user.username });
		return getMemo(mid);
	});

	// Root mode: delete any credit memo, without posting or reversing anything.
	ctx.route("DELETE", "/root/credit-memos/:id", async (req) => {
		if (!ctx.root) throw new ctx.HttpError(409, "root mode needs Ledger 0.21.1 or newer");
		if (!req.user?.root) throw new ctx.HttpError(403, "turn on root mode first (Settings → Root)");
		const mid = id(req, "id", "credit memo");
		const { rows } = await q(`SELECT number FROM ${T("credit_memos")} WHERE id = $1`, [mid]);
		if (!rows[0]) throw notFound("credit memo");
		await ctx.root.remove(req, "credit_memos", mid, `Sales: deleted credit memo ${rows[0].number}`);
		return { deleted: true };
	});

	return {
		/**
		 * A credit memo left in "posting" means Ledger stopped while posting it:
		 * open it with its entry if that was posted, otherwise remove it.
		 */
		async recover(org) {
			const { rows } = await q(`SELECT id, number FROM ${T("credit_memos")} WHERE status = 'posting' AND created_at < now() - interval '1 minute'`);
			for (const r of rows) {
				try {
					const linked = (await ctx.ledger.linkedEntries(`credit-memo:${r.id}`)).filter((l) => !l.reversed && String(l.label ?? "").startsWith("Credit memo "));
					if (!linked.length) {
						await q(`DELETE FROM ${T("credit_memos")} WHERE id = $1 AND status = 'posting'`, [String(r.id)]);
						continue;
					}
					const entry = await ctx.ledger.getJournalEntry(linked[0].entry_id);
					const m = await getMemo(r.id);
					const clearing = await billable.credits(m.currency);
					const line = entry.lines.find((l) => l.account_code === clearing?.code && BigInt(l.credit_cents ?? 0) > 0n);
					await q(`UPDATE ${T("credit_memos")} SET status = 'open', journal_entry_id = $2, ledger_line_id = $3 WHERE id = $1 AND status = 'posting'`, [String(r.id), String(entry.id), line ? String(line.id) : null]);
				} catch (e) {
					ctx.log.warn("could not recover a credit memo that was being posted when Ledger stopped", { number: r.number, err: e.message, ...(org ? { organization: org.name } : {}) });
				}
			}
		},
	};
}
