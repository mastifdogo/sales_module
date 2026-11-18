// Fixes from the 0.19.0 review: a tag followed in the organization it was set
// in only, numbers past 9999, undoing records whose entry is already reversed
// or gone, billable costs re-checked on issue, a deposit applied at most
// once over, recovery of an invoice whose entry was posted, deposits beyond
// the newest forty, clear answers to bad input, and lists a page at a time.

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";
import register from "../server.mjs";
import { addDays } from "../lib/money.mjs";
import { docRow, documentRows, fakeCtx, lineRow, NotFoundError, settle } from "./fake.mjs";

const ran = (queries, text) => queries.filter((x) => x.sql.includes(text));

/** Sales loaded into a stand-in Ledger; the queries of the startup are forgotten. */
async function loaded(options) {
	const fake = fakeCtx(options);
	await register(fake.ctx);
	await settle();
	fake.queries.length = 0;
	fake.logs.length = 0;
	return fake;
}

// ---- tags: one organization ---------------------------------------------------------------

test("a tag set in one organization is followed in that organization's books only", async () => {
	// As Ledger does it: the request's organization travels with the async context (orgs.ts),
	// and announce() calls the listeners from inside it, after the change is saved.
	const scope = new AsyncLocalStorage();
	const orgs = [{ id: 1, name: "Main books", kind: "business" }, { id: 2, name: "Side", kind: "business" }];
	const here = () => scope.getStore() ?? orgs[0];
	const followed = []; // the organization each "follow" UPDATE ran in
	const synced = [];
	const listeners = [];
	const { ctx } = fakeCtx({
		rowsFor: (sql, params) => {
			if (!sql.includes("paid_by_tag = CASE WHEN $2::text = 'paid'")) return null;
			followed.push(here().id);
			// Journal entry #12 is an open invoice's in both organizations: ids are per organization.
			return [{ id: 1n, number: "INV-0001", status: "open", paid_by_tag: params[2], was: !params[2] }];
		},
		extra: {
			orgs: {
				forEach: async (fn) => {
					for (const o of orgs) await scope.run(o, () => fn(o));
				},
				current: async () => here(),
			},
			tags: { set: async () => [], remove: async () => [], of: async () => [], entries: async () => [], onChange: (fn) => listeners.push(fn) },
			dashboard: new Proxy({}, { get: (_, name) => async () => (synced.push([String(name), here().id]), name === "list" ? [] : true) }),
		},
	});
	await register(ctx);
	await settle();
	followed.length = 0;
	synced.length = 0;

	const announce = (org, change) => scope.run(org, () => Promise.resolve().then(() => listeners[0](change)));
	await announce(orgs[1], { entry_id: 12, action: "set", tag: "paid", entity_id: null, module_id: null });
	assert.deepEqual(followed, [2], "only the organization whose entry was tagged");
	await settle(700);
	assert.deepEqual([...new Set(synced.map(([, org]) => org))], [2], "and only its lists and reminders are refreshed");

	followed.length = 0;
	await announce(orgs[0], { entry_id: 12, action: "removed", tag: "paid", entity_id: null, module_id: null });
	assert.deepEqual(followed, [1]);
});

// ---- numbering -----------------------------------------------------------------------------

test("a document number past 9999 keeps all its digits", async () => {
	const { call, queries } = await loaded({
		rowsFor: (sql, params) => {
			if (sql.includes("terms_days, tax_ids, archived FROM")) return [{ id: 3n, currency: "CAD", terms_days: null, tax_ids: null, archived: false }];
			if (sql.includes("lpad(")) return [{ id: 5n }];
			return documentRows({ 5: { doc: docRow({ id: 5n, status: "draft", number: "INV-10000" }) } })(sql, params);
		},
	});
	const made = await call("POST", "/invoices", { body: { customer_id: 3, lines: [{ description: "Work", quantity: "1", unit_price: "100", tax_ids: [] }] } });
	assert.equal(made.status, 201);
	// lpad(text, 4, '0') cuts "10000" down to "1000": the width is at least four, and never less than the number.
	const sql = ran(queries, "lpad(")[0].sql;
	assert.match(sql, /lpad\(\(next_invoice_number - 1\)::text, greatest\(4, length\(\(next_invoice_number - 1\)::text\)\), '0'\) AS number/);
	assert.doesNotMatch(sql, /::text, 4, '0'\)/);
});

// ---- undoing a record whose entry is already reversed, or gone ---------------------------

async function voiding(getJournalEntry) {
	const reversed = [];
	const fake = await loaded({
		rowsFor: (sql, params) => {
			if (sql.includes("SET status = 'void', updated_at = now()")) return [{ number: "INV-0001", journal_entry_id: 40n }];
			return documentRows({ 1: { doc: docRow({ status: "void", journal_entry_id: 40n }) } })(sql, params);
		},
		extra: {
			ledger: {
				getJournalEntry,
				reverseJournalEntry: async (id) => (reversed.push(String(id)), { id: 41 }),
				linkJournalEntry: async () => ({}),
			},
		},
	});
	return { ...fake, reversed, run: () => fake.call("POST", "/invoices/:id/void", { params: { id: "1" } }) };
}

test("voiding an invoice whose entry a person already reversed in Ledger doesn't reverse it again", async () => {
	const v = await voiding(async () => ({ id: 40, reverses_id: null, reversed_by_id: 41, lines: [] }));
	const doc = await v.run();
	assert.equal(doc.status, "void");
	assert.deepEqual(v.reversed, []);
	assert.equal(ran(v.queries, "SET void_entry_id").length, 0);
	assert.equal(ran(v.queries, "SET status = 'open' WHERE id = $1 AND status = 'void'").length, 0, "it stays void");
});

test("voiding an invoice whose entry is gone (deleted in root mode) goes through too", async () => {
	const v = await voiding(async () => {
		throw new NotFoundError();
	});
	assert.equal((await v.run()).status, "void");
	assert.deepEqual(v.reversed, []);
});

test("voiding an invoice whose entry stands reverses it; any other failure leaves the invoice open", async () => {
	const stands = await voiding(async () => ({ id: 40, reverses_id: null, reversed_by_id: null, lines: [] }));
	await stands.run();
	assert.deepEqual(stands.reversed, ["40"]);
	assert.deepEqual(ran(stands.queries, "SET void_entry_id")[0].params, ["1", "41"]);

	const broken = await voiding(async () => {
		throw new Error("connection lost");
	});
	await assert.rejects(broken.run(), /connection lost/);
	assert.deepEqual(broken.reversed, []);
	assert.equal(ran(broken.queries, "SET status = 'open' WHERE id = $1 AND status = 'void'").length, 1);
});

test("removing a payment whose entry was already reversed in Ledger takes it off the invoice without reversing again", async () => {
	const reversed = [];
	const { call, queries } = await loaded({
		rowsFor: (sql, params) => {
			if (sql.includes("DELETE FROM mod_sales.payments WHERE id = $2 AND document_id = $1")) return [{ amount_cents: 4000n, journal_entry_id: 50n }];
			return documentRows({
				1: { doc: docRow({ paid_cents: 4000n, journal_entry_id: 40n }), payments: [{ id: 7n, payment_date: "2026-11-05", amount_cents: 4000n, method: "", reference: "", journal_entry_id: 50n, matched_entry_id: null }] },
			})(sql, params);
		},
		extra: {
			ledger: {
				getJournalEntry: async (id) => ({ id: Number(id), reverses_id: null, reversed_by_id: String(id) === "50" ? 51 : null, lines: [] }),
				reverseJournalEntry: async (id) => (reversed.push(String(id)), { id: 52 }),
				linkJournalEntry: async () => ({}),
			},
		},
	});
	await call("DELETE", "/invoices/:id/payments/:pid", { params: { id: "1", pid: "7" } });
	assert.deepEqual(reversed, []);
	assert.deepEqual(ran(queries, "DELETE FROM mod_sales.payments WHERE id = $2")[0].params, ["1", "7"]);
});

// ---- issuing re-checks the billable costs --------------------------------------------------

async function issuing({ costReversed }) {
	const posted = [];
	const fake = await loaded({
		rowsFor: (sql, params) => {
			if (sql.includes("SET status = 'posting'")) return [{ id: 1n }];
			if (sql.includes("c WHERE id = $1")) return [{ id: 3n, entity_id: 5n, currency: "CAD" }];
			return documentRows({ 1: { doc: docRow({ status: "draft" }), lines: [lineRow({ billed_ledger_line_ids: ["700"] })] } })(sql, params);
		},
		extra: {
			ledger: {
				clearingAccount: async () => ({ code: "1150", name: "Billable costs to recharge" }),
				getAccount: async () => ({ code: "1150", name: "Billable costs to recharge", currency: "CAD", module_id: "sales" }),
				// The cost the draft bills (journal line 700); reversed in Ledger since the draft was saved, or not.
				listJournalEntries: async () => [
					{ id: 70, entry_date: "2026-11-01", description: "Permit", entity: { id: 5 }, reverses_id: null, reversed_by_id: costReversed ? 71 : null, lines: [{ id: 700, account_code: "1150", debit_cents: 5000 }] },
				],
				createJournalEntry: async (e) => (posted.push(e), { id: 90 }),
			},
		},
	});
	return { ...fake, posted, run: () => fake.call("POST", "/invoices/:id/issue", { params: { id: "1" } }) };
}

test("a draft that bills a cost since reversed isn't issued: 409, and it is a draft again", async () => {
	const i = await issuing({ costReversed: true });
	await assert.rejects(i.run(), (e) => e.status === 409 && /can't be issued/.test(e.message) && /no longer available/.test(e.message));
	assert.deepEqual(i.posted, []);
	assert.equal(ran(i.queries, "SET status = 'draft' WHERE id = $1 AND status = 'posting'").length, 1);
	assert.equal(ran(i.queries, "SET status = 'open', journal_entry_id").length, 0);
});

test("a draft whose billed costs are all still there is issued", async () => {
	const i = await issuing({ costReversed: false });
	await i.run();
	assert.equal(ran(i.queries, "SET status = 'open', journal_entry_id").length, 1);
	assert.equal(ran(i.queries, "SET status = 'draft' WHERE id = $1 AND status = 'posting'").length, 0);
});

// ---- a deposit pays at most its own amount -------------------------------------------------

async function applying({ lineAccount = "1000", insert = [{ id: 9n }], used = [0n, 0n] } = {}) {
	let asked = 0;
	const fake = await loaded({
		rowsFor: (sql, params) => {
			if (sql.includes("AS cents FROM mod_sales.payments WHERE matched_line_id = $1")) return [{ cents: used[Math.min(asked++, used.length - 1)] }];
			if (sql.includes("AS balance_cents, d.issue_date::text")) return [{ id: 3n, number: "INV-0003", currency: "CAD", balance_cents: 10000n, issue_date: "2026-11-01", due_date: "2026-12-01", po_number: "", journal_entry_id: null, customer_id: 3n, customer: "Acme", company: "" }];
			if (sql.includes("INSERT INTO mod_sales.payments")) return insert;
			if (sql.includes("DELETE FROM mod_sales.payments WHERE id = $2 AND document_id = $1")) return [{ amount_cents: 10000n, journal_entry_id: null }];
			return documentRows({ 3: { doc: docRow({ id: 3n, number: "INV-0003" }) } })(sql, params);
		},
		extra: {
			settings: { get: async () => ({ bank_account_cad: "1000" }), set: async () => {}, onChange() {} },
			ledger: {
				// A $100.00 deposit: Dr the account, Cr customer deposits.
				getJournalEntry: async () => ({
					id: 6,
					entry_date: "2026-11-10",
					reference: "",
					reverses_id: null,
					reversed_by_id: null,
					lines: [{ id: 11, account_code: lineAccount, currency: "CAD", debit_cents: 10000, credit_cents: 0 }, { id: 12, account_code: "2300", currency: "CAD", debit_cents: 0, credit_cents: 10000 }],
				}),
				linkJournalEntry: async () => ({}),
			},
		},
	});
	return { ...fake, run: () => fake.call("POST", "/payments/apply", { body: { entry_id: 6, line_id: 11, allocations: [{ invoice_id: 3, amount: "100" }] } }) };
}

test("a deposit applied in full: the statement that records the payment holds it to what is left of the deposit", async () => {
	const a = await applying();
	const r = await a.run();
	assert.deepEqual(r.body, { recorded: 1, remaining_cents: 0n });
	const insert = ran(a.queries, "INSERT INTO mod_sales.payments")[0];
	assert.match(insert.sql, /\$8::bigint IS NULL OR \$2::bigint \+ \(SELECT coalesce\(sum\(m\.amount_cents\), 0\) FROM mod_sales\.payments m WHERE m\.matched_line_id = \$8::bigint\) <= \$9::bigint/);
	assert.deepEqual(insert.params.slice(6), ["6", "11", "10000"]); // the deposit's entry, its line, and its amount
});

test("two people applying one deposit at the same moment: the one that sees both steps back, 409", async () => {
	// Neither statement saw the other's payment; afterwards $200.00 is matched to the $100.00 deposit.
	const a = await applying({ used: [0n, 20000n] });
	await assert.rejects(a.run(), (e) => e.status === 409 && /applied elsewhere meanwhile/.test(e.message));
	assert.deepEqual(ran(a.queries, "DELETE FROM mod_sales.payments WHERE id = $2")[0].params, [3n, 9n], "its payment is taken off again");
});

test("a deposit already used up when the payment is recorded: 409, nothing recorded", async () => {
	const a = await applying({ insert: [], used: [0n, 10000n] });
	await assert.rejects(a.run(), (e) => e.status === 409 && /applied elsewhere meanwhile/.test(e.message));
	assert.equal(ran(a.queries, "DELETE FROM mod_sales.payments").length, 0);
});

test("only a debit on a bank account from Settings is a deposit: any other line is refused, 422", async () => {
	const a = await applying({ lineAccount: "1200" }); // e.g. an invoice's own debit to receivables
	await assert.rejects(a.run(), (e) => e.status === 422 && /bank account/.test(e.message));
	assert.equal(ran(a.queries, "INSERT INTO mod_sales.payments").length, 0);
});

// ---- startup recovery ------------------------------------------------------------------------

async function recovering(linkedEntries) {
	const fake = fakeCtx({
		rowsFor: (sql, params) => {
			if (sql.includes("WHERE kind = 'invoice' AND status = 'posting' ORDER BY id")) return [{ id: 4n, number: "INV-0004" }];
			return documentRows({ 4: { doc: docRow({ id: 4n, number: "INV-0004", journal_entry_id: 90n }) } })(sql, params);
		},
		extra: { ledger: { linkedEntries, getJournalEntry: async () => ({ id: 90, lines: [] }) } },
	});
	await register(fake.ctx);
	await settle();
	return fake;
}

test("an invoice stuck in posting whose entry was posted becomes open with that entry, not a draft", async () => {
	const asked = [];
	const { queries, logs } = await recovering(async (ref) => {
		asked.push(ref);
		return [
			{ entry_id: 95, ref, label: "Payment on invoice INV-0004 · Acme", href: "", reversed: false },
			{ entry_id: 90, ref, label: "Invoice INV-0004 · Acme", href: "", reversed: false },
			{ entry_id: 80, ref, label: "Invoice INV-0004 · Acme", href: "", reversed: true },
		];
	});
	assert.deepEqual(asked, ["invoice:4"]);
	assert.deepEqual(ran(queries, "SET status = 'open', journal_entry_id = $2::bigint")[0].params, ["4", "90"]);
	assert.equal(ran(queries, "SET status = 'draft' WHERE id = $1 AND status = 'posting'").length, 0);
	assert.ok(logs.some(([level, msg]) => level === "warn" && /it is open now, with that entry/.test(msg)));
});

test("an invoice stuck in posting with nothing posted (or only a reversed entry) is a draft again", async () => {
	for (const linked of [[], [{ entry_id: 80, ref: "invoice:4", label: "Invoice INV-0004 · Acme", href: "", reversed: true }]]) {
		const { queries } = await recovering(async () => linked);
		assert.deepEqual(ran(queries, "SET status = 'draft' WHERE id = $1 AND status = 'posting'")[0].params, ["4"]);
		assert.equal(ran(queries, "SET status = 'open', journal_entry_id").length, 0);
	}
});

test("an invoice stuck in posting stays as it is when the books can't be asked", async () => {
	const { queries, logs } = await recovering(async () => {
		throw new Error("connection lost");
	});
	assert.equal(ran(queries, "SET status = 'draft' WHERE id = $1").length, 0);
	assert.equal(ran(queries, "SET status = 'open', journal_entry_id").length, 0);
	assert.deepEqual(logs.at(-1), ["info", "sales module ready", { dashboard: false }]);
});

// ---- deposit matching looks at every deposit ---------------------------------------------

test("the rules look at every unmatched deposit; only what the AI is asked is capped at forty", async () => {
	const prompts = [];
	// Sixty deposits, newest first; the 56th (line 155) names the invoice.
	const lines = Array.from({ length: 60 }, (_, i) => ({ journal_entry_id: 500 + i, line_id: 100 + i, entry_date: addDays("2026-11-15", -i), description: i === 55 ? "E-transfer INV-0003" : "Deposit", debit_cents: 5000 }));
	const { call, queries } = await loaded({
		rowsFor: (sql) => (sql.includes("AS balance_cents, d.issue_date::text") ? [{ id: 3n, number: "INV-0003", currency: "CAD", balance_cents: 7700n, issue_date: "2026-09-01", due_date: "2026-10-01", po_number: "", journal_entry_id: null, customer_id: 3n, customer: "Acme", company: "" }] : null),
		extra: {
			settings: { get: async () => ({ bank_account_cad: "1000" }), set: async () => {}, onChange() {} },
			ledger: { accountLedger: async () => ({ lines }) },
			llm: { status: async () => ({ configured: true, allowed: true }), json: async (r) => (prompts.push(r.prompt), { data: { matches: [] } }) },
		},
	});
	const r = await call("POST", "/payments/match", { body: {} });
	assert.equal(r.deposits_checked, 60);
	assert.equal(r.found, 1);
	const saved = ran(queries, "INSERT INTO mod_sales.payment_suggestions");
	assert.equal(saved.length, 1);
	assert.equal(saved[0].params[1], "155"); // the old deposit that names the invoice
	assert.equal(saved[0].params[9], "rule");
	assert.equal(prompts.length, 1);
	assert.equal(prompts[0].split("\n").filter((l) => /^D\d+ \| /.test(l)).length, 40);
	// Suggestions are replaced for the deposit a rule matched and the forty the AI saw; an older
	// deposit's earlier AI suggestion is left alone, a rule's is always redone.
	const del = ran(queries, "DELETE FROM mod_sales.payment_suggestions")[0];
	assert.equal(del.params[0].length, 60);
	assert.equal(del.params[2].length, 41);
	assert.ok(del.params[2].includes("155") && del.params[2].includes("100") && !del.params[2].includes("159"));
	assert.match(del.sql, /s\.source = 'rule' OR s\.line_id = ANY\(\$3::bigint\[\]\)/);
});

// ---- bad input ------------------------------------------------------------------------------

test("deleting a tax by an id too large for an integer is a plain 404", async () => {
	const { call, queries } = await loaded();
	await assert.rejects(call("DELETE", "/taxes/:id", { params: { id: "99999999999" }, role: "admin" }), (e) => e.status === 404);
	assert.equal(ran(queries, "$1::int").length, 0);
});

test("deleting a tax in use by nobody removes it from customers and categories first", async () => {
	const { call, queries } = await loaded({ rowsFor: (sql) => (sql.includes("FROM mod_sales.taxes WHERE id = $1") ? [{ id: 4n, name: "PST" }] : null) });
	await call("DELETE", "/taxes/:id", { params: { id: "4" }, role: "admin" });
	assert.equal(ran(queries, "array_remove(tax_ids, $1::int)").length, 2);
});

test("deleting a customer who has projects (but no documents) answers 409, not a database error", async () => {
	const withProjects = await loaded({ rowsFor: (sql) => (sql.includes("FROM mod_sales.projects WHERE customer_id = $1") ? [{ n: 1 }] : sql.includes("AS n FROM mod_sales.documents WHERE customer_id = $1") ? [{ n: 0 }] : null) });
	await assert.rejects(withProjects.call("DELETE", "/customers/:id", { params: { id: "2" } }), (e) => e.status === 409 && /projects/.test(e.message));
	assert.equal(ran(withProjects.queries, "DELETE FROM mod_sales.customers").length, 0);

	// Something was added for them between the check and the delete: the foreign key says so.
	const raced = await loaded({
		rowsFor: (sql) => {
			if (sql.includes("DELETE FROM mod_sales.customers")) throw Object.assign(new Error('violates foreign key constraint "projects_customer_id_fkey"'), { code: "23503" });
			return sql.includes("count(*)::int AS n") ? [{ n: 0 }] : null;
		},
	});
	await assert.rejects(raced.call("DELETE", "/customers/:id", { params: { id: "2" } }), (e) => e.status === 409 && !/foreign key/.test(e.message));
});

test("only an admin sends the test email", async () => {
	const { call } = await loaded();
	await assert.rejects(call("POST", "/settings/test-email", { body: { to: "someone@example.test" }, role: "bookkeeper" }), (e) => e.status === 403);
	// An admin gets past that check (and is then told what is wrong with the mail setup or the address).
	await assert.rejects(call("POST", "/settings/test-email", { body: {}, role: "admin" }), (e) => e.status !== 403);
});

// ---- lists come a page at a time ------------------------------------------------------------

test("a list says how many documents there are and whether more follow; limit and offset page through them", async () => {
	const row = (n) => ({ id: BigInt(n), kind: "invoice", number: `INV-${n}`, status: "open", issue_date: "2026-11-01", due_date: "2099-01-01", currency: "CAD", total_cents: 100n, paid_cents: 0n, sent_at: null, customer_id: 3n, paid_by_tag: false, customer_name: "Acme", customer_company: "" });
	const { call, queries } = await loaded({
		rowsFor: (sql, params) => {
			if (sql.includes("SELECT count(*)::int AS total")) return [{ total: 1234 }];
			if (sql.includes("LIMIT $7::int OFFSET $8::int")) return Array.from({ length: Math.min(params[6], 1234 - params[7]) }, (_, i) => row(params[7] + i + 1));
			return null;
		},
	});
	const first = await call("GET", "/invoices");
	assert.equal(first.data.length, 500);
	assert.deepEqual([first.total, first.limit, first.offset, first.has_more], [1234, 500, 0, true]);
	const last = await call("GET", "/invoices", { query: { limit: "200", offset: "1200" } });
	assert.equal(last.data.length, 34);
	assert.deepEqual([last.total, last.limit, last.offset, last.has_more], [1234, 200, 1200, false]);
	assert.deepEqual(ran(queries, "LIMIT $7::int OFFSET $8::int").at(-1).params.slice(6), [200, 1200]);
	// The count asks for the same documents as the page.
	assert.deepEqual(ran(queries, "SELECT count(*)::int AS total").at(-1).params, ran(queries, "LIMIT $7::int OFFSET $8::int").at(-1).params.slice(0, 6));
	for (const query of [{ limit: "0" }, { limit: "501" }, { limit: "many" }, { offset: "-1" }, { offset: "1.5" }]) {
		await assert.rejects(call("GET", "/quotes", { query }), (e) => e.status === 422, JSON.stringify(query));
	}
});
