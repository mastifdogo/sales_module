-- Billable items (0.10.0): an invoice line can bill amounts posted in Ledger
-- to the "Billable items" accounts (Settings → Sales) for its customer. The
-- line keeps which of Ledger's journal lines it bills, so an item is billed
-- only once; a void invoice or a deleted draft frees them again.
ALTER TABLE document_lines ADD COLUMN billed_ledger_line_ids bigint[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN document_lines.billed_ledger_line_ids IS 'Ids of the journal lines in Ledger (billable items) this invoice line bills';
