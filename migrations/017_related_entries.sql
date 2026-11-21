-- Linked entries (Ledger 0.28.0): an invoice's entry is linked to the entries
-- of the costs and credit memos it bills, so each shows on the other's page
-- in Ledger. The entries Sales linked it to; NULL: not worked out yet.
ALTER TABLE documents ADD COLUMN related_entry_ids bigint[];
COMMENT ON COLUMN documents.related_entry_ids IS 'The journal entries (billed costs, applied credit memos) Sales linked this invoice''s entry to in Ledger; NULL: not worked out yet';
