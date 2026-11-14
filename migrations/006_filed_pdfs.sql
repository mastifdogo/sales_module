-- The PDF of an invoice, quote or estimate, as it was last issued or emailed,
-- is filed in Ledger's PDF store (Documents, Ledger 0.19.0). Sales keeps only
-- the id of that stored document; the file itself is Ledger's.
ALTER TABLE documents ADD COLUMN pdf_document_id bigint;
COMMENT ON COLUMN documents.pdf_document_id IS 'The id of this document''s PDF in Ledger''s Documents (the PDF store), once issued or emailed';
