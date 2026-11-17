import { test } from "node:test";
import assert from "node:assert/strict";
import { rateItems } from "../server/billable.mjs";

test("rateItems reads Ledger's rate tags as invoice line items", () => {
	const tags = [
		{ id: 1, tag: "vendor", entity: { id: 4, name: "Hydro One" } },
		{ id: 7, tag: "rate", description: " Labour ", quantity: 7.5, unit: "hours", rate_cents: 8000 },
		{ id: 8, tag: "rate", description: null, quantity: null, unit: null, rate_cents: 2500 },
		{ id: 9, tag: "rate", description: "Empty", quantity: null, unit: null, rate_cents: null },
	];
	assert.deepEqual(rateItems(tags), [
		{ id: "7", description: "Labour", quantity: "7.5", unit: "hours", rate_cents: "8000", amount_cents: "60000" },
		{ id: "8", description: "", quantity: null, unit: "", rate_cents: "2500", amount_cents: "2500" },
	]);
	assert.deepEqual(rateItems(undefined), []);
	assert.deepEqual(rateItems([{ id: 3, tag: "rate", quantity: "2", rate_cents: null }]), [
		{ id: "3", description: "", quantity: "2", unit: "", rate_cents: null, amount_cents: null },
	]);
});
