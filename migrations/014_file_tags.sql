-- Ledger's shared tags on files and the data kept with a file (Ledger
-- 0.27.0, Sales 0.19.0). The PDF of an invoice that Sales filed in Ledger's
-- Documents carries "billed", "paid" and "overdue" like the invoice's journal
-- entry does, and what Sales knows about the document is saved with the file
-- (its extraction), so no other module has to read the PDF.
--
-- file_tags: the tags Sales knows to be on the filed PDF, so a sync only
-- calls Ledger for invoices whose tags should change (as entry_tags does for
-- the entry).
ALTER TABLE documents ADD COLUMN file_tags text[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN documents.file_tags IS 'Ledger file tags known to be on this invoice''s PDF in Ledger''s Documents: billed, paid, overdue';

-- file_data_status: the document's status as last saved in the data kept
-- with its PDF. NULL: Sales has saved no data with the current PDF yet.
ALTER TABLE documents ADD COLUMN file_data_status text;
COMMENT ON COLUMN documents.file_data_status IS 'The status last saved in the data kept with this document''s PDF in Ledger''s Documents; NULL when none is saved yet';

-- A tag changed on a file in Ledger is looked up by the file's id.
CREATE INDEX documents_pdf_document_idx ON documents (pdf_document_id) WHERE pdf_document_id IS NOT NULL;
