// Sales for Ledger: invoices, quotes, estimates, customers, sales taxes and
// categories. Ledger loads this file at startup and calls register(ctx); the
// API it gets is described in Ledger's docs/MODULES.md. Every route is under
// /api/v1/m/sales.

import { catalogRoutes } from "./server/catalog.mjs";
import { helpers } from "./server/common.mjs";
import { csvImport, importRoutes } from "./server/imports.mjs";
import { customerRoutes } from "./server/customers.mjs";
import { dashboardSync } from "./server/dashboard.mjs";
import { copyDocumentSettings, documentSettingsRoutes } from "./server/document-settings.mjs";
import { documentRoutes } from "./server/documents.mjs";
import { mailHelpers } from "./server/email.mjs";
import { moveSettings } from "./server/move-settings.mjs";
import { paymentRoutes } from "./server/payments.mjs";
import { rootRoutes } from "./server/root.mjs";
import { searchProvider } from "./server/search.mjs";
import { settingsRoutes } from "./server/settings.mjs";
import { entryTags } from "./server/tags.mjs";

export default async function register(ctx) {
	const h = helpers(ctx);
	// Ledger's shared tags on journal entries (Ledger ≥ 0.23.0); does nothing on an older one.
	const tags = entryTags(ctx, h);
	const dashboard = dashboardSync(ctx, h, tags);
	// Every successful change (anything but GET) refreshes the dashboard items.
	const routes = Object.create(ctx);
	routes.route = (method, path, handler) =>
		ctx.route(method, path, async (req) => {
			const result = await handler(req);
			if (method !== "GET") dashboard.schedule(req.user?.organization?.id);
			return result;
		});

	const mail = mailHelpers(routes, h);
	settingsRoutes(routes, h, mail);
	documentSettingsRoutes(routes, h);
	catalogRoutes(routes, h);
	const customers = customerRoutes(routes, h);
	const docs = documentRoutes(routes, h, mail, tags);
	paymentRoutes(routes, h, docs);
	rootRoutes(routes, h);
	importRoutes(routes, h, dashboard, customers);
	csvImport(ctx, h, customers);
	searchProvider(ctx, h);
	// Startup runs in the main books; each organization has its own documents
	// and (Ledger ≥ 0.11.1) its own settings, so visit each one.
	await ctx.orgs.forEach(async (org) => {
		await moveSettings(ctx, h, org);
		await copyDocumentSettings(ctx, h, org);
		await docs.makeClearingAccounts(org);
		await docs.recover(org);
	});
	// An invoice tagged paid (or no longer) by a person or another module: its lists and reminders follow.
	tags.listen((org) => dashboard.schedule(org?.id));
	// The first sync also tags the invoices issued before the tags existed.
	dashboard.start();
	ctx.log.info("sales module ready", { dashboard: Boolean(ctx.dashboard) });
}
