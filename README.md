# Sales — a Ledger module

A module for [Ledger](https://github.com/mastifdogo/Bookeeping). It appears
in Ledger's sidebar as **Sales**, with a hammer icon, and lets you:

- **write invoices** with line items, automatic numbering (`INV-0001`…), due
  dates from payment terms, drafts you can edit, duplicate, issue or void
- **write quotes and estimates**, each with its own numbering (`QUO-`, `EST-`)
  and a "valid until" date. You can email them, mark them accepted or declined,
  and turn one into an invoice with one click. Quotes are firm prices;
  estimates carry an "approximate" disclaimer.
- **charge GST and other sales taxes**. GST (5%) is set up and on by default.
  HST, PST and QST are ready to switch on, and you can add your own. A line
  can carry several taxes (e.g. GST + PST). Customers and categories can
  have their own taxes (e.g. none for an exempt or US customer). Your GST/HST
  registration number prints on every document.
- **sort sales into categories** (Labour, Materials, …), each tracking to
  a revenue account. The Categories page shows sales per category over any
  date range.
- **share customers with the rest of Ledger**: customers live in Ledger's
  list of customers and vendors (Entities in the sidebar), the same one
  Ledger and every other module use. A customer added there can be invoiced
  in Sales straight away; one added in Sales shows up there. Sales keeps its
  own extras (company, Cc addresses, tax number, currency, payment terms,
  taxes), and the entries it posts say which customer they're with.
- **keep customer records**: contact details, billing address, Cc addresses,
  currency, payment terms, taxes, notes, balance owing and every document
  sent to them
- **email PDFs** through Ledger's shared mailbox (Settings → Mail: any
  IMAP/SMTP account, Proton Mail through its Bridge, or Gmail), with
  editable messages and a log of every send
- **file PDFs in Ledger's Documents**: when an invoice is issued, and each
  time an invoice, quote or estimate is emailed, its PDF is filed there
  under the customer, one per document (the latest replaces the one before).
  The document's page has a **Filed PDF** button that opens it. The file
  says what it is in Ledger's shared language (Ledger 0.27.0): what Sales
  knows about the document is saved with it (customer, number, dates,
  totals, lines), so no other module has to read the PDF again, and an
  invoice's PDF carries the file tags **billed**, **paid** and **overdue**
  as the invoice changes.
- **bill costs to customers**: Sales has its own clearing account, *Billable
  costs to recharge* (one per currency, made for you). Post a cost you'll
  pass on to it in Ledger and tag the entry with the customer; it then shows
  under **+ Billable items** on that customer's new invoice. Tick any of
  them and add them as one line, or each as its own line. When the invoice
  is posted, the cost goes back out of the clearing account (so it returns
  to zero) and anything above cost is revenue. You can also have Sales look
  in other accounts (Settings → Sales → Accounts → Billable costs). An item
  is billed only once; deleting the draft or voiding the invoice frees it.
- **receive payments**: from a customer's page, enter what came in and it's
  spread over their open invoices, oldest first (you can change the split),
  and posted to the books. Partial payments are fine.
- **match bank deposits** that are already in the books (e.g. imported from
  a statement) to the invoices they pay: exact matches by amount or invoice
  number, and, when an admin allows Sales under **Settings → LLM API**, Ledger's
  AI for the rest (one deposit paying several invoices, vague descriptions).
  Matches are saved as suggestions on the **Payments** tab (and the
  dashboard shows how many wait): change the amounts if needed, then
  **Apply** or **Reject**. Nothing is applied until a person approves it; a
  rejected deposit isn't suggested again. Applying never counts the money twice:
  a deposit credited to receivable is just linked; one sitting in another
  account (e.g. suspense) is moved to receivable with one entry.
- **put reminders on Ledger's dashboard**: a notification when invoices are
  overdue, a to-do for each issued invoice that hasn't been emailed, and a
  to-do to follow up on each sent quote or estimate. They clear themselves
  when the invoice is emailed or paid, or the quote is decided. Each one
  opens the document it's about.
- **bring in customers from other software**: when you migrate to Ledger
  (Settings → Import & export → Migrate), Ledger sends the customer list to
  Sales. The Customers tab (and a dashboard to-do) shows it: who's new and
  who's already a customer, with a box to tick for each. Only the people you
  choose are added; **Don't import** sets the list aside.
- **import customers from a CSV file**: Settings → Sales has an **Import
  customers from CSV** card (Ledger's). Any spreadsheet export works: Ledger
  matches the columns (name, company, email, phone, address, GST number,
  currency, payment terms, notes) and shows what Sales would do first:
  "Would add 12 customers; skipping 2 already in Sales". Rows with a bad
  email or currency are listed to fix, and nothing is added until you press
  Import. Importing the same file twice adds nobody.
- **create accounts on the spot**: the account dropdowns for categories and
  taxes end with **+ New account…**, which opens Ledger's New account
  dialog and selects the new account, without losing what you'd filled in.
- **projects**: group a customer's invoices, quotes, estimates and
  billable costs by project, with what's quoted, invoiced, paid and owed.
- **find things from Ledger's search bar**: customers, and invoices, quotes
  and estimates by number, customer or PO number.
- optionally **post to the books**: issuing an invoice posts Dr receivable,
  Cr each line's category revenue account and Cr each tax's payable account.
  A payment posts Dr bank / Cr receivable. Voiding an invoice or removing a
  payment reverses its entry. Quotes and estimates are never posted.
  Every entry Sales posts (and every bank deposit it applies) is linked to
  its invoice: Ledger shows "Invoice INV-0031 · Acme" on the entry and in
  the journal, and the link opens the invoice in Sales.

It has no dependencies (the PDF writer and the email client are built in),
so Ledger installs it as-is. The page works at full width and in a narrow
side pane.

## Install

Needs **Ledger 0.27.0 or newer** (the one file store with tags on files and data kept with a file, shared tags on journal entries, root mode, clearing accounts, renumbered accounts, Documents, the shared mailbox, the shared customer list, sub-accounts, Import from CSV, customer lists from Ledger's migration,
"+ New account…", journal entry links, settings per organization, plus the
settings form, Gmail, search and user roles from earlier versions). In
Ledger, open **Settings → Modules**, enter `mastifdogo/sales_module` and add it.
Ledger installs the latest GitHub Release, creates the module's database
schema (`mod_sales`) and adds **Sales** to the sidebar. You can hide or move
it under **Settings → Sidebar**.

**Upgrading from v0.1.0**: your settings are copied into Ledger's settings
form (Settings → Sales) on the first start; check them there. If you had set
up SMTP, Sales keeps using it.

**Upgrading from v0.0.0** (then called "Invoices & customers", id
`invoices`): Ledger won't update a module whose id changed, so the old one
keeps running with the generic icon. Remove it under Settings → Modules,
then add `mastifdogo/sales_module` again. The old module's data
stays in the `mod_invoices` schema.

**Organizations**: each organization has its own customers, documents,
taxes, numbering and settings (business name, GST number, prefixes, account
codes, email), so a business and someone's personal books, or two
businesses, invoice separately. Each organization's admins fill in
**Settings → Sales** for it; a new organization starts from the defaults.

### Changes

- **0.19.0**: the PDFs Sales files speak Ledger's shared file language
  (needs **Ledger 0.27.0**), and fixes from a review.
  - **Data kept with the file.** When a PDF is filed (an invoice issued,
    any document emailed), Sales saves what it knows as the file's extracted
    data: `type` (invoice, quote or estimate), `customer`, `entity_id`,
    `number`, `date`, `due_date`, `currency`, `subtotal_cents`, `tax_cents`,
    `total_cents`, `items` (description, quantity, unit, rate_cents,
    amount_cents) and `sales` (`id`, `kind`, `status`). Other modules read
    that instead of the PDF. The status in it follows the document, and
    invoices filed by an earlier version get theirs on the first sync (a
    quote or estimate gets it the next time it is emailed).
  - **Tags on the file.** An invoice's PDF is tagged **billed** once issued,
    **paid** when paid (which takes **overdue** off), **overdue** while past
    due; the tags come off when the invoice is voided, and **paid** when a
    payment is removed. A person tagging the PDF **paid** on Ledger's
    Documents page is treated like tagging the invoice's entry: the invoice
    shows as *paid (tagged in Ledger)*, and taking the tag off opens it
    again. The entry and the PDF always say the same.
  - Fixed: a tag set on an entry in one organization could mark another
    organization's invoice with the same entry number as paid.
  - Fixed: document numbers past 9999 were cut to four digits (10000 became
    INV-1000), repeating numbers already used.
  - Fixed: an invoice or payment whose entry was already reversed in
    Ledger's journal (or deleted in root mode) could not be voided or
    removed; it now is, without a second reversal.
  - Fixed: issuing a draft checks its billable costs again. If one was
    reversed, replaced or invoiced elsewhere meanwhile, the invoice is not
    issued (edit the draft).
  - Fixed: one bank deposit could pay more than its amount when applied
    twice at the same moment, and a debit that isn't on a bank account from
    Settings could be applied as a deposit.
  - Fixed: an invoice that was being issued when Ledger stopped, after its
    entry was posted, became a draft again and would post twice; it is now
    open with that entry.
  - Fixed: deposit matching only looked at the newest 40 unmatched
    deposits; the rules now look at all of them (only what is sent to the
    AI is capped).
  - Clear answers to bad input: a date in year 0000, a due date past
    9999-12-31, deleting a tax by an impossible id (404), deleting a
    customer who has projects (409).
  - Only an admin can send the test email.
  - Lists of invoices, quotes and estimates come a page at a time, with
    **Show more** and a count, instead of stopping silently at 500.
- **0.18.0**: an invoice line that bills costs from Ledger has a
  **Description from a tag…** dropdown with every tag on those costs'
  entries; picking one fills the description. **+ Billable items** can
  **use item tags** (Ledger's rate items: description, quantity, unit and
  rate, Ledger 0.24.0 and later): a cost with items becomes one line per
  item, with the item's description, quantity and rate (the line remembers
  its item and has no tag dropdown). A cost split over several lines is
  still billed once, and its cost is taken out of the clearing account once.
- **0.17.1**: **+ Billable items** can be filtered by tag (the entry's tags
  in Ledger, such as a vendor or "materials", or "No tags") and by a date
  range; each item shows its tags, and only the items shown and ticked are
  added.
- **0.17.0**: projects and paid billable costs.
  - A **Projects** tab: a project belongs to one customer and gathers its
    invoices, quotes and estimates, with what's quoted, invoiced, paid and
    outstanding. A project's page lets you assign the customer's unbilled
    costs to it, and starts invoices, quotes and estimates for it; invoices,
    quotes and estimates have a Project picker, and a customer's page lists
    their projects. Close a project when it's done; root mode can delete one.
  - Billable costs, from the clearing account or the accounts you added,
    are tagged **billed** in Ledger when invoiced (as before) and now also
    **paid** when that invoice is paid, in Sales or by a "paid" tag on the
    invoice's entry. Unpaying takes Sales' own "paid" tag off again, leaving
    one a person or another module set.
  - Fix: deleting a draft invoice made from a quote or estimate works again,
    and that quote is accepted again, free to convert anew.
- **0.16.1:** Voiding an invoice only takes the "billed" tag off a billable cost's entry if Sales
  set it. A tag set by the module that posted the cost (Employees, for hours) stays, so voiding an
  invoice no longer undoes that module's own billing.
- **0.16.0**: Ledger's shared tags (Ledger 0.23.0). Each issued invoice's
  journal entry is tagged with its **customer** and **billed**, then
  **paid** when it is paid in full and **overdue** while it is past due
  and unpaid; removing a payment or voiding the invoice takes them off
  again. Billable costs added to an invoice get **billed** on their own
  entries. If a person or another module tags an invoice's entry **paid**
  in Ledger, Sales shows the invoice as *paid (tagged in Ledger)* and
  leaves it out of the open and overdue lists, without recording a
  payment or posting anything; taking the tag off opens it again.
  Invoices issued before this update are tagged the first time Sales
  starts. On a Ledger older than 0.23.0 Sales works as before, without
  tags.
- **0.15.0**: root mode (Ledger 0.21.1). While an admin has root mode on,
  invoices, quotes, estimates, payments and customers show red **Root**
  controls to delete them, or change a document's status, whatever its
  state. Ledger logs each change and can put it back; nothing is posted
  or reversed in the books. Ledger won't leave root mode while Sales has
  broken records (an issued document with no lines, an invoice whose
  payments don't add up). Account pickers leave out hidden clearing
  accounts and Ledger's own; Sales never posts to Ledger's Unreconciled
  account. Needs Ledger 0.21.1.
- **0.14.1**: fixes. **+ Billable items** now shows on every invoice (it
  was hidden unless an extra billable account was set, so costs in Sales'
  own clearing account couldn't be billed). Looking for matching deposits
  from one customer's page no longer drops the suggestions waiting for
  other customers. The dashboard to-dos for moving customers and for a
  customer list open the right page, and a list of kind `entity` gets its
  to-do straight away. A draft for a customer archived since can be edited
  without choosing another customer. A list address with an unknown
  `status` answers "not valid" instead of a server error, and error
  messages point to Settings → Sales → Accounts and Taxes.
- **0.14.0**: billable costs go through Sales' own clearing account,
  *Billable costs to recharge*, which Sales makes and always looks in;
  invoicing an item clears its cost from it. Other accounts are optional.
  Needs Ledger 0.20.0.
- **0.13.0**: a tidier Settings → Sales. Accounts are chosen from a list
  instead of typed as codes, grouped under Canadian dollars, US dollars and
  Billable costs, and shown only when posting to the books is on. The mail
  server fields show only when you send through a server of your own.
  Shorter labels throughout. Saved values are unchanged. Needs Ledger 0.19.8.

- **0.12.0**: Settings → Sales is split into tabs: Business, Accounts,
  Invoices, Quotes, Estimates, Taxes and Email. Each tab saves on its own.
  Nothing about your settings changes. Needs Ledger 0.19.6.

- **0.11.0**: invoice, quote and estimate settings each have their own tab
  under Settings → Sales (below Ledger's form): number prefix and next
  number, days, printed terms and email text. Estimates now have their own
  email text, and invoices can have printed terms. Your current values are
  copied over when Sales starts.
- **0.10.0**: billable items. Set the accounts under Settings → Sales;
  costs posted to them and tagged with a customer can be added to that
  customer's invoice, individually or combined into one line, and are then
  marked as billed.
- **0.9.0**: renumbering an account in Ledger no longer breaks Sales: the
  revenue accounts of categories and the accounts taxes are owed to follow
  the new code (they moved out of a JSON map into columns Ledger updates).
  If someone changes the amounts of an entry Sales posted, the invoice page
  says so and shows both totals; Sales' own record isn't touched. Needs
  Ledger 0.19.3.
- **0.8.0**: PDFs are filed in Ledger's Documents when issued or emailed
  (a **Filed PDF** button opens the one on file). Mail goes through
  Ledger's shared mailbox under Settings → Mail, whatever provider it is;
  if you used "Ledger's Gmail account", nothing changes for you. Needs
  Ledger 0.19.0.
- **0.7.0**: customers live in Ledger's shared list of customers and
  vendors (Ledger 0.16.0). After upgrading, the Customers tab (and a
  dashboard to-do) shows the customers kept only in Sales and what moving
  each would do: join the entry with the same name, or be added. Nothing
  moves until you approve it. Customer names are now unique, as they are in
  Ledger's list. Entries record their customer, sub-accounts show indented
  in account dropdowns, and lists of kind `entity` are accepted. Needs
  Ledger 0.16.0.
- **0.6.0**: import customers from a CSV file (Settings → Sales; Ledger's
  Import from CSV). Needs Ledger 0.13.2.
- **0.5.0**: customer lists from Ledger's migration, reviewed before
  anyone is added; "+ New account…" in account dropdowns; the old settings
  table no longer keeps an SMTP password (Ledger 0.13.0 backups copy module
  tables to CSV). Needs Ledger 0.12.0.
- **0.4.1**: in lists and a customer's Transactions, the whole row opens
  the record (click, or Enter from the keyboard); numbers are plain text.
- **0.4.0**: journal entries Sales posts, reversals, and matched bank
  deposits carry a link to their invoice (needs Ledger 0.11.2).
- **0.3.0**: settings per organization; payment suggestions wait on the
  Payments tab for a person to apply or reject them.

### Accounts it uses

Only when ledger posting is on. Create them under **Accounts** first, in
each currency you invoice in. The codes are examples; pick them in Settings.

| Purpose | Type | Example |
|---|---|---|
| Accounts receivable | asset | `1200 Accounts receivable` |
| Bank (where payments land) | asset | `1000 Bank` |
| Revenue per category, plus a default for lines without one | revenue | `4000 Sales`, `4100 Labour`, `4200 Materials` |
| Each sales tax you collect | liability | `2200 GST/HST payable`, `2210 PST payable` |

## Set up

Setup is for admins (Ledger's user roles). Bookkeepers create and send
documents, record payments and manage customers; viewers can only look.

1. **Settings → Sales** (Ledger's settings form for the module):
   - **Your business**: name, address, GST/HST registration number, footer.
   - **Ledger posting** (optional): turn it on and enter the receivable,
     default revenue and bank account codes for each currency.
   - **Email**: *Ledger's mailbox* (the default). *Sales' own mail server
     settings* remain for setups from before Ledger had a mailbox.
   - **Billable items** accounts (optional).
2. Below that form on the same tab:
   - **Email** shows whether sending works, with a **Send a test email** button.
   - **Invoices, quotes and estimates**: a tab each, with the number prefix
     and next number, the payment terms (invoices) or how long it stays
     valid (quotes, estimates), the terms printed on the PDF, and the email
     subject and message, with placeholders.
   - **Taxes**: GST is on. Click **Edit** on each tax you collect, turn it
     on, choose the account it's owed to (e.g. `2200 GST/HST payable`) and
     whether new lines get it by default.
3. **Mail**: an admin connects a mailbox under **Settings → Mail** and
   ticks **Sales** under "may send". Until then the Email section says
   what's missing.
4. Under **Sales → Categories**, add your sales categories and the revenue
   account each goes to. Lines without a category use the default revenue
   account.

Sales' own mail server settings (older setups; new ones should connect the
mailbox under Settings → Mail instead):

| Provider | Server | Port / security | Password |
|---|---|---|---|
| Microsoft 365 / Outlook | smtp.office365.com | 587 STARTTLS | account or app password; SMTP AUTH must be enabled for the mailbox |
| Fastmail | smtp.fastmail.com | 465 TLS | app password |
| iCloud | smtp.mail.me.com | 587 STARTTLS | app-specific password |
| Gmail without Ledger's connection | smtp.gmail.com | 465 TLS | an [App Password](https://myaccount.google.com/apppasswords) |
| Local relay (Postfix…) | e.g. localhost | 25 none | usually none |

The container needs outbound access to that port. The SMTP password is a
secret field in Ledger's form and is never sent back to the browser.

## Using it

- **Customers → + Invoice / + Quote / + Estimate** starts a document for that customer.
- On each line, pick a category; its taxes fill in (category's, else the
  customer's, else the defaults). Click the tax chips to change them.
- **Invoices**: *Save draft* keeps it editable. *Save & issue* locks it and
  posts it when posting is on. *Email* sends the PDF; emailing a draft issues
  it first. Use *Record payment* for payments and *Void* to cancel.
- **Tags in Ledger** (Ledger 0.23.0 or newer, with posting on): the journal
  entry of an issued invoice carries Ledger's shared tags, which every
  module and the journal read the same way: **customer** (who it is with),
  **billed**, **paid** once it is paid in full, **overdue** while it is
  past due and unpaid. Sales keeps them in step with the invoice, hourly
  and after every change, and tags the entries of billable costs **billed**
  while an invoice bills them. A tag is the entry's, not Sales': when
  someone else tags an invoice's entry **paid**, the invoice shows as
  *paid (tagged in Ledger)* and drops out of the open and overdue lists
  and the overdue reminder, with no payment recorded and nothing posted;
  remove the tag in Ledger, or record the real payment in Sales, to change
  that. An invoice that Sales holds payments for in full stays paid, and
  gets its **paid** tag back if someone removes it.
- **Tags on the filed PDF** (Ledger 0.27.0): an invoice's PDF in Ledger's
  Documents carries **billed**, **paid** and **overdue** the same way, with
  posting on or off, and tagging the PDF **paid** there does what tagging
  the entry does. Who the file is with is the document's customer, not a
  tag. Ledger also shows the file as **extracted**: the data Sales saved
  with it.
- **Quotes and estimates**: *Email* (or *Mark as sent*), then *Accepted* or
  *Declined*. *Convert to invoice* creates a draft invoice with the same
  lines and tax rates, linked both ways. Sent quotes stay editable until
  they're decided.
- Saved documents keep the tax rates they were written with, so changing a
  rate later only affects new lines.

Money is kept as integer cents. Each tax is computed once on the lines it
applies to and rounded half away from zero.

## API

Everything the page does is available under `/api/v1/m/sales` with a Ledger
login:

- `invoices`, `quotes`, `estimates`: list, create, read, update, delete, plus
  `/:id/pdf`, `/:id/send`, `/:id/duplicate`. A list returns a page:
  `?limit=` (1 to 500, 500 if left out) and `?offset=`, answered with
  `data`, `total`, `limit`, `offset` and `has_more`
- invoices also have `/:id/issue`, `/:id/void` and `/:id/payments`
- quotes and estimates also have `/:id/mark-sent`, `/:id/accept`,
  `/:id/decline`, `/:id/reopen` and `/:id/convert`
- `customers/:id/payments` (receive a payment), `payments/match` (look for
  deposit matches and save them as suggestions), `payments/suggestions`
  (list; `/:id/apply` with optional changed amounts, `/:id/reject`),
  `payments/apply` (apply a deposit the user picked)
- `customers`, `categories`, `taxes`, `settings` (read-only), `numbering`,
  `settings/test-email`, `summary`
- Changing taxes, categories or numbering, and the test email, need the
  admin role.

## Development

```
ledger-module.json      manifest
server.mjs              register(ctx): wires up the route files
server/common.mjs       input validation, settings, shared helpers
server/documents.mjs    invoices, quotes, estimates (lines, posting, PDF, email)
server/catalog.mjs      taxes and categories
server/customers.mjs    customers
server/customer-store.mjs  customers in Ledger's shared list (add, update, adopt, move)
server/billable.mjs     billable items from the clearing and other accounts
server/imports.mjs      customer lists from Ledger's migration, Import from CSV
server/settings.mjs     settings for the page, numbering, test email, summary
server/document-settings.mjs  invoice, quote and estimate settings (their tabs)
server/email.mjs        sending through ctx.mail (or the older own-SMTP settings)
server/search.mjs       results for Ledger's search bar
server/payments.mjs     receive payment, deposit matching (rules + ctx.llm)
server/dashboard.mjs    notifications and to-dos on Ledger's dashboard
server/tags.mjs         Ledger's shared tags on invoices' entries and filed PDFs
server/projects.mjs     projects
server/root.mjs         root mode
server/move-settings.mjs  one-time copy of pre-0.2.0 settings into Ledger's form
lib/money.mjs           exact money and tax arithmetic
lib/pdf.mjs             PDF writer and document layout
lib/mail.mjs            SMTP client (TLS, STARTTLS, AUTH PLAIN/LOGIN) and MIME builder
lib/csv.mjs             reader for the customer lists Ledger hands over
migrations/             database schema (each file runs once; never edit a released one)
ui/                     the page shown inside Ledger (plain HTML/JS, no build);
                        settings-*.html are the pages on the tabs of Settings → Sales
test/                   unit tests: npm test
```

Check it with Ledger's module checker, from a Ledger checkout (needs
PostgreSQL):

```sh
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  node .claude/skills/ledger-module/scripts/check-module.ts ../invoice-costumer-module
```

Add `--serve 8098` to keep it running and try it in a browser.

## Releasing

Bump `version` in `ledger-module.json`: new features raise the middle
number (`0.4.0` → `0.5.0`), fixes only the last (`0.4.0` → `0.4.1`), and
merge it into `main`. The **Release** workflow
(`.github/workflows/release.yml`) then creates the tag `v<version>` and the
GitHub Release by itself; don't tag by hand. If it fails with "Resource not
accessible by integration", allow it once under the repository's Settings →
Actions → General → Workflow permissions ("Read and write permissions"),
then Actions → Release → Run workflow. Ledger installs the release on its
update schedule, or straight away with **Update modules now** under
Settings → Modules.
