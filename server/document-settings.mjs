// Settings for each kind of document (invoice, quote, estimate): number
// prefix and next number, days (payment terms, or valid for), terms printed
// on the PDF, and the email subject and message. Up to 0.10.0 these were in
// Ledger's settings form; from 0.11.0 they're in Sales' own table and shown
// as a tab each below that form (ui/setup.html), because Ledger's form can't
// make tabs.

export const DOC_KINDS = ["invoice", "quote", "estimate"];

// Where each column's value was in Ledger's form (and in the pre-0.2.0 table).
const FROM_FORM = {
	invoice: { number_prefix: "invoice_prefix", days: "default_terms_days", terms: null, email_subject: "email_subject", email_message: "email_body" },
	quote: { number_prefix: "quote_prefix", days: "quote_valid_days", terms: "quote_terms", email_subject: "quote_email_subject", email_message: "quote_email_body" },
	estimate: { number_prefix: "estimate_prefix", days: "estimate_valid_days", terms: "estimate_terms", email_subject: "quote_email_subject", email_message: "quote_email_body" },
};

/**
 * Copies an organization's values from Ledger's form into document_settings,
 * once (run inside ctx.orgs.forEach at startup). Values the form never saved
 * come from the pre-0.2.0 table, else the defaults stay.
 */
export async function copyDocumentSettings(ctx, h, org = null) {
	const { rows } = await h.q(`SELECT * FROM ${h.T("settings")} WHERE id = 1 AND NOT document_settings_copied`);
	const old = rows[0];
	if (!old) return;
	let form = {};
	try {
		// The fields left the manifest, so ctx.settings no longer returns them;
		// read what Ledger stored for Sales (read-only).
		const r = await h.q(`SELECT "values" FROM public.module_settings WHERE module_id = $1`, ["sales"]);
		form = r.rows[0]?.values ?? {};
	} catch (e) {
		ctx.log.warn("could not read Sales' old settings from Ledger; keeping the defaults", { err: e.message });
	}
	const pick = (key, type) => {
		for (const src of [form[key], old[key]]) {
			if (type === "number" ? Number.isInteger(src) : typeof src === "string" && src.trim() !== "") return src;
		}
		return undefined;
	};
	let copied = 0;
	for (const kind of DOC_KINDS) {
		const map = FROM_FORM[kind];
		const set = {};
		for (const [col, key] of Object.entries(map)) {
			if (!key) continue;
			const v = pick(key, col === "days" ? "number" : "text");
			if (v === undefined) continue;
			// The shared quote/estimate email used {{type}}: give each its own words.
			set[col] = typeof v === "string" && kind !== "invoice" ? v.replaceAll("{{type}}", kind === "quote" ? "Quote" : "Estimate").replaceAll("{{type_lower}}", kind) : v;
		}
		const ok = {
			number_prefix: (v) => v.length <= 20,
			days: (v) => v >= 0 && v <= 365,
			terms: (v) => v.length <= 5000,
			email_subject: (v) => v.length <= 300,
			email_message: (v) => v.length <= 10000,
		};
		const cols = Object.keys(set).filter((c) => ok[c](set[c]));
		if (cols.length === 0) continue;
		await h.q(`UPDATE ${h.T("document_settings")} SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now() WHERE kind = $1`, [kind, ...cols.map((c) => set[c])]);
		copied += cols.length;
	}
	await h.q(`UPDATE ${h.T("settings")} SET document_settings_copied = true WHERE id = 1`);
	ctx.log.info("document settings copied from Ledger's form", { values: copied, ...(org ? { organization: org.name } : {}) });
}

export function documentSettingsRoutes(ctx, h) {
	const { T, q, bad, notFound, body, text, intIn, requireAdmin } = h;

	async function all() {
		const [docs, counters] = await Promise.all([
			q(`SELECT kind, number_prefix, days, terms, email_subject, email_message, updated_at FROM ${T("document_settings")}`),
			q(`SELECT next_invoice_number, next_quote_number, next_estimate_number FROM ${T("settings")} WHERE id = 1`),
		]);
		const byKind = new Map(docs.rows.map((r) => [r.kind, r]));
		return DOC_KINDS.map((kind) => ({ ...byKind.get(kind), kind, next_number: Number(counters.rows[0]?.[`next_${kind}_number`] ?? 1) }));
	}

	ctx.route("GET", "/document-settings", async () => ({ data: await all() }));

	ctx.route("PUT", "/document-settings/:kind", async (req) => {
		requireAdmin(req);
		const kind = req.params.kind;
		if (!DOC_KINDS.includes(kind)) throw notFound("kind of document");
		const o = body(req);
		const set = {};
		if ("number_prefix" in o) {
			set.number_prefix = text(o, "number_prefix", 20);
			if (/[\\/]/.test(set.number_prefix)) throw bad("number_prefix can't contain slashes");
		}
		if ("days" in o) set.days = intIn(o.days, "days", 0, 365);
		if ("terms" in o) set.terms = text(o, "terms", 5000, { multiline: true });
		if ("email_subject" in o) set.email_subject = text(o, "email_subject", 300, { required: true });
		if ("email_message" in o) set.email_message = text(o, "email_message", 10000, { required: true, multiline: true });
		const cols = Object.keys(set);
		if (cols.length) await q(`UPDATE ${T("document_settings")} SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now() WHERE kind = $1`, [kind, ...cols.map((c) => set[c])]);
		if ("next_number" in o) {
			const n = intIn(o.next_number, "next_number", 1, 999_999_999);
			await q(`UPDATE ${T("settings")} SET next_${kind}_number = $1, updated_at = now() WHERE id = 1`, [n]);
		}
		return (await all()).find((d) => d.kind === kind);
	});
}
