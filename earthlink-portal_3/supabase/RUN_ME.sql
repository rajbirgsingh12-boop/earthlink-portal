-- ============================================================
-- RUN_ME.sql — every upgrade in one paste, in the right order.
-- Supabase → SQL Editor → New query → paste ALL of this → Run.
-- Safe to run as many times as you like.
-- ============================================================

-- ---------- from upgrade_invoices_aging_docs.sql ----------

-- ---- line items imported from a NYCHA release PDF ----
create table if not exists release_items (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references releases(id) on delete cascade,
  line int default 0,
  code text default '',
  description text default '',
  qty numeric default 0,
  uom text default '',
  unit_price numeric default 0,
  amount numeric default 0
);
create index if not exists release_items_release_idx on release_items(release_id);
alter table release_items enable row level security;
drop policy if exists "release_items read" on release_items;
create policy "release_items read" on release_items for select
  using (my_role() in ('admin','office','accountant') or exists (
    select 1 from releases r where r.id = release_items.release_id and r.assigned_to = auth.uid()));
drop policy if exists "release_items ins" on release_items;
create policy "release_items ins" on release_items for insert
  with check (my_role() in ('admin','office'));
drop policy if exists "release_items upd" on release_items;
create policy "release_items upd" on release_items for update
  using (my_role() in ('admin','office'));
drop policy if exists "release_items del" on release_items;
create policy "release_items del" on release_items for delete
  using (my_role() in ('admin','office'));

-- ---- releases: aging dates, address, attached documents ----
alter table releases add column if not exists address text default '';
alter table releases add column if not exists invoice_sent date;
alter table releases add column if not exists paid_date date;
alter table releases add column if not exists attachments jsonb default '[]'::jsonb;

-- ---- invoices: NYCHA header fields ----
alter table invoices add column if not exists release_id uuid references releases(id) on delete set null;
alter table invoices add column if not exists contract_number text default '';
alter table invoices add column if not exists release_number text default '';
alter table invoices add column if not exists development text default '';
alter table invoices add column if not exists work_order text default '';
alter table invoices add column if not exists period_from date;
alter table invoices add column if not exists period_to date;
alter table invoice_items add column if not exists category text default '';

-- ---- private storage bucket for release documents ----
insert into storage.buckets (id, name, public) values ('docs', 'docs', false)
  on conflict (id) do nothing;
drop policy if exists "docs read" on storage.objects;
create policy "docs read" on storage.objects for select
  using (bucket_id = 'docs' and auth.uid() is not null);
drop policy if exists "docs write" on storage.objects;
-- any signed-in user may upload (foremen add job photos); which releases a
-- foreman can attach to is still limited by the releases-table policies
create policy "docs write" on storage.objects for insert
  with check (bucket_id = 'docs' and auth.uid() is not null);
drop policy if exists "docs delete" on storage.objects;
create policy "docs delete" on storage.objects for delete
  using (bucket_id = 'docs' and public.my_role() in ('admin','office'));

-- ---------- from upgrade_proposal_creator.sql ----------

-- ---- per-contract price list (the full NYCHA catalog with line numbers) ----
create table if not exists contract_items (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references contracts(id) on delete cascade,
  line int default 0,
  code text default '',
  category text default '',
  description text default '',
  uom text default '',
  unit_price numeric default 0,
  created_at timestamptz default now()
);
create index if not exists contract_items_contract_idx on contract_items(contract_id);
alter table contract_items enable row level security;
drop policy if exists "contract_items read" on contract_items;
create policy "contract_items read" on contract_items for select
  using (auth.uid() is not null);
drop policy if exists "contract_items ins" on contract_items;
create policy "contract_items ins" on contract_items for insert
  with check (my_role() in ('admin','office'));
drop policy if exists "contract_items upd" on contract_items;
create policy "contract_items upd" on contract_items for update
  using (my_role() in ('admin','office'));
drop policy if exists "contract_items del" on contract_items;
create policy "contract_items del" on contract_items for delete
  using (my_role() in ('admin','office'));

-- ---- NYCHA walk-sheet fields on proposals (additive; the existing
--      proposals table and page keep working unchanged) ----
alter table proposals add column if not exists contract_id uuid references contracts(id);
alter table proposals add column if not exists development text default '';
alter table proposals add column if not exists address text default '';
alter table proposals add column if not exists apt text default '';
alter table proposals add column if not exists stairhall text default '';
alter table proposals add column if not exists walk_date text default '';
alter table proposals add column if not exists release_number text default '';
alter table proposals add column if not exists total numeric default 0;
alter table proposals add column if not exists nycha_staff text default '';
alter table proposals add column if not exists vendor_staff text default '';
alter table proposals add column if not exists start_date text default '';
alter table proposals add column if not exists finish_date text default '';
alter table proposals add column if not exists qty_map jsonb default '{}'::jsonb;
alter table price_items add column if not exists line int default 0;
alter table proposal_items add column if not exists category text default '';
alter table proposal_items add column if not exists line int default 0;

-- ---------- from upgrade_payroll_paid.sql ----------
alter table timesheet_weeks add column if not exists paid_map jsonb default '{}'::jsonb;

-- ---------- from upgrade_pact.sql ----------
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

-- ---------- from upgrade_payroll_class.sql ----------
alter table timesheet_entries add column if not exists trade text;

-- ---------- from upgrade_schedule.sql ----------
alter table releases add column if not exists crew jsonb default '[]'::jsonb;
alter table releases add column if not exists start_date text default '';
alter table releases add column if not exists finish_date text default '';
alter table pact_jobs add column if not exists start_date text default '';
alter table pact_jobs add column if not exists finish_date text default '';

-- ---------- from upgrade_realtime.sql ----------
do $$ begin alter publication supabase_realtime add table releases; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table release_items; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table proposals; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table contracts; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table contract_items; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table price_items; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table timesheet_entries; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table timesheet_weeks; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table employees; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table profiles; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table pact_jobs; exception when duplicate_object then null; end $$;
