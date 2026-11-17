---
name: ledger-module
description: Work on this Ledger module (a plugin for the Ledger bookkeeping app, installed from this GitHub repository): add features, fix bugs, update it for new Ledger versions, check it, and release it. Use for any change to this repository's module code, manifest, migrations, UI or releases.
---

# Working on this Ledger module

This repository is a **Ledger module**: `ledger-module.json` (manifest),
`server.mjs` (runs inside the Ledger server), `ui/` (its page in Ledger) and
`migrations/` (SQL in its own schema). Ledger installs the latest GitHub
Release of this repository. Ledger itself is
[mastifdogo/Bookeeping](https://github.com/mastifdogo/Bookeeping).

## Push to `main` without asking

**When work on this module is finished and its checks pass, commit and push
it to `main` of this repository straight away. Do not ask "shall I push?",
do not wait for a go-ahead, do not leave it on a branch, and do not open a
pull request.** The owner has asked for this as a standing rule: every
finished change goes to `main`, where the release workflow publishes the new
version. Asking first is the mistake.

- Bump `version` in `ledger-module.json` in the same push, so it releases.
- After pushing, say what was pushed and the new version; don't ask whether
  to release it, it already is.
- If your environment gives you a different work branch, push there as it
  requires and then to `main` as well.
- Don't push only if: the checks fail; the user said in this conversation
  not to; or the change belongs in Ledger's repository, not this one.

## 1. Get a Ledger checkout and read the module API

The API reference and the full workflow live in the Ledger repository.

- Use `$LEDGER_DIR`, a sibling checkout (`../Accounting`, `../Bookeeping`),
  or clone one: `git clone --depth 1 https://github.com/mastifdogo/Bookeeping /tmp/ledger-for-modules`
  (`scripts/check.sh` does this for you).
- Read **`<ledger>/docs/MODULE_LLM_CONTEXT.md`** in full before changing
  anything: manifest, `ctx` API and return shapes, `ctx.settings`,
  `ctx.dashboard`, `ctx.llm`, `ctx.mail`, `ctx.documents`, `ctx.search`, roles, migrations,
  UI and security rules.
- Then follow **`<ledger>/.claude/skills/ledger-module/SKILL.md`** (design
  rules, implementation rules, checks, publishing). Treat this repository as
  the module directory it talks about. Where the docs and Ledger's code
  disagree, the code wins (`backend/src/module-host.ts`, `modules.ts`,
  `module-settings.ts`).

Set `"ledger": ">=x.y.z"` in the manifest to the oldest Ledger with every
feature the module uses (the context file says which version added what;
`git -C <ledger> describe --tags --abbrev=0` is the latest release).

## 2. Rules that bite

- No npm packages at runtime: Ledger installs the release as-is. Only
  `node:*` built-ins, global `fetch`, and this repo's own files. (A
  `package.json` here is only for running tests.)
- Never edit a released migration; add the next `NNN_name.sql`.
- Money is integer cents per currency; post to the books only with
  `ctx.ledger.createJournalEntry(entry, req.user)`, with `links` to the
  record it came from (Ledger ≥ 0.11.2).
- AI goes through `ctx.llm` (stay provider-neutral: never branch on the
  provider or model, validate `json()` data) and mail through `ctx.mail`
  (Ledger ≥ 0.18.3), not `ctx.gmail`: no API keys, OAuth, IMAP or SMTP of
  the module's own for those. The admin allows the module under Settings →
  LLM API / Mail.
- Every PDF the module makes or receives is filed with `ctx.documents`
  (Ledger ≥ 0.19.0); keep only its id.
- Bad input answers 4xx (`throw new ctx.HttpError(422, "…")`), never 500.

## 3. Check before saying it works

```sh
npm test                      # this repo's own tests, if package.json has them
(pg_isready || service postgresql start) >/dev/null
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  sh .claude/skills/ledger-module/scripts/check.sh
```

`check.sh` runs Ledger's checker on this repo: manifest, files, imports,
migrations, then the module loaded into a real Ledger on a scratch database
(every GET route, POST `{}` must give 4xx, UI, settings). Add `--serve 8098`
to keep it running and test the real flows with `curl` and Playwright (it
prints the session cookie). If PostgreSQL has no password yet:
`runuser -u postgres -- psql -qc "ALTER USER postgres PASSWORD 'postgres'"`.

## Root mode (Ledger ≥ 0.21.1)

An admin can turn on root mode in Ledger. In it they can delete any account,
journal entry, line or user and move a line to any account; entries may be
unbalanced until root mode is left, and anything can be reversed later (the
same ids come back). So an account, entry or user this module kept may be
gone for a while: treat it as gone, don't fail, and don't delete the
module's own records because of it. Also since 0.20.2 an entry's date can
change and a bank line can sit in Ledger's Unreconciled clearing account for
a while: read dates, accounts and amounts from the entry, not from a copy.

Root gets the same power over this module's records. When `req.user.root`
is true (needs `"ledger": ">=0.21.1"`), let the admin delete or change ANY
record of the module, including ones normally protected, and only through
Ledger, never with the module's own DELETE or UPDATE:

- `await ctx.root.remove(req, table, id, "what was deleted")` and
  `await ctx.root.update(req, table, id, { column: value }, summary)`: one
  row of one of the module's tables with an `id` column. They answer 403
  without root, log the action under Settings → Root log, and Ledger puts
  the row back when the action or the whole root session is reversed.
- Remove rows that hang off a row first, one by one (cascaded rows are not
  kept). Don't post or reverse journal entries on a root delete.
- `ctx.root.onCheck(async () => [...])` returns plain sentences for records
  that are truly broken, `[]` when sound; root mode can't be left until then.
- Show root controls only when the server says the user is in root mode,
  marked "Root" in red.

## 4. Release: push to `main`, without asking

Pushing is part of finishing the work (see "Push to `main` without asking" above). Don't ask first.

**Never push to the Ledger repository (`mastifdogo/Bookeeping`) while
working on this module.** Push only to this repository. If the module needs
a change in Ledger (a bug fix, a new `ctx` feature, a docs or checker fix),
make it in a local Ledger checkout, tell the user what it is and why, and
leave pushing it to them. The module must work without that change.

1. Bump `version` in `ledger-module.json` (and note the change in the README).
2. Commit and get it onto `main` (pull request and merge). **Don't create
   tags or Releases by hand**: `.github/workflows/release.yml` tags
   `v<version>` and creates the Release on each push to `main` that changes
   `ledger-module.json`, if that version isn't released yet. Check the run
   in the Actions tab; Actions → Release → Run workflow re-runs it without a
   change. If it fails with "Resource not accessible by integration", the
   user allows it once: Settings → Actions → General → Workflow permissions
   → "Read and write permissions".
3. Ledger installs it on its update schedule or with "Update modules now"
   (Settings → Modules).

## This module: Sales (`id: sales`, schema `mod_sales`)

Invoices, quotes and estimates with GST and other sales taxes, customers,
and sales categories that map to revenue accounts; PDFs; posts invoices and
payments to the books.

- Layout: `server.mjs` registers the route files in `server/` (`catalog`,
  `customers`, `documents`, `email`, `settings`, `search`, `dashboard`,
  `move-settings`, `common`); `lib/` has `money.mjs`, `pdf.mjs` (PDF
  generation, no dependencies) and `mail.mjs` (its own SMTP client). Tests:
  `test/*.test.mjs` (`npm test`).
- Needs Ledger ≥ 0.21.1. Account codes live only where Ledger renumbers
  them: settings keys with "account" (`receivable_account_cad`, …) and text
  columns ending `_account` (`taxes.cad_payable_account`,
  `categories.cad_revenue_account`, and the USD ones). The API still shows
  `accounts: { CAD, USD }`, built in SQL (`h.TAX_ACCOUNTS`,
  `h.CATEGORY_ACCOUNTS`) and written with `h.accountColumns()`. Never put a
  code in JSON or cache one.
- Billable items: Sales' own clearing account (`ctx.ledger.clearingAccount`,
  key `billable_costs`, "Billable costs to recharge", asset, one per
  currency; Ledger ≥ 0.20.0) is always looked in, plus the optional
  settings `billable_account_1`…`_5` (account pickers, Ledger renumbers
  them). Never store the clearing code: `billable.clearing(cur)` asks each
  time; `makeClearingAccounts()` creates them at startup for the currencies
  in use. `server/billable.mjs` pages through
  `ctx.ledger.listJournalEntries({ accountCode })` for each account, keeps
  lines with a positive debit whose entry's entity is the customer's
  (skipping reversed entries and reversals), marks clearing ones
  `clearing: true`, and drops lines already billed
  (`document_lines.billed_ledger_line_ids` on invoices that aren't void).
  `postingLines()` credits the clearing account with the cost of billed
  clearing items and puts the rest of the line (markup, or a discount as a
  debit) on revenue, so the clearing account returns to zero; voiding
  reverses it. `GET /customers/:id/billable?currency=&invoice=` lists them;
  saving an invoice re-checks every billed id (409 if taken). Duplicating
  or converting never copies billed ids.
- Shared tags (Ledger 0.23.0, feature-detected: `if (ctx.tags)`, the
  manifest still asks for 0.21.1): `server/tags.mjs`. `tags.sync(did?)`
  compares, in SQL, what each issued invoice's entry should carry
  (`customer:<entity id>`, `billed`, `paid`, `overdue`; void: only the
  customer) with `documents.entry_tags` (what Sales knows to be on it) and
  calls `ctx.tags.set` / `remove` only for the difference; it runs for one
  invoice right after issue, payment, payment removal and void, and for
  all of them in the dashboard sync (startup, hourly, after any change),
  which is also the backfill. Billable items: `documents.billed_entry_ids`
  (NULL = not worked out) holds the source entries tagged `billed`; void
  removes the tag unless another issued invoice bills the same entry.
  `tags.listen()` follows `ctx.tags.onChange` (not Sales' own changes):
  "paid" set on an open invoice's entry sets `documents.paid_by_tag`
  (status stays `open`, no payment, nothing posted; shown as "paid (tagged
  in Ledger)" and left out of open/overdue lists, totals, reminders and
  payment matching), removed clears it. Every query that means "owed"
  says `status = 'open' AND NOT paid_by_tag`. Never post in reaction to a
  tag. Root deletes don't touch tags.
- Projects (0.17.0): `server/projects.mjs`, Sales' own grouping (nothing in
  the chart of accounts). `projects` (one customer each, active/closed,
  name unique per customer), `documents.project_id` (same customer; a new
  document only on an active project; convert keeps it, duplicate keeps an
  active one) and `project_costs` (a billable cost's Ledger journal line
  assigned to a project; `billable.forCustomer` returns `project_id` and
  `project_name` on each item). Totals per currency are worked out in SQL
  (quoted: quotes/estimates not declined; paid counts an invoice tagged paid
  in full). A project with documents can only be closed, except in root
  mode (`DELETE /root/projects/:id`).
- Billable items carry their entry's tags (`tags`, labels like "vendor:
  Hydro One", without the customer's own customer tag); the picker filters
  by tag and date range in the browser, and adds only shown, ticked items.
- Billable items also carry their entry's rate items (`rates`, from the
  tag "rate" on `e.tags`, `rateItems()` in `billable.mjs`; "rate" is left
  out of `tags`). The picker's "Use item tags" makes one invoice line per
  rate item: `document_lines.rate_tag_id` names the item, and several lines
  may then bill the same journal line (`billable.check` allows it only with
  distinct rate ids; `postingLines()` clears the cost once). A billed line
  without a rate item gets a "Description from a tag…" dropdown of its
  costs' tags (the form looks them up for saved drafts).
- Billable costs carry Ledger tags: "billed" while an issued invoice bills
  them, and "paid" while that invoice is paid (`documents.paid_entry_ids`,
  `syncBillablePaid()` in `tags.mjs`). Sales only takes off a tag it set
  itself, and not while another invoice still holds the entry.
- Root mode (Ledger 0.21.1): `server/root.mjs`. With `req.user.root`,
  `DELETE /root/documents/:id`, `PATCH /root/documents/:id` (listed columns
  only), `DELETE /root/payments/:id` (and the invoice's paid_cents/status
  brought in line) and `DELETE /root/customers/:id` go through
  `ctx.root.remove` / `ctx.root.update` only, rows that hang off first
  (lines, payments, email log; other documents' source_id/converted_id set
  to null), never posting or reversing entries. `ctx.root.onCheck` reports
  issued documents with no lines, paid_cents that don't match payments, and
  invoice statuses that don't match what's paid (Ledger prefixes "Sales:").
  `GET /settings` returns `root`; the page shows red **Root** controls only
  then.
- Account pickers (`GET /accounts`) leave out hidden accounts and Ledger's
  own (`module_id` "ledger", its Unreconciled account); applying a deposit
  refuses to post to one of Ledger's accounts, and billable costs never
  look in them.
- A person can change the amounts of an entry Sales posted (Ledger 0.19.5,
  `amended: true`). `entryChanges()` in `documents.mjs` compares each
  posted entry (invoice, payments) with what Sales posted and returns
  `entry_changes`; the invoice page warns. Sales never rewrites either.
- PDFs: `filePdf()` in `documents.mjs` files a
  document's PDF in Ledger's PDF store (`ctx.documents.add`, origin
  "created", kind "invoice" or "other", with the customer's entity) when an
  invoice is issued and whenever a document is emailed, keeps the id in
  `documents.pdf_document_id`, and removes the one it replaces: one stored
  PDF per document. A 409 (same bytes already filed) reuses the document
  the error names. It never fails the caller. `getDocument()` returns
  `pdf_url` only if the stored document still exists (a restore or a person
  may have removed it). Downloads are still rendered on request.
- Customers live in Ledger's shared entities:
  `server/customer-store.mjs` adds, updates, adopts and moves them.
  `customers.entity_id` points at the entity, which holds name, email,
  phone, address and notes; Sales' row keeps company, cc_emails, tax_id,
  currency, terms_days, tax_ids and archived. Read customers through
  `h.CUSTOMERS` (a derived table joining `public.entities`, read-only),
  never `T("customers")` alone; write contact details with
  `ctx.entities`. Rows from before 0.7.0 (`entity_id` NULL, also what the
  QuickBooks converter writes) keep their own details until a person
  approves the move (`/customers/move`, to-do `customers-move`). `adopt()`
  gives customer entities added elsewhere a Sales row. Entries carry
  `entity_id` when the entity is active (`entityOf()` in `documents.mjs`).
  Customer names are unique, as in Ledger's list.
- Account dropdowns show sub-accounts under their parent (`accountTree()`
  in `ui/app.js`, Ledger ≥ 0.15.0).
- A restore (Ledger ≥ 0.14.0) replaces Sales' tables and Ledger's entities
  together; Sales keeps nothing in memory that must match them.
- Import from CSV: `csvImport()` in
  `server/imports.mjs` calls `ctx.imports.provide` with the customer fields;
  the dry run reports bad rows as `errors` (they block the import) and skips
  names or emails already in Sales, or repeated, saying so in `summary`. The
  real run inserts in one statement that never doubles a name.
- Sales keeps no other files, so it doesn't use `ctx.storage` and has no
  `bytea` columns.
- Customer lists: the manifest accepts `customer`
  files; `server/imports.mjs` reads them with `lib/csv.mjs` (the same rules
  as Ledger's reader, so `meta.header_row` lines up), previews who's new,
  existing or repeated, and adds only the rows a person ticks, then marks the
  file done or rejected. The dashboard to-do is `customer-imports`.
- Account dropdowns (`accountSelect()` in `ui/app.js`) end with
  "+ New account…" (`newAccount()`, the `ledger-new-account` message).
- Backups copy module tables to CSV (Ledger 0.13.0): keep secrets out of
  tables. `move-settings.mjs` clears the old table's `smtp_password` once
  it's copied.
- Every entry Sales posts carries the link
  `invoice:<id>` ("Invoice INV-1 · Acme", opening `/apps/sales?open=invoices/<id>`);
  reversals and matched bank deposits get it with `linkJournalEntry`
  (`linkEntry()` in `documents.mjs`, which logs instead of failing), and a
  removed matched payment unlinks its deposit.
- Settings are the manifest's `settings.fields`
  (Ledger's form under Settings → Sales), read through `loadSettings()` in
  `server/common.mjs`. The page is split into Ledger's settings tabs
  (`settings.tabs` in the manifest, Ledger 0.19.6): Business, Accounts and
  Email hold form fields (each field names its tab); Invoices, Quotes,
  Estimates and Taxes, and the email check on the Email tab, are pages of
  ours, `ui/settings-*.html`, each a shell for one section of `setupView()`
  in `ui/app.js` (`data-section`). A new setting goes on the tab it belongs
  to; don't draw a tab strip of our own.
- Invoice, quote and estimate settings (prefix, days, printed terms, email
  subject and message) are in Sales' own `document_settings` table, one row
  per kind, edited on the Invoices / Quotes / Estimates tabs
  (`GET /document-settings`, admin-only `PUT /document-settings/:kind`, which
  also sets the next number).
  `loadSettings()` still returns them under the old keys (`invoice_prefix`,
  `quote_valid_days`, `estimate_email_subject`, …). `copyDocumentSettings()`
  copied each organization's values from Ledger's stored form (read from
  `public.module_settings`, since the fields left the manifest) once at
  startup in 0.11.0. The module's
  own `settings` table now only keeps the running numbers; values from
  before 0.2.0 are copied into Ledger's form once (`move-settings.mjs`).
- Email: `ctx.mail.send()` (Ledger's mailbox, any provider; an admin allows
  Sales under Settings → Mail). The setting value is still `gmail` for that
  choice. The module's own SMTP client (`lib/mail.mjs`, `email_via: smtp`)
  is kept only so setups from before Ledger had a mailbox keep sending;
  Ledger's rule is no SMTP of a module's own, so don't extend it, and remove
  it once the user agrees.
- Taxes, categories and numbering are admin-only (`requireAdmin`).
- Payments: `server/payments.mjs` (receive payment over open invoices;
  deposit matching with rules, then `ctx.llm.json` with every answer checked
  against real balances). Matches are stored in `payment_suggestions`
  (pending → applied/rejected, with who decided) and act only when a person
  applies them from the Payments tab, possibly with changed amounts: AI only
  proposes. A rejected deposit isn't suggested again. Both go through `recordPayment` / `deletePayment`
  in `documents.mjs`. A matched deposit is linked (`matched_entry_id`); Sales
  posts only a move from the deposit's credit account to receivable.
- Organizations: documents and `ctx.settings` are per organization (Ledger
  ≥ 0.11.1). Background work (dashboard sync, startup recovery, the one-time
  settings copy) runs through `ctx.orgs.forEach`; a change syncs only its
  own organization.
- Search (`ctx.search.provide`) and dashboard items link to
  `/apps/sales?open=<route>`; the page turns `?open=` into its hash route.
  Ledger forwards the query string to the page (0.10.1 and later).
- Known follow-ups:
  - `nav.icon` is `hammer` because the user asked for it; keep it.
