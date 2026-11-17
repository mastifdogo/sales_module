-- Projects (0.17.0): a piece of work for one customer. Invoices, quotes and
-- estimates can belong to one, and so can billable costs (by the journal
-- line in Ledger), so a project's page shows what was quoted, invoiced,
-- paid and still owed for it.
CREATE TABLE projects (
    id          bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id bigint  NOT NULL REFERENCES customers (id),
    name        text    NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    notes       text    NOT NULL DEFAULT '' CHECK (length(notes) <= 5000),
    status      text    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
    created_by  text    NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE projects IS 'Projects of a customer; invoices, quotes, estimates and billable costs can belong to one';
CREATE UNIQUE INDEX projects_customer_name_idx ON projects (customer_id, lower(name));

ALTER TABLE documents ADD COLUMN project_id bigint REFERENCES projects (id);
COMMENT ON COLUMN documents.project_id IS 'The project this invoice, quote or estimate is for, if any';
CREATE INDEX documents_project_idx ON documents (project_id) WHERE project_id IS NOT NULL;

-- Billable costs assigned to a project before they are invoiced: a journal
-- line in Ledger (in Sales' clearing account or another billable account).
CREATE TABLE project_costs (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ledger_line_id bigint NOT NULL UNIQUE,
    project_id     bigint NOT NULL REFERENCES projects (id),
    assigned_by    text   NOT NULL DEFAULT '',
    assigned_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE project_costs IS 'Billable costs (journal lines in Ledger) assigned to a project';
COMMENT ON COLUMN project_costs.ledger_line_id IS 'Id of the journal line in Ledger (the billable cost)';
