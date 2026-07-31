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
alter table releases add column if not exists labor_breakdown jsonb default '[]'::jsonb;
alter table releases add column if not exists labor_hours numeric default 0;
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

-- ---------- from upgrade_worker_phone.sql ----------
alter table employees add column if not exists phone text default '';

-- ---------- from upgrade_day_schedule.sql ----------
create table if not exists schedule_days (
  id uuid primary key default gen_random_uuid(),
  day text not null,
  release_id uuid references releases(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  description text default '',
  texted boolean default false,
  created_at timestamptz default now()
);
alter table schedule_days enable row level security;
do $$ begin
  create policy "schedule_days read" on schedule_days for select using (my_role() in ('admin','office','accountant'));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "schedule_days ins" on schedule_days for insert with check (my_role() in ('admin','office'));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "schedule_days upd" on schedule_days for update using (my_role() in ('admin','office'));
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "schedule_days del" on schedule_days for delete using (my_role() in ('admin','office'));
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table schedule_days; exception when duplicate_object then null; end $$;
alter table schedule_days add column if not exists address text default '';

-- ---------- from upgrade_storage_meter.sql ----------
-- used, so upgrading the Supabase plan is a decision made on real numbers.
create or replace function public.storage_usage()
returns json
language sql
security definer
set search_path = ''
as $$
  select json_build_object(
    'bytes', coalesce(sum((metadata->>'size')::bigint), 0),
    'files', count(*)
  )
  from storage.objects
  where bucket_id = 'docs';
$$;
revoke all on function public.storage_usage() from public;
grant execute on function public.storage_usage() to authenticated;

-- ---------- from upgrade_docs_read.sql ----------
drop policy if exists "docs read" on storage.objects;
create policy "docs read" on storage.objects for select
  using (bucket_id = 'docs' and (
    public.my_role() in ('admin','office','accountant')
    or exists (
      select 1 from public.releases r
      where r.id::text = (storage.foldername(name))[1] and r.assigned_to = auth.uid()
    )
  ));

-- ---------- from upgrade_speed.sql (indexes, once-per-query role checks, server helpers) ----------
-- SPEED UPGRADE — safe to run any time, changes no behavior, only makes the
-- database faster. Two parts:
--
-- 1) Missing indexes: filters the app uses constantly (payroll week, day
--    schedule, walk sheets by contract…) get proper indexes so lookups stop
--    scanning whole tables as they grow.
create index if not exists timesheet_entries_week_idx on timesheet_entries(week_id);
create index if not exists timesheet_entries_release_idx on timesheet_entries(release_id);
create index if not exists timesheet_weeks_ending_idx on timesheet_weeks(week_ending);
create index if not exists schedule_days_day_idx on schedule_days(day);
create index if not exists proposals_contract_idx on proposals(contract_id);
create index if not exists proposal_items_proposal_idx on proposal_items(proposal_id);
create index if not exists releases_assigned_idx on releases(assigned_to) where assigned_to is not null;
create index if not exists invoices_proposal_idx on invoices(proposal_id);
create index if not exists invoice_items_invoice_idx on invoice_items(invoice_id);
create index if not exists pact_jobs_po_idx on pact_jobs(po_number);

-- 2) Row-security speedup: every policy calls my_role() / auth.uid(), and
--    Postgres re-runs those for EVERY ROW it checks (they can't be inlined —
--    my_role() is SECURITY DEFINER). Wrapping each call as a scalar subselect
--    makes Postgres evaluate it ONCE per query instead. On a 2,000-release
--    fetch that's 1 profiles lookup instead of 2,000. This block rewrites all
--    existing policies in place — same rules, just cached role checks.
do $$
declare
  p record;
  new_qual text;
  new_check text;
  cmd text;
begin
  for p in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname in ('public', 'storage')
  loop
    new_qual := p.qual;
    new_check := p.with_check;

    -- wrap my_role() calls (skip expressions already wrapped by a prior run —
    -- the wrapped form deparses with SELECT directly next to the call)
    if new_qual is not null and new_qual !~* 'select\s+(public\.)?my_role' then
      new_qual := replace(new_qual, 'public.my_role()', '<<MR>>');
      new_qual := replace(new_qual, 'my_role()', '<<MR>>');
      new_qual := replace(new_qual, '<<MR>>', '(select public.my_role())');
    end if;
    if new_check is not null and new_check !~* 'select\s+(public\.)?my_role' then
      new_check := replace(new_check, 'public.my_role()', '<<MR>>');
      new_check := replace(new_check, 'my_role()', '<<MR>>');
      new_check := replace(new_check, '<<MR>>', '(select public.my_role())');
    end if;

    -- wrap auth.uid() calls the same way
    if new_qual is not null and new_qual !~* 'select\s+auth\.uid' then
      new_qual := replace(new_qual, 'auth.uid()', '(select auth.uid())');
    end if;
    if new_check is not null and new_check !~* 'select\s+auth\.uid' then
      new_check := replace(new_check, 'auth.uid()', '(select auth.uid())');
    end if;

    if new_qual is distinct from p.qual or new_check is distinct from p.with_check then
      cmd := format('alter policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
      if new_qual is distinct from p.qual and new_qual is not null then
        cmd := cmd || format(' using (%s)', new_qual);
      end if;
      if new_check is distinct from p.with_check and new_check is not null then
        cmd := cmd || format(' with check (%s)', new_check);
      end if;
      begin
        execute cmd;
      exception when others then
        raise notice 'skipped %.% policy % (%)', p.schemaname, p.tablename, p.policyname, sqlerrm;
      end;
    end if;
  end loop;
end $$;

-- 3) Two more indexes: deleting a release checks these tables for links
create index if not exists schedule_days_release_idx on schedule_days(release_id);
create index if not exists invoices_release_idx on invoices(release_id);

-- 4) Server-side helpers so the phone stops downloading whole tables to
--    answer tiny questions. Each one respects row security (security invoker),
--    and the app falls back to the old way if a helper isn't installed yet.

-- which releases on a contract have line items? (one small list instead of
-- one downloaded row per line item)
create or replace function public.releases_with_items(cid uuid)
returns setof uuid language sql stable security invoker set search_path = public as
$$ select distinct ri.release_id from release_items ri join releases r on r.id = ri.release_id where r.contract_id = cid $$;

-- total logged hours per release (one number per release instead of the
-- entire timesheet history)
create or replace function public.logged_hours_by_release()
returns table (release_id uuid, hours numeric) language sql stable security invoker set search_path = public as
$$ select te.release_id, coalesce(sum(h.h), 0)
   from timesheet_entries te cross join lateral unnest(te.hours) as h(h)
   where te.release_id is not null group by te.release_id $$;

-- set one day's hours atomically (one round trip, and two phones editing
-- different days of the same worker can never overwrite each other)
create or replace function public.set_day_hours(eid uuid, di int, val numeric)
returns numeric[] language sql volatile security invoker set search_path = public as
$$ update timesheet_entries set hours[di + 1] = val where id = eid returning hours $$;

grant execute on function public.releases_with_items(uuid), public.logged_hours_by_release(), public.set_day_hours(uuid, int, numeric) to authenticated;

-- 5) Slimmer audit rows: the release audit log kept full before/after copies
--    including the attachments list — a bulk folder attach wrote megabytes of
--    history. The heavy keys stay out; everything else is still recorded.
create or replace function public.audit_releases() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log (user_id, action, table_name, record_id, before, after)
  values (auth.uid(), TG_OP, 'releases', coalesce(new.id, old.id),
          to_jsonb(old) - 'attachments', to_jsonb(new) - 'attachments');
  return coalesce(new, old);
end $$;
