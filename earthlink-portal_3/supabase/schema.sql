-- Earth Link Portal — Phase 1 schema
-- Paste this whole file into Supabase → SQL Editor → Run.

create type user_role as enum ('admin','office','foreman','accountant');

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text,
  role user_role not null default 'foreman',
  created_at timestamptz default now()
);

create table contracts (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  name text,
  agency text,
  ceiling numeric,
  award_date date,
  expiry_date date,
  created_at timestamptz default now()
);

create table releases (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references contracts(id) on delete cascade,
  rel_number text default '',
  location text default '',
  buildings text default '',
  ticket text default '',
  amount numeric default 0,
  pre_check text default '',
  date_completed text default '',
  payroll_done boolean default false,
  received boolean default false,
  canceled boolean default false,
  labor_hours numeric default 0,
  assigned_to uuid references profiles(id),
  notes text default '',
  created_at timestamptz default now()
);
create index releases_contract_idx on releases(contract_id);

create table audit_log (
  id bigint generated always as identity primary key,
  user_id uuid,
  action text,
  table_name text,
  record_id uuid,
  before jsonb,
  after jsonb,
  at timestamptz default now()
);

-- auto-create a profile on signup (default role: foreman; promote in Users page or SQL)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name) values (new.id, split_part(new.email, '@', 1));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- audit trigger on releases
create or replace function public.audit_releases()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log (user_id, action, table_name, record_id, before, after)
  values (auth.uid(), TG_OP, 'releases', coalesce(new.id, old.id), to_jsonb(old), to_jsonb(new));
  return coalesce(new, old);
end $$;
create trigger releases_audit after insert or update or delete on releases
  for each row execute function public.audit_releases();

-- helper: current user's role
create or replace function public.my_role() returns user_role
language sql stable security definer set search_path = public as
$$ select role from profiles where id = auth.uid() $$;

-- RLS
alter table profiles enable row level security;
alter table contracts enable row level security;
alter table releases enable row level security;
alter table audit_log enable row level security;

create policy "profiles: read own or staff read all" on profiles for select
  using (id = auth.uid() or my_role() in ('admin','office','accountant'));
create policy "profiles: admin updates roles" on profiles for update
  using (my_role() = 'admin') with check (my_role() = 'admin');

create policy "contracts: staff read" on contracts for select
  using (my_role() in ('admin','office','accountant') or exists (
    select 1 from releases r where r.contract_id = contracts.id and r.assigned_to = auth.uid()));
create policy "contracts: office write" on contracts for insert
  with check (my_role() in ('admin','office'));
create policy "contracts: office update" on contracts for update
  using (my_role() in ('admin','office'));
create policy "contracts: admin delete" on contracts for delete
  using (my_role() = 'admin');

create policy "releases: staff read all, foreman read assigned" on releases for select
  using (my_role() in ('admin','office','accountant') or assigned_to = auth.uid());
create policy "releases: office insert" on releases for insert
  with check (my_role() in ('admin','office'));
create policy "releases: office update, foreman update assigned" on releases for update
  using (my_role() in ('admin','office') or assigned_to = auth.uid());
create policy "releases: office delete" on releases for delete
  using (my_role() in ('admin','office'));

create policy "audit: admin read" on audit_log for select using (my_role() = 'admin');

-- AFTER RUNNING: create your account in Authentication → Add user,
-- sign in once, then promote yourself:
--   update profiles set role = 'admin' where name = 'YOUR_EMAIL_PREFIX';

-- ===== Phase 2 & 3 =====
create table org (
  id int primary key default 1 check (id = 1),
  company text default 'Earth Link General Construction, Inc.',
  address1 text default '',
  address2 text default 'Richmond Hill, NY',
  phone text default '',
  email text default '',
  license text default '',
  terms text default 'Net 30'
);
insert into org (id) values (1);

create table clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text default '', email text default '', phone text default '', address text default '',
  created_at timestamptz default now()
);
insert into clients (name) values ('NYCHA'), ('Boulevard'), ('Fairstead'), ('JRM Construction Management');

create table price_items (
  id uuid primary key default gen_random_uuid(),
  code text default '', description text not null, unit text default 'EA',
  unit_price numeric default 0, category text default '',
  created_at timestamptz default now()
);

create table proposals (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  client_name text default '', job text default '',
  date date default current_date, tax_pct numeric default 0,
  status text default 'draft' check (status in ('draft','sent','approved','invoiced','declined')),
  notes text default '',
  created_at timestamptz default now()
);
create table proposal_items (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references proposals(id) on delete cascade,
  code text default '', description text default '', unit text default 'EA',
  qty numeric default 1, unit_price numeric default 0, sort int default 0
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  proposal_id uuid references proposals(id),
  client_name text default '', job text default '',
  date date default current_date, due_date date,
  tax_pct numeric default 0,
  status text default 'open' check (status in ('open','paid')),
  paid_date date,
  created_at timestamptz default now()
);
create table invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  code text default '', description text default '', unit text default 'EA',
  qty numeric default 1, unit_price numeric default 0, sort int default 0
);

create table employees (
  id uuid primary key default gen_random_uuid(),
  name text not null, trade text default '', base_rate numeric default 0, active boolean default true,
  created_at timestamptz default now()
);
create table timesheet_weeks (
  id uuid primary key default gen_random_uuid(),
  week_ending date not null,
  created_at timestamptz default now()
);
create table timesheet_entries (
  id uuid primary key default gen_random_uuid(),
  week_id uuid not null references timesheet_weeks(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  job_label text default '', rate numeric default 0,
  release_id uuid references releases(id),
  hours numeric[] default '{0,0,0,0,0,0,0}',
  entered_by uuid references profiles(id)
);

-- RLS for new tables
alter table org enable row level security;
alter table clients enable row level security;
alter table price_items enable row level security;
alter table proposals enable row level security;
alter table proposal_items enable row level security;
alter table invoices enable row level security;
alter table invoice_items enable row level security;
alter table employees enable row level security;
alter table timesheet_weeks enable row level security;
alter table timesheet_entries enable row level security;

-- staff = admin/office write, accountant read
create policy "org read" on org for select using (auth.uid() is not null);
create policy "org write" on org for update using (my_role() in ('admin','office'));

do $$
declare t text;
begin
  foreach t in array array['clients','price_items','proposals','proposal_items','invoices','invoice_items','employees','timesheet_weeks','timesheet_entries']
  loop
    execute format('create policy "%s read" on %I for select using (my_role() in (''admin'',''office'',''accountant''))', t, t);
    execute format('create policy "%s ins" on %I for insert with check (my_role() in (''admin'',''office''))', t, t);
    execute format('create policy "%s upd" on %I for update using (my_role() in (''admin'',''office''))', t, t);
    execute format('create policy "%s del" on %I for delete using (my_role() in (''admin'',''office''))', t, t);
  end loop;
end $$;

-- ===== Phase 4: invoice generator, payment aging, document storage =====
-- (same statements as upgrade_invoices_aging_docs.sql — idempotent)
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

-- ===== Phase 4b: NYCHA proposal creator =====
-- (same statements as upgrade_proposal_creator.sql — idempotent)
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

-- ===== Phase 4c: worker payment tracking =====
alter table timesheet_weeks add column if not exists paid_map jsonb default '{}'::jsonb;

-- ===== Phase 4d: PACT job tracking =====
-- (same statements as upgrade_pact.sql — idempotent)
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
