# SUBSCRIPT — Subscription Operations Platform

SUBSCRIPT is a local-first subscription operations demo built with **JavaScript, Node.js 24, and SQLite**. The server uses Node's built-in `node:sqlite` module, so it needs no npm packages or hosted services. The responsive browser UI and server share JavaScript; SQLite stores accounts, catalog, plans, subscriptions, quotations, invoices, discounts, taxes, payments, and activity.

## Start the app

Install Node.js 24 or newer, then run this from the project directory:

```powershell
node server.js
```

Open <http://127.0.0.1:5000>. The database `subscript.db` is created and seeded on first run. Set `PORT`, `SUBSCRIPT_DB`, and `SUBSCRIPT_SECRET` through environment variables to customize the local server. There are no external package installs.

## Demo accounts

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@subscript.demo` | `AdminDemo!2026` |
| Staff | `staff@subscript.demo` | `StaffDemo!2026` |
| Customer | `mia@example.demo` | `CustomerDemo!2026` |

Initial records are clearly identified as sample data. The demo passwords are for local evaluation only. Passwords use PBKDF2 hashes; registration enforces a 9+ character password with uppercase, lowercase, and a symbol.

## Included workflows

- Customer registration and role-aware sign-in.
- Customer, product, variant, plan, tax, and discount records.
- Quotations that confirm into active subscriptions.
- Subscription pause, resume, renewal, and closure actions.
- Explicit due-billing processing with one invoice per subscription billing period.
- Tax and eligible discount calculations during invoice generation.
- Manual payment recording and explicitly labelled payment simulations.
- Customer portal data isolation and printable invoices.
- Dashboard KPIs backed by SQLite data.

## Tests

Node's built-in test runner starts an isolated app instance with a disposable database:

```powershell
node --test tests/app.test.js
```

The checks cover sign-in, password validation, billing idempotency, quotation confirmation, subscription controls, payment recording, customer isolation, and database persistence after a server restart.

## Scope and deployment notes

This is a hackathon demonstration app, not a production accounting system. Password reset email, real payment gateway processing, a background billing scheduler, CSV export, quotation templates, and a subscription change request queue are not implemented. Billing runs from the dashboard action. Payment amounts use SQLite `REAL`; a production deployment should use integer minor units, CSRF protection, expiring server-side sessions, secure cookies over HTTPS, migrations and backups, and reviewed authentication flows. Never expose the demo credentials publicly.
