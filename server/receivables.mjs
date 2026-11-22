// Where what a customer owes sits in the books.
//
// Ledger 0.31.0 gives every customer an account of their own under accounts
// receivable (one per currency, made the first time it is asked for), and
// what the customer owes is that account's balance. Sales posts there:
//
//   an invoice    Dr the customer's own account (ctx.entities.account);
//   a payment     Cr the account the invoice's receivable line sits in, read
//                 from the invoice's entry: the customer's own account, also
//                 for an invoice issued before, whose line Ledger moved there
//                 when it was updated;
//   a void        reverses the invoice's entry, in the same account.
//
// The account then says whose the entry is, so such an entry needs no
// "customer" tag (Ledger reads the tag from the account).
//
// A receivables account chosen under Settings → Sales → Accounts that Ledger
// has NOT tagged "Accounts receivable" is kept as chosen: invoices and
// payments post to it, all customers together, and their entries are tagged
// with the customer as before (customers' own accounts sit under the tagged
// account, and posting there would ignore the choice). On a Ledger before
// 0.31.0 (no ctx.entities.account) everything posts to the receivables
// account and is tagged, as before.

/** Whether an account (as Ledger returns it) holds receivables: the tagged account, or a customer's own. */
export const isReceivable = (a) => a?.kind === "receivable" || a?.entity?.role === "customer";

export function receivables(ctx, h) {
	/** Ledger keeps an account per customer (0.31.0). */
	const own = () => typeof ctx.entities?.account === "function";

	/**
	 * The account a new invoice of this document's customer is posted to:
	 * { code, own }. `own`: it is the customer's own account, which says whose
	 * the entry is. With no receivables account chosen and none tagged, Ledger
	 * makes "Accounts receivable" along with the customer's account; `code` is
	 * "" only when there is neither an account nor a customer in Ledger's list.
	 */
	async function forNew(doc, s) {
		const a = s.accounts?.[doc.currency] ?? {};
		const entity = doc.customer?.entity_id;
		// A chosen account that Ledger hasn't tagged is kept as chosen.
		if (!own() || entity === null || entity === undefined || (a.receivable && !a.receivable_tagged)) return { code: a.receivable ?? "", own: false };
		try {
			const account = await ctx.entities.account(Number(entity), "customer", doc.currency);
			return { code: account.code, own: true };
		} catch (e) {
			// E.g. the entity is no longer a customer in Ledger's list: receivables, as before.
			ctx.log.warn("could not get the customer's own account; posting to accounts receivable", { customer: doc.customer?.name, currency: doc.currency, err: e.message });
			return { code: a.receivable ?? "", own: false };
		}
	}

	/**
	 * The account an issued invoice's receivable line sits in, which is where
	 * a payment on it is credited: read from its entry, since Ledger (or a
	 * person) may have moved the line since Sales posted it, and the account
	 * in the settings may have changed. The line is the debit Sales posted
	 * with the memo "Invoice <number>"; it counts while it sits in a
	 * receivable account or another asset account that is in use (receivables
	 * of the user's own). Falls back to what a new invoice would be posted to.
	 */
	async function ofInvoice(doc, s) {
		const { code } = await forNew(doc, s);
		if (doc.journal_entry_id === null || doc.journal_entry_id === undefined) return code;
		const entry = await ctx.ledger.getJournalEntry(doc.journal_entry_id).catch(() => null);
		const debits = (entry?.lines ?? []).filter((l) => (l.currency ?? doc.currency) === doc.currency && BigInt(l.debit_cents ?? 0) > 0n);
		if (debits.length === 0 || debits.some((l) => l.account_code === code)) return code;
		const account = (c) => ctx.ledger.getAccount(c).catch(() => null);
		const posted = debits.find((l) => l.memo === `Invoice ${doc.number}`);
		if (posted) {
			const a = await account(posted.account_code);
			if (isReceivable(a) || (a && a.type === "asset" && a.is_active !== false && !a.module_id)) return posted.account_code;
		}
		for (const c of new Set(debits.map((l) => l.account_code))) if (isReceivable(await account(c))) return c;
		return code;
	}

	/**
	 * What the customer owes by Ledger's own count: the balance of each of
	 * their accounts, [{ currency, cents, account_code }]; null when Ledger
	 * keeps no such accounts or the customer isn't in its list.
	 */
	async function owed(entityId) {
		if (!own() || entityId === null || entityId === undefined || typeof ctx.entities.get !== "function") return null;
		const e = await ctx.entities.get(Number(entityId)).catch(() => null);
		if (!e || !Array.isArray(e.accounts)) return null;
		return e.accounts.filter((a) => a.role === "customer").map((a) => ({ currency: a.currency, cents: BigInt(a.owed_cents ?? 0).toString(), account_code: a.code }));
	}

	return { enabled: own, forNew, ofInvoice, owed };
}
