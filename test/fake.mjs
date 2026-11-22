// Stand-ins for Ledger shared by the tests: a ctx whose database answers from
// `rowsFor(sql, params)`, the rows getDocument() reads for a document, and
// (fakeBooks) Ledger's books themselves: accounts, customers, journal entries
// and tags, as a Ledger with customers' own accounts (≥ 0.31.0) or an older one.

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

/**
 * A stand-in for Ledger's books, as far as Sales posts to them: accounts,
 * customers (entities), journal entries and the tags on them.
 *
 * `own: true` behaves like Ledger ≥ 0.31.0, where every customer has an
 * account of their own under accounts receivable: `entities.account`, a line
 * posted to the tagged receivable account with the customer goes to the
 * customer's own account, and the tag "customer" is read from that account
 * (set moves the line there and keeps no tag; remove moves it back).
 * `own: false` is an older Ledger: no such accounts, and tags are just kept.
 * `update()` turns an older Ledger into the new one the way its migration
 * does: the receivable lines of the entries that are a customer's move to
 * the customer's own account, and the customer tags that said so go.
 *
 * Spread `extra` into fakeCtx({ extra }) (with a `settings` of the test's own).
 */
export function fakeBooks({ own = true, accounts = [], entities = [] } = {}) {
	const accts = new Map();
	const ents = new Map(entities.map((e) => [Number(e.id), { is_customer: true, is_vendor: false, is_active: true, ...e, id: Number(e.id) }]));
	const entries = new Map();
	let stored = []; // the tags kept apart: { id, entry_id, tag, entity_id, note, module_id }
	const calls = []; // ["set" | "remove", entry id, tag, opts]: what was asked of ctx.tags
	const links = [];
	const listeners = [];
	let nextEntry = 100;
	let nextLine = 1000;
	let nextTag = 1;
	let ownAccounts = own;

	const addAccount = (a) => (accts.set(a.code, { name: a.code, type: "asset", currency: "CAD", kind: null, is_active: true, hidden: false, module_id: null, parent_code: null, entity: null, ...a }), accts.get(a.code));
	for (const a of accounts) addAccount(a);
	const account = (code) => {
		const a = accts.get(String(code));
		if (!a) throw new NotFoundError();
		return a;
	};
	const entry = (id) => {
		const e = entries.get(Number(id));
		if (!e) throw new NotFoundError();
		return e;
	};

	/** The customer's own account in a currency, made under `under` (or the tagged receivable account) when they have none. */
	function ownAccount(entityId, currency, under = null) {
		const who = ents.get(Number(entityId));
		if (!who) throw new NotFoundError();
		const found = [...accts.values()].find((a) => a.entity?.id === who.id && a.entity.role === "customer" && a.currency === currency);
		if (found) return found;
		if (!who.is_customer) throw new HttpError(422, `${who.name} is a vendor, not a customer`);
		const parent = under ?? [...accts.values()].find((a) => a.kind === "receivable" && a.currency === currency) ?? addAccount({ code: currency === "CAD" ? "1200" : `1200-${currency}`, name: "Accounts receivable", currency, kind: "receivable" });
		return addAccount({ code: `${parent.code}-${who.id}`, name: who.name, currency, parent_code: parent.code, entity: { id: who.id, name: who.name, role: "customer" } });
	}
	const isControl = (code) => accts.get(code)?.kind === "receivable" && !accts.get(code)?.entity;

	/** An entry's tags as Ledger returns them: the kept ones, and "customer" read from the accounts its lines sit in. */
	function tagsOf(entryId) {
		const e = entry(entryId);
		const out = stored.filter((t) => t.entry_id === e.id).map((t) => ({ id: t.id, tag: t.tag, entity: t.entity_id === null ? null : { id: t.entity_id, name: ents.get(t.entity_id)?.name ?? "" }, note: t.note, module_id: t.module_id, account_code: null }));
		if (!ownAccounts) return out;
		for (const l of e.lines) {
			const who = accts.get(l.account_code)?.entity;
			if (!who || out.some((t) => t.tag === who.role && t.entity?.id === who.id)) continue;
			out.push({ id: 0, tag: who.role, entity: { id: who.id, name: who.name }, note: "", module_id: null, account_code: l.account_code });
		}
		return out;
	}

	/** Moves an entry's lines (and those of the entry that reverses it, or that it reverses) from one account to another. */
	function move(e, from, to) {
		let moved = 0;
		for (const x of [e, ...[...entries.values()].filter((o) => o.reverses_id === e.id || o.id === e.reverses_id)]) {
			for (const l of x.lines) if (l.account_code === from) (l.account_code = to), x === e && moved++;
		}
		return moved;
	}

	const ledger = {
		listAccounts: async () => [...accts.values()].filter((a) => a.is_active).map((a) => ({ ...a })),
		getAccount: async (code) => ({ ...account(code) }),
		async createJournalEntry(e, user) {
			const who = e.entity_id === undefined || e.entity_id === null ? null : ents.get(Number(e.entity_id));
			if (e.entity_id !== undefined && e.entity_id !== null && (!who || !who.is_active)) throw new HttpError(422, "entity_id: that customer or vendor is inactive");
			const sum = (k) => e.lines.reduce((s, l) => s + BigInt(l[k] ?? 0), 0n);
			if (sum("debit_cents") !== sum("credit_cents") || sum("debit_cents") === 0n) throw new HttpError(422, "the entry doesn't balance");
			const lines = e.lines.map((l, i) => {
				let a = account(l.account_code);
				// Ledger ≥ 0.31.0: a customer's line in accounts receivable is posted to the customer's own account.
				if (ownAccounts && who?.is_customer && isControl(a.code)) a = ownAccount(who.id, a.currency, a);
				return { id: nextLine++, line_number: i + 1, account_code: a.code, account_name: a.name, currency: a.currency, debit_cents: BigInt(l.debit_cents ?? 0), credit_cents: BigInt(l.credit_cents ?? 0), memo: l.memo ?? "" };
			});
			const made = { id: nextEntry++, entry_date: e.entry_date, description: e.description ?? "", reference: e.reference ?? "", entity: who ? { id: who.id, name: who.name } : null, reverses_id: null, reversed_by_id: null, amended: false, lines, posted_by: user?.username ?? null };
			entries.set(made.id, made);
			for (const l of e.links ?? []) links.push({ entry_id: made.id, ...l });
			return ledger.getJournalEntry(made.id);
		},
		async getJournalEntry(id) {
			const e = entry(id);
			return { ...e, lines: e.lines.map((l) => ({ ...l })), tags: tagsOf(e.id), links: links.filter((l) => l.entry_id === e.id) };
		},
		async reverseJournalEntry(id, opts = {}) {
			const e = entry(id);
			if (e.reversed_by_id !== null) throw new HttpError(409, `entry ${e.id} was already reversed`);
			const rev = { ...e, id: nextEntry++, entry_date: opts.entry_date ?? e.entry_date, description: opts.description ?? `Reversal of ${e.description}`, reverses_id: e.id, reversed_by_id: null, lines: e.lines.map((l) => ({ ...l, id: nextLine++, debit_cents: l.credit_cents, credit_cents: l.debit_cents })) };
			entries.set(rev.id, rev);
			e.reversed_by_id = rev.id;
			return ledger.getJournalEntry(rev.id);
		},
		linkJournalEntry: async (id, link) => void links.push({ entry_id: entry(id).id, ...link }),
		unlinkJournalEntry: async (id, ref) => void links.splice(0, links.length, ...links.filter((l) => !(l.entry_id === Number(id) && l.ref === ref))),
		linkedEntries: async (ref) => links.filter((l) => l.ref === ref).map((l) => ({ ...l, reversed: entries.get(l.entry_id)?.reversed_by_id !== null })),
		async accountLedger(code) {
			account(code);
			const lines = [];
			for (const e of entries.values()) for (const l of e.lines) if (l.account_code === String(code)) lines.push({ ...l, line_id: l.id, journal_entry_id: e.id, entry_date: e.entry_date, description: e.description, reference: e.reference });
			return { lines };
		},
	};

	const tags = {
		standard: ["paid", "billed", "overdue", "customer", "vendor", "rate"],
		of: async (entryId) => tagsOf(entryId),
		entries: async () => [],
		onChange: (fn) => listeners.push(fn),
		async set(entryId, tag, opts = {}) {
			const e = entry(entryId);
			calls.push(["set", String(e.id), tag, opts]);
			const entityId = opts.entity_id === undefined || opts.entity_id === null ? null : Number(opts.entity_id);
			if (ownAccounts && tag === "customer" && entityId !== null) {
				// The line in accounts receivable moves to the customer's own account, which then says whose
				// the entry is; a tag is kept only for an entry with no such line.
				for (const code of [...new Set(e.lines.map((l) => l.account_code))].filter(isControl)) move(e, code, ownAccount(entityId, accts.get(code).currency, accts.get(code)).code);
				if (e.lines.some((l) => accts.get(l.account_code)?.entity?.id === entityId)) {
					stored = stored.filter((t) => !(t.entry_id === e.id && t.tag === tag && t.entity_id === entityId));
					return tagsOf(e.id);
				}
			}
			stored = stored.filter((t) => !(t.entry_id === e.id && t.tag === tag && t.entity_id === entityId));
			stored.push({ id: nextTag++, entry_id: e.id, tag, entity_id: entityId, note: opts.note ?? "", module_id: "sales" });
			return tagsOf(e.id);
		},
		async remove(entryId, tag, opts = {}) {
			const e = entry(entryId);
			calls.push(["remove", String(e.id), tag, opts]);
			const entityId = opts.entity_id === undefined || opts.entity_id === null ? null : Number(opts.entity_id);
			stored = stored.filter((t) => !(t.entry_id === e.id && t.tag === tag && (entityId === null || t.entity_id === entityId)));
			if (ownAccounts && tag === "customer") {
				// Read from the customer's own account: the line goes back to accounts receivable.
				for (const code of [...new Set(e.lines.map((l) => l.account_code))]) {
					const a = accts.get(code);
					if (a?.entity?.role === "customer" && (entityId === null || a.entity.id === entityId) && isControl(a.parent_code)) move(e, code, a.parent_code);
				}
			}
			return tagsOf(e.id);
		},
	};

	/** What sits in an account: debits less credits. */
	const balance = (code) => [...entries.values()].flatMap((e) => e.lines).filter((l) => l.account_code === String(code)).reduce((s, l) => s + l.debit_cents - l.credit_cents, 0n);
	const entityAccounts = (id) => [...accts.values()].filter((a) => a.entity?.id === Number(id)).map((a) => ({ role: a.entity.role, code: a.code, currency: a.currency, owed_cents: balance(a.code) }));

	const ents_ = {
		get: async (id) => {
			const e = ents.get(Number(id));
			if (!e) throw new NotFoundError();
			return { ...e, accounts: ownAccounts ? entityAccounts(e.id) : [] };
		},
	};
	const account31 = async (entityId, role, currency) => {
		if (role !== "customer") throw new HttpError(422, "the stand-in only keeps customers' accounts");
		return { ...ownAccount(entityId, currency) };
	};
	if (ownAccounts) ents_.account = account31;

	return {
		extra: { ledger, tags, entities: ents_ },
		calls,
		links,
		listeners,
		entries,
		accounts: accts,
		entities: ents,
		balance,
		entry,
		tagsOf,
		/** The tags kept apart (not read from an account). */
		stored: () => stored.map((t) => ({ ...t })),
		/** What the customer owes by Ledger's count in a currency: their own account's balance (null: no such account). */
		owed: (entityId, currency = "CAD") => entityAccounts(entityId).find((a) => a.currency === currency)?.owed_cents ?? null,
		/**
		 * Ledger is updated to 0.31.0 (its migration 034): every line in the
		 * tagged receivable account of an entry tagged with one customer, or
		 * posted with a customer, moves to that customer's own account (the
		 * entry that reverses it goes along), and the customer tags that are now
		 * read from the account are deleted.
		 */
		update() {
			if (ownAccounts) return;
			ownAccounts = true;
			ents_.account = account31;
			for (const e of entries.values()) {
				const tagged = stored.filter((t) => t.entry_id === e.id && t.tag === "customer");
				const who = tagged.length === 1 ? tagged[0].entity_id : tagged.length === 0 && ents.get(e.entity?.id)?.is_customer ? e.entity.id : null;
				if (who === null) continue;
				for (const code of [...new Set(e.lines.map((l) => l.account_code))].filter(isControl)) move(e, code, ownAccount(who, accts.get(code).currency, accts.get(code)).code);
			}
			stored = stored.filter((t) => !(t.tag === "customer" && entry(t.entry_id).lines.some((l) => accts.get(l.account_code)?.entity?.id === t.entity_id)));
		},
	};
}
