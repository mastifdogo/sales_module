// Ledger's one file store (Ledger ≥ 0.27.0): the PDF Sales files for an
// invoice, quote or estimate carries what Sales knows about it (its
// extraction) and, for an invoice, the shared file tags billed, paid and
// overdue; a person tagging the PDF is followed like a tag on the entry.

import assert from "node:assert/strict";
import { test } from "node:test";
import register from "../server.mjs";
import { extractionOf } from "../server/documents.mjs";
import { docRow, documentRows, fakeCtx, lineRow, NotFoundError, settle } from "./fake.mjs";

const ran = (queries, text) => queries.filter((x) => x.sql.includes(text));

/** A stand-in for ctx.documents that records what Sales does with it. */
function fakeDocuments({ ensure = async () => ({ document: { id: 77 }, added: true }) } = {}) {
	const calls = []; // [what, document id, …]
	const listeners = [];
	return {
		calls,
		listeners,
		api: {
			add: async () => {
				throw new Error("Sales files with ensure(), not add()");
			},
			ensure: async (d, user) => (calls.push(["ensure", d, user]), ensure(d)),
			get: async (id) => ({ id: Number(id) }),
			url: (id) => `/api/v1/documents/${id}/file`,
			remove: async (id) => void calls.push(["remove", Number(id)]),
			setExtracted: async (id, x, user) => (calls.push(["setExtracted", Number(id), x, user]), {}),
			tags: {
				standard: ["extracted", "posted", "paid", "billed", "overdue"],
				set: async (id, tag, opts = {}, user) => (calls.push(["tag", Number(id), tag, opts, user]), []),
				remove: async (id, tag) => (calls.push(["untag", Number(id), tag]), []),
				of: async () => [],
				onChange: (fn) => listeners.push(fn),
			},
		},
	};
}

const isFileSync = (sql) => sql.includes("AS file_wanted");
const isFileData = (sql) => sql.includes("d.file_data_status IS NULL AND d.kind = 'invoice'");

test("what Sales knows about a document, in the keys every module reads", () => {
	const doc = docRow({
		id: 31n,
		number: "INV-10000",
		subtotal_cents: 32500n,
		tax_cents: 1500n,
		total_cents: 34000n,
		lines: [
			lineRow({ description: "Design work", quantity: 1500n, unit_price_cents: 20000n, amount_cents: 30000n }),
			lineRow({ description: "Discount", quantity: 1000n, unit_price_cents: -500n, amount_cents: -500n }),
		],
	});
	assert.deepEqual(extractionOf(doc), {
		type: "invoice",
		customer: "Acme",
		entity_id: 5,
		number: "INV-10000",
		date: "2026-11-01",
		due_date: "2026-12-01",
		currency: "CAD",
		subtotal_cents: 32500,
		tax_cents: 1500,
		total_cents: 34000,
		items: [
			{ description: "Design work", quantity: 1.5, unit: "", rate_cents: 20000, amount_cents: 30000 },
			{ description: "Discount", quantity: 1, unit: "", rate_cents: -500, amount_cents: -500 },
		],
		sales: { id: 31, kind: "invoice", status: "open" },
	});
	// A quote for a customer who isn't in Ledger's list: no entity (Ledger drops a null key).
	const quote = extractionOf(docRow({ kind: "quote", status: "sent", number: "QUO-0002", customer: { name: "Walk-in", entity_id: null }, lines: [] }));
	assert.equal(quote.type, "quote");
	assert.equal(quote.entity_id, null);
	assert.deepEqual(quote.sales, { id: 1, kind: "quote", status: "sent" });
});

test("issuing an invoice files its PDF with ensure(), saves what Sales knows with it, and tags it billed", async () => {
	const docs = fakeDocuments();
	let filed = false;
	const { ctx, call, queries } = fakeCtx({
		rowsFor: (sql, params) => {
			if (sql.includes("SET status = 'posting'")) return [{ id: 1n }];
			if (sql.includes("pdf_document_id = $2::bigint\n")) filed = true;
			// Once filed, its PDF should carry "billed" and carries nothing yet.
			if (isFileSync(sql)) return filed ? [{ id: 1n, number: "INV-0001", pdf_document_id: 77n, file_tags: [], file_wanted: ["billed"] }] : [];
			return documentRows({ 1: () => ({ doc: docRow({ status: "open", pdf_document_id: filed ? 77n : null }) }) })(sql, params);
		},
		extra: { documents: docs.api },
	});
	await register(ctx);
	await settle();
	docs.calls.length = 0;
	queries.length = 0;
	const user = { username: "bob", role: "bookkeeper" };
	await call("POST", "/invoices/:id/issue", { params: { id: "1" }, user });

	const [ensure, saved, tagged] = docs.calls;
	assert.equal(ensure[0], "ensure");
	assert.deepEqual({ ...ensure[1], data: null }, { kind: "invoice", origin: "created", filename: "Invoice-INV-0001.pdf", data: null, title: "Invoice INV-0001 · Acme", doc_date: "2026-11-01", entity_id: 5 });
	assert.equal(ensure[1].data.subarray(0, 5).toString(), "%PDF-");
	assert.equal(ensure[2].username, "bob");
	// The whole of it, replacing whatever was there: Sales made the file, nothing to approve.
	assert.equal(saved[0], "setExtracted");
	assert.equal(saved[1], 77);
	assert.equal(saved[2].replace, true);
	assert.deepEqual(saved[2].data, extractionOf({ ...docRow({ status: "open" }), lines: [lineRow()] }));
	assert.equal(saved[3].username, "bob");
	assert.deepEqual(tagged.slice(0, 4), ["tag", 77, "billed", { note: "Invoice INV-0001" }]);
	assert.equal(docs.calls.length, 3);
	// Sales remembers the file, that its data says "open", and the tag on it.
	assert.deepEqual(ran(queries, "pdf_document_id = $2::bigint\n")[0].params, ["1", "77"]);
	assert.deepEqual(ran(queries, "SET file_data_status = $2 WHERE id = $1 AND pdf_document_id = $3::bigint")[0].params, ["1", "open", "77"]);
	assert.deepEqual(ran(queries, "SET file_tags = $2::text[]")[0].params, ["1", ["billed"], "77"]);
});

test("a PDF filed again after the document changed replaces the old one; the same bytes keep their document", async () => {
	// Emailing needs a mailbox; Ledger's is connected and Sales may send.
	const mail = { status: async () => ({ connected: true, kind: "imap", account: "books@example.test", canRead: false, canSend: true }), send: async () => ({ id: "m1" }) };
	async function resend(ensuredId) {
		const docs = fakeDocuments({ ensure: async () => ({ document: { id: ensuredId }, added: ensuredId !== 77 }) });
		const { ctx, call, queries } = fakeCtx({
			rowsFor: (sql, params) => documentRows({ 2: { doc: docRow({ id: 2n, kind: "quote", status: "sent", number: "QUO-0002", pdf_document_id: 77n, customer: { ...docRow().customer, email: "ap@acme.test" } }) } })(sql, params),
			extra: { documents: docs.api, mail },
		});
		await register(ctx);
		await settle();
		docs.calls.length = 0;
		queries.length = 0;
		await call("POST", "/quotes/:id/send", { params: { id: "2" } });
		return { calls: docs.calls, queries };
	}
	const changed = await resend(78);
	assert.deepEqual(changed.calls.map((c) => c[0]), ["ensure", "remove", "setExtracted"]);
	assert.deepEqual(changed.calls[1], ["remove", 77]);
	assert.equal(changed.calls[2][1], 78);
	assert.equal(changed.calls[2][2].data.type, "quote");
	assert.deepEqual(changed.calls[2][2].data.sales, { id: 2, kind: "quote", status: "sent" });
	// Another file: the tags and data Sales knew of were on the old one.
	assert.match(ran(changed.queries, "pdf_document_id = $2::bigint\n")[0].sql, /file_tags = CASE WHEN pdf_document_id IS DISTINCT FROM \$2::bigint THEN '\{\}' ELSE file_tags END/);

	const same = await resend(77);
	assert.deepEqual(same.calls.map((c) => c[0]), ["ensure", "setExtracted"]);
});

test("a sync brings the tags on invoices' PDFs in line: paid, void, and a PDF deleted in Ledger is forgotten", async () => {
	const docs = fakeDocuments();
	docs.api.tags.remove = async (id, tag) => {
		if (Number(id) === 63) throw new NotFoundError();
		docs.calls.push(["untag", Number(id), tag]);
		return [];
	};
	let asked = 0;
	const { ctx, queries } = fakeCtx({
		rowsFor: (sql) => {
			if (!isFileSync(sql) || asked++ > 0) return null;
			return [
				// Paid in full: "paid" on, "overdue" off.
				{ id: 1n, number: "INV-0001", pdf_document_id: 61n, file_tags: ["billed", "overdue"], file_wanted: ["billed", "paid"] },
				// Void: nothing is said of it any more.
				{ id: 2n, number: "INV-0002", pdf_document_id: 62n, file_tags: ["billed", "overdue"], file_wanted: [] },
				// Its PDF was deleted on the Documents page.
				{ id: 3n, number: "INV-0003", pdf_document_id: 63n, file_tags: ["billed"], file_wanted: [] },
				// Issued before Sales tagged files, now past due.
				{ id: 4n, number: "INV-0004", pdf_document_id: 64n, file_tags: [], file_wanted: ["billed", "overdue"] },
			];
		},
		extra: { documents: docs.api },
	});
	await register(ctx);
	await settle();
	assert.deepEqual(
		docs.calls.map((c) => c.slice(0, 3)),
		[
			["untag", 61, "overdue"],
			["tag", 61, "paid"],
			["untag", 62, "billed"],
			["untag", 62, "overdue"],
			["tag", 64, "billed"],
			["tag", 64, "overdue"],
		],
	);
	assert.deepEqual(ran(queries, "SET file_tags = $2::text[]").map((x) => x.params), [["1", ["billed", "paid"], "61"], ["2", [], "62"], ["4", ["billed", "overdue"], "64"]]);
	assert.deepEqual(ran(queries, "SET pdf_document_id = NULL, file_tags = '{}', file_data_status = NULL")[0].params, ["3", "63"]);
	// The query: every invoice with a filed PDF, with or without a journal entry; nothing once void or a draft again.
	const sql = queries.find((x) => isFileSync(x.sql)).sql;
	assert.match(sql, /WHERE d\.kind = 'invoice' AND d\.pdf_document_id IS NOT NULL\n/);
	assert.match(sql, /CASE WHEN d\.status IN \('open', 'paid'\) THEN 'billed' END/);
	assert.match(sql, /d\.status = 'open' AND NOT d\.paid_by_tag AND d\.due_date < \$1::date THEN 'overdue'/);
});

test("the data kept with a PDF follows the document's status, and invoices filed before get theirs", async () => {
	const docs = fakeDocuments();
	let asked = 0;
	const { ctx, queries } = fakeCtx({
		rowsFor: (sql, params) => {
			if (isFileData(sql)) {
				if (asked++ > 0) return [];
				return [
					// Paid since its PDF was filed: only the status changes in what is saved.
					{ id: 1n, kind: "invoice", number: "INV-0001", status: "paid", pdf_document_id: 61n, file_data_status: "open" },
					// Filed by an older Sales: nothing saved with it yet.
					{ id: 2n, kind: "invoice", number: "INV-0002", status: "open", pdf_document_id: 62n, file_data_status: null },
				];
			}
			return documentRows({ 2: { doc: docRow({ id: 2n, number: "INV-0002", pdf_document_id: 62n }) } })(sql, params);
		},
		extra: { documents: docs.api },
	});
	await register(ctx);
	await settle();
	const saved = docs.calls.filter((c) => c[0] === "setExtracted");
	assert.deepEqual(saved[0].slice(1, 3), [61, { data: { sales: { id: 1, kind: "invoice", status: "paid" } } }]); // merged: no replace
	assert.equal(saved[1][1], 62);
	assert.equal(saved[1][2].replace, true);
	assert.equal(saved[1][2].data.number, "INV-0002");
	assert.deepEqual(ran(queries, "SET file_data_status = $2 WHERE id = $1").map((x) => x.params), [["1", "paid", "61"], ["2", "open", "62"]]);
	// Quotes and estimates may have been edited since they were filed: theirs is saved when they are filed again.
	assert.match(queries.find((x) => isFileData(x.sql)).sql, /d\.file_data_status IS NULL AND d\.kind = 'invoice' AND d\.status IN \('open', 'paid', 'void'\)/);
});

test("a person tagging an invoice's PDF paid in Ledger is followed like a tag on its entry; Sales' own changes are not", async () => {
	const docs = fakeDocuments();
	const { ctx, queries } = fakeCtx({
		rowsFor: (sql, params) => {
			if (!sql.includes("paid_by_tag = CASE WHEN $2::text = 'paid'")) return null;
			return params[0] === "77" ? [{ id: 1n, number: "INV-0001", status: "open", paid_by_tag: params[2], was: !params[2] }] : [];
		},
		extra: { documents: docs.api },
	});
	const scheduled = [];
	ctx.dashboard = new Proxy({}, { get: (_, name) => async () => (scheduled.push(name), name === "list" ? [] : true) });
	await register(ctx);
	await settle();
	assert.equal(docs.listeners.length, 1);
	const follow = () => ran(queries, "paid_by_tag = CASE WHEN $2::text = 'paid'");
	const say = docs.listeners[0];

	// Sales' own change, and tags Sales doesn't keep on files.
	await say({ document_id: 77, action: "set", tag: "paid", module_id: "sales" });
	await say({ document_id: 77, action: "set", tag: "posted", module_id: null });
	await say({ document_id: 77, action: "set", tag: "extracted", module_id: "bills" });
	assert.equal(follow().length, 0);

	// A person tags the PDF paid on the Documents page.
	scheduled.length = 0;
	await say({ document_id: 77, action: "set", tag: "paid", module_id: null });
	assert.deepEqual(follow().at(-1).params, ["77", "paid", true]);
	// The same statement as for the entry, keyed by the file and remembering the file's tags.
	assert.match(follow().at(-1).sql, /WHERE kind = 'invoice' AND pdf_document_id = \$1::bigint AND status IN \('open', 'paid'\) FOR UPDATE/);
	assert.match(follow().at(-1).sql, /SET file_tags = CASE WHEN \$3::boolean THEN array_append\(array_remove\(d\.file_tags, \$2::text\), \$2::text\)/);
	await settle(700);
	assert.ok(scheduled.includes("list"), "its lists and reminders are refreshed");

	// Taken off again, by another module: open again.
	await say({ document_id: 77, action: "removed", tag: "paid", module_id: "bank" });
	assert.deepEqual(follow().at(-1).params, ["77", "paid", false]);
	await settle(700);

	// A file that isn't an invoice's PDF changes nothing.
	scheduled.length = 0;
	await say({ document_id: 5, action: "set", tag: "paid", module_id: null });
	await settle(700);
	assert.deepEqual(scheduled, []);

	// Someone cleared what was saved with the PDF: Sales no longer counts it as saved.
	await say({ document_id: 77, action: "removed", tag: "extracted", module_id: null });
	assert.deepEqual(ran(queries, "SET file_data_status = NULL WHERE pdf_document_id = $1::bigint").at(-1).params, ["77"]);

	// Following a tag never tags anything itself.
	assert.deepEqual(docs.calls.filter((c) => c[0] === "tag" || c[0] === "untag"), []);
});

test("Sales keeps no files of its own: no storage folder, no file bytes in its tables", async () => {
	const { readdir, readFile } = await import("node:fs/promises");
	const root = new URL("../", import.meta.url);
	for (const dir of ["server/", "lib/", "migrations/"]) {
		for (const name of await readdir(new URL(dir, root))) {
			const text = await readFile(new URL(dir + name, root), "utf8");
			assert.doesNotMatch(text, /ctx\.storage\b/, `${dir}${name} uses ctx.storage`);
			assert.doesNotMatch(text, /\bbytea\b/i, `${dir}${name} has a bytea column`);
			assert.doesNotMatch(text, /documents\.add\(/, `${dir}${name} files with add(); use ensure()`);
		}
	}
});
