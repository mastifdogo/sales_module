// Root mode (Ledger ≥ 0.21.1): an admin with root mode on (req.user.root) can
// delete or change any of Sales' records, also the ones Sales normally
// protects (issued, sent, paid, posted). Always through ctx.root, never
// Sales' own DELETE or UPDATE, so Ledger keeps each row, logs it under
// Settings → Root log and can put it back. Rows that hang off a row go first.
// No journal entries are posted or reversed here: the books are root's to fix.

const ROW_COLUMNS = {
	documents: ["status", "number", "issue_date", "due_date", "currency", "po_number", "notes", "paid_cents", "subtotal_cents", "tax_cents", "total_cents", "journal_entry_id", "void_entry_id", "sent_at", "project_id"],
	payments: ["payment_date", "amount_cents", "method", "reference", "journal_entry_id", "matched_entry_id"],
	customers: ["company", "cc_emails", "tax_id", "currency", "terms_days", "archived"],
};

export function rootRoutes(ctx, h) {
	const { T, q, bad, notFound, body, id } = h;
	const root = ctx.root;

	function needRoot(req) {
		if (!root) throw new ctx.HttpError(409, "root mode needs Ledger 0.21.1 or newer");
		if (!req.user?.root) throw new ctx.HttpError(403, "turn on root mode first (Settings → Root)");
	}

	/** Removes one document and everything that hangs off it. */
	async function removeDocument(req, did) {
		const { rows } = await q(`SELECT id, kind, number FROM ${T("documents")} WHERE id = $1`, [String(did)]);
		const doc = rows[0];
		if (!doc) throw notFound("document");
		for (const t of ["document_lines", "payments", "email_log"]) {
			for (const r of (await q(`SELECT id FROM ${T(t)} WHERE document_id = $1`, [String(did)])).rows) await root.remove(req, t, r.id);
		}
		// Other documents pointing at it (the quote it came from, the invoice it became).
		for (const col of ["source_id", "converted_id"]) {
			for (const r of (await q(`SELECT id FROM ${T("documents")} WHERE ${col} = $1`, [String(did)])).rows) await root.update(req, "documents", r.id, { [col]: null });
		}
		return root.remove(req, "documents", did, `Sales: deleted ${doc.kind} ${doc.number}`);
	}

	/** What a root change may set: the listed columns, plain values only. */
	function changes(table, o) {
		const set = {};
		for (const [k, v] of Object.entries(o)) {
			if (!ROW_COLUMNS[table].includes(k)) throw bad(`${k} can't be changed here`);
			if (v !== null && !["string", "number", "boolean"].includes(typeof v)) throw bad(`${k} must be a plain value`);
			set[k] = v;
		}
		if (Object.keys(set).length === 0) throw bad("nothing to change");
		return set;
	}

	ctx.route("DELETE", "/root/documents/:id", async (req) => {
		needRoot(req);
		await removeDocument(req, id(req, "id", "document"));
		return { deleted: true };
	});

	ctx.route("PATCH", "/root/documents/:id", async (req) => {
		needRoot(req);
		const did = id(req, "id", "document");
		const { rows } = await q(`SELECT number FROM ${T("documents")} WHERE id = $1`, [did]);
		if (!rows[0]) throw notFound("document");
		const set = changes("documents", body(req));
		await root.update(req, "documents", did, set, `Sales: changed ${rows[0].number} (${Object.keys(set).join(", ")})`);
		return { changed: true };
	});

	// A payment: removed, and what's paid on its invoice brought back in line.
	ctx.route("DELETE", "/root/payments/:id", async (req) => {
		needRoot(req);
		const pid = id(req, "id", "payment");
		const { rows } = await q(
			`SELECT p.id, p.amount_cents, d.id AS document_id, d.number, d.status, d.paid_cents, d.total_cents
			   FROM ${T("payments")} p JOIN ${T("documents")} d ON d.id = p.document_id WHERE p.id = $1`,
			[pid],
		);
		const p = rows[0];
		if (!p) throw notFound("payment");
		await root.remove(req, "payments", pid, `Sales: deleted a payment on ${p.number}`);
		const paid = BigInt(p.paid_cents) - BigInt(p.amount_cents);
		const set = { paid_cents: (paid < 0n ? 0n : paid).toString() };
		if (p.status === "paid" && paid < BigInt(p.total_cents)) set.status = "open";
		await root.update(req, "documents", p.document_id, set, `Sales: ${p.number} after removing a payment`);
		return { deleted: true };
	});

	// A customer: its documents first (with everything on them), then Sales' row.
	// The customer's entry in Ledger's shared list stays.
	ctx.route("DELETE", "/root/customers/:id", async (req) => {
		needRoot(req);
		const cid = id(req, "id", "customer");
		const { rows } = await q(`SELECT id FROM ${T("customers")} WHERE id = $1`, [cid]);
		if (!rows[0]) throw notFound("customer");
		for (const d of (await q(`SELECT id FROM ${T("documents")} WHERE customer_id = $1 ORDER BY id DESC`, [cid])).rows) await removeDocument(req, d.id);
		await root.remove(req, "customers", cid, `Sales: deleted customer ${cid}`);
		return { deleted: true };
	});

	// A project, whatever is on it: its documents leave it, its cost assignments go.
	ctx.route("DELETE", "/root/projects/:id", async (req) => {
		needRoot(req);
		const pid = id(req, "id", "project");
		const { rows } = await q(`SELECT name FROM ${T("projects")} WHERE id = $1`, [pid]);
		if (!rows[0]) throw notFound("project");
		for (const d of (await q(`SELECT id FROM ${T("documents")} WHERE project_id = $1`, [pid])).rows) await root.update(req, "documents", d.id, { project_id: null });
		for (const c of (await q(`SELECT id FROM ${T("project_costs")} WHERE project_id = $1`, [pid])).rows) await root.remove(req, "project_costs", c.id);
		await root.remove(req, "projects", pid, `Sales: deleted project ${rows[0].name}`);
		return { deleted: true };
	});

	// What must be put right before root mode can be left.
	root?.onCheck(async () => {
		const problems = [];
		const empty = await q(
			`SELECT d.kind, d.number FROM ${T("documents")} d
			  WHERE d.status <> 'draft' AND NOT EXISTS (SELECT 1 FROM ${T("document_lines")} l WHERE l.document_id = d.id)
			  ORDER BY d.id LIMIT 20`,
		);
		for (const r of empty.rows) problems.push(`${r.kind} ${r.number} is ${r.kind === "invoice" ? "issued" : "sent"} but has no lines.`);
		const paid = await q(
			`SELECT d.number, d.paid_cents, coalesce(sum(p.amount_cents), 0) AS payments
			   FROM ${T("documents")} d LEFT JOIN ${T("payments")} p ON p.document_id = d.id
			  WHERE d.kind = 'invoice' GROUP BY d.id HAVING d.paid_cents <> coalesce(sum(p.amount_cents), 0) ORDER BY d.id LIMIT 20`,
		);
		for (const r of paid.rows) problems.push(`invoice ${r.number} says ${r.paid_cents} cents paid, but its payments add up to ${r.payments}.`);
		const status = await q(
			`SELECT number, status FROM ${T("documents")}
			  WHERE kind = 'invoice' AND ((status = 'paid' AND paid_cents < total_cents) OR (status = 'open' AND total_cents > 0 AND paid_cents >= total_cents) OR status = 'posting')
			  ORDER BY id LIMIT 20`,
		);
		const foreign = await q(
			`SELECT d.kind, d.number, p.name FROM ${T("documents")} d JOIN ${T("projects")} p ON p.id = d.project_id
			  WHERE p.customer_id <> d.customer_id ORDER BY d.id LIMIT 20`,
		);
		for (const r of foreign.rows) problems.push(`${r.kind} ${r.number} is on project ${r.name}, which is another customer's.`);
		for (const r of status.rows) problems.push(`invoice ${r.number} is "${r.status}", which doesn't match what's paid on it.`);
		return problems;
	});
}
