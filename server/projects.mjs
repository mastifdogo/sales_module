// Projects (0.17.0): a piece of work for one customer, a grouping inside
// Sales (nothing in the chart of accounts). Invoices, quotes and estimates
// can belong to a project (documents.project_id), and so can billable costs
// before they are invoiced (project_costs, by Ledger's journal line), so a
// project shows what was quoted, invoiced, paid and is still owed for it.

import { CURRENCIES } from "./common.mjs";

export function projectRoutes(ctx, h, billable) {
	const { T, q, bad, notFound, conflict, body, text, id, isId, CUSTOMERS } = h;

	// Per currency: quoted (quotes and estimates not declined), invoiced (issued
	// invoices), paid (on them; an invoice tagged paid in Ledger counts in full)
	// and outstanding (what's still owed).
	const TOTALS = (alias) => `(
		SELECT coalesce(jsonb_agg(t ORDER BY t.currency), '[]') FROM (
			SELECT d.currency,
			       sum(CASE WHEN d.kind <> 'invoice' AND d.status <> 'declined' THEN d.total_cents ELSE 0 END)::bigint AS quoted_cents,
			       sum(CASE WHEN d.kind = 'invoice' AND d.status IN ('open', 'paid') THEN d.total_cents ELSE 0 END)::bigint AS invoiced_cents,
			       sum(CASE WHEN d.kind = 'invoice' AND d.status IN ('open', 'paid')
			                THEN CASE WHEN d.status = 'open' AND d.paid_by_tag THEN d.total_cents ELSE d.paid_cents END ELSE 0 END)::bigint AS paid_cents,
			       sum(CASE WHEN d.kind = 'invoice' AND d.status = 'open' AND NOT d.paid_by_tag THEN d.total_cents - d.paid_cents ELSE 0 END)::bigint AS outstanding_cents
			  FROM ${T("documents")} d WHERE d.project_id = ${alias}.id GROUP BY d.currency
		) t) AS totals`;

	const SELECT = `
		SELECT p.id, p.customer_id, p.name, p.notes, p.status, p.created_by, p.created_at, p.updated_at,
		       c.name AS customer_name, c.company AS customer_company, c.currency AS customer_currency,
		       (SELECT count(*)::int FROM ${T("documents")} d WHERE d.project_id = p.id) AS document_count,
		       ${TOTALS("p")}
		  FROM ${T("projects")} p JOIN ${CUSTOMERS} c ON c.id = p.customer_id`;

	async function getProject(pid) {
		const { rows } = await q(`${SELECT} WHERE p.id = $1`, [String(pid)]);
		if (!rows[0]) throw notFound("project");
		return rows[0];
	}

	function input(o, partial) {
		const out = {};
		if (!partial || "name" in o) {
			out.name = text(o, "name", 120, { required: true });
		}
		if (!partial || "notes" in o) out.notes = text(o, "notes", 5000, { multiline: true });
		if ("status" in o) {
			if (!["active", "closed"].includes(o.status)) throw bad("status must be active or closed");
			out.status = o.status;
		}
		return out;
	}

	const nameTaken = (e) => {
		if (e?.code === "23505") throw conflict("this customer already has a project with that name");
		throw e;
	};

	ctx.route("GET", "/projects", async (req) => {
		const customer = req.query.get("customer_id") ?? "";
		if (customer && !isId(customer)) throw bad("customer_id is not valid");
		const status = req.query.get("status") ?? "";
		if (status && !["active", "closed"].includes(status)) throw bad("status must be active or closed");
		const search = (req.query.get("q") ?? "").trim();
		const { rows } = await q(
			`${SELECT}
			  WHERE ($1 = '' OR p.customer_id = nullif($1, '')::bigint)
			    AND ($2 = '' OR p.status = $2)
			    AND ($3 = '' OR p.name ILIKE $4 OR c.name ILIKE $4)
			  ORDER BY p.status, lower(c.name), lower(p.name), p.id
			  LIMIT 1000`,
			[customer, status, search, h.like(search)],
		);
		return { data: rows };
	});

	ctx.route("POST", "/projects", async (req) => {
		const o = body(req);
		if (!isId(o.customer_id)) throw bad("customer_id is required");
		const { rows } = await q(`SELECT id, archived FROM ${CUSTOMERS} c WHERE id = $1`, [String(o.customer_id)]);
		if (!rows[0]) throw bad("customer_id: there is no such customer");
		if (rows[0].archived) throw bad("customer_id: this customer is archived");
		const p = input(o, false);
		const r = await q(
			`INSERT INTO ${T("projects")} (customer_id, name, notes, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
			[String(o.customer_id), p.name, p.notes, req.user.username],
		).catch(nameTaken);
		return ctx.response(201, await getProject(r.rows[0].id));
	});

	ctx.route("GET", "/projects/:id", async (req) => {
		const p = await getProject(id(req, "id", "project"));
		const docs = await q(
			`SELECT id, kind, number, status, issue_date::text, due_date::text, currency, total_cents, paid_cents,
			        d.status = 'open' AND d.paid_by_tag AS paid_by_tag
			   FROM ${T("documents")} d WHERE project_id = $1 ORDER BY issue_date DESC, id DESC`,
			[String(p.id)],
		);
		// The customer's unbilled costs that are this project's, or no project's yet.
		const costs = [];
		const problems = [];
		for (const cur of CURRENCIES) {
			const r = await billable.forCustomer(String(p.customer_id), cur);
			problems.push(...r.problems);
			for (const it of r.items) if (!it.credit && (it.project_id === null || String(it.project_id) === String(p.id))) costs.push({ ...it, currency: cur });
		}
		return { ...p, documents: docs.rows, costs, problems: [...new Set(problems)] };
	});

	ctx.route("PUT", "/projects/:id", async (req) => {
		const pid = id(req, "id", "project");
		await getProject(pid);
		const p = input(body(req), true);
		const cols = Object.keys(p);
		if (cols.length) {
			await q(`UPDATE ${T("projects")} SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [pid, ...Object.values(p)]).catch(nameTaken);
		}
		return getProject(pid);
	});

	// Only a project nothing belongs to yet; close it otherwise (root can delete any).
	ctx.route("DELETE", "/projects/:id", async (req) => {
		const pid = id(req, "id", "project");
		const p = await getProject(pid);
		if (p.document_count > 0) throw conflict("this project has invoices, quotes or estimates; close it instead");
		await q(
			`WITH c AS (DELETE FROM ${T("project_costs")} WHERE project_id = $1)
			 DELETE FROM ${T("projects")} WHERE id = $1`,
			[pid],
		);
	});

	// Assigns billable costs (Ledger journal lines) to the project, or takes them off.
	ctx.route("PUT", "/projects/:id/costs", async (req) => {
		const pid = id(req, "id", "project");
		const p = await getProject(pid);
		const o = body(req);
		if (!Array.isArray(o.line_ids) || o.line_ids.length === 0 || o.line_ids.length > 500 || !o.line_ids.every(isId)) throw bad("line_ids must list the billable costs");
		if (typeof o.assigned !== "boolean") throw bad("assigned must be true or false");
		const ids = [...new Set(o.line_ids.map(String))];
		if (!o.assigned) {
			await q(`DELETE FROM ${T("project_costs")} WHERE project_id = $1 AND ledger_line_id = ANY($2::bigint[])`, [pid, ids]);
			return getProject(pid);
		}
		if (p.status !== "active") throw conflict("this project is closed");
		const open = new Map();
		for (const cur of CURRENCIES) for (const it of (await billable.forCustomer(String(p.customer_id), cur)).items) if (!it.credit) open.set(String(it.line_id), it);
		const missing = ids.filter((x) => !open.has(x));
		if (missing.length) throw conflict(`${missing.length} of these costs aren't unbilled costs of ${p.customer_name} any more; reload`);
		const other = ids.filter((x) => open.get(x).project_id !== null && String(open.get(x).project_id) !== String(pid));
		if (other.length) throw conflict(`${other.length} of these costs belong to another project; take them off it first`);
		await q(
			`INSERT INTO ${T("project_costs")} (ledger_line_id, project_id, assigned_by)
			 SELECT x, $1, $3 FROM unnest($2::bigint[]) x
			 ON CONFLICT (ledger_line_id) DO NOTHING`,
			[pid, ids, req.user.username],
		);
		return getProject(pid);
	});

	return { getProject };
}
