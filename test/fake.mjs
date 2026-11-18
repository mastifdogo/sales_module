// Stand-ins for Ledger shared by the tests: a ctx whose database answers from
// `rowsFor(sql, params)`, and the rows getDocument() reads for a document.

export class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

/** What Ledger throws for a missing entry, account or document: no status, only its class. */
export class NotFoundError extends Error {
	constructor() {
		super("not found");
	}
}

/**
 * A stand-in for Ledger's ctx. `rowsFor(sql, params)` answers the queries a
 * test cares about (null: no rows); `extra` adds or replaces members
 * (ledger, documents, tags, settings, orgs, llm, …).
 */
export function fakeCtx({ rowsFor = () => null, extra = {} } = {}) {
	const routes = [];
	const logs = [];
	const queries = [];
	const ctx = {
		id: "sales",
		schema: "mod_sales",
		route: (method, path, handler) => routes.push({ method, path, handler }),
		db: {
			query: async (sql, params) => {
				queries.push({ sql, params });
				const rows = (await rowsFor(sql, params)) ?? [];
				return { rows, rowCount: rows.length };
			},
		},
		HttpError,
		response: (status, body) => ({ status, body }),
		log: { info: (m, a) => logs.push(["info", m, a]), warn: (m, a) => logs.push(["warn", m, a]), error: (m, a) => logs.push(["error", m, a]) },
		ledger: {},
		settings: { get: async () => ({}), set: async () => {}, onChange() {} },
		orgs: { forEach: async (fn) => fn({ id: 1, name: "Main books", kind: "business" }), current: async () => ({ id: 1, name: "Main books", kind: "business" }) },
		...extra,
	};
	/** Calls a route as a logged-in user would. */
	const call = (method, path, { params = {}, body = {}, query = {}, role = "bookkeeper", user = {} } = {}) => {
		const route = routes.find((r) => r.method === method && r.path === path);
		if (!route) throw new Error(`no route ${method} ${path}`);
		return route.handler({ method, path, params, body, query: new URLSearchParams(query), user: { username: "bob", role, organization: { id: 1, name: "Main books", kind: "business" }, ...user } });
	};
	return { ctx, routes, logs, queries, call };
}

export const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

/** A document as getDocument()'s first query returns it. */
export const docRow = (o = {}) => ({
	id: 1n,
	kind: "invoice",
	number: "INV-0001",
	customer_id: 3n,
	status: "open",
	issue_date: "2026-11-01",
	due_date: "2026-12-01",
	currency: "CAD",
	po_number: "",
	notes: "",
	subtotal_cents: 10000n,
	tax_cents: 0n,
	total_cents: 10000n,
	paid_cents: 0n,
	journal_entry_id: null,
	void_entry_id: null,
	source_id: null,
	converted_id: null,
	project_id: null,
	pdf_document_id: null,
	paid_by_tag: false,
	sent_at: null,
	customer: { id: 3, name: "Acme", company: "", email: "", cc_emails: "", address: "", tax_id: "", phone: "", entity_id: 5, entity_active: true },
	source: null,
	converted: null,
	project: null,
	...o,
});

export const lineRow = (o = {}) => ({
	id: 1n,
	position: 1,
	category_id: null,
	category_name: null,
	description: "Work",
	quantity: 1000n,
	unit_price_cents: 10000n,
	taxes: [],
	amount_cents: 10000n,
	billed_ledger_line_ids: [],
	rate_tag_id: null,
	...o,
});

/**
 * Answers getDocument()'s queries. `docs` maps a document id to
 * { doc, lines?, payments? } or to a function returning that (so a test can
 * change what a later read sees). Returns null for any other query.
 */
export function documentRows(docs) {
	const of = (id) => {
		const d = docs[String(id)];
		return typeof d === "function" ? d() : d;
	};
	return (sql, params) => {
		const d = of(params?.[0]);
		if (sql.includes("AS customer,") && sql.includes("WHERE d.id = $1")) return d ? [d.doc] : [];
		if (sql.includes("mod_sales.document_lines l LEFT JOIN")) return d?.lines ?? [lineRow()];
		if (sql.includes("FROM mod_sales.payments WHERE document_id = $1 ORDER BY")) return d?.payments ?? [];
		return null;
	};
}
