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
//   open → void. While no invoice takes it, a memo can be edited: the
//   corrected entry is posted and the old one reversed (an entry can't be
//   changed), keeping the memo's number. A credit memo is "applied" while an invoice that isn't void
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

	/** What frees a credit memo from the invoice that applies it. */
	const undo = (inv) => (inv.status === "draft" || inv.status === "posting" ? "take it off that draft (or delete the draft)" : "void that invoice");

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

	/**
	 * Validates a credit memo's fields (`existing`: the memo being edited, whose
	 * values stand for what isn't given) and works out where it posts. Returns
	 * { cols, cust, cat, revenue, clearing }.
	 */
	async function memoInput(o, existing = null) {
		const s = await loadSettings();
		const given = (k) => o[k] !== undefined;
		const customerId = given("customer_id") ? o.customer_id : existing?.customer_id;
		if (!isId(customerId)) throw bad("customer_id is required");
		const { rows } = await q(`SELECT id, name, currency, entity_id, entity_active, archived FROM ${CUSTOMERS} c WHERE id = $1`, [String(customerId)]);
		const cust = rows[0];
		if (!cust) throw bad("customer_id: there is no such customer");
		if (cust.archived && String(existing?.customer_id ?? "") !== String(cust.id)) throw bad("customer_id: this customer is archived");
		if (cust.entity_id === null || !cust.entity_active) throw bad("customer_id: this customer isn't in Ledger's customer list yet (Customers → Review the move), so the credit can't be tagged with them");
		const date = given("memo_date") && o.memo_date !== "" && o.memo_date !== null ? dateField(o.memo_date, "memo_date") : (existing?.memo_date ?? today());
		const cur = given("currency") && o.currency !== "" && o.currency !== null ? currency(o.currency) : (existing && String(existing.customer_id) === String(cust.id) ? existing.currency : cust.currency);
		if (!given("amount") && !existing) throw bad("amount is required");
		const amount = given("amount") ? decimal(o.amount, 2, "amount") : BigInt(existing.amount_cents);
		if (amount <= 0n) throw bad("amount must be more than 0");
		if (amount > MAX_CENTS) throw bad("amount is too large");
		const description = given("description") ? text(o, "description", 1000, { multiline: true }) : (existing?.description ?? "");
		const catId = given("category_id") ? o.category_id : existing?.category_id;
		let cat = null;
		if (catId !== undefined && catId !== null && catId !== "") {
			if (!isId(catId)) throw bad("category_id: there is no such category");
			cat = (await q(`SELECT id, name, ${CATEGORY_ACCOUNTS} FROM ${T("categories")} WHERE id = $1`, [String(catId)])).rows[0];
			if (!cat) throw bad("category_id: there is no such category");
		}
		// It is posted when made: the credit lives in the books, in the clearing account.
		if (!s.post_to_ledger) throw bad("credit memos are posted to the books: turn on “Post invoices and payments to the books” first (Settings → Sales → Accounts)");
		const revenue = cat?.accounts?.[cur] || s.accounts?.[cur]?.revenue;
		if (!revenue) throw bad(cat ? `category "${cat.name}" has no ${cur} revenue account, and no default revenue account is set (Settings → Sales → Accounts)` : `set the default ${cur} revenue account first (Settings → Sales → Accounts), or choose a category`);
		const clearing = await billable.credits(cur);
		if (!clearing) throw conflict("credit memos need Ledger 0.20.0 or newer (clearing accounts)");
		return {
			cols: { customer_id: String(cust.id), memo_date: date, currency: cur, amount_cents: amount.toString(), category_id: cat ? String(cat.id) : null, description },
			cust,
			cat,
			revenue,
			clearing,
		};
	}

	/** Posts a credit memo: Dr revenue / Cr the credits clearing account, with the customer. Returns { entry, lineId }. */
	async function postMemo(number, mid, { cols, cust, cat, revenue, clearing }, user) {
		const amount = BigInt(cols.amount_cents);
		const first = cols.description.split("\n")[0];
		const entry = await ctx.ledger.createJournalEntry(
			{
				entry_date: cols.memo_date,
				description: `Credit memo ${number} – ${cust.name}${first ? ` – ${first}` : ""}`.slice(0, 500),
				reference: number,
				lines: [
					{ account_code: revenue, debit_cents: amount, memo: `${cat ? cat.name : "Sales"} – Credit memo ${number}` },
					{ account_code: clearing.code, credit_cents: amount, memo: (first || `Credit memo ${number}`).slice(0, 500) },
				],
				links: [link({ id: mid, number, customer_name: cust.name })],
				entity_id: Number(cust.entity_id),
			},
			user,
		);
		const line = entry.lines.find((l) => l.account_code === clearing.code && BigInt(l.credit_cents ?? 0) > 0n);
		return { entry, lineId: line ? String(line.id) : null };
	}

	ctx.route("POST", "/credit-memos", async (req) => {
		const input = await memoInput(body(req));
		const mid = await insertMemo(input.cols, req.user);
		const memo = await getMemo(mid);
		let posted;
		try {
			posted = await postMemo(memo.number, mid, input, req.user);
		} catch (e) {
			await q(`DELETE FROM ${T("credit_memos")} WHERE id = $1 AND status = 'posting'`, [String(mid)]);
			throw e;
		}
		await q(`UPDATE ${T("credit_memos")} SET status = 'open', journal_entry_id = $2, ledger_line_id = $3 WHERE id = $1`, [String(mid), String(posted.entry.id), posted.lineId]);
		ctx.log.info("credit memo posted", { memo: memo.number, entry: String(posted.entry.id), user: req.user.username });
		return ctx.response(201, await getMemo(mid));
	});

	/**
	 * Edits a credit memo that no invoice has taken yet. Its entry can't be
	 * changed, so the corrected one is posted and then the old one reversed;
	 * the memo keeps its number and points at the new entry (and its new
	 * clearing line, the billable item an invoice will bill).
	 */
	ctx.route("PUT", "/credit-memos/:id", async (req) => {
		const mid = id(req, "id", "credit memo");
		const before = await getMemo(mid);
		if (before.status === "void") throw conflict("this credit memo is void");
		if (before.status !== "open") throw conflict("this credit memo is being posted right now");
		if (before.applied_to) throw conflict(`this credit memo is applied on invoice ${before.applied_to.number} and can't be changed; ${undo(before.applied_to)} first`);
		const input = await memoInput(body(req), before);
		const c = input.cols;
		const same =
			c.customer_id === String(before.customer_id) &&
			c.memo_date === before.memo_date &&
			c.currency === before.currency &&
			c.amount_cents === String(before.amount_cents) &&
			String(c.category_id ?? "") === String(before.category_id ?? "") &&
			c.description === before.description;
		if (same) return before;
		// Claim it, in one statement that also checks no invoice took it meanwhile.
		const claimed = await q(
			`UPDATE ${T("credit_memos")} m SET status = 'posting'
			  WHERE m.id = $1 AND m.status = 'open'
			    AND NOT EXISTS (SELECT 1 FROM ${T("documents")} d JOIN ${T("document_lines")} l ON l.document_id = d.id
			                     WHERE d.kind = 'invoice' AND d.status <> 'void' AND m.ledger_line_id = ANY(l.billed_ledger_line_ids))
			  RETURNING id`,
			[mid],
		);
		if (!claimed.rows[0]) throw conflict("this credit memo changed meanwhile; reload");
		const back = () => q(`UPDATE ${T("credit_memos")} SET status = 'open' WHERE id = $1 AND status = 'posting'`, [mid]);
		let posted;
		try {
			posted = await postMemo(before.number, mid, input, req.user);
		} catch (e) {
			await back();
			throw e;
		}
		// The old entry out of the books (unless a person already reversed or deleted it), on
		// its own date, so it and its reversal cancel out in the same period.
		const old = before.journal_entry_id;
		let reversal = null;
		if (old !== null) {
			try {
				if (await stillInBooks(old)) reversal = await ctx.ledger.reverseJournalEntry(old, { entry_date: before.memo_date, description: `Credit memo ${before.number} changed` }, req.user);
			} catch (e) {
				// Leave the books as they were: take the new entry out again.
				await ctx.ledger.reverseJournalEntry(posted.entry.id, { description: `Credit memo ${before.number}: change not made` }, req.user).catch((e2) =>
					ctx.log.error("could not take back the entry of a credit memo change that failed", { memo: before.number, entry: String(posted.entry.id), err: e2.message }),
				);
				await back();
				throw e;
			}
		}
		await q(
			`UPDATE ${T("credit_memos")}
			    SET status = 'open', journal_entry_id = $2, ledger_line_id = $3,
			        customer_id = $4, memo_date = $5, currency = $6, amount_cents = $7, category_id = $8, description = $9,
			        edited_at = now(), edited_by = $10
			  WHERE id = $1`,
			[mid, String(posted.entry.id), posted.lineId, c.customer_id, c.memo_date, c.currency, c.amount_cents, c.category_id, c.description, req.user.username],
		);
		if (reversal) await linkEntry(reversal.id, link(before, "Changed credit memo"), req.user);
		ctx.log.info("credit memo changed", { memo: before.number, entry: String(posted.entry.id), replaced: old === null ? null : String(old), user: req.user.username });
		return getMemo(mid);
	});

	ctx.route("POST", "/credit-memos/:id/void", async (req) => {
		const mid = id(req, "id", "credit memo");
		const o = body(req);
		const date = o.date === undefined || o.date === "" ? today() : dateField(o.date, "date");
		const before = await getMemo(mid);
		if (before.status === "void") throw conflict("this credit memo is already void");
		if (before.status !== "open") throw conflict("this credit memo is being posted right now");
		if (before.applied_to) throw conflict(`this credit memo is applied on invoice ${before.applied_to.number}; ${undo(before.applied_to)} first`);
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
			const { rows } = await q(`SELECT id, number, journal_entry_id FROM ${T("credit_memos")} WHERE status = 'posting' AND created_at < now() - interval '1 minute'`);
			for (const r of rows) {
				try {
					const linked = (await ctx.ledger.linkedEntries(`credit-memo:${r.id}`)).filter((l) => !l.reversed && String(l.label ?? "").startsWith("Credit memo "));
					if (!linked.length) {
						// A new memo whose entry never got posted goes; an edited one stays as it was.
						if (r.journal_entry_id === null) await q(`DELETE FROM ${T("credit_memos")} WHERE id = $1 AND status = 'posting'`, [String(r.id)]);
						else await q(`UPDATE ${T("credit_memos")} SET status = 'open' WHERE id = $1 AND status = 'posting'`, [String(r.id)]);
						continue;
					}
					// An edit stopped between posting the new entry and reversing the old one leaves two:
					// the newest is the memo's, the others are reversed. (Sales' own copy of the fields may
					// still be the old ones; the entry says what was posted.)
					const ids = linked.map((l) => BigInt(l.entry_id)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
					const latest = ids.at(-1);
					for (const other of ids.slice(0, -1)) await ctx.ledger.reverseJournalEntry(String(other), { description: `Credit memo ${r.number} changed` });
					const entry = await ctx.ledger.getJournalEntry(String(latest));
					// Its one credit line is the clearing account's (Sales posted it; the debit is revenue).
					const line = entry.lines.find((l) => BigInt(l.credit_cents ?? 0) > 0n);
					if (ids.length > 1) ctx.log.warn("a credit memo was being changed when Ledger stopped; it now points at its newest entry, but its amount, date or customer in Sales may be the old ones: check it against the entry", { number: r.number, entry: String(entry.id) });
					await q(`UPDATE ${T("credit_memos")} SET status = 'open', journal_entry_id = $2, ledger_line_id = $3 WHERE id = $1 AND status = 'posting'`, [String(r.id), String(entry.id), line ? String(line.id) : null]);
				} catch (e) {
					ctx.log.warn("could not recover a credit memo that was being posted when Ledger stopped", { number: r.number, err: e.message, ...(org ? { organization: org.name } : {}) });
				}
			}
		},
	};
}
