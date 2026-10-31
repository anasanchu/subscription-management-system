# SUBSCRIPT — Subscription Operations Platform

**Subscription Management System — Odoo Make-A-Ton 9.0 Kochi Hackathon 2026**

SUBSCRIPT helps a small team keep the recurring customer journey in one place: customer → quote → subscription → invoice → payment. It is designed to make renewals and open balances easier to see without requiring users to understand accounting software.

## What it does

- Shows customers, active subscriptions, estimated recurring revenue, collected payments, unpaid balances, and upcoming billing on the dashboard.
- Stores customers, products, product variants, plans, quotations, subscriptions, tax rates, discount rules, invoices, and payments in SQLite.
- Turns a confirmed quotation into an active subscription.
- Lets permitted users pause, resume, renew, or close subscriptions.
- Creates invoices for subscriptions that are due when an admin or staff member selects **Process due billing**. The same subscription period cannot be invoiced twice.
- Applies eligible tax and discount rules when an invoice is created.
- Tracks manual payments and clearly marks simulated customer payments.
- Gives customers a separate portal for their own subscriptions, invoices, and payment history.
- Provides printable invoices using the browser’s print dialog.

The interface uses plain-language labels, a responsive layout, and local system fonts. It does not need a hosted database, payment account, or third-party font download.

## Technology

- **Node.js 24 or newer** — serves the website and JSON API.
- **SQLite via Node’s built-in `node:sqlite` module** — persists application records without an npm database package.
- **HTML, CSS, and browser JavaScript** — provides the responsive interface.
- **Node’s built-in test runner** — checks core workflows using a temporary database.

## Run the application

1. Install Node.js 24 or newer.
2. Open PowerShell in the project folder.
3. Start the server:

   ```powershell
   node server.js
   ```

4. Visit <http://127.0.0.1:5000>.

The first run creates `subscript.db` in the project directory and inserts sample data. To use a different port or database file, set `PORT` or `SUBSCRIPT_DB` before starting the server:

```powershell
$env:PORT = "5001"
$env:SUBSCRIPT_DB = ".\data\subscript.db"
node server.js
```

The folder named by `SUBSCRIPT_DB` must already exist. Stop the server with **Ctrl+C**.

## Demo accounts

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@subscript.demo` | `AdminDemo!2026` |
| Staff | `staff@subscript.demo` | `StaffDemo!2026` |
| Customer | `mia@example.demo` | `CustomerDemo!2026` |

These accounts and the included business records are sample data for local demonstration. Do not use the demo passwords for a public deployment.

## Suggested demo flow

1. Sign in as **Admin** and explain the dashboard’s recurring revenue, money collected, and open invoices.
2. Open **Quotes**, create one for a customer and plan, then confirm it. The confirmed quote creates an active subscription.
3. Open **Subscriptions** and show its status and next billing date. Pause, resume, renew, or close it to demonstrate the lifecycle controls.
4. Select **Process due billing** on the dashboard or invoice page. SUBSCRIPT creates invoices for eligible due periods and advances the next billing date. Run it again to show that no duplicate invoice is created for the same period.
5. Record a payment against an invoice and show the updated invoice status.
6. Sign out and sign in as the **Customer** to show the customer portal and its account-specific records.

## Project layout

```text
server.js             HTTP server, SQLite schema, seed data, API, and business rules
public/index.html     Browser interface and client-side interactions
public/design.css     Visual styles, responsive layout, and accessibility states
tests/app.test.js     UI and end-to-end workflow checks
package.json          Node version and start/test scripts
subscript.db          Local persistent database, created at first run (git-ignored)
```

## Run the tests

From the project folder, run:

```powershell
node --test tests/app.test.js
```

The tests use a disposable SQLite database and cover page rendering, sign-in, password rules, billing idempotency, quotation confirmation, subscription controls, payment recording, customer data isolation, and persistence after a server restart.

## Data and access notes

- Passwords are stored as PBKDF2 hashes, never as plain text.
- Roles are `ADMIN`, `STAFF`, and `CUSTOMER`; customer routes restrict data to the signed-in customer.
- SQLite foreign keys, indexes, parameterized queries, and a unique constraint on `(subscription_id, period)` help protect related records and prevent duplicate invoices.
- The server binds to `127.0.0.1`, making this a local demo by default.
- `subscript.db` is excluded from Git. Keep customer data and real credentials out of commits.

## Current limitations

This is a hackathon demo, not production accounting software. It does not include password-reset email, a real payment gateway, automatic background billing, CSV reports, reusable quotation templates, customer change-request approvals, or detailed product-line invoice items. Billing is run manually from the interface. Product variants can be recorded, but choosing a variant does not yet update a quote or subscription price. Amounts use SQLite `REAL`; production financial software should use integer minor units or a decimal type. Sessions are held in server memory and expire when the server restarts.

Before hosting this publicly, add reviewed persistent sessions, CSRF protection, HTTPS and secure cookies, database migrations and backups, stronger operational logging, and a production-grade payment and password-reset flow.
