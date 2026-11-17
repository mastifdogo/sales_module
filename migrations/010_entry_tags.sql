-- Ledger's shared tags on journal entries (Ledger 0.23.0, Sales 0.16.0).
-- Sales keeps "customer", "billed", "paid" and "overdue" true on each issued
-- invoice's entry, and "billed" on the entries of the billable costs it bills.
--
-- entry_tags: the tags Sales knows to be on the invoice's entry ("billed",
-- "paid", "overdue", "customer:<entity id>"), so a sync only calls Ledger
-- for invoices whose tags should change.
ALTER TABLE documents ADD COLUMN entry_tags text[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN documents.entry_tags IS 'Ledger tags known to be on the invoice''s journal entry: billed, paid, overdue, customer:<entity id>';

-- The invoice's entry was tagged "paid" by a person or another module while
-- Sales holds no payment for it: Sales shows it as paid and leaves it out of
-- the open and overdue lists, without recording a payment or posting anything.
ALTER TABLE documents ADD COLUMN paid_by_tag boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN documents.paid_by_tag IS 'The invoice''s journal entry is tagged paid in Ledger by someone else; no payment is recorded in Sales';

-- The journal entries of the billable items this invoice bills, tagged
-- "billed" when it is issued. NULL: not worked out yet.
ALTER TABLE documents ADD COLUMN billed_entry_ids bigint[];
COMMENT ON COLUMN documents.billed_entry_ids IS 'Journal entries of the billable items on this invoice that Sales tagged billed; NULL until worked out';
