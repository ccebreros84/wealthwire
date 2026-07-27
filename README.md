# wealthwire.app

The public, no-sign-in demo: download an Excel template, upload orders, watch them validate,
walk through confirm & route — and at the Route click, the early-access gate captures a work
email plus the custodian banks that user needs. Leads land in Neon.

Next.js 14 (App Router, JavaScript) · Neon Postgres · deployed on Vercel.

## Run it locally

```bash
npm install
cp .env.example .env.local     # fill DATABASE_URL, or leave it out to test without a DB
npm run dev                    # http://localhost:3000
```

Without `DATABASE_URL` the app still works end to end — the lead is logged to the server
console instead of being stored, and the UI shows the same thank-you.

## Deploy

1. **Push this folder to GitHub** as its own repo (root of the repo = this folder).
   ```bash
   git init && git add -A && git commit -m "WealthWire demo app"
   git remote add origin git@github.com:<you>/wealthwire-app.git
   git push -u origin main
   ```
2. **Vercel → Add New → Project → Import** that repo. Framework preset: Next.js. No build
   settings to change.
3. **Neon**: in the Vercel project, *Storage → Create Database → Neon* (or connect an existing
   Neon project). The integration writes `DATABASE_URL` into every environment for you.
   Pick the **eu-central-1 (Frankfurt)** region — closest to Swiss users, and keeps the data in the EU.
4. **Create the table**: open the Neon SQL editor and run [`sql/schema.sql`](sql/schema.sql).
5. **Domain**: Vercel → Settings → Domains → add `wealthwire.app`, then point the registrar at
   the records Vercel shows (usually an `A` record to `76.76.21.21`, plus `CNAME www`).
6. Redeploy once after the env vars land.

### Environment variables

| Variable | Required | What it does |
|---|---|---|
| `DATABASE_URL` | yes (for storage) | Neon connection string. Added by the Vercel + Neon integration. |
| `RESEND_API_KEY` | no | Turns on the "email me each new lead" notification ([resend.com](https://resend.com)). |
| `LEAD_NOTIFY_TO` | no | Where the notification goes, e.g. `hello@wealthwire.ch`. Comma-separated for several. |
| `LEAD_NOTIFY_FROM` | no | Verified sender. Defaults to Resend's sandbox sender. |

Notification failures never break the signup — the lead is already saved by then.

## Reading the leads

```sql
select * from leads_export;                      -- newest first, banks flattened
copy (select * from leads_export) to stdout with csv header;   -- CSV
```

## How the flow is wired

| File | Role |
|---|---|
| `app/page.js` | The whole client flow: start → validate → confirm → gate. Inline styles, no CSS framework. |
| `lib/orders.js` | Column contract, template generation, .xlsx/.csv parsing, all validation rules. |
| `app/api/lead/route.js` | `POST /api/lead` → Neon insert + optional Resend notification. Edge runtime. |
| `sql/schema.sql` | `leads` table + `leads_export` view. |

### The order sheet contract

`Instrument · ISIN · Side · Quantity · Order type · Limit · CCY · Custody account · Client ref`

Required: Instrument, ISIN, Side, Quantity, CCY, Custody account. The generated template ships
four example rows and a *How to use* sheet documenting every column and every check.

### Validation rules

Blocking errors: header row must match the template · required fields filled · ISIN is 12
characters · ISIN check digit valid · Side is BUY or SELL · Quantity is a positive number ·
Custody account present · CCY is a 3-letter code.

Warnings (never block): duplicate instrument + side + account · LIMIT order with no limit price.

Rows are editable in the grid and revalidate as you type. Continue stays disabled while any
blocking error remains.

### The gate

Opens on the **Route N orders via FIX** click, after a custodian has been picked (that bank
pre-fills the gate's bank list). It captures email + banks + the basket's order count, posts to
`/api/lead`, and shows a thank-you. No fills, no blotter — routing is deliberately dead.

To move the gate earlier or later, it is one call site: `openGate()` in `app/page.js`.

## Deliberately not here

No sign-in, no session, no persistence between visits (a reload starts fresh), no market data,
no real account verification, and no FIX connectivity. The uploaded sheet is parsed in the
browser and never leaves it — only the email and bank names are sent to the server.
