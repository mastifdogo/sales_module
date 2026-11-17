-- Billable costs follow their invoice's payment (0.17.0): the entries of the
-- billable items an invoice bills are tagged "paid" in Ledger while that
-- invoice is paid, as well as "billed" while it stands.
ALTER TABLE documents ADD COLUMN paid_entry_ids bigint[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN documents.paid_entry_ids IS 'Journal entries of the billable items on this invoice that Sales tagged paid (while the invoice is paid)';
