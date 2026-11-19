-- Credit memos (0.20.0): an amount credited to a customer against the income
-- from them. Creating one posts Dr revenue / Cr Sales' clearing account
-- "Customer credits to apply" (a liability, one per currency), with the
-- customer as the entry's entity. The credit then shows among that
-- customer's billable items, and an invoice that takes it debits the clearing
-- account back to zero and lowers what the customer owes.
CREATE TABLE credit_memos (
    id               bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    number           text    NOT NULL UNIQUE,
    customer_id      bigint  NOT NULL REFERENCES customers (id),
    memo_date        date    NOT NULL,
    currency         text    NOT NULL CHECK (currency IN ('CAD', 'USD')),
    amount_cents     bigint  NOT NULL CHECK (amount_cents > 0),
    category_id      bigint  REFERENCES categories (id) ON DELETE SET NULL,
    description      text    NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
    status           text    NOT NULL DEFAULT 'posting' CHECK (status IN ('posting', 'open', 'void')),
    journal_entry_id bigint,
    ledger_line_id   bigint,
    void_entry_id    bigint,
    created_by       text    NOT NULL DEFAULT '',
    created_at       timestamptz NOT NULL DEFAULT now(),
    voided_at        timestamptz
);
COMMENT ON TABLE credit_memos IS 'Credits to customers, posted against revenue into the clearing account "Customer credits to apply" and applied on an invoice as a billable item';
COMMENT ON COLUMN credit_memos.ledger_line_id IS 'The journal line that credits the clearing account: the billable item an invoice bills to apply it';
CREATE INDEX credit_memos_customer_idx ON credit_memos (customer_id);

ALTER TABLE settings ADD COLUMN next_credit_memo_number int NOT NULL DEFAULT 1 CHECK (next_credit_memo_number > 0);
