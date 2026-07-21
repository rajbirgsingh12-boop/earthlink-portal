-- ============================================================
-- UPGRADE: PACT job tracking
-- Paste ALL of this into Supabase → SQL Editor → Run. Safe to run twice.
-- ============================================================
create table if not exists pact_jobs (
  id uuid primary key default gen_random_uuid(),
  partner text default '',
  development text default '',
  job_number text default '',
  description text default '',
  amount numeric default 0,
  approved boolean default false,
  work_done boolean default false,
  invoice_sent date,
  received boolean default false,
  paid_date date,
  canceled boolean default false,
  attachments jsonb default '[]'::jsonb,
  notes text default '',
  created_at timestamptz default now()
);
alter table pact_jobs add column if not exists po_number text default '';
alter table pact_jobs add column if not exists po_date text default '';
alter table pact_jobs add column if not exists address text default '';
alter table pact_jobs add column if not exists property_unit text default '';
alter table pact_jobs add column if not exists contact text default '';
alter table pact_jobs add column if not exists bill_to text default '';
alter table pact_jobs add column if not exists items jsonb default '[]'::jsonb;
alter table pact_jobs add column if not exists invoice_number text default '';
alter table pact_jobs add column if not exists tax_pct numeric default 8.875;
alter table pact_jobs enable row level security;
drop policy if exists "pact_jobs read" on pact_jobs;
create policy "pact_jobs read" on pact_jobs for select
  using (my_role() in ('admin','office','accountant'));
drop policy if exists "pact_jobs ins" on pact_jobs;
create policy "pact_jobs ins" on pact_jobs for insert
  with check (my_role() in ('admin','office'));
drop policy if exists "pact_jobs upd" on pact_jobs;
create policy "pact_jobs upd" on pact_jobs for update
  using (my_role() in ('admin','office'));
drop policy if exists "pact_jobs del" on pact_jobs;
create policy "pact_jobs del" on pact_jobs for delete
  using (my_role() in ('admin','office'));
