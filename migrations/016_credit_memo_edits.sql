-- Credit memos can be edited until an invoice takes them (0.20.2): who last
-- changed one and when. The change posts a corrected entry and reverses the
-- old one; the memo keeps its number.
ALTER TABLE credit_memos ADD COLUMN edited_at timestamptz;
ALTER TABLE credit_memos ADD COLUMN edited_by text NOT NULL DEFAULT '';
