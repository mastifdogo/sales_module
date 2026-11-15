-- Account codes get columns of their own. People can renumber an account in
-- Ledger (0.19.3); Ledger then rewrites the old code in module tables, but
-- only in text columns named like *_account, never inside JSON. Each tax and
-- category kept its codes in a JSON map ({"CAD": "4100"}); they move here.
ALTER TABLE taxes ADD COLUMN cad_payable_account text, ADD COLUMN usd_payable_account text;
COMMENT ON COLUMN taxes.cad_payable_account IS 'Ledger account this tax is owed to, for CAD documents';
COMMENT ON COLUMN taxes.usd_payable_account IS 'Ledger account this tax is owed to, for USD documents';
UPDATE taxes SET cad_payable_account = nullif(accounts ->> 'CAD', ''), usd_payable_account = nullif(accounts ->> 'USD', '');
ALTER TABLE taxes DROP COLUMN accounts;

ALTER TABLE categories ADD COLUMN cad_revenue_account text, ADD COLUMN usd_revenue_account text;
COMMENT ON COLUMN categories.cad_revenue_account IS 'Ledger revenue account for this category''s CAD sales (empty: the default in Settings)';
COMMENT ON COLUMN categories.usd_revenue_account IS 'Ledger revenue account for this category''s USD sales (empty: the default in Settings)';
UPDATE categories SET cad_revenue_account = nullif(accounts ->> 'CAD', ''), usd_revenue_account = nullif(accounts ->> 'USD', '');
ALTER TABLE categories DROP COLUMN accounts;
