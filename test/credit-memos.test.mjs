import { test } from "node:test";
import assert from "node:assert/strict";
import { billableItems } from "../server/billable.mjs";
import { helpers } from "../server/common.mjs";
import { creditMemoRoutes } from "../server/credit-memos.mjs";
import { fakeCtx } from "./fake.mjs";

const ACCOUNTS = {
	1150: { code: "1150", name: "Billable costs to recharge", currency: "CAD", module_id: "sales" },
	2150: { code: "2150", name: "Customer credits to apply", currency: "CAD", module_id: "sales" },
};
const clearingAccount = async ({ key, type }) => (key === "billable_costs" ? { ...ACCOUNTS[1150], type } : { ...ACCOUNTS[2150], type });

test("credit memos are billable items with a negative amount, from the credits clearing account", async () => {
	const asked = [];
	const { ctx } = fakeCtx({
		extra: {
			ledger: {
				clearingAccount: async (o) => (asked.push([o.key, o.type]), clearingAccount(o)),
				getAccount: async (code) => ACCOUNTS[code],
				listJournalEntries: async ({ accountCode }) =>
					accountCode === "2150"
						? [
								// A credit memo for this customer, one for another customer, and one already reversed.
								{ id: 90, entry_date: "2026-11-03", description: "Credit memo CM-0001", reference: "CM-0001", entity: { id: 5 }, lines: [{ id: 900, account_code: "4000", debit_cents: 3000 }, { id: 901, account_code: "2150", credit_cents: 3000, memo: "Damaged tiles" }] },
								{ id: 91, entry_date: "2026-11-04", description: "Credit memo CM-0002", entity: { id: 6 }, lines: [{ id: 910, account_code: "4000", debit_cents: 100 }, { id: 911, account_code: "2150", credit_cents: 100 }] },
								{ id: 92, entry_date: "2026-11-05", description: "Credit memo CM-0003", entity: { id: 5 }, reversed_by_id: 93, lines: [{ id: 920, account_code: "4000", debit_cents: 100 }, { id: 921, account_code: "2150", credit_cents: 100 }] },
							]
						: [{ id: 70, entry_date: "2026-11-01", description: "Permit", entity: { id: 5 }, lines: [{ id: 700, account_code: "1150", debit_cents: 5000 }, { id: 701, account_code: "1000", credit_cents: 5000 }] }],
			},
		},
		rowsFor: (sql) => (sql.includes("c WHERE id = $1") ? [{ id: 3n, entity_id: 5n, currency: "CAD" }] : null),
	});
	const r = await billableItems(ctx, helpers(ctx)).forCustomer("3", "CAD");
	assert.deepEqual(r.credit_clearing, { code: "2150", name: "Customer credits to apply" });
	assert.deepEqual(r.accounts, ["1150"]);
	assert.deepEqual(
		r.items.map((i) => [i.line_id, i.amount_cents, i.credit, i.clearing, i.description, i.reference]),
		[
			["700", "5000", false, true, "Permit", ""],
			["901", "-3000", true, true, "Damaged tiles", "CM-0001"],
		],
	);
	assert.ok(asked.some(([key, type]) => key === "customer_credits" && type === "liability"));
});

test("creating a credit memo posts Dr revenue / Cr the credits clearing account, with the customer", async () => {
	const posted = [];
	let row = null;
	const { ctx, routes, call } = fakeCtx({
		extra: {
			settings: { get: async () => ({ post_to_ledger: true, revenue_account_cad: "4000" }), set: async () => {}, onChange() {} },
			ledger: {
				clearingAccount,
				createJournalEntry: async (e) => (posted.push(e), { id: 55, lines: [{ id: 550, account_code: "4000", debit_cents: "2500" }, { id: 551, account_code: "2150", credit_cents: "2500" }] }),
			},
		},
		rowsFor: (sql, params) => {
			if (sql.includes("entity_active, archived FROM")) return [{ id: 3n, name: "Acme", currency: "CAD", entity_id: 5n, entity_active: true, archived: false }];
			if (sql.includes("INSERT INTO mod_sales.credit_memos")) {
				row = { id: 7n, number: "CM-0001", customer_id: 3n, memo_date: params[1], currency: params[2], amount_cents: params[3], status: "posting", customer_name: "Acme", applied_to: null };
				return [{ id: 7n }];
			}
			if (sql.includes("SET status = 'open', journal_entry_id = $2, ledger_line_id = $3")) row = { ...row, status: "open", journal_entry_id: params[1], ledger_line_id: params[2] };
			if (sql.includes("FROM mod_sales.credit_memos m JOIN") && sql.includes("WHERE m.id = $1")) return row ? [row] : [];
			return null;
		},
	});
	creditMemoRoutes(ctx, helpers(ctx));
	assert.ok(routes.some((r) => r.method === "POST" && r.path === "/credit-memos"));

	// Nothing to credit, or no amount: 422.
	await assert.rejects(call("POST", "/credit-memos", { body: {} }), { status: 422 });
	await assert.rejects(call("POST", "/credit-memos", { body: { customer_id: 3, amount: "0" } }), { status: 422 });

	const res = await call("POST", "/credit-memos", { body: { customer_id: 3, memo_date: "2026-11-19", amount: "25.00", description: "Damaged tiles" } });
	assert.equal(res.status, 201);
	assert.equal(res.body.status, "open");
	assert.equal(res.body.ledger_line_id, "551");
	assert.equal(posted.length, 1);
	const e = posted[0];
	assert.equal(e.entity_id, 5);
	assert.deepEqual(e.links.map((l) => l.ref), ["credit-memo:7"]);
	assert.deepEqual(
		e.lines.map((l) => [l.account_code, String(l.debit_cents ?? 0), String(l.credit_cents ?? 0)]),
		[
			["4000", "2500", "0"],
			["2150", "0", "2500"],
		],
	);
});

test("a credit memo needs posting to the books on", async () => {
	const { ctx, call } = fakeCtx({
		extra: { ledger: { clearingAccount } },
		rowsFor: (sql) => (sql.includes("entity_active, archived FROM") ? [{ id: 3n, name: "Acme", currency: "CAD", entity_id: 5n, entity_active: true, archived: false }] : null),
	});
	creditMemoRoutes(ctx, helpers(ctx));
	await assert.rejects(call("POST", "/credit-memos", { body: { customer_id: 3, amount: "10" } }), { status: 422, message: /Post invoices and payments to the books/ });
});

/** A ctx with one open credit memo (id 7, entry 55, clearing line 551), applied on `applied` if given. */
function editCtx({ applied = null } = {}) {
	const posted = [];
	const reversed = [];
	let row = { id: 7n, number: "CM-0001", customer_id: 3n, memo_date: "2026-11-10", currency: "CAD", amount_cents: 2500n, category_id: null, description: "Damaged tiles", status: "open", journal_entry_id: 55n, ledger_line_id: 551n, customer_name: "Acme", applied_to: applied };
	const updates = [];
	const fake = fakeCtx({
		extra: {
			settings: { get: async () => ({ post_to_ledger: true, revenue_account_cad: "4000" }), set: async () => {}, onChange() {} },
			ledger: {
				clearingAccount,
				createJournalEntry: async (e) => (posted.push(e), { id: 60, lines: [{ id: 600, account_code: "4000", debit_cents: "4000" }, { id: 601, account_code: "2150", credit_cents: "4000" }] }),
				getJournalEntry: async (id) => ({ id, reversed_by_id: null }),
				reverseJournalEntry: async (id, o) => (reversed.push([String(id), o]), { id: 61 }),
				linkJournalEntry: async () => ({}),
			},
		},
		rowsFor: (sql, params) => {
			if (sql.includes("entity_active, archived FROM")) return [{ id: 3n, name: "Acme", currency: "CAD", entity_id: 5n, entity_active: true, archived: false }];
			if (sql.includes("FROM mod_sales.credit_memos m JOIN") && sql.includes("WHERE m.id = $1")) return [row];
			if (sql.includes("SET status = 'posting'")) return applied ? [] : [{ id: 7n }];
			if (sql.includes("edited_at = now()")) {
				updates.push(params);
				row = { ...row, journal_entry_id: params[1], ledger_line_id: params[2], amount_cents: params[6], description: params[8] };
			}
			return null;
		},
	});
	creditMemoRoutes(fake.ctx, helpers(fake.ctx));
	return { ...fake, posted, reversed, updates };
}

test("editing an unapplied credit memo posts the corrected entry and reverses the old one, on its date", async () => {
	const { call, posted, reversed, updates } = editCtx();
	const res = await call("PUT", "/credit-memos/:id", { params: { id: "7" }, body: { amount: "40.00" } });
	assert.equal(posted.length, 1);
	assert.deepEqual(posted[0].lines.map((l) => [l.account_code, String(l.debit_cents ?? 0), String(l.credit_cents ?? 0)]), [["4000", "4000", "0"], ["2150", "0", "4000"]]);
	assert.equal(posted[0].reference, "CM-0001"); // keeps its number
	assert.deepEqual(reversed, [["55", { entry_date: "2026-11-10", description: "Credit memo CM-0001 changed" }]]);
	assert.equal(updates.length, 1);
	assert.equal(res.ledger_line_id, "601"); // the new clearing line is the billable item now
	assert.equal(res.description, "Damaged tiles"); // what wasn't given stays
});

test("an edit that changes nothing posts nothing", async () => {
	const { call, posted, reversed } = editCtx();
	await call("PUT", "/credit-memos/:id", { params: { id: "7" }, body: { amount: "25.00", description: "Damaged tiles" } });
	assert.deepEqual([posted.length, reversed.length], [0, 0]);
});

test("a credit memo applied on an invoice can't be edited", async () => {
	const { call, posted } = editCtx({ applied: { id: 9, number: "INV-0009", status: "draft" } });
	await assert.rejects(call("PUT", "/credit-memos/:id", { params: { id: "7" }, body: { amount: "40.00" } }), { status: 409, message: /applied on invoice INV-0009/ });
	assert.equal(posted.length, 0);
});
