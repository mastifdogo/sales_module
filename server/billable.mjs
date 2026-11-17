// Billable items: costs posted to Sales' own clearing account "Billable costs
// to recharge" (one per currency, Ledger ≥ 0.20.0), or to other accounts the
// user adds under Settings → Sales → Accounts, on entries tagged with a
// customer (the entry's entity, Ledger ≥ 0.16.0), not yet on an invoice.
// When Sales posts the invoice, the cost of items from the clearing account
// is credited back to it, so the clearing account returns to zero. A new invoice can take
// any of them, each as its own line or several combined into one line; the
// line keeps which journal lines it bills (document_lines.billed_ledger_line_ids),
// so an item can't be billed twice. Deleting a draft or voiding an invoice
// frees its items again.

const PAGE = 500;
export const CLEARING_KEY = "billable_costs";
export const CLEARING_NAME = "Billable costs to recharge";
const MAX_PAGES = 20; // up to 10,000 entries per account

export function billableItems(ctx, h) {
	const { T, q, CUSTOMERS, loadSettings } = h;

	/**
	 * Sales' clearing account for billable costs in a currency, made on first
	 * use. Asked for each time: never store its code (it can be renumbered).
	 */
	async function clearing(currency) {
		if (!ctx.ledger.clearingAccount) return null;
		return ctx.ledger.clearingAccount({
			key: CLEARING_KEY,
			name: CLEARING_NAME,
			currency,
			type: "asset",
			description: "Costs paid for customers that Sales bills on to them. Post a cost here, tagged with the customer; invoicing it in Sales clears it.",
		});
	}

	/** The extra billable accounts set in Settings (codes, renumbered by Ledger with the account). */
	async function accounts() {
		return (await loadSettings()).billable_accounts;
	}

	/** Journal line ids already on an invoice that isn't void (other than `exceptDoc`). */
	async function billedLineIds(exceptDoc = null) {
		const { rows } = await q(
			`SELECT DISTINCT unnest(l.billed_ledger_line_ids)::text AS id
			   FROM ${T("document_lines")} l JOIN ${T("documents")} d ON d.id = l.document_id
			  WHERE d.kind = 'invoice' AND d.status <> 'void' AND ($1::bigint IS NULL OR d.id <> $1::bigint)`,
			[exceptDoc === null || exceptDoc === undefined ? null : String(exceptDoc)],
		);
		return new Set(rows.map((r) => r.id));
	}

	/**
	 * A customer's unbilled items in one currency, oldest first:
	 * [{ line_id, entry_id, date, description, reference, account_code, account_name, amount_cents }],
	 * plus what's set up and any account that couldn't be read.
	 */
	async function forCustomer(customerId, currency, { exceptDoc = null } = {}) {
		const extra = await accounts();
		const own = await clearing(currency).catch((e) => {
			ctx.log.warn("could not get the billable-costs clearing account", { currency, err: e.message });
			return null;
		});
		const codes = [...new Set([...(own ? [own.code] : []), ...extra])];
		const out = { clearing: own ? { code: own.code, name: own.name } : null, accounts: codes, items: [], problems: [] };
		if (codes.length === 0) return out;
		const { rows } = await q(`SELECT id, entity_id, currency FROM ${CUSTOMERS} c WHERE id = $1`, [String(customerId)]);
		const cust = rows[0];
		if (!cust) throw new ctx.HttpError(404, "no such customer");
		if (cust.entity_id === null) {
			out.problems.push("This customer isn't in Ledger's customer list yet (Customers → Review the move), so no entries can be tagged with them.");
			return out;
		}
		const entity = String(cust.entity_id);
		const billed = await billedLineIds(exceptDoc);
		for (const code of codes) {
			let acct;
			try {
				acct = await ctx.ledger.getAccount(code);
			} catch {
				out.problems.push(`Billable items account ${code} doesn't exist in Ledger (Settings → Sales).`);
				continue;
			}
			if (acct.currency !== currency || acct.module_id === "ledger") continue; // never Ledger's own (Unreconciled)
			for (let page = 0; page < MAX_PAGES; page++) {
				const entries = await ctx.ledger.listJournalEntries({ accountCode: code, limit: PAGE, offset: page * PAGE });
				for (const e of entries) {
					// Reversed entries and the reversals themselves aren't billable.
					if (String(e.entity?.id ?? e.entity_id ?? "") !== entity || e.reverses_id != null || e.reversed_by_id != null) continue;
					for (const l of e.lines) {
						if (l.account_code !== code) continue;
						const cents = BigInt(l.debit_cents ?? 0) - BigInt(l.credit_cents ?? 0);
						if (cents <= 0n || billed.has(String(l.id))) continue;
						out.items.push({
							line_id: String(l.id),
							entry_id: String(e.id),
							date: e.entry_date,
							description: (l.memo || e.description || "").trim(),
							reference: e.reference ?? "",
							account_code: code,
							account_name: acct.name,
							amount_cents: cents.toString(),
							clearing: own !== null && code === own.code,
						});
					}
				}
				if (entries.length < PAGE) break;
			}
		}
		out.items.sort((a, b) => (a.date === b.date ? Number(a.line_id) - Number(b.line_id) : a.date < b.date ? -1 : 1));
		// Which project each cost was assigned to (0.17.0), if any.
		if (out.items.length) {
			const { rows: assigned } = await q(
				`SELECT pc.ledger_line_id::text AS line_id, p.id AS project_id, p.name AS project_name
				   FROM ${T("project_costs")} pc JOIN ${T("projects")} p ON p.id = pc.project_id
				  WHERE pc.ledger_line_id = ANY($1::bigint[])`,
				[out.items.map((i) => i.line_id)],
			);
			const byLine = new Map(assigned.map((r) => [r.line_id, r]));
			for (const it of out.items) {
				const a = byLine.get(String(it.line_id));
				it.project_id = a ? String(a.project_id) : null;
				it.project_name = a ? a.project_name : null;
			}
		}
		return out;
	}

	/**
	 * Checks the journal lines an invoice's lines want to bill: each must be
	 * a current billable item of this customer in this currency, used once.
	 * Throws 409 otherwise.
	 */
	async function check(customerId, currency, lineIdsPerLine, exceptDoc) {
		const wanted = lineIdsPerLine.flat();
		if (wanted.length === 0) return;
		if (new Set(wanted).size !== wanted.length) throw new ctx.HttpError(422, "the same billable item is on two lines");
		const { items } = await forCustomer(customerId, currency, { exceptDoc });
		const open = new Set(items.map((i) => i.line_id));
		const gone = wanted.filter((id) => !open.has(id));
		if (gone.length) throw new ctx.HttpError(409, `${gone.length} billable item${gone.length === 1 ? " is" : "s are"} no longer available for this customer (already invoiced, reversed, or not tagged with them); reload and choose again`);
	}

	return { accounts, clearing, forCustomer, check };
}
