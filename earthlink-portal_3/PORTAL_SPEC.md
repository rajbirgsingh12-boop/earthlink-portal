# Earth Link Portal — Build Spec v1

Professional multi-user portal for Earth Link General Construction. Replaces the Claude artifact prototype with a hosted app: real logins, role-based access, Postgres database, mobile-friendly.

## Stack

- **Next.js 14+** (App Router, TypeScript) — the app
- **Supabase** — Postgres database, authentication, row-level security (RLS), file storage for job photos
- **Vercel** — hosting, auto-deploys from GitHub
- **Tailwind CSS** — styling (keep the carbon-book look: paper #F6F4EF, ink #1A1D21, work orange #E8611C, stamp-style status chips, IBM Plex Mono for numbers, Barlow Condensed for headers)
- **SheetJS (xlsx)** — spreadsheet import/export
- Cost: $0/mo on free tiers (Vercel Hobby + Supabase Free). Upgrade Supabase Pro ~$25/mo when team/data grows. Domain ~$12/yr.

## Roles

| Module | Admin | Office | Foreman | Accountant |
|---|---|---|---|---|
| Releases (all contracts) | full | full | only assigned to them | read |
| Mark payroll/received/canceled | yes | yes | mark own complete only | no |
| Price book | full | full | read | no |
| Proposals & invoices | full | full | no | read |
| Payroll weeks | full | full | enter own hours only | read + export |
| Employees/crew | full | full | no | read |
| Users & roles | full | no | no | no |
| Audit log | full | no | no | no |

Enforce with Supabase RLS policies, not just UI hiding.

## Database tables

- **profiles** — id (auth.users FK), name, role (admin|office|foreman|accountant), phone
- **contracts** — id, number, name, agency, ceiling, award_date, expiry_date, notes
- **releases** — id, contract_id FK, rel_number, location, buildings, ticket, amount, pre_check, date_completed, payroll_done bool, received bool, canceled bool, assigned_to FK profiles nullable, notes, photos (storage refs)
- **clients** — id, name, contact, email, phone, address
- **price_items** — id, code, description, unit, unit_price, category
- **proposals** — id, number (PROP-YYYY-###), client_id, job, date, tax_pct, status (draft|sent|approved|invoiced|declined), notes
- **proposal_items** — id, proposal_id FK, code, description, unit, qty, unit_price, sort
- **invoices** — id, number (INV-YYYY-###), proposal_id nullable, client_id, job, date, due_date, tax_pct, status (open|paid), paid_date
- **invoice_items** — same shape as proposal_items
- **employees** — id, name, trade, base_rate, active bool
- **timesheet_weeks** — id, week_ending
- **timesheet_entries** — id, week_id FK, employee_id FK, job_label, rate, hours numeric[7] (Mon–Sun), entered_by FK
- **audit_log** — id, user_id, action, table_name, record_id, before jsonb, after jsonb, at timestamptz. Trigger-based on releases, invoices, timesheet_entries.

## Modules & build phases

**Phase 1 — the daily driver (build first)**
- Auth (email magic link or password), profiles, role gate
- Contracts + Releases: list, search, filters (All / Chase list = not received / Payroll to submit / Canceled), tap-to-toggle stamps, per-row cancel/restore
- XLSX import wizard for release sheets (header auto-detect: Release, Location, Buildings, Ticket #, Amount, pre check, Date Completed, Payroll, Received; a Status column with "CANCELED" sets the canceled flag)
- KPI cards per contract: released / received / not received / payroll pending
- Audit log

**Phase 2 — money paper**
- Price book (CRUD + xlsx import with column mapping)
- Proposal builder: client picker, type-ahead line search from price book, qty, editable price, custom lines, tax, totals
- One-click convert proposal → invoice (same lines, auto number, due date from terms)
- PDF generation for proposals/invoices/statements (react-pdf or server-side) on company letterhead
- Statements: per client, open invoices, aging buckets 0-30/31-60/61-90/90+
- Pipeline dashboard: stamps by status, open pipeline $, receivable $, overdue count

**Phase 3 — payroll**
- Crew list (name, trade, base rate)
- Weekly timesheets: 7-day grid per worker per job, multiple entries per worker allowed
- OT: computed per employee across all entries, >40 hrs, FLSA weighted-average rate method (base gross = Σ hrs×rate; avg rate = base/total hrs; OT premium = OT hrs × 0.5 × avg rate)
- "Start from last week" copy
- Export week to xlsx for accountant (daily hours, reg/OT, gross, week total + labor-by-job sheet)
- Foreman mobile view: enter own crew hours only

**Phase 4 — field & polish**
- Photo upload on releases (Supabase storage), before/after
- Release assignment to foremen + email/SMS notify on assign
- Ceiling dashboard: per contract ceiling vs released vs billed vs paid, months to expiry
- Global search, CSV/xlsx export everywhere

## Data migration

1. Release sheets: use the import wizard (Phase 1). Export the current Claude artifact data first (it has the Status=CANCELED column baked in) so canceled flags carry over.
2. Price list, clients, crew: xlsx import with column mapping.
3. Keep Dropbox as cold storage; the portal becomes the working copy.

## Kickoff prompt (paste into Claude Code)

> Build Phase 1 of the app described in PORTAL_SPEC.md (this file — read it fully first). Next.js 14 App Router + TypeScript + Tailwind + Supabase. Set up: Supabase schema with RLS policies per the role matrix, auth with email login, profiles with roles, and the Contracts + Releases module exactly as specified, including the xlsx import wizard and the four KPI cards and filter views. Seed one admin user. Visual style per the spec's design tokens: paper/ink/work-orange palette, stamp-style status chips, mono numbers, condensed uppercase headers. Mobile-first. When done, give me the exact steps to create the Supabase project, set env vars, and deploy to Vercel.

Then build Phases 2-4 as separate sessions, one phase at a time, testing between.

## Honest notes

- This is a few focused weekends, not one click. Phase 1 alone makes it usable daily.
- Never store SSNs or full bank details in this app. Payroll here is hours/rates/gross only; the accountant handles taxes and identity data.
- Set up daily Supabase backups (built-in) once real data lives here.
- Buy the domain early (earthlinkgc.com or similar) — email at your own domain also upgrades every proposal you send.
