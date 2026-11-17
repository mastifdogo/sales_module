-- Invoice lines filled from a billable cost's rate item (Ledger's tag "rate",
-- Ledger 0.24.0; several per entry from 0.25.0). The line keeps which item
-- (the tag's id) it came from: its description is that item's, and one cost
-- may be split over several lines, one per item.
ALTER TABLE document_lines ADD COLUMN rate_tag_id bigint;
COMMENT ON COLUMN document_lines.rate_tag_id IS 'The rate item (Ledger tag id) of the billed cost this line was filled from, if any';
