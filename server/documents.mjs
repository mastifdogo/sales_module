// Invoices, quotes and estimates. They share one table and most of their
// code (lines, categories, taxes, PDF, email), but each kind has its own
// routes (/invoices, /quotes, /estimates), numbering and statuses:
//
//   invoice:          draft → open → paid, or open → void. Issuing posts it to
//                     the books when ledger posting is on (Dr receivable,
//                     Cr revenue per category and each tax); payments post
//                     Dr bank / Cr receivable; voiding reverses. "Receivable"
//                     is the customer's own account under accounts receivable
//                     on Ledger ≥ 0.31.0 (receivables.mjs).
//   quote, estimate:  draft → sent → accepted or declined; "convert" turns
//                     one into a draft invoice. Never posted to the books.

import { addDays, computeTotals, formatDecimal, formatMoney, MAX_CENTS, today } from "../lib/money.mjs";
import { renderDocumentPdf } from "../lib/pdf.mjs";
import { isNotFound, KINDS } from "./common.mjs";
import { billableItems } from "./billable.mjs";
import { receivables } from "./receivables.mjs";
import { openLink } from "./search.mjs";

const MAX_LINES = 200;
const MAX_PAGE = 500; // documents per page of a list
// Column types for parameters in INSERT ... SELECT, where Postgres can't infer them.
const COLUMN_TYPES = {
	customer_id: "bigint",
	issue_date: "date",
	due_date: "date",
	currency: "text",
	po_number: "text",
	notes: "text",
	subtotal_cents: "bigint",
	tax_cents: "bigint",
	total_cents: "bigint",
	source_id: "bigint",
	project_id: "bigint",
};
const OPEN_QUOTE = ["draft", "sent"];

/**
 * What Sales knows about an invoice, quote or estimate (as getDocument()
 * returns it), in the keys every Ledger module reads a file's data by
 * (Ledger ≥ 0.27.0, ctx.documents.setExtracted): money in integer cents,
 * dates YYYY-MM-DD. What is Sales' own goes under "sales".
 */
export function extractionOf(doc) {
	const cents = (v) => Number(BigInt(v ?? 0)); // far below 2^53: see MAX_CENTS
	return {
		type: doc.kind,
		customer: doc.customer?.name ?? "",
		entity_id: doc.customer?.entity_id === null || doc.customer?.entity_id === undefined ? null : Number(doc.customer.entity_id),
		number: doc.number,
		date: doc.issue_date,
		due_date: doc.due_date,
		currency: doc.currency,
		subtotal_cents: cents(doc.subtotal_cents),
		tax_cents: cents(doc.tax_cents),
		total_cents: cents(doc.total_cents),
		items: (doc.lines ?? []).map((l) => ({
			description: l.description,
			quantity: Number(formatDecimal(l.quantity, 3)),
			unit: "",
			rate_cents: cents(l.unit_price_cents),
			amount_cents: cents(l.amount_cents),
		})),
		sales: { id: Number(doc.id), kind: doc.kind, status: doc.status },
	};
}

export function documentRoutes(ctx, h, mail, tags) {
	const { T, q, bad, notFound, conflict, body, text, dateField, currency, decimal, id, isId, idList, like, loadSettings, CUSTOMERS, TAX_ACCOUNTS, CATEGORY_ACCOUNTS } = h;
	const billable = billableItems(ctx, h);
	const receivable = receivables(ctx, h);

	/**
	 * Makes Sales' billable-costs clearing account for each currency in use
	 * (the default and the customers'), so people can post costs to it.
	 */
	async function makeClearingAccounts(org) {
		try {
			const s = await loadSettings();
			const { rows } = await q(`SELECT DISTINCT currency FROM ${T("customers")}`);
			for (const cur of new Set([s.default_currency, ...rows.map((r) => r.currency)])) {
				await billable.clearing(cur);
				await billable.credits(cur);
			}
		} catch (e) {
			ctx.log.warn("could not make the billable-costs clearing accounts", { err: e.message, ...(org ? { organization: org.name } : {}) });
		}
	}

	const byId = (rows) => new Map(rows.map((r) => [String(r.id), r]));
	const loadTaxes = async () => byId((await q(`SELECT *, ${TAX_ACCOUNTS} FROM ${T("taxes")}`)).rows);
	const loadCategories = async () => byId((await q(`SELECT *, ${CATEGORY_ACCOUNTS} FROM ${T("categories")}`)).rows);
	const validDays = (kind, s, cust) => (kind === "invoice" ? (cust.terms_days ?? s.default_terms_days) : s[KINDS[kind].validDays]);

	// ---- input --------------------------------------------------------------------

	/** Validates a document body; returns its columns and lines (as JSON for jsonb_to_recordset). */
	async function documentInput(kind, o, s, existing) {
		const customerId = o.customer_id ?? existing?.customer_id;
		if (!isId(customerId)) throw bad("customer_id is required");
		const { rows } = await q(`SELECT id, currency, terms_days, tax_ids, archived FROM ${CUSTOMERS} x WHERE id = $1`, [String(customerId)]);
		const cust = rows[0];
		if (!cust) throw bad("customer_id: there is no such customer");
		if (cust.archived && String(existing?.customer_id) !== String(cust.id)) throw bad("customer_id: this customer is archived");

		const issue = o.issue_date === undefined ? (existing?.issue_date ?? today()) : dateField(o.issue_date, "issue_date");
		const keepDue = existing && o.issue_date === undefined;
		const due = o.due_date === undefined || o.due_date === "" || o.due_date === null ? (keepDue ? existing.due_date : addDays(issue, validDays(kind, s, cust))) : dateField(o.due_date, "due_date");
		if (due < issue) throw bad(`${kind === "invoice" ? "due_date" : "valid until"} can't be before the date`);
		const cur = o.currency === undefined ? (existing?.currency ?? cust.currency) : currency(o.currency);

		let lines = existing?.lines ?? [];
		if (!(o.lines === undefined && existing)) {
			if (!Array.isArray(o.lines) || o.lines.length === 0) throw bad("lines: add at least one line");
			if (o.lines.length > MAX_LINES) throw bad(`lines: at most ${MAX_LINES} lines`);
			const [taxes, categories] = await Promise.all([loadTaxes(), loadCategories()]);
			lines = o.lines.map((l, i) => {
				const f = (k) => `lines[${i + 1}].${k}`;
				if (!l || typeof l !== "object") throw bad(`${f("description")} is required`);
				let category = null;
				if (l.category_id !== undefined && l.category_id !== null && l.category_id !== "") {
					category = isId(l.category_id) ? categories.get(String(l.category_id)) : undefined;
					if (!category) throw bad(`${f("category_id")}: there is no such category`);
				}
				const description = text(l, "description", 1000, { required: true, multiline: true });
				const quantity = decimal(l.quantity ?? "1", 3, f("quantity"));
				if (quantity <= 0n || quantity > 10n ** 12n) throw bad(`${f("quantity")} must be more than 0`);
				const unit = decimal(l.unit_price ?? "", 2, f("unit_price"));
				if (unit > MAX_CENTS || unit < -MAX_CENTS) throw bad(`${f("unit_price")} is too large`);
				// Taxes: as given, else the category's, the customer's, or the defaults.
				const taxIds = l.tax_ids === undefined || l.tax_ids === null ? (category?.tax_ids ?? cust.tax_ids ?? s.default_tax_ids ?? []).map(String) : idList(l.tax_ids, f("tax_ids"));
				const lineTaxes = taxIds.map((tid) => {
					const t = taxes.get(String(tid));
					if (!t) throw bad(`${f("tax_ids")}: there is no such tax`);
					return { id: Number(t.id), name: t.name, rate: Number(t.rate) };
				});
				let billed = [];
				if (l.billed_ledger_line_ids !== undefined && l.billed_ledger_line_ids !== null) {
					if (kind !== "invoice") throw bad(`${f("billed_ledger_line_ids")}: only invoices bill items`);
					if (!Array.isArray(l.billed_ledger_line_ids) || l.billed_ledger_line_ids.length > 500) throw bad(`${f("billed_ledger_line_ids")} must be a list of billable items`);
					billed = idList(l.billed_ledger_line_ids, f("billed_ledger_line_ids")).map(String);
				}
				// The billed cost's rate item it was filled from (Ledger's tag "rate"), if any.
				let rateTag = null;
				if (l.rate_tag_id !== undefined && l.rate_tag_id !== null && l.rate_tag_id !== "") {
					if (!isId(l.rate_tag_id)) throw bad(`${f("rate_tag_id")} is not valid`);
					if (billed.length !== 1) throw bad(`${f("rate_tag_id")}: a line from a rate item bills exactly one billable item`);
					rateTag = String(l.rate_tag_id);
				}
				return { category_id: category ? String(category.id) : null, description, quantity, unit_price_cents: unit, taxes: lineTaxes, billed_ledger_line_ids: billed, rate_tag_id: rateTag };
			});
		}
		// The project, if any: one of this customer's, and active unless it already was this document's.
		let projectId = existing?.project_id ?? null;
		if (o.project_id !== undefined) {
			projectId = o.project_id === null || o.project_id === "" ? null : o.project_id;
			if (projectId !== null) {
				if (!isId(projectId)) throw bad("project_id is not valid");
				const { rows: pr } = await q(`SELECT id, customer_id, status FROM ${T("projects")} WHERE id = $1`, [String(projectId)]);
				if (!pr[0]) throw bad("project_id: there is no such project");
				if (String(pr[0].customer_id) !== String(cust.id)) throw bad("project_id: that project is another customer's");
				if (pr[0].status !== "active" && String(existing?.project_id ?? "") !== String(projectId)) throw bad("project_id: that project is closed");
				projectId = String(pr[0].id);
			}
		} else if (projectId !== null && existing && String(existing.customer_id) !== String(cust.id)) {
			// A new customer: the old customer's project doesn't apply.
			projectId = null;
		}
		// Billable items must still be this customer's, in this currency, and not billed elsewhere.
		await billable.check(String(cust.id), cur, lines.map((l) => (l.billed_ledger_line_ids ?? []).map(String)), existing?.id ?? null, lines.map((l) => (l.rate_tag_id === null || l.rate_tag_id === undefined ? null : String(l.rate_tag_id))));
		const totals = computeTotals(lines);
		if (totals.total > MAX_CENTS || totals.total < -MAX_CENTS) throw bad("the total is too large");
		return {
			cols: {
				customer_id: String(cust.id),
				issue_date: issue,
				due_date: due,
				currency: cur,
				po_number: o.po_number === undefined ? (existing?.po_number ?? "") : text(o, "po_number", 100),
				notes: o.notes === undefined ? (existing?.notes ?? "") : text(o, "notes", 5000, { multiline: true }),
				subtotal_cents: totals.subtotal.toString(),
				tax_cents: totals.tax.toString(),
				total_cents: totals.total.toString(),
				project_id: projectId === null ? null : String(projectId),
			},
			linesJson: JSON.stringify(
				lines.map((l, i) => ({
					position: i + 1,
					category_id: l.category_id === null ? null : String(l.category_id),
					description: l.description,
					quantity: l.quantity.toString(),
					unit_price_cents: l.unit_price_cents.toString(),
					taxes: l.taxes,
					amount_cents: totals.amounts[i].toString(),
					billed_ledger_line_ids: (l.billed_ledger_line_ids ?? []).map(String),
					rate_tag_id: l.rate_tag_id === null || l.rate_tag_id === undefined ? null : String(l.rate_tag_id),
				})),
			),
		};
	}

	const LINES_FROM_JSON = (src, param) => `
		INSERT INTO ${T("document_lines")} (document_id, position, category_id, description, quantity, unit_price_cents, taxes, amount_cents, billed_ledger_line_ids, rate_tag_id)
		SELECT ${src}.id, x.position, x.category_id, x.description, x.quantity, x.unit_price_cents, x.taxes, x.amount_cents, coalesce(x.billed_ledger_line_ids, '{}'), x.rate_tag_id
		  FROM ${src}, jsonb_to_recordset(${param}::jsonb)
		       AS x(position int, category_id bigint, description text, quantity bigint, unit_price_cents bigint, taxes jsonb, amount_cents bigint, billed_ledger_line_ids bigint[], rate_tag_id bigint)`;

	/** Inserts a draft with the kind's next number, skipping numbers already taken. */
	async function insertDocument(kind, cols, linesJson, user) {
		const { prefix, next } = KINDS[kind];
		const names = Object.keys(cols);
		// The prefix comes from Ledger's settings form; the counter from the module's own table.
		const params = [...Object.values(cols), user.username, linesJson, kind, (await loadSettings())[prefix]];
		const n = names.length;
		// The number has at least four digits (INV-0042). lpad() cuts a longer text short
		// ("10000" to "1000"), so past 9999 the width is the number's own.
		const sql = `
			WITH n AS (
				UPDATE ${T("settings")} SET ${next} = ${next} + 1 WHERE id = 1
				RETURNING $${n + 4}::text || lpad((${next} - 1)::text, greatest(4, length((${next} - 1)::text)), '0') AS number
			), doc AS (
				INSERT INTO ${T("documents")} (kind, number, ${names.join(", ")}, created_by)
				SELECT $${n + 3}::text, n.number, ${names.map((k, i) => `$${i + 1}::${COLUMN_TYPES[k]}`).join(", ")}, $${n + 1}::text FROM n
				RETURNING id
			), lines AS (${LINES_FROM_JSON("doc", `$${n + 2}`)})
			SELECT id FROM doc`;
		for (let attempt = 0; ; attempt++) {
			try {
				const { rows } = await q(sql, params);
				return rows[0].id;
			} catch (e) {
				if (e?.code !== "23505" || attempt >= 100) throw e;
				// The number is taken (e.g. the next number was set back); the failed
				// statement rolled back, so step past it and try again.
				await q(`UPDATE ${T("settings")} SET ${next} = ${next} + 1 WHERE id = 1`);
			}
		}
	}

	// ---- reading ------------------------------------------------------------------------

	async function getDocument(did, kind) {
		const { rows } = await q(
			`SELECT d.*, d.issue_date::text, d.due_date::text,
			        jsonb_build_object('id', c.id, 'name', c.name, 'company', c.company, 'email', c.email, 'cc_emails', c.cc_emails,
			                           'address', c.address, 'tax_id', c.tax_id, 'phone', c.phone,
			                           'entity_id', c.entity_id, 'entity_active', c.entity_active) AS customer,
			        (SELECT jsonb_build_object('id', s.id, 'kind', s.kind, 'number', s.number) FROM ${T("documents")} s WHERE s.id = d.source_id) AS source,
			        (SELECT jsonb_build_object('id', v.id, 'kind', v.kind, 'number', v.number) FROM ${T("documents")} v WHERE v.id = d.converted_id) AS converted,
			        (SELECT jsonb_build_object('id', pj.id, 'name', pj.name, 'status', pj.status) FROM ${T("projects")} pj WHERE pj.id = d.project_id) AS project
			   FROM ${T("documents")} d JOIN ${CUSTOMERS} c ON c.id = d.customer_id
			  WHERE d.id = $1`,
			[did],
		);
		const doc = rows[0];
		if (!doc || (kind && doc.kind !== kind)) throw notFound(kind ?? "document");
		const [lines, payments, emails] = await Promise.all([
			q(
				`SELECT l.id, l.position, l.category_id, cat.name AS category_name, l.description, l.quantity, l.unit_price_cents, l.taxes, l.amount_cents,
				        l.billed_ledger_line_ids::text[] AS billed_ledger_line_ids, l.rate_tag_id::text AS rate_tag_id
				   FROM ${T("document_lines")} l LEFT JOIN ${T("categories")} cat ON cat.id = l.category_id
				  WHERE l.document_id = $1 ORDER BY l.position, l.id`,
				[did],
			),
			q(`SELECT id, payment_date::text, amount_cents, method, reference, journal_entry_id, matched_entry_id, created_by, created_at FROM ${T("payments")} WHERE document_id = $1 ORDER BY payment_date, id`, [did]),
			q(`SELECT id, recipients, subject, ok, error, sent_by, sent_at FROM ${T("email_log")} WHERE document_id = $1 ORDER BY id DESC LIMIT 50`, [did]),
		]);
		doc.lines = lines.rows.map((l) => ({ ...l, quantity_text: formatDecimal(l.quantity, 3), tax_ids: l.taxes.map((t) => t.id) }));
		doc.payments = payments.rows;
		doc.emails = emails.rows;
		doc.taxes = computeTotals(doc.lines).taxes;
		doc.balance_cents = doc.kind !== "invoice" || doc.status === "void" ? 0n : BigInt(doc.total_cents) - BigInt(doc.paid_cents);
		const t = today();
		// Its entry was tagged "paid" in Ledger by someone else: paid, as far as lists and reminders go.
		doc.paid_by_tag = doc.kind === "invoice" && doc.status === "open" && doc.paid_by_tag === true;
		doc.overdue = doc.kind === "invoice" && doc.status === "open" && !doc.paid_by_tag && doc.due_date < t;
		doc.expired = doc.kind !== "invoice" && OPEN_QUOTE.includes(doc.status) && doc.due_date < t;
		doc.entry_changes = await entryChanges(doc);
		// Its PDF in Ledger's Documents, if it's (still) there: a restore or a
		// person may have removed it.
		doc.pdf_url = null;
		if (doc.pdf_document_id !== null && ctx.documents) {
			const filed = await ctx.documents.get(Number(doc.pdf_document_id)).catch(() => null);
			if (filed) doc.pdf_url = ctx.documents.url(filed.id);
		}
		return doc;
	}

	const LIST_FILTERS = {
		invoice: {
			"": "true",
			draft: "d.status IN ('draft', 'posting')",
			open: "d.status = 'open' AND NOT d.paid_by_tag",
			overdue: "d.status = 'open' AND NOT d.paid_by_tag AND d.due_date < $4::date",
			paid: "(d.status = 'paid' OR (d.status = 'open' AND d.paid_by_tag))",
			void: "d.status = 'void'",
		},
		quote: {
			"": "true",
			pending: "d.status IN ('draft', 'sent') AND d.due_date >= $4::date",
			draft: "d.status = 'draft'",
			sent: "d.status = 'sent'",
			accepted: "d.status = 'accepted'",
			declined: "d.status = 'declined'",
			expired: "d.status IN ('draft', 'sent') AND d.due_date < $4::date",
			converted: "d.status = 'converted'",
		},
	};
	LIST_FILTERS.estimate = LIST_FILTERS.quote;

	// ---- invoice posting --------------------------------------------------------------

	/**
	 * The ledger lines for an invoice: Dr receivable (`receivableCode`: the customer's own
	 * account, or the receivables account); Cr revenue per category account and each tax's account.
	 */
	async function postingLines(doc, totals, s, receivableCode) {
		// Billed items that came from one of Sales' clearing accounts: their
		// amount goes back to that account (clearing it); the rest of the line is
		// revenue. A cost is credited back to "Billable costs to recharge"; a
		// credit memo (a negative amount) is debited back out of "Customer
		// credits to apply".
		const fromClearing = new Map(); // journal line id → { code, cents, credit }
		if (doc.kind === "invoice" && doc.lines.some((l) => (l.billed_ledger_line_ids ?? []).length)) {
			const { items } = await billable.forCustomer(String(doc.customer_id), doc.currency, { exceptDoc: doc.id });
			for (const it of items) if (it.clearing) fromClearing.set(String(it.line_id), { code: it.account_code, cents: BigInt(it.amount_cents), credit: it.credit === true });
		}
		const cur = doc.currency;
		if (!receivableCode) throw bad(`Ledger posting is on, but there is no ${cur} receivable account: tag one "Accounts receivable" on Ledger's Accounts page, or choose one under Settings → Sales → Accounts`);
		const [categories, taxes] = await Promise.all([loadCategories(), loadTaxes()]);
		const credits = new Map(); // account → cents
		const cleared = new Set();
		const add = (acct, cents, memo) => credits.set(acct, { cents: (credits.get(acct)?.cents ?? 0n) + cents, memo });
		doc.lines.forEach((l, i) => {
			const cat = l.category_id === null ? null : categories.get(String(l.category_id));
			const acct = cat?.accounts?.[cur] || s.accounts?.[cur]?.revenue;
			if (!acct) {
				throw bad(
					cat
						? `category "${cat.name}" has no ${cur} revenue account, and no default revenue account is set (Settings → Sales → Accounts)`
						: `line ${i + 1} has no category, and no default ${cur} revenue account is set (Settings → Sales → Accounts)`,
				);
			}
			// A cost split over several lines (one per rate item) is cleared once, on its first line.
			let cost = 0n;
			for (const id of l.billed_ledger_line_ids ?? []) {
				const it = fromClearing.get(String(id));
				if (!it || cleared.has(String(id))) continue;
				cleared.add(String(id));
				add(it.code, it.cents, it.credit ? "Customer credit applied" : "Billable costs");
				cost += it.cents;
			}
			add(acct, totals.amounts[i] - cost, cat ? cat.name : "Sales");
		});
		for (const t of totals.taxes) {
			if (t.tax_cents === 0n) continue;
			const acct = taxes.get(String(t.id))?.accounts?.[cur];
			if (!acct) throw bad(`set the ${cur} account for ${t.name} first (Settings → Sales → Taxes)`);
			add(acct, t.tax_cents, t.name);
		}
		const memo = `Invoice ${doc.number}`;
		const lines = [{ account_code: receivableCode, debit_cents: totals.total, memo }];
		for (const [acct, { cents, memo: what }] of credits) {
			if (cents > 0n) lines.push({ account_code: acct, credit_cents: cents, memo: `${what} – ${memo}` });
			else if (cents < 0n) lines.push({ account_code: acct, debit_cents: -cents, memo: `${what} – ${memo}` });
		}
		return lines;
	}

	/** The link Ledger shows on a journal entry that came from this invoice (Ledger ≥ 0.11.2). */
	const invoiceLink = (doc, what = "Invoice") => ({
		ref: `invoice:${doc.id}`,
		label: `${what} ${doc.number} · ${doc.customer?.name ?? ""}`.slice(0, 200),
		href: openLink(`invoices/${doc.id}`),
	});

	/**
	 * Entries Sales posted for this document that a person has since changed
	 * in Ledger (Ledger ≥ 0.19.5 marks them amended): what the entry now
	 * totals next to what Sales posted. Sales' own record stays as it is.
	 */
	async function entryChanges(doc) {
		const posted = [];
		if (doc.journal_entry_id !== null) posted.push({ what: `Invoice ${doc.number}`, id: doc.journal_entry_id, cents: BigInt(doc.total_cents) });
		for (const p of doc.payments ?? []) if (p.journal_entry_id !== null) posted.push({ what: `Payment of ${p.payment_date}`, id: p.journal_entry_id, cents: BigInt(p.amount_cents) });
		const out = [];
		for (const x of posted) {
			const e = await ctx.ledger.getJournalEntry(x.id).catch(() => null);
			if (!e?.amended) continue;
			const now = BigInt(e.totals?.find((t) => t.currency === doc.currency)?.amount_cents ?? 0);
			out.push({ what: x.what, entry_id: String(x.id), posted_cents: x.cents.toString(), now_cents: now.toString(), differs: now !== x.cents });
		}
		return out;
	}

	/** Who an entry is with, for Ledger (≥ 0.16.0): the customer's entity, when it has an active one. */
	const entityOf = (doc) => (doc.customer?.entity_id != null && doc.customer.entity_active ? { entity_id: Number(doc.customer.entity_id) } : {});

	/**
	 * Whether an entry Sales posted still stands in the books, so that undoing
	 * the record it belongs to must reverse it. A person may have reversed it
	 * in Ledger's journal already, or deleted it in root mode: then there is
	 * nothing left to reverse (Ledger would answer 409 or 404, and the invoice
	 * or payment could never be voided or removed). Returns the entry, or
	 * null when it is gone or already reversed.
	 */
	async function stillInBooks(entryId, what) {
		let entry;
		try {
			entry = await ctx.ledger.getJournalEntry(entryId);
		} catch (e) {
			if (!isNotFound(e)) throw e;
			ctx.log.info("the journal entry is no longer in the books; nothing to reverse", { entry: String(entryId), what });
			return null;
		}
		if (entry.reversed_by_id !== null && entry.reversed_by_id !== undefined) {
			ctx.log.info("the journal entry was already reversed in Ledger; not reversing it again", { entry: String(entryId), reversed_by: String(entry.reversed_by_id), what });
			return null;
		}
		return entry;
	}

	/** Links an entry that already exists (a reversal, a matched deposit); a failure here never undoes the work. */
	async function linkEntry(entryId, link, user) {
		try {
			await ctx.ledger.linkJournalEntry(entryId, link, user);
		} catch (e) {
			ctx.log.warn("could not link journal entry", { entry: String(entryId), ref: link.ref, error: e.message });
		}
	}

	/**
	 * Files a document's PDF in Ledger's PDF store (Documents, Ledger ≥ 0.19.0)
	 * and remembers its id. One stored PDF per document, the latest issued or
	 * emailed: the one it replaces is removed. Never fails the caller.
	 */
	async function filePdf(doc, pdf, user) {
		if (!ctx.documents) return;
		try {
			// ensure(): files it, or gives back the document that already holds the same bytes.
			const { document } = await ctx.documents.ensure(
				{
					kind: doc.kind === "invoice" ? "invoice" : "other",
					origin: "created",
					filename: pdfName(doc),
					data: pdf,
					title: `${KINDS[doc.kind].label} ${doc.number} · ${doc.customer.name}`.slice(0, 200),
					doc_date: doc.issue_date,
					...entityOf(doc),
				},
				user,
			);
			const id = document.id;
			const prev = doc.pdf_document_id;
			// Another file: Sales knows of no tags or saved data on it yet.
			await q(
				`UPDATE ${T("documents")}
				    SET file_tags = CASE WHEN pdf_document_id IS DISTINCT FROM $2::bigint THEN '{}' ELSE file_tags END,
				        file_data_status = CASE WHEN pdf_document_id IS DISTINCT FROM $2::bigint THEN NULL ELSE file_data_status END,
				        pdf_document_id = $2::bigint
				  WHERE id = $1`,
				[String(doc.id), String(id)],
			);
			if (prev !== null && prev !== undefined && String(prev) !== String(id)) await ctx.documents.remove(Number(prev)).catch(() => {});
			// The file says what Sales already knows, so no other module has to read it; and its
			// tags (billed, paid, overdue) follow the invoice.
			await saveFileData({ ...doc, pdf_document_id: id }, user);
			await tags.syncFiles(doc.id, user);
		} catch (e) {
			ctx.log.warn("could not file the PDF in Ledger's documents", { document: String(doc.id), err: e.message });
		}
	}

	/**
	 * Saves what Sales knows about a document as the data kept with its filed
	 * PDF (the document's extraction, Ledger ≥ 0.27.0). Sales made the file,
	 * so this is its own record, not something read by AI: nothing to approve.
	 * It replaces what was there: the PDF was just filed, or is an issued
	 * invoice's, which doesn't change.
	 */
	async function saveFileData(doc, user) {
		if (!ctx.documents?.setExtracted || doc.pdf_document_id === null || doc.pdf_document_id === undefined) return;
		await ctx.documents.setExtracted(Number(doc.pdf_document_id), { data: extractionOf(doc), replace: true }, user);
		await q(`UPDATE ${T("documents")} SET file_data_status = $2 WHERE id = $1 AND pdf_document_id = $3::bigint`, [String(doc.id), doc.status, String(doc.pdf_document_id)]);
	}
	// The sync saves it for invoices whose PDF was filed before Sales did this (tags.mjs).
	tags.saveFileDataWith?.(async (did, user) => saveFileData(await getDocument(did), user));

	/** Issues a draft invoice: locks it, posts it to the books when enabled, and marks it open. */
	async function issueInvoice(did, user) {
		const s = await loadSettings();
		const claimed = await q(`UPDATE ${T("documents")} SET status = 'posting', updated_at = now() WHERE id = $1 AND kind = 'invoice' AND status = 'draft' RETURNING id`, [did]);
		if (claimed.rowCount === 0) {
			const doc = await getDocument(did, "invoice");
			throw conflict(doc.status === "posting" ? "this invoice is being issued right now" : `invoice ${doc.number} is already issued`);
		}
		let entryId = null;
		// What Sales knows the entry to say from the moment it is posted: whose it is, when its
		// receivable line is in the customer's own account (no "customer" tag is set then).
		let known = [];
		try {
			const doc = await getDocument(did, "invoice");
			const totals = computeTotals(doc.lines);
			if (totals.total <= 0n) throw bad("the invoice total must be more than zero");
			// The costs it bills were checked when the draft was saved; one may have been reversed,
			// replaced or put on another invoice since. Issuing it anyway would bill a cost that is
			// gone, tag nothing "billed", and leave its replacement free to be invoiced again.
			try {
				await billable.check(String(doc.customer_id), doc.currency, doc.lines.map((l) => (l.billed_ledger_line_ids ?? []).map(String)), doc.id, doc.lines.map((l) => l.rate_tag_id ?? null));
			} catch (e) {
				if (e?.status !== 409 && e?.status !== 422) throw e;
				throw conflict(`invoice ${doc.number} can't be issued as it is (edit the draft): ${e.message}`);
			}
			if (s.post_to_ledger) {
				// The customer's own account under accounts receivable (Ledger ≥ 0.31.0), else receivables.
				const to = await receivable.forNew(doc, s);
				const entry = await ctx.ledger.createJournalEntry(
					{
						entry_date: doc.issue_date,
						description: `Invoice ${doc.number} – ${doc.customer.name}`.slice(0, 500),
						reference: doc.number.slice(0, 100),
						lines: await postingLines(doc, totals, s, to.code),
						links: [invoiceLink(doc)],
						...entityOf(doc),
					},
					user,
				);
				entryId = String(entry.id);
				// The account says whose the entry is (read back from what was posted).
				if (to.own && (entry.lines ?? []).some((l) => l.account_code === to.code)) known = [`customer:${Number(doc.customer.entity_id)}`];
			}
			await q(
				`UPDATE ${T("documents")} SET status = 'open', journal_entry_id = $2, issued_at = now(), updated_at = now(),
				        subtotal_cents = $3, tax_cents = $4, total_cents = $5, entry_tags = $6::text[]
				  WHERE id = $1`,
				[did, entryId, totals.subtotal.toString(), totals.tax.toString(), totals.total.toString(), known],
			);
		} catch (e) {
			if (entryId === null) await q(`UPDATE ${T("documents")} SET status = 'draft' WHERE id = $1 AND status = 'posting'`, [did]);
			throw e;
		}
		ctx.log.info("invoice issued", { document: did, entry: entryId, user: user.username });
		// Ledger's shared tags: billed on its entry (and the customer, unless the account already
		// says whose it is), billed on the costs it bills.
		await tags.sync(did, user);
		const issued = await getDocument(did);
		await filePdf(issued, renderDocumentPdf(issued, s), user);
		return getDocument(did);
	}

	/** Deletes a payment row and takes it off the invoice; returns the deleted payment or null. */
	async function removePayment(did, pid) {
		const { rows } = await q(
			`WITH p AS (DELETE FROM ${T("payments")} WHERE id = $2 AND document_id = $1 RETURNING amount_cents, journal_entry_id),
			      doc AS (UPDATE ${T("documents")} d
			                 SET paid_cents = d.paid_cents - p.amount_cents, updated_at = now(),
			                     status = CASE WHEN d.status = 'paid' THEN 'open' ELSE d.status END
			                FROM p WHERE d.id = $1)
			 SELECT * FROM p`,
			[did, pid],
		);
		return rows[0] ?? null;
	}

	/**
	 * Records a payment on an open invoice and raises what's paid on it.
	 * `posting` says what goes into the books:
	 *   "bank" (default): Dr bank / Cr receivable (the account the invoice's
	 *     receivable line sits in: the customer's own on Ledger ≥ 0.31.0), when
	 *     ledger posting is on and the invoice was posted;
	 *   { lines, plain? }: these journal lines instead (e.g. moving a matched bank
	 *     deposit out of a clearing account into receivable); `plain`: posted
	 *     without the customer as the entry's entity (the lines say whose it is);
	 *   "none": nothing (the money is already in the books).
	 * `matched` links the payment to a bank deposit already in the books.
	 * Returns the payment id; on failure nothing is left behind.
	 */
	async function recordPayment(did, { date, amount, method = "", reference = "", posting = "bank", matched = null }, user) {
		// A matched deposit pays at most its own amount (`matched.cents`), over all the payments that use it.
		const depositLimit = matched ? BigInt(matched.cents).toString() : null;
		const depositUsedUp = () => conflict("that deposit was applied elsewhere meanwhile and has less left; reload and try again");
		if (amount <= 0n) throw bad("amount must be more than zero");
		const s = await loadSettings();
		const before = await getDocument(did, "invoice");
		if (before.status !== "open") throw conflict(`payments can only be recorded on issued, unpaid invoices (${before.number} is ${before.status})`);
		if (amount > before.balance_cents) throw bad(`amount is more than the balance due on ${before.number} (${formatMoney(before.balance_cents, before.currency)})`);
		let lines = null;
		const memo = `Payment on invoice ${before.number}`;
		if (posting === "bank" && s.post_to_ledger && before.journal_entry_id !== null) {
			const accounts = s.accounts?.[before.currency] ?? {};
			const to = await receivable.ofInvoice(before, s);
			if (!to || !accounts.bank) throw bad(`Ledger posting is on, but the ${before.currency} receivable and bank accounts aren't both set (Settings → Sales)`);
			lines = [
				{ account_code: accounts.bank, debit_cents: amount, memo },
				{ account_code: to, credit_cents: amount, memo },
			];
		} else if (posting && typeof posting === "object") {
			lines = posting.lines.map((l) => ({ ...l, memo: l.memo ?? memo }));
		}

		// Record the payment and raise paid_cents in one statement, only if it still fits the balance
		// and, for a matched deposit, what the payments already matched to that deposit leave of it.
		const { rows } = await q(
			`WITH doc AS (
				UPDATE ${T("documents")}
				   SET paid_cents = paid_cents + $2::bigint, updated_at = now(),
				       status = CASE WHEN paid_cents + $2::bigint >= total_cents THEN 'paid' ELSE status END,
				       paid_by_tag = CASE WHEN paid_cents + $2::bigint >= total_cents THEN false ELSE paid_by_tag END
				 WHERE id = $1 AND kind = 'invoice' AND status = 'open' AND paid_cents + $2::bigint <= total_cents
				   AND ($8::bigint IS NULL OR $2::bigint + (SELECT coalesce(sum(m.amount_cents), 0) FROM ${T("payments")} m WHERE m.matched_line_id = $8::bigint) <= $9::bigint)
				RETURNING id
			)
			INSERT INTO ${T("payments")} (document_id, payment_date, amount_cents, method, reference, created_by, matched_entry_id, matched_line_id)
			SELECT id, $3::date, $2::bigint, $4::text, $5::text, $6::text, $7::bigint, $8::bigint FROM doc RETURNING id`,
			[did, amount.toString(), date, method, reference, user.username, matched ? String(matched.entry_id) : null, matched ? String(matched.line_id) : null, depositLimit],
		);
		if (!rows[0]) {
			if (matched) {
				const used = await q(`SELECT coalesce(sum(amount_cents), 0)::bigint AS cents FROM ${T("payments")} WHERE matched_line_id = $1`, [String(matched.line_id)]);
				if (amount + BigInt(used.rows[0]?.cents ?? 0) > BigInt(matched.cents)) throw depositUsedUp();
			}
			throw conflict(`${before.number} changed meanwhile; reload and try again`);
		}
		const pid = rows[0].id;
		if (matched) {
			// Two payments recorded at the very same moment don't see each other in the statement
			// above (each reads what was committed when it began). Now that this one is committed,
			// look again: whichever of them looks last sees both and steps back, before anything is posted.
			const used = await q(`SELECT coalesce(sum(amount_cents), 0)::bigint AS cents FROM ${T("payments")} WHERE matched_line_id = $1`, [String(matched.line_id)]);
			if (BigInt(used.rows[0]?.cents ?? 0) > BigInt(matched.cents)) {
				await removePayment(did, pid);
				throw depositUsedUp();
			}
		}
		if (lines) {
			try {
				const entry = await ctx.ledger.createJournalEntry(
					{ entry_date: date, description: `${memo} – ${before.customer.name}`.slice(0, 500), reference: (reference || before.number).slice(0, 100), lines, links: [invoiceLink(before, "Payment on invoice")], ...(posting?.plain === true ? {} : entityOf(before)) },
					user,
				);
				await q(`UPDATE ${T("payments")} SET journal_entry_id = $2 WHERE id = $1`, [pid, String(entry.id)]);
			} catch (e) {
				await removePayment(did, pid);
				throw e;
			}
		}
		// A deposit already in the books that this payment uses: link it to the invoice too.
		if (!lines && matched) await linkEntry(matched.entry_id, invoiceLink(before, "Payment on invoice"), user);
		// Paid in full: the invoice's entry is tagged "paid" (which takes "overdue" off).
		await tags.sync(did, user);
		return pid;
	}

	/**
	 * Removes a payment: reverses the entry this module posted for it, if any,
	 * and takes it off the invoice. A matched bank deposit stays in the books.
	 */
	async function deletePayment(did, pid, user) {
		const doc = await getDocument(did, "invoice");
		const p = doc.payments.find((x) => String(x.id) === String(pid));
		if (!p) throw notFound("payment");
		// Reverse first: if that fails, nothing has changed. A second concurrent
		// attempt fails here too, since Ledger reverses an entry only once.
		if (p.journal_entry_id !== null && (await stillInBooks(p.journal_entry_id, `payment on invoice ${doc.number}`))) {
			const rev = await ctx.ledger.reverseJournalEntry(p.journal_entry_id, { entry_date: today(), description: `Removed payment on invoice ${doc.number}` }, user);
			await linkEntry(rev.id, invoiceLink(doc, "Removed payment on invoice"), user);
		}
		await removePayment(did, String(pid));
		// A matched deposit that no longer pays this invoice loses its link to it.
		if (p.journal_entry_id === null && p.matched_entry_id != null && !doc.payments.some((x) => x.id !== p.id && String(x.matched_entry_id) === String(p.matched_entry_id))) {
			await ctx.ledger.unlinkJournalEntry(p.matched_entry_id, `invoice:${doc.id}`).catch((e) => ctx.log.warn("could not unlink journal entry", { error: e.message }));
		}
		// Open again: "paid" comes off the invoice's entry.
		await tags.sync(did, user);
	}

	// ---- PDF and email ----------------------------------------------------------------------

	const pdfName = (doc) => `${KINDS[doc.kind].label}-${doc.number.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;

	function fill(template, doc, s) {
		const label = KINDS[doc.kind].label;
		const vars = {
			type: label,
			type_lower: label.toLowerCase(),
			number: doc.number,
			customer: doc.customer.name,
			company: doc.customer.company || doc.customer.name,
			total: formatMoney(doc.total_cents, doc.currency),
			balance: formatMoney(doc.balance_cents, doc.currency),
			due_date: doc.due_date,
			valid_until: doc.due_date,
			issue_date: doc.issue_date,
			business: s.business_name || s.from_name || "",
		};
		return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (Object.hasOwn(vars, k) ? vars[k] : m));
	}

	function emailDefaults(doc, s) {
		const inv = doc.kind === "invoice";
		return {
			to: doc.customer.email,
			cc: doc.customer.cc_emails,
			subject: fill(inv ? s.email_subject : s[`${doc.kind}_email_subject`], doc, s),
			message: fill(inv ? s.email_body : s[`${doc.kind}_email_body`], doc, s),
		};
	}

	const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

	function summaryRows(doc) {
		const label = KINDS[doc.kind].label;
		return doc.kind === "invoice"
			? [[label, doc.number], ["Issued", doc.issue_date], ["Due", doc.due_date], ["Amount due", formatMoney(doc.balance_cents, doc.currency)]]
			: [[label, doc.number], ["Date", doc.issue_date], ["Valid until", doc.due_date], ["Total", formatMoney(doc.total_cents, doc.currency)]];
	}

	function emailHtml(message, doc) {
		const paras = message
			.split(/\n{2,}/)
			.map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, "<br>")}</p>`)
			.join("");
		const rows = summaryRows(doc);
		const row = ([k, v], i) =>
			`<tr><td style="padding:4px 16px 4px 0;color:#5d6875">${esc(k)}</td><td style="padding:4px 0;text-align:right${i === rows.length - 1 ? ";font-weight:600" : ""}">${esc(v)}</td></tr>`;
		return `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #dde1e6;border-radius:8px;padding:24px;font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1d232b">
${paras}
<table style="border-collapse:collapse;margin-top:8px;font-size:14px">${rows.map(row).join("")}</table>
<p style="margin:16px 0 0;color:#5d6875;font-size:13px">The ${esc(KINDS[doc.kind].label.toLowerCase())} is attached as a PDF.</p>
</div></body></html>`;
	}

	// ---- routes, per kind ----------------------------------------------------------------------

	for (const [kind, K] of Object.entries(KINDS)) {
		const base = `/${K.plural}`;
		const docId = (req) => id(req, "id", kind);
		const isInvoice = kind === "invoice";
		const editable = (doc) => (isInvoice ? doc.status === "draft" : OPEN_QUOTE.includes(doc.status));

		ctx.route("GET", base, async (req) => {
			const status = req.query.get("status") ?? "";
			const search = (req.query.get("q") ?? "").trim();
			const customer = req.query.get("customer_id") ?? "";
			if (customer && !/^\d{1,18}$/.test(customer)) throw bad("customer_id is not valid");
			const project = req.query.get("project_id") ?? "";
			if (project && !/^\d{1,18}$/.test(project)) throw bad("project_id is not valid");
			const where = Object.hasOwn(LIST_FILTERS[kind], status) ? LIST_FILTERS[kind][status] : null;
			if (!where) throw bad(`status must be one of: ${Object.keys(LIST_FILTERS[kind]).filter(Boolean).join(", ")}`);
			// A page at a time (?limit=, at most 500, and ?offset=); `total` and `has_more` say what is left.
			const limit = req.query.get("limit") ? h.intIn(req.query.get("limit"), "limit", 1, MAX_PAGE) : MAX_PAGE;
			const offset = req.query.get("offset") ? h.intIn(req.query.get("offset"), "offset", 0, 1_000_000_000) : 0;
			const from = `
				   FROM ${T("documents")} d JOIN ${CUSTOMERS} c ON c.id = d.customer_id
				  WHERE d.kind = $5 AND ${where}
				    AND ($1 = '' OR d.number ILIKE $2 OR c.name ILIKE $2 OR c.company ILIKE $2 OR d.po_number ILIKE $2)
				    AND ($3 = '' OR d.customer_id = nullif($3, '')::bigint)
				    AND ($6 = '' OR d.project_id = nullif($6, '')::bigint)
				    AND $4::date IS NOT NULL`;
			const params = [search, like(search), customer, today(), kind, project];
			const [{ rows }, count] = await Promise.all([
				q(
					`SELECT d.id, d.kind, d.number, d.status, d.issue_date::text, d.due_date::text, d.currency, d.total_cents, d.paid_cents,
					        d.sent_at, d.customer_id, d.status = 'open' AND d.paid_by_tag AS paid_by_tag, c.name AS customer_name, c.company AS customer_company${from}
					  ORDER BY d.issue_date DESC, d.id DESC
					  LIMIT $7::int OFFSET $8::int`,
					[...params, limit, offset],
				),
				q(`SELECT count(*)::int AS total${from}`, params),
			]);
			const total = Math.max(count.rows[0]?.total ?? 0, offset + rows.length);
			const t = today();
			return {
				data: rows.map((d) => ({
					...d,
					overdue: isInvoice && d.status === "open" && !d.paid_by_tag && d.due_date < t,
					expired: !isInvoice && OPEN_QUOTE.includes(d.status) && d.due_date < t,
				})),
				total,
				limit,
				offset,
				has_more: offset + rows.length < total,
			};
		});

		ctx.route("POST", base, async (req) => {
			const s = await loadSettings();
			const { cols, linesJson } = await documentInput(kind, body(req), s, null);
			return ctx.response(201, await getDocument(await insertDocument(kind, cols, linesJson, req.user)));
		});

		ctx.route("GET", `${base}/:id`, async (req) => getDocument(docId(req), kind));

		ctx.route("PUT", `${base}/:id`, async (req) => {
			const existing = await getDocument(docId(req), kind);
			const why = isInvoice ? "only draft invoices can be edited" : `only draft or sent ${K.plural} can be edited`;
			if (!editable(existing)) throw conflict(why);
			const s = await loadSettings();
			const { cols, linesJson } = await documentInput(kind, body(req), s, existing);
			const names = Object.keys(cols);
			// One statement, so the document and its lines change together, and only while it's still editable.
			const { rows } = await q(
				`WITH upd AS (
					UPDATE ${T("documents")} SET ${names.map((k, i) => `${k} = $${i + 2}::${COLUMN_TYPES[k]}`).join(", ")}, updated_at = now()
					 WHERE id = $1 AND status = ANY($${names.length + 3}::text[]) RETURNING id
				), del AS (
					DELETE FROM ${T("document_lines")} WHERE document_id IN (SELECT id FROM upd)
				), ins AS (${LINES_FROM_JSON("upd", `$${names.length + 2}`)})
				SELECT id FROM upd`,
				[existing.id, ...Object.values(cols), linesJson, isInvoice ? ["draft"] : OPEN_QUOTE],
			);
			if (!rows[0]) throw conflict(why);
			return getDocument(existing.id);
		});

		ctx.route("DELETE", `${base}/:id`, async (req) => {
			const did = docId(req);
			const allowed = isInvoice ? ["draft"] : ["draft", "sent", "accepted", "declined"];
			// A draft invoice made from a quote or estimate: that one is accepted again, free to convert anew.
			const { rows: gone } = await q(
				`WITH del AS (DELETE FROM ${T("documents")} WHERE id = $1 AND kind = $2 AND status = ANY($3::text[]) RETURNING id),
				      rel AS (UPDATE ${T("documents")} SET converted_id = NULL, status = 'accepted', updated_at = now()
				               WHERE converted_id IN (SELECT id FROM del) AND status = 'converted')
				 SELECT id FROM del`,
				[did, kind, allowed],
			);
			const rowCount = gone.length;
			if (rowCount === 0) {
				await getDocument(did, kind); // 404 when missing
				throw conflict(isInvoice ? "only drafts can be deleted; void an issued invoice instead" : `this ${kind} was converted to an invoice and can't be deleted`);
			}
		});

		ctx.route("POST", `${base}/:id/duplicate`, async (req) => {
			const src = await getDocument(docId(req), kind);
			const s = await loadSettings();
			const taxes = await loadTaxes();
			const { cols, linesJson } = await documentInput(
				kind,
				{
					customer_id: src.customer_id,
					issue_date: today(),
					currency: src.currency,
					notes: src.notes,
					project_id: src.project?.status === "active" ? String(src.project.id) : null,
					lines: src.lines.map((l) => ({
						category_id: l.category_id,
						description: l.description,
						quantity: formatDecimal(l.quantity, 3),
						unit_price: formatDecimal(l.unit_price_cents, 2),
						tax_ids: l.tax_ids.filter((t) => taxes.has(String(t))),
					})),
				},
				s,
				null,
			);
			return ctx.response(201, await getDocument(await insertDocument(kind, cols, linesJson, req.user)));
		});

		ctx.route("GET", `${base}/:id/pdf`, async (req) => {
			const doc = await getDocument(docId(req), kind);
			const pdf = renderDocumentPdf(doc, await loadSettings());
			return { filename: pdfName(doc), content_type: "application/pdf", content_base64: pdf.toString("base64") };
		});

		ctx.route("GET", `${base}/:id/email`, async (req) => emailDefaults(await getDocument(docId(req), kind), await loadSettings()));

		ctx.route("POST", `${base}/:id/send`, async (req) => {
			const did = docId(req);
			const o = body(req);
			const s = await loadSettings();
			let doc = await getDocument(did, kind);
			if (["void", "declined", "converted"].includes(doc.status)) throw conflict(`this ${kind} is ${doc.status}`);
			const d = emailDefaults(doc, s);
			const to = mail.addresses(o.to ?? d.to, "to", true);
			const cc = mail.addresses(o.cc ?? d.cc, "cc", false);
			const subject = o.subject === undefined ? d.subject : text(o, "subject", 300, { required: true });
			const message = o.message === undefined ? d.message : text(o, "message", 10000, { multiline: true });
			const st = await mail.status(s);
			if (!st.ready) throw conflict(st.problem);
			if (isInvoice && doc.status === "draft") doc = await issueInvoice(did, req.user);

			const recipients = [...to, ...cc].join(", ");
			const pdf = renderDocumentPdf(doc, s);
			try {
				await mail.deliver(s, {
					to,
					cc,
					bcc: [],
					subject,
					text: message + "\n\n" + summaryRows(doc).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n",
					html: emailHtml(message, doc),
					attachments: [{ filename: pdfName(doc), contentType: "application/pdf", content: pdf }],
				});
			} catch (e) {
				const msg = e instanceof ctx.HttpError ? e.message : `sending failed: ${e.message}`;
				await q(`INSERT INTO ${T("email_log")} (document_id, recipients, subject, ok, error, sent_by) VALUES ($1, $2, $3, false, $4, $5)`, [did, recipients, subject, msg.slice(0, 1000), req.user.username]);
				ctx.log.warn("email failed", { document: did, err: e.message });
				throw e instanceof ctx.HttpError ? e : new ctx.HttpError(502, msg);
			}
			await q(`INSERT INTO ${T("email_log")} (document_id, recipients, subject, ok, sent_by) VALUES ($1, $2, $3, true, $4)`, [did, recipients, subject, req.user.username]);
			await q(`UPDATE ${T("documents")} SET sent_at = now(), status = CASE WHEN kind <> 'invoice' AND status = 'draft' THEN 'sent' ELSE status END WHERE id = $1`, [did]);
			ctx.log.info("document emailed", { document: did, kind, to: recipients, user: req.user.username });
			// What was sent is what's on file.
			await filePdf(await getDocument(did), pdf, req.user);
			return getDocument(did);
		});

		if (isInvoice) invoiceRoutes(base, docId);
		else quoteRoutes(kind, base, docId);
	}

	// ---- billable items ----------------------------------------------------------------------

	// A customer's unbilled items: ?currency=CAD, and &invoice=<id> when editing that draft.
	ctx.route("GET", "/customers/:id/billable", async (req) => {
		const cid = id(req, "id", "customer");
		const cur = currency(req.query.get("currency") || "CAD");
		const inv = req.query.get("invoice");
		if (inv && !isId(inv)) throw bad("invoice must be an invoice id");
		return billable.forCustomer(cid, cur, { exceptDoc: inv || null });
	});

	// ---- invoice-only routes ------------------------------------------------------------------

	function invoiceRoutes(base, docId) {
		ctx.route("POST", `${base}/:id/issue`, async (req) => issueInvoice(docId(req), req.user));

		ctx.route("POST", `${base}/:id/void`, async (req) => {
			const did = docId(req);
			const o = body(req);
			const date = o.date === undefined || o.date === "" ? today() : dateField(o.date, "date");
			const { rows } = await q(
				`UPDATE ${T("documents")} SET status = 'void', updated_at = now()
				  WHERE id = $1 AND kind = 'invoice' AND status = 'open' AND paid_cents = 0 RETURNING number, journal_entry_id`,
				[did],
			);
			if (!rows[0]) {
				const doc = await getDocument(did, "invoice");
				if (doc.status === "draft") throw conflict("drafts aren't in the books; delete it instead");
				if (doc.status === "void") throw conflict("this invoice is already void");
				throw conflict("remove this invoice's payments before voiding it");
			}
			const { number, journal_entry_id } = rows[0];
			let voidEntry = null;
			if (journal_entry_id !== null) {
				try {
					// Its entry may have been reversed in Ledger's journal already (or deleted in root
					// mode): then the books need nothing more, and the invoice is simply void.
					if (await stillInBooks(journal_entry_id, `invoice ${number}`)) {
						const rev = await ctx.ledger.reverseJournalEntry(journal_entry_id, { entry_date: date, description: `Void invoice ${number}` }, req.user);
						await q(`UPDATE ${T("documents")} SET void_entry_id = $2 WHERE id = $1`, [did, String(rev.id)]);
						voidEntry = rev.id;
					}
				} catch (e) {
					await q(`UPDATE ${T("documents")} SET status = 'open' WHERE id = $1 AND status = 'void'`, [did]);
					throw e;
				}
			}
			// Void: nothing is owed on it, whatever its entry was tagged; billed, paid and
			// overdue come off the entry, and billed off the costs it billed.
			await q(`UPDATE ${T("documents")} SET paid_by_tag = false WHERE id = $1 AND status = 'void'`, [did]);
			await tags.sync(did, req.user);
			const doc = await getDocument(did);
			if (voidEntry !== null) await linkEntry(voidEntry, invoiceLink(doc, "Void invoice"), req.user);
			return doc;
		});

		ctx.route("POST", `${base}/:id/payments`, async (req) => {
			const o = body(req);
			const date = o.payment_date === undefined || o.payment_date === "" ? today() : dateField(o.payment_date, "payment_date");
			const amount = decimal(o.amount, 2, "amount");
			const did = docId(req);
			await recordPayment(did, { date, amount, method: text(o, "method", 50), reference: text(o, "reference", 100) }, req.user);
			return ctx.response(201, await getDocument(did));
		});

		ctx.route("DELETE", `${base}/:id/payments/:pid`, async (req) => {
			const did = docId(req);
			await deletePayment(did, id(req, "pid", "payment"), req.user);
			return getDocument(did);
		});
	}

	// ---- quote and estimate routes ---------------------------------------------------------------

	function quoteRoutes(kind, base, docId) {
		/** Moves a quote/estimate from one of `from` to `to`; explains a refusal. */
		async function transition(req, from, to, extra = "") {
			const did = docId(req);
			const { rowCount } = await q(
				`UPDATE ${T("documents")} SET status = $3, updated_at = now() ${extra} WHERE id = $1 AND kind = $2 AND status = ANY($4::text[])`,
				[did, kind, to, from],
			);
			if (rowCount === 0) {
				const doc = await getDocument(did, kind);
				throw conflict(`this ${kind} is ${doc.status}`);
			}
			return getDocument(did);
		}

		ctx.route("POST", `${base}/:id/mark-sent`, (req) => transition(req, ["draft"], "sent", ", sent_at = coalesce(sent_at, now())"));
		ctx.route("POST", `${base}/:id/accept`, (req) => transition(req, OPEN_QUOTE, "accepted", ", decided_at = now()"));
		ctx.route("POST", `${base}/:id/decline`, (req) => transition(req, OPEN_QUOTE, "declined", ", decided_at = now()"));
		ctx.route("POST", `${base}/:id/reopen`, (req) => transition(req, ["accepted", "declined"], "sent", ", decided_at = NULL"));

		// Turns the quote/estimate into a draft invoice with the same lines.
		ctx.route("POST", `${base}/:id/convert`, async (req) => {
			const did = docId(req);
			const src = await getDocument(did, kind);
			if (!["draft", "sent", "accepted"].includes(src.status)) throw conflict(src.status === "converted" ? `already converted to invoice ${src.converted?.number}` : `this ${kind} is ${src.status}`);
			const claimed = await q(
				`UPDATE ${T("documents")} SET status = 'converted', decided_at = coalesce(decided_at, now()), updated_at = now()
				  WHERE id = $1 AND status = ANY($2::text[]) RETURNING id`,
				[did, ["draft", "sent", "accepted"]],
			);
			if (claimed.rowCount === 0) throw conflict("it changed meanwhile; reload and try again");
			try {
				const s = await loadSettings();
				const { rows } = await q(`SELECT terms_days FROM ${CUSTOMERS} x WHERE id = $1`, [src.customer_id]);
				const issue = today();
				const cols = {
					customer_id: String(src.customer_id),
					issue_date: issue,
					due_date: addDays(issue, rows[0].terms_days ?? s.default_terms_days),
					currency: src.currency,
					po_number: src.po_number,
					notes: src.notes,
					subtotal_cents: String(src.subtotal_cents),
					tax_cents: String(src.tax_cents),
					total_cents: String(src.total_cents),
					source_id: String(src.id),
					project_id: src.project_id === null || src.project_id === undefined ? null : String(src.project_id),
				};
				// The invoice keeps the quoted lines, categories and tax rates as they were.
				const linesJson = JSON.stringify(
					src.lines.map((l) => ({
						position: l.position,
						category_id: l.category_id === null ? null : String(l.category_id),
						description: l.description,
						quantity: String(l.quantity),
						unit_price_cents: String(l.unit_price_cents),
						taxes: l.taxes,
						amount_cents: String(l.amount_cents),
					})),
				);
				const invId = await insertDocument("invoice", cols, linesJson, req.user);
				await q(`UPDATE ${T("documents")} SET converted_id = $2 WHERE id = $1`, [did, invId]);
				ctx.log.info("converted to invoice", { document: did, invoice: String(invId), user: req.user.username });
				return ctx.response(201, await getDocument(invId));
			} catch (e) {
				await q(`UPDATE ${T("documents")} SET status = $2 WHERE id = $1 AND status = 'converted' AND converted_id IS NULL`, [did, src.status]);
				throw e;
			}
		});
	}

	return {
		recordPayment,
		deletePayment,
		getDocument,
		/** The account an issued invoice's receivable line sits in (where a payment on it is credited). */
		receivableOf: async (did) => receivable.ofInvoice(await getDocument(did, "invoice"), await loadSettings()),
		makeClearingAccounts,
		/**
		 * An invoice left in "posting" means Ledger stopped mid-issue. Issuing
		 * posts the entry first and marks the invoice open after, so the entry
		 * may already be in the books, linked to the invoice: then the invoice
		 * is open with that entry (a draft would post it a second time when
		 * issued again). With nothing posted it is a draft again.
		 */
		async recover(org = null) {
			const where = org ? { organization: org.name } : {};
			const stuck = await q(`SELECT id, number FROM ${T("documents")} WHERE kind = 'invoice' AND status = 'posting' ORDER BY id`);
			for (const r of stuck.rows) {
				let entry = null;
				try {
					// The invoice's own entry carries the link "Invoice <number> · <customer>"; payments and
					// reversals are linked to the same invoice under other labels.
					const linked = await ctx.ledger.linkedEntries(`invoice:${r.id}`);
					const posted = linked.filter((l) => !l.reversed && String(l.label ?? "").startsWith("Invoice ")).map((l) => BigInt(l.entry_id));
					if (posted.length) entry = posted.reduce((a, b) => (a > b ? a : b)).toString();
				} catch (e) {
					// Not knowing whether it was posted, a draft could post it twice: it waits for the next start.
					ctx.log.warn("could not check the books for an invoice that was being issued when Ledger stopped; it stays as it is until Ledger starts again", { number: r.number, err: e.message, ...where });
					continue;
				}
				if (entry === null) {
					await q(`UPDATE ${T("documents")} SET status = 'draft' WHERE id = $1 AND status = 'posting'`, [String(r.id)]);
					ctx.log.warn("invoice was being issued when Ledger stopped, before anything was posted; it is a draft again", { number: r.number, ...where });
					continue;
				}
				await q(
					`UPDATE ${T("documents")} SET status = 'open', journal_entry_id = $2::bigint, issued_at = coalesce(issued_at, now()), updated_at = now() WHERE id = $1 AND status = 'posting'`,
					[String(r.id), entry],
				);
				ctx.log.warn("invoice was being issued when Ledger stopped, after its entry was posted; it is open now, with that entry", { number: r.number, entry, ...where });
				// What issuing does next: the tags, and the PDF on file. Neither may stop the startup.
				try {
					await tags.sync(String(r.id));
					const issued = await getDocument(String(r.id));
					await filePdf(issued, renderDocumentPdf(issued, await loadSettings()));
				} catch (e) {
					ctx.log.warn("could not finish issuing a recovered invoice", { number: r.number, err: e.message, ...where });
				}
			}
		},
	};
}
