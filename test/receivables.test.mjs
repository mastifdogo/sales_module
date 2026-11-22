// Customers' own accounts under accounts receivable (Ledger ≥ 0.31.0,
// ctx.entities.account): invoices, payments, matched deposits and voids post
// to the customer's own account, whose balance is what the customer owes, and
// such entries carry no "customer" tag (the account says whose they are).
// On an older Ledger, and for a receivables account of the user's own that
// Ledger hasn't tagged, everything posts to the receivables account and is
// tagged, as before. Run against the stand-in books in fake.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";
import register from "../server.mjs";
import { docRow, documentRows, fakeBooks, fakeCtx, settle } from "./fake.mjs";

const ACCOUNTS = [
	{ code: "1000", name: "Bank", kind: "chequing" },
	{ code: "1200", name: "Accounts receivable", kind: "receivable" },
	{ code: "1250", name: "Trade debtors" }, // receivables of the user's own, not tagged in Ledger
	{ code: "2300", name: "Customer deposits", type: "liability" },
	{ code: "4000", name: "Sales", type: "revenue" },
];
const ACME = { id: 5, name: "Acme" };

/**
 * Sales with one draft invoice (id 1, $100.00, Acme = entity 5) on the
 * stand-in books. Sales' own tables are played by `inv` and `payments`.
 */
async function world({ own = true, settings = {}, entity = {}, doc = {} } = {}) {
	const books = fakeBooks({ own, accounts: ACCOUNTS, entities: [{ ...ACME, ...entity }] });
	const inv = { ...docRow({ status: "draft", customer: { ...docRow().customer, entity_active: entity.is_active !== false }, ...doc }), entry_tags: [] };
	const payments = [];
	let nextPayment = 7n;
	const wanted = () => ["customer:5", ...(["open", "paid"].includes(inv.status) ? ["billed"] : []), ...(inv.status === "paid" ? ["paid"] : [])];
	const rowsFor = (sql, params) => {
		if (/next_invoice_number/.test(sql) && sql.includes("SELECT")) return [{ next_invoice_number: 2, next_quote_number: 1, next_estimate_number: 1 }];
		if (sql.includes("SET status = 'posting'")) return inv.status === "draft" ? ((inv.status = "posting"), [{ id: 1n }]) : [];
		if (sql.includes("SET status = 'open', journal_entry_id = $2, issued_at")) return void Object.assign(inv, { status: "open", journal_entry_id: params[1] === null ? null : BigInt(params[1]), entry_tags: params[5] });
		if (sql.includes("SET status = 'draft' WHERE id = $1 AND status = 'posting'")) return void (inv.status = "draft");
		if (sql.includes("INSERT INTO mod_sales.payments")) {
			const amount = BigInt(params[1]);
			if (inv.status !== "open" || inv.paid_cents + amount > inv.total_cents) return [];
			inv.paid_cents += amount;
			if (inv.paid_cents >= inv.total_cents) inv.status = "paid";
			payments.push({ id: nextPayment, payment_date: params[2], amount_cents: amount, method: params[3], reference: params[4], journal_entry_id: null, matched_entry_id: params[6] === null ? null : BigInt(params[6]), matched_line_id: params[7] });
			return [{ id: nextPayment++ }];
		}
		if (sql.includes("UPDATE mod_sales.payments SET journal_entry_id = $2")) return void (payments.find((p) => p.id === params[0]).journal_entry_id = BigInt(params[1]));
		if (sql.includes("DELETE FROM mod_sales.payments WHERE id = $2 AND document_id = $1")) {
			const i = payments.findIndex((p) => String(p.id) === String(params[1]));
			if (i < 0) return [];
			const [p] = payments.splice(i, 1);
			inv.paid_cents -= p.amount_cents;
			if (inv.status === "paid") inv.status = "open";
			return [{ amount_cents: p.amount_cents, journal_entry_id: p.journal_entry_id }];
		}
		if (sql.includes("AS cents FROM mod_sales.payments WHERE matched_line_id = $1")) return [{ cents: payments.filter((p) => String(p.matched_line_id) === String(params[0])).reduce((s, p) => s + p.amount_cents, 0n) }];
		if (sql.includes("FROM mod_sales.payments WHERE journal_entry_id = $1 LIMIT 1")) return payments.filter((p) => String(p.journal_entry_id) === String(params[0]));
		if (sql.includes("SET status = 'void', updated_at = now()")) return inv.status === "open" && inv.paid_cents === 0n ? ((inv.status = "void"), [{ number: inv.number, journal_entry_id: inv.journal_entry_id }]) : [];
		if (sql.includes("SET void_entry_id = $2")) return void (inv.void_entry_id = BigInt(params[1]));
		// tags.mjs: the invoices whose entry should carry other tags than Sales knows it to.
		if (sql.includes("AS wanted")) {
			if (inv.journal_entry_id === null || !["open", "paid", "void"].includes(inv.status) || BigInt(params[2]) >= inv.id) return [];
			const w = wanted();
			return w.length === inv.entry_tags.length && w.every((k) => inv.entry_tags.includes(k)) ? [] : [{ id: inv.id, number: inv.number, journal_entry_id: inv.journal_entry_id, entry_tags: [...inv.entry_tags], wanted: w }];
		}
		if (sql.includes("SET entry_tags = $2::text[]")) return void (inv.entry_tags = params[1]);
		if (sql.includes("AS balance_cents, d.issue_date::text")) {
			return inv.status === "open" ? [{ id: inv.id, number: inv.number, currency: inv.currency, balance_cents: inv.total_cents - inv.paid_cents, issue_date: inv.issue_date, due_date: inv.due_date, po_number: "", journal_entry_id: inv.journal_entry_id, customer_id: 3n, customer: "Acme", company: "" }] : [];
		}
		if (sql.includes("AS outstanding FROM") && sql.includes("WHERE c.id = $1")) return [{ id: 3n, entity_id: 5n, name: "Acme", outstanding: [] }];
		return documentRows({ 1: () => ({ doc: { ...inv }, payments: payments.map((p) => ({ ...p })) }) })(sql, params);
	};
	const fake = fakeCtx({
		rowsFor,
		extra: { ...books.extra, settings: { get: async () => ({ post_to_ledger: true, revenue_account_cad: "4000", bank_account_cad: "1000", ...settings }), set: async () => {}, onChange() {} } },
	});
	await register(fake.ctx);
	await settle();
	const invoice = (action, body = {}) => fake.call("POST", `/invoices/:id/${action}`, { params: { id: "1" }, body });
	return {
		...fake,
		books,
		inv,
		payments,
		issue: () => invoice("issue"),
		pay: (amount) => invoice("payments", { amount, payment_date: "2026-11-10" }),
		unpay: (pid) => fake.call("DELETE", "/invoices/:id/payments/:pid", { params: { id: "1", pid: String(pid) } }),
		void: () => invoice("void", { date: "2026-11-20" }),
		/** The lines of an entry as "Dr|Cr account cents". */
		lines: (id) => books.entry(id).lines.map((l) => `${l.debit_cents > 0n ? "Dr" : "Cr"} ${l.account_code} ${l.debit_cents > 0n ? l.debit_cents : l.credit_cents}`),
		/** The "customer" tags Sales asked Ledger to set or remove. */
		customerCalls: () => books.calls.filter((c) => c[2] === "customer"),
	};
}

test("Ledger 0.31: an invoice is posted to the customer's own account, with no customer tag; payment, removal and void follow it there", async () => {
	const w = await world();
	const doc = await w.issue();
	assert.equal(doc.status, "open");
	const entry = Number(w.inv.journal_entry_id);
	assert.deepEqual(w.lines(entry), ["Dr 1200-5 10000", "Cr 4000 10000"]);
	assert.equal(w.books.entry(entry).entity.id, 5);
	assert.equal(w.books.accounts.get("1200-5").parent_code, "1200");
	assert.equal(w.books.balance("1200"), 0n, "nothing in accounts receivable itself");
	assert.equal(w.books.owed(5), 10000n);
	// The account says whose the entry is: Sales sets no customer tag, and knows the entry to say so.
	assert.deepEqual(w.customerCalls(), []);
	assert.deepEqual(w.books.stored().map((t) => t.tag), ["billed"]);
	assert.deepEqual(w.inv.entry_tags, ["customer:5", "billed"]);
	assert.deepEqual(w.books.tagsOf(entry).find((t) => t.tag === "customer"), { id: 0, tag: "customer", entity: { id: 5, name: "Acme" }, note: "", module_id: null, account_code: "1200-5" });

	await w.pay("40");
	const payment = Number(w.payments[0].journal_entry_id);
	assert.deepEqual(w.lines(payment), ["Dr 1000 4000", "Cr 1200-5 4000"]);
	assert.equal(w.books.owed(5), 6000n);

	await w.unpay(w.payments[0].id);
	assert.equal(w.books.owed(5), 10000n, "the reversal mirrors the payment, in the same account");

	await w.pay("100");
	assert.equal(w.inv.status, "paid");
	assert.equal(w.books.owed(5), 0n);
	await w.unpay(w.payments[0].id);

	const voided = await w.void();
	assert.equal(voided.status, "void");
	assert.deepEqual(w.lines(Number(w.inv.void_entry_id)), ["Cr 1200-5 10000", "Dr 4000 10000"]);
	assert.equal(w.books.owed(5), 0n);
	assert.equal(w.books.balance("1200"), 0n);
	assert.deepEqual(w.customerCalls(), [], "never a customer tag, set or removed");
});

test("an older Ledger (no ctx.entities.account): the receivables account and the customer tag, as before", async () => {
	const w = await world({ own: false });
	await w.issue();
	const entry = Number(w.inv.journal_entry_id);
	assert.deepEqual(w.lines(entry), ["Dr 1200 10000", "Cr 4000 10000"]);
	assert.deepEqual(w.customerCalls(), [["set", String(entry), "customer", { entity_id: 5 }]]);
	assert.deepEqual(w.books.stored().map((t) => t.tag).sort(), ["billed", "customer"]);
	await w.pay("40");
	assert.deepEqual(w.lines(Number(w.payments[0].journal_entry_id)), ["Dr 1000 4000", "Cr 1200 4000"]);
	assert.equal(w.books.balance("1200"), 6000n);
	assert.equal(w.books.accounts.has("1200-5"), false);
});

test("after Ledger's update moved an invoice's line to the customer's account and deleted its customer tag, Sales doesn't fight it, and payments and the void find the line", async () => {
	const w = await world({ own: false });
	await w.issue();
	const entry = Number(w.inv.journal_entry_id);
	await w.pay("25");
	const first = Number(w.payments[0].journal_entry_id);
	w.books.calls.length = 0;

	w.books.update(); // Ledger 0.31.0's migration
	assert.deepEqual(w.lines(entry), ["Dr 1200-5 10000", "Cr 4000 10000"]);
	assert.deepEqual(w.lines(first), ["Dr 1000 2500", "Cr 1200-5 2500"], "the payment was posted with the customer: its line moved too");
	assert.deepEqual(w.books.stored().map((t) => t.tag), ["billed"], "the customer tag is read from the account now");

	// The sync that follows (startup, hourly, after any change): nothing to set, nothing to remove.
	await w.call("POST", "/invoices/:id/payments", { params: { id: "1" }, body: { amount: "25", payment_date: "2026-11-12" } });
	await settle(700);
	assert.deepEqual(w.books.calls, [], "no tag is re-added or removed");
	assert.deepEqual(w.lines(Number(w.payments[1].journal_entry_id)), ["Dr 1000 2500", "Cr 1200-5 2500"]);
	assert.equal(w.books.owed(5), 5000n);

	for (const p of [...w.payments]) await w.unpay(p.id);
	assert.equal(w.books.owed(5), 10000n);
	await w.void();
	assert.equal(w.books.owed(5), 0n);
	assert.equal(w.books.balance("1200"), 0n);
	assert.deepEqual(w.customerCalls(), []);
});

test("an invoice's line still in accounts receivable on Ledger 0.31 (Sales knows of no customer on its entry): the sync's customer tag moves it to the customer's account", async () => {
	const w = await world({ own: false });
	await w.issue();
	const entry = Number(w.inv.journal_entry_id);
	// As if it had never been tagged (issued before Sales tagged entries) and Ledger's update couldn't tell whose it was.
	await w.books.extra.tags.remove(entry, "customer");
	w.books.entry(entry).entity = null;
	w.inv.entry_tags = ["billed"];
	w.books.update();
	assert.deepEqual(w.lines(entry), ["Dr 1200 10000", "Cr 4000 10000"]);
	w.books.calls.length = 0;

	await w.pay("10"); // any change syncs the invoice's tags
	assert.deepEqual(w.customerCalls(), [["set", String(entry), "customer", { entity_id: 5 }]]);
	assert.deepEqual(w.lines(entry), ["Dr 1200-5 10000", "Cr 4000 10000"]);
	assert.equal(w.books.stored().some((t) => t.tag === "customer"), false, "no tag is kept: the account says it");
	assert.equal(w.books.owed(5), 9000n);
});

test("a receivables account of your own that Ledger hasn't tagged is kept as chosen: one account for all customers, entries tagged with the customer", async () => {
	const w = await world({ settings: { receivable_account_cad: "1250" } });
	await w.issue();
	const entry = Number(w.inv.journal_entry_id);
	assert.deepEqual(w.lines(entry), ["Dr 1250 10000", "Cr 4000 10000"]);
	assert.deepEqual(w.customerCalls(), [["set", String(entry), "customer", { entity_id: 5 }]]);
	assert.equal(w.books.stored().some((t) => t.tag === "customer" && t.entity_id === 5), true, "no receivable line of Ledger's: the tag is kept");
	await w.pay("100");
	assert.deepEqual(w.lines(Number(w.payments[0].journal_entry_id)), ["Dr 1000 10000", "Cr 1250 10000"]);
	assert.equal(w.books.balance("1250"), 0n);
	assert.equal(w.books.accounts.has("1200-5"), false, "no account is made for the customer");
});

test("the receivables account changed in the settings after an invoice was issued: its payment still goes where the invoice sits", async () => {
	const settings = { receivable_account_cad: "1250" };
	const w = await world({ settings });
	await w.issue();
	delete settings.receivable_account_cad; // none chosen any more: new invoices go to customers' own accounts
	await w.pay("100");
	assert.deepEqual(w.lines(Number(w.payments[0].journal_entry_id)), ["Dr 1000 10000", "Cr 1250 10000"]);
	assert.equal(w.books.balance("1250"), 0n);
});

test("the tagged Accounts receivable chosen in the settings is the same as choosing none: the customer's own account", async () => {
	const w = await world({ settings: { receivable_account_cad: "1200" } });
	await w.issue();
	assert.deepEqual(w.lines(Number(w.inv.journal_entry_id)), ["Dr 1200-5 10000", "Cr 4000 10000"]);
	assert.deepEqual(w.customerCalls(), []);
});

test("a customer made inactive in Ledger's list: the invoice still goes to their own account, without the entity on the entry", async () => {
	const w = await world({ entity: { is_active: false } });
	await w.issue();
	const entry = w.books.entry(Number(w.inv.journal_entry_id));
	assert.equal(entry.entity, null);
	assert.deepEqual(w.lines(entry.id), ["Dr 1200-5 10000", "Cr 4000 10000"]);
	assert.equal(w.books.owed(5), 10000n);
	assert.deepEqual(w.customerCalls(), []);
});

test("a customer whose entity can't have an account of its own (no longer a customer in Ledger): accounts receivable, as before", async () => {
	const w = await world({ entity: { is_customer: false, is_vendor: true } });
	await w.issue();
	assert.deepEqual(w.lines(Number(w.inv.journal_entry_id)), ["Dr 1200 10000", "Cr 4000 10000"]);
	assert.ok(w.logs.some(([level, msg]) => level === "warn" && /could not get the customer's own account/.test(msg)));
});

// ---- matched deposits --------------------------------------------------------------------------

/** A $100.00 deposit already in the books: Dr bank / Cr `credit`, posted with `entity` or nobody. */
const deposit = (w, credit, entity = null) =>
	w.books.extra.ledger.createJournalEntry({
		entry_date: "2026-11-15",
		description: "Deposit ACME",
		lines: [{ account_code: "1000", debit_cents: 10000n }, { account_code: credit, credit_cents: 10000n }],
		...(entity === null ? {} : { entity_id: entity }),
	});
const apply = (w, dep, amount = "100") => w.call("POST", "/payments/apply", { body: { entry_id: dep.id, line_id: dep.lines[0].id, allocations: [{ invoice_id: 1, amount }] } });

test("a deposit credited to the customer's own account pays the invoice with nothing more posted", async () => {
	const w = await world();
	await w.issue();
	const dep = await deposit(w, "1200", 5); // Ledger sends the line to Acme's account
	assert.equal(dep.lines[1].account_code, "1200-5");
	const before = w.books.entries.size;
	const r = await apply(w, dep);
	assert.equal(r.body.recorded, 1);
	assert.equal(w.books.entries.size, before, "no entry posted");
	assert.equal(w.payments[0].journal_entry_id, null);
	assert.equal(w.inv.status, "paid");
	assert.equal(w.books.owed(5), 0n);
	assert.ok(w.books.links.some((l) => l.entry_id === dep.id && l.ref === "invoice:1"), "the deposit is linked to the invoice");
});

test("a deposit sitting in accounts receivable with no customer is moved to the customer's account, by an entry without the entity", async () => {
	const w = await world();
	await w.issue();
	const dep = await deposit(w, "1200");
	assert.equal(dep.lines[1].account_code, "1200");
	await apply(w, dep, "60");
	const move = w.books.entry(Number(w.payments[0].journal_entry_id));
	assert.deepEqual(w.lines(move.id), ["Dr 1200 6000", "Cr 1200-5 6000"]);
	assert.equal(move.entity, null, "with the customer on it, Ledger would send both lines to the customer's account");
	assert.equal(w.books.tagsOf(move.id).find((t) => t.tag === "customer")?.entity.id, 5, "the account says whose it is");
	assert.equal(w.books.owed(5), 4000n);
	assert.equal(w.books.balance("1200"), -4000n, "what is left of the deposit");
	// Removing the payment reverses the move.
	await w.unpay(w.payments[0].id);
	assert.equal(w.books.owed(5), 10000n);
	assert.equal(w.books.balance("1200"), -10000n);
});

test("a deposit sitting in another account is moved to the customer's own account, with the customer", async () => {
	const w = await world();
	await w.issue();
	const dep = await deposit(w, "2300");
	await apply(w, dep);
	const move = w.books.entry(Number(w.payments[0].journal_entry_id));
	assert.deepEqual(w.lines(move.id), ["Dr 2300 10000", "Cr 1200-5 10000"]);
	assert.equal(move.entity.id, 5);
	assert.equal(w.books.owed(5), 0n);
	assert.equal(w.books.balance("2300"), 0n);
});

test("an older Ledger: a deposit credited to receivables is just linked, one elsewhere is moved to receivables", async () => {
	const w = await world({ own: false });
	await w.issue();
	const inAr = await deposit(w, "1200");
	const before = w.books.entries.size;
	await apply(w, inAr, "30");
	assert.equal(w.books.entries.size, before);
	const elsewhere = await deposit(w, "2300");
	await apply(w, elsewhere, "70");
	const move = w.books.entry(Number(w.payments[1].journal_entry_id));
	assert.deepEqual(w.lines(move.id), ["Dr 2300 7000", "Cr 1200 7000"]);
	assert.equal(move.entity.id, 5);
});

// ---- the rest ----------------------------------------------------------------------------------

test("the customer page says what the customer owes by Ledger's own count; an older Ledger has no such number", async () => {
	const w = await world();
	await w.issue();
	await w.pay("40");
	const c = await w.call("GET", "/customers/:id", { params: { id: "3" } });
	assert.deepEqual(c.ledger_owed, [{ currency: "CAD", cents: "6000", account_code: "1200-5" }]);
	const old = await world({ own: false });
	assert.equal((await old.call("GET", "/customers/:id", { params: { id: "3" } })).ledger_owed, null);
});

test("customers' own accounts are never offered as an account for a sale or a tax", async () => {
	const w = await world();
	await w.issue();
	const { data } = await w.call("GET", "/accounts");
	assert.equal(data.some((a) => a.code === "1200-5"), false);
	assert.equal(data.some((a) => a.code === "1200"), true);
	const { helpers } = await import("../server/common.mjs");
	await assert.rejects(helpers(w.ctx).accountMap({ CAD: "1200-5" }, "accounts"), (e) => e.status === 422 && /Acme's own account/.test(e.message));
});

test("settings say whether the receivables account is the one Ledger tagged (customers' accounts sit under it)", async () => {
	const { helpers } = await import("../server/common.mjs");
	const load = async (settings) => helpers((await world({ settings })).ctx).loadSettings();
	const cad = async (settings) => (({ receivable, receivable_tagged }) => [receivable, receivable_tagged])((await load(settings)).accounts.CAD);
	assert.deepEqual(await cad({}), ["1200", true]);
	assert.deepEqual(await cad({ receivable_account_cad: "1200" }), ["1200", true]);
	assert.deepEqual(await cad({ receivable_account_cad: "1250" }), ["1250", false]);
	assert.equal((await load({})).accounts.USD.receivable_tagged, false, "no USD receivables at all");
	assert.equal((await load({ post_to_ledger: false })).accounts.CAD.receivable_tagged, false);
});
