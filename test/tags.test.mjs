// Ledger's shared tags on journal entries (ctx.tags, Ledger ≥ 0.23.0): what
// Sales sets and removes on invoices' entries, and how it follows a tag that
// a person or another module changes.

import assert from "node:assert/strict";
import { test } from "node:test";
import register from "../server.mjs";

/** A stand-in for Ledger's ctx; `rowsFor(sql, params)` answers the queries a test cares about. */
function fakeCtx({ rowsFor = () => null, tags = true, extra = {} } = {}) {
	const routes = [];
	const logs = [];
	const queries = [];
	const calls = []; // ["set" | "remove", entryId, tag, opts]
	const listeners = [];
	class HttpError extends Error {
		constructor(status, message) {
			super(message);
			this.status = status;
		}
	}
	const ctx = {
		id: "sales",
		schema: "mod_sales",
		route: (method, path, handler) => routes.push({ method, path, handler }),
		db: {
			query: async (sql, params) => {
				queries.push({ sql, params });
				const rows = rowsFor(sql, params) ?? [];
				return { rows, rowCount: rows.length };
			},
		},
		HttpError,
		response: (status, body) => ({ status, body }),
		log: { info: (m, a) => logs.push(["info", m, a]), warn: (m, a) => logs.push(["warn", m, a]), error: (m, a) => logs.push(["error", m, a]) },
		ledger: {},
		settings: { get: async () => ({}), set: async () => {}, onChange() {} },
		orgs: { forEach: async (fn) => fn({ id: 1, name: "Main books", kind: "business" }) },
		...(tags
			? {
					tags: {
						standard: ["paid", "billed", "overdue", "customer", "vendor"],
						set: async (entryId, tag, opts = {}) => (calls.push(["set", String(entryId), tag, opts]), []),
						remove: async (entryId, tag, opts = {}) => (calls.push(["remove", String(entryId), tag, opts]), []),
						of: async () => [],
						entries: async () => [],
						onChange: (fn) => listeners.push(fn),
					},
				}
			: {}),
		...extra,
	};
	return { ctx, routes, logs, queries, calls, listeners };
}

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
/** The query that asks which invoices' entries carry other tags than they should. */
const isOutOfLine = (sql) => sql.includes("AS wanted");
const savedTags = (queries) => queries.filter((x) => x.sql.includes("SET entry_tags = $2::text[]")).map((x) => x.params);

test("without ctx.tags (an older Ledger) Sales loads and never asks about tags", async () => {
	const { ctx, queries, logs } = fakeCtx({ tags: false });
	await register(ctx);
	await settle();
	assert.equal(queries.filter((x) => isOutOfLine(x.sql) || x.sql.includes("billed_entry_ids") || x.sql.includes("paid_by_tag = CASE")).length, 0);
	assert.deepEqual(logs.at(-1), ["info", "sales module ready", { dashboard: false }]);
});

test("startup tags the entries of invoices issued before the tags: customer, billed, paid or overdue", async () => {
	let asked = 0;
	const { ctx, calls, queries } = fakeCtx({
		rowsFor: (sql) => {
			if (!isOutOfLine(sql) || asked++ > 0) return null;
			return [
				{ id: 1n, number: "INV-0001", journal_entry_id: 40n, entry_tags: [], wanted: ["customer:5", "billed"] },
				{ id: 2n, number: "INV-0002", journal_entry_id: 41n, entry_tags: [], wanted: ["customer:5", "billed", "paid"] },
				{ id: 3n, number: "INV-0003", journal_entry_id: 42n, entry_tags: [], wanted: ["billed", "overdue"] }, // a customer not in Ledger's list yet
			];
		},
	});
	await register(ctx);
	await settle();
	assert.deepEqual(calls, [
		["set", "40", "customer", { entity_id: 5 }],
		["set", "40", "billed", { note: "Invoice INV-0001" }],
		["set", "41", "customer", { entity_id: 5 }],
		["set", "41", "billed", { note: "Invoice INV-0002" }],
		["set", "41", "paid", {}],
		["set", "42", "billed", { note: "Invoice INV-0003" }],
		["set", "42", "overdue", {}],
	]);
	// What is on each entry is remembered, so the next sync has nothing to do.
	assert.deepEqual(savedTags(queries), [["1", ["customer:5", "billed"]], ["2", ["customer:5", "billed", "paid"]], ["3", ["billed", "overdue"]]]);
	// The query looks at issued invoices with an entry, and works out overdue from the due date.
	const sql = queries.find((x) => isOutOfLine(x.sql)).sql;
	assert.match(sql, /d\.journal_entry_id IS NOT NULL AND d\.status IN \('open', 'paid', 'void'\)/);
	assert.match(sql, /d\.status = 'open' AND NOT d\.paid_by_tag AND d\.due_date < \$1::date THEN 'overdue'/);
});

test("a sync only changes what differs: paid and no longer, overdue and no longer, void", async () => {
	let asked = 0;
	const { ctx, calls, queries } = fakeCtx({
		rowsFor: (sql) => {
			if (!isOutOfLine(sql) || asked++ > 0) return null;
			return [
				// Paid in full: "paid" on (Ledger takes "overdue" off with it; Sales asks anyway, harmlessly).
				{ id: 1n, number: "INV-0001", journal_entry_id: 40n, entry_tags: ["customer:5", "billed", "overdue"], wanted: ["customer:5", "billed", "paid"] },
				// Its payment was removed and it is past due: open again.
				{ id: 2n, number: "INV-0002", journal_entry_id: 41n, entry_tags: ["customer:5", "billed", "paid"], wanted: ["customer:5", "billed", "overdue"] },
				// Void: the status tags come off, who it is with stays.
				{ id: 3n, number: "INV-0003", journal_entry_id: 42n, entry_tags: ["customer:5", "billed", "overdue"], wanted: ["customer:5"] },
				// The customer became another entity in Ledger's list.
				{ id: 4n, number: "INV-0004", journal_entry_id: 43n, entry_tags: ["customer:5", "billed"], wanted: ["customer:9", "billed"] },
			];
		},
	});
	await register(ctx);
	await settle();
	assert.deepEqual(calls, [
		["remove", "40", "overdue", {}],
		["set", "40", "paid", {}],
		["remove", "41", "paid", {}],
		["set", "41", "overdue", {}],
		["remove", "42", "billed", {}],
		["remove", "42", "overdue", {}],
		["remove", "43", "customer", { entity_id: 5 }],
		["set", "43", "customer", { entity_id: 9 }],
	]);
	assert.equal(savedTags(queries).length, 4);
});

test("an entry that can't be tagged doesn't stop the others, and is tried again on the next sync", async () => {
	let asked = 0;
	const { ctx, calls, queries, logs } = fakeCtx({
		rowsFor: (sql) => {
			if (!isOutOfLine(sql) || asked++ > 0) return null;
			return [
				{ id: 1n, number: "INV-0001", journal_entry_id: 40n, entry_tags: [], wanted: ["billed"] },
				{ id: 2n, number: "INV-0002", journal_entry_id: 41n, entry_tags: [], wanted: ["billed"] },
			];
		},
	});
	const set = ctx.tags.set;
	ctx.tags.set = async (entryId, ...rest) => {
		if (String(entryId) === "40") throw new Error("not found");
		return set(entryId, ...rest);
	};
	await register(ctx);
	await settle();
	assert.deepEqual(calls, [["set", "41", "billed", { note: "Invoice INV-0002" }]]);
	assert.deepEqual(savedTags(queries), [["2", ["billed"]]]); // invoice 1 is left as it was
	assert.ok(logs.some(([level, msg]) => level === "warn" && msg === "could not tag an invoice's journal entry"));
});

test("billable costs: their entries are tagged billed when the invoice is issued, and freed when it is void", async () => {
	const { ctx, calls, queries } = fakeCtx({
		extra: {
			ledger: {
				clearingAccount: async () => ({ code: "1150", name: "Billable costs to recharge" }),
				getAccount: async () => ({ code: "1150", name: "Billable costs to recharge", currency: "CAD", module_id: "sales" }),
				listJournalEntries: async () => [
					{ id: 70, entry_date: "2026-11-01", description: "Permit", entity: { id: 5 }, lines: [{ id: 700, account_code: "1150", debit_cents: 5000 }, { id: 701, account_code: "1000", credit_cents: 5000 }] },
					{ id: 71, entry_date: "2026-11-02", description: "Courier", entity: { id: 5 }, lines: [{ id: 710, account_code: "1150", debit_cents: 2000 }, { id: 711, account_code: "1000", credit_cents: 2000 }] },
				],
			},
		},
		rowsFor: (sql, params) => {
			// An issued invoice bills journal line 700; nothing worked out for it yet.
			if (sql.includes("AS line_ids")) return [{ id: 8n, number: "INV-0008", customer_id: 3n, currency: "CAD", line_ids: ["700"] }];
			if (sql.includes("c WHERE id = $1")) return [{ id: 3n, entity_id: 5n, currency: "CAD" }];
			// A void invoice had tagged entries 80 and 81; another issued invoice still bills 81.
			if (sql.includes("d.status = 'void' AND cardinality(d.billed_entry_ids) > 0")) return [{ id: 9n, number: "INV-0009", entries: ["80", "81"] }];
			if (sql.includes("= ANY(billed_entry_ids)")) return params[0] === "81" ? [{ "?column?": 1 }] : [];
			return null;
		},
	});
	await register(ctx);
	await settle();
	assert.deepEqual(calls, [
		["set", "70", "billed", { note: "Invoice INV-0008" }],
		["remove", "80", "billed", {}],
	]);
	const saved = queries.filter((x) => /SET billed_entry_ids = (\$2::bigint\[\]|'\{\}') WHERE id = \$1/.test(x.sql)).map((x) => x.params);
	assert.deepEqual(saved, [["8", ["70"]], ["9"]]);
});

test("a tag changed by a person or another module is followed; Sales' own changes are not", async () => {
	const { ctx, listeners, queries, calls } = fakeCtx({
		rowsFor: (sql, params) => {
			if (!sql.includes("paid_by_tag = CASE WHEN $2::text = 'paid'")) return null;
			// Entry 40 is an open invoice's; entry 41 belongs to an invoice Sales has payments for.
			if (params[0] === "40") return [{ id: 1n, number: "INV-0001", status: "open", paid_by_tag: params[2], was: !params[2] }];
			if (params[0] === "41") return [{ id: 2n, number: "INV-0002", status: "paid", paid_by_tag: false, was: false }];
			return [];
		},
	});
	const scheduled = [];
	ctx.dashboard = new Proxy({}, { get: (_, name) => async () => (scheduled.push(name), name === "list" ? [] : true) });
	await register(ctx);
	await settle();
	assert.equal(listeners.length, 1);
	const follow = () => queries.filter((x) => x.sql.includes("paid_by_tag = CASE WHEN $2::text = 'paid'"));

	// Sales' own change, a tag Sales doesn't keep, and an entry that isn't an invoice's.
	await listeners[0]({ entry_id: 40, action: "set", tag: "paid", entity_id: null, module_id: "sales" });
	await listeners[0]({ entry_id: 40, action: "set", tag: "reviewed", entity_id: null, module_id: null });
	assert.equal(follow().length, 0);
	await listeners[0]({ entry_id: 99, action: "set", tag: "paid", entity_id: null, module_id: null });
	assert.equal(follow().length, 1);

	// A person tags the invoice's entry paid: recorded, and the lists and reminders are refreshed.
	scheduled.length = 0;
	await listeners[0]({ entry_id: 40, action: "set", tag: "paid", entity_id: null, module_id: null });
	assert.deepEqual(follow().at(-1).params, ["40", "paid", true]);
	await settle(700);
	assert.ok(scheduled.includes("list"), "the dashboard was synced");

	// Another module takes it off: open again.
	scheduled.length = 0;
	await listeners[0]({ entry_id: 40, action: "removed", tag: "paid", entity_id: null, module_id: "bank" });
	assert.deepEqual(follow().at(-1).params, ["40", "paid", false]);
	await settle(700);
	assert.ok(scheduled.includes("list"));

	// "paid" taken off an invoice Sales holds the payments for: it stays paid, nothing is refreshed now.
	scheduled.length = 0;
	await listeners[0]({ entry_id: 41, action: "removed", tag: "paid", entity_id: null, module_id: null });
	await settle(700);
	assert.deepEqual(scheduled, []);

	// The customer tag is remembered with its entity.
	await listeners[0]({ entry_id: 40, action: "removed", tag: "customer", entity_id: 5, module_id: null });
	assert.deepEqual(follow().at(-1).params, ["40", "customer:5", false]);

	// Following a tag never tags anything itself, and never posts.
	assert.deepEqual(calls, []);
	assert.equal(ctx.ledger.createJournalEntry, undefined);
});

test("an invoice tagged paid in Ledger is left out of the open and overdue lists and shown under paid", async () => {
	const { ctx, routes, queries } = fakeCtx();
	await register(ctx);
	const list = (status) => routes.find((r) => r.method === "GET" && r.path === "/invoices").handler({ params: {}, query: new URLSearchParams({ status }), user: { username: "bob", role: "viewer" } });
	const where = async (status) => {
		queries.length = 0;
		await list(status);
		return queries.find((x) => x.sql.includes("d.kind = $5")).sql;
	};
	assert.match(await where("open"), /d\.status = 'open' AND NOT d\.paid_by_tag\n/);
	assert.match(await where("overdue"), /d\.status = 'open' AND NOT d\.paid_by_tag AND d\.due_date < \$4::date/);
	assert.match(await where("paid"), /\(d\.status = 'paid' OR \(d\.status = 'open' AND d\.paid_by_tag\)\)/);
});
