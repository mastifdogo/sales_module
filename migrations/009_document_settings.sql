-- Invoice, quote and estimate settings get a tab each under Settings → Sales
-- (0.11.0), drawn by Sales below Ledger's form, so they move out of Ledger's
-- form into this table: one row per kind. Sales copies each organization's
-- current values in once when it starts (document_settings_copied).
CREATE TABLE document_settings (
    kind           text PRIMARY KEY CHECK (kind IN ('invoice', 'quote', 'estimate')),
    number_prefix  text NOT NULL CHECK (length(number_prefix) <= 20),
    -- Invoices: days until due (payment terms). Quotes and estimates: days valid.
    days           int  NOT NULL CHECK (days BETWEEN 0 AND 365),
    -- Printed at the bottom of the PDF.
    terms          text NOT NULL DEFAULT '' CHECK (length(terms) <= 5000),
    email_subject  text NOT NULL CHECK (length(email_subject) BETWEEN 1 AND 300),
    email_message  text NOT NULL CHECK (length(email_message) BETWEEN 1 AND 10000),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE document_settings IS 'Settings for each kind of document: number prefix, days, printed terms, email text';

INSERT INTO document_settings (kind, number_prefix, days, terms, email_subject, email_message) VALUES
    ('invoice', 'INV-', 30, '',
     'Invoice {{number}} from {{business}}',
     E'Hello {{customer}},\n\nPlease find attached invoice {{number}} for {{total}}, due {{due_date}}.\n\nThank you for your business.\n{{business}}'),
    ('quote', 'QUO-', 30, 'Prices are fixed until the date above. To accept, reply to this email.',
     'Quote {{number}} from {{business}}',
     E'Hello {{customer}},\n\nPlease find attached quote {{number}} for {{total}}, valid until {{due_date}}.\n\nLet us know if you have any questions.\n{{business}}'),
    ('estimate', 'EST-', 30, 'This is an estimate, not a fixed price. The final invoice may differ.',
     'Estimate {{number}} from {{business}}',
     E'Hello {{customer}},\n\nPlease find attached estimate {{number}} for {{total}}, valid until {{due_date}}.\n\nLet us know if you have any questions.\n{{business}}');

ALTER TABLE settings ADD COLUMN document_settings_copied boolean NOT NULL DEFAULT false;
