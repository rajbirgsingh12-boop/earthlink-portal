-- ============================================================
-- RUN_ME.sql — FINAL UPDATE (Aug 2026)
-- Every upgrade in one paste, in the right order.
--
-- HOW TO RUN:
--   Supabase → SQL Editor → New query → paste ALL of this → Run.
--
-- Safe to run as many times as you like — every step checks
-- whether it's already done. Running it again never hurts.
--
-- What's in here: release line items + document storage,
-- walk-sheet / proposal fields, PACT jobs, day schedule,
-- worker phone numbers, live-update wiring, the storage
-- meter, the foreman document-read fix, 12 speed indexes,
-- once-per-query role checks, three server helpers the app
-- uses to load faster on phones, and the slimmer release
-- audit log. This file also REPAIRS the release audit
-- trigger if an older copy of upgrade_speed.sql was ever run.
--
-- Aug 20 additions: the proposal-sent date on PACT jobs,
-- PACT invoicing locked to Admin 1 in the database itself,
-- everyone's email on their profile row (Settings shows it),
-- the login fix for accounts stuck waiting on Supabase
-- emails that never arrive, and the work-line wording
-- cleanup applied to every job already in the portal.
--
-- Sep additions: one PO is one job (the database refuses a
-- twin), and PACT jobs on the same crew schedule as NYCHA
-- releases — the calendar's "Who's going?" remembers who is
-- on each job, and a moved job takes its crew with it. A
-- priced job comes off the calendar (15), a contract's
-- price book holds each code once (16), invoice numbers are
-- held until a job is priced (17), each worker has a
-- language for the crew text (18), a crew text can be set
-- up for later (19), photos the crew texts back to the
-- company number land on the job (20), and a worker who
-- texts "no" (nobody home) is sent their next job (21).
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

-- ============================================================
-- ADDED AUG 20, 2026 — everything since the last consolidation,
-- in one place so this file stays the only one you ever run.
-- Every step below checks itself; running twice never hurts.
-- ============================================================

-- 6) PACT proposals — the date one went out, so a quote waiting on a
--    signature is visible the same way an unpaid invoice is.
alter table pact_jobs add column if not exists proposal_sent date;

-- 7) PACT invoicing belongs to Admin 1 only. The app already hides it from
--    Admin 2; this makes the database itself refuse, so the rule holds even
--    for someone poking at the API directly.
create or replace function pact_invoice_fields_admin_only()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if my_role() <> 'admin' and (
       new.invoice_number is distinct from old.invoice_number
    or new.invoice_sent   is distinct from old.invoice_sent
    or new.received       is distinct from old.received
    or new.paid_date      is distinct from old.paid_date
  ) then
    raise exception 'Only Admin 1 can change PACT invoicing (invoice number, invoiced, received, paid)';
  end if;
  return new;
end $$;
drop trigger if exists pact_invoice_fields_admin_only on pact_jobs;
create trigger pact_invoice_fields_admin_only
  before update on pact_jobs
  for each row execute function pact_invoice_fields_admin_only();

-- 8) Every person's email shows on the Settings page. Emails live in
--    auth.users, which the app cannot read — this copies each one onto the
--    person's profile row and keeps it there as accounts come and go.
alter table profiles add column if not exists email text default '';

update profiles p
   set email = u.email
  from auth.users u
 where u.id = p.id
   and coalesce(p.email, '') is distinct from coalesce(u.email, '');

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, email)
  values (new.id, split_part(new.email, '@', 1), new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.sync_profile_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end $$;
drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row execute function public.sync_profile_email();

-- 9) Fix logins without email. Supabase's built-in mailer barely delivers
--    anything until a real email service is connected, which strands new
--    accounts on a confirmation email that never comes. This confirms every
--    waiting account so they can just sign in with their password.
update auth.users
   set email_confirmed_at = now()
 where email_confirmed_at is null;

-- 10) To set someone's password directly (instead of a reset email that
--     won't arrive): take the -- off the two lines below, fill in the email
--     and the new password, Run — then clear the password from this window.
--
-- update auth.users
--    set encrypted_password = extensions.crypt('THE_NEW_PASSWORD', extensions.gen_salt('bf'))
--  where email = 'info@earthlinkgc.com';

-- 11) The wording fix, applied to every job ALREADY in the portal — not just
--     the ones uploaded from now on. "Primer — 1 coat" becomes "Primer",
--     any "— 1 coat / — 2 coats" tail comes off, and "Wall repair" reads
--     "Scrape and plaster". Prices and quantities are not touched.
update pact_jobs
   set items = (
     select coalesce(jsonb_agg(
       jsonb_set(t.it, '{description}', to_jsonb(
         case when t.it->>'description' = 'Wall repair' then 'Scrape and plaster'
              else regexp_replace(t.it->>'description', '\s*—\s*[12]\s*coats?\s*$', '')
         end
       )) order by t.ord
     ), '[]'::jsonb)
     from jsonb_array_elements(items) with ordinality as t(it, ord)
   )
 where jsonb_typeof(items) = 'array'
   and jsonb_array_length(items) > 0
   and (items::text ~ '—\s*[12]\s*coats?' or items::text like '%Wall repair%');

-- 12) A paper trail for PACT jobs, same as releases have had all along.
--     Every change to a job keeps its before-and-after in audit_log (minus
--     the bulky attachments list) — so if lines are ever lost again, what
--     they said is one query away instead of gone.
create or replace function public.audit_pact_jobs() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log (user_id, action, table_name, record_id, before, after)
  values (auth.uid(), TG_OP, 'pact_jobs', coalesce(new.id, old.id),
          to_jsonb(old) - 'attachments', to_jsonb(new) - 'attachments');
  return coalesce(new, old);
end $$;
drop trigger if exists pact_jobs_audit on pact_jobs;
create trigger pact_jobs_audit
  after insert or update or delete on pact_jobs
  for each row execute function public.audit_pact_jobs();

-- 13) One PO is one job — the database says so too.
-- The site checks before it saves, but two uploads landing in the same
-- second (the phone and the email intake, say) could each pass that check.
-- This makes the second one fail with a plain message instead. Canceled
-- jobs don't count, so a PO can be re-made after its job was canceled.
-- the same stripping the site does: labels off the front ("PO# 09001" →
-- "9001"), then everything that isn't a letter or digit, then leading zeros
create or replace function public.norm_po(v text) returns text
language sql immutable as $$
  select ltrim(regexp_replace(regexp_replace(lower(coalesce(v, '')),
    '^\s*(?:(?:purchase\s*order|p\.?\s*o\.?|work\s*order|w\.?o\.?|order|no\.?|number|#)\s*[:#.-]*\s*)+', '', 'i'),
    '[^a-z0-9]', '', 'g'), '0');
$$;
create or replace function public.pact_jobs_no_dupes() returns trigger
language plpgsql as $$
declare
  k text := public.norm_po(new.po_number);
  twin uuid;
begin
  if k = '' then k := public.norm_po(new.job_number); end if;
  if k = '' or coalesce(new.canceled, false) then return new; end if;
  select id into twin from pact_jobs
   where id <> new.id and not coalesce(canceled, false)
     and (public.norm_po(po_number) = k or public.norm_po(job_number) = k)
   limit 1;
  if twin is not null then
    raise exception 'PO % is already a job (one PO is one job — open that one)', coalesce(nullif(new.po_number, ''), new.job_number)
      using errcode = 'unique_violation';
  end if;
  return new;
end $$;
drop trigger if exists pact_jobs_no_dupes on pact_jobs;
create trigger pact_jobs_no_dupes
  before insert or update of po_number, job_number, canceled on pact_jobs
  for each row execute function public.pact_jobs_no_dupes();
create index if not exists pact_jobs_norm_po on pact_jobs (public.norm_po(po_number));
create index if not exists pact_jobs_norm_job on pact_jobs (public.norm_po(job_number));

-- 14) PACT jobs go on the same crew schedule as NYCHA releases.
-- One crew table, one texting flow: a schedule_days row can belong to a PACT
-- job instead of a release. Worker, day, description, address and the TEXTED
-- mark are the same columns, so the crew texts and their never-double-text
-- guard (/api/text skips rows already stamped) cover PACT with no new machinery.
-- releases.crew (from the older schedule upgrade, above) is dormant —
-- schedule_days superseded it; do not reuse it for PACT.
alter table schedule_days add column if not exists pact_job_id uuid references pact_jobs(id) on delete cascade;
create index if not exists schedule_days_pact_job on schedule_days (pact_job_id);
create index if not exists schedule_days_day on schedule_days (day);

-- The job's site exactly as the app writes it on a crew row — lib/pactCrew.ts
-- siteOf(); keep the two identical: "123 Main St, Brooklyn, NY 11201, Apt 4B"
create or replace function public.pact_site(p pact_jobs) returns text
language sql immutable as $$
  select concat_ws(', ',
    coalesce(nullif(trim(p.address), ''), nullif(trim(p.development), '')),
    case when coalesce(trim(p.property_unit), '') <> '' then 'Apt ' || trim(p.property_unit) end)
$$;

-- Crew rows made before this section ran (texts sent without the link) are
-- matched to their job by day + site and linked.
update schedule_days s set pact_job_id = p.id from pact_jobs p
  where s.pact_job_id is null and s.release_id is null
    and s.day = coalesce(p.start_date, '') and s.address = public.pact_site(p);

-- The job's date and site and its crew rows are ONE fact. This trigger is the
-- only thing that moves crew rows — app code never does (the PACT page's
-- patch, the calendar's save, a re-uploaded PO's new date, a re-read all just
-- write pact_jobs and rely on it). Runs as the caller: admin/office already
-- hold update/delete on schedule_days under RLS.
create or replace function public.pact_job_follows() returns trigger
language plpgsql as $$
begin
  if new.start_date is distinct from old.start_date then
    if coalesce(new.start_date, '') = '' then
      -- no date = off the schedule (a crew with no day is exactly the drift we avoid)
      delete from schedule_days where pact_job_id = new.id and day = coalesce(old.start_date, '');
    else
      -- rows on the old day move to the new day and lose their TEXTED mark
      update schedule_days set day = new.start_date, texted = false
        where pact_job_id = new.id and day = coalesce(old.start_date, '');
    end if;
  end if;
  if public.pact_site(new) is distinct from public.pact_site(old) then
    -- a corrected address reaches the rows the same way (and un-tells the crew)
    update schedule_days set address = public.pact_site(new), texted = false
      where pact_job_id = new.id and address is distinct from public.pact_site(new);
  end if;
  return new;
end $$;
drop trigger if exists pact_job_follows on pact_jobs;
create trigger pact_job_follows
  after update of start_date, address, property_unit, development on pact_jobs
  for each row execute function public.pact_job_follows();

-- 15) A priced job comes off the calendar.
-- A PO is priced on its own the moment it's uploaded — the price list fills
-- the lines it can (1 SF of plaster, its primer, its paint) and that total
-- is written to list_subtotal. When the lines later add up to something
-- else (the real square feet typed after the work, a rate changed by hand)
-- the job is PRICED, and the calendar is done with it. An invoice sent, or
-- a payment in, counts as priced too. The flag is a plain yes/no, so the
-- calendar can read it for everyone without showing anyone a dollar.
-- Jobs from before this section carry no baseline: those count as priced
-- only by money that exists (an invoice sent, a payment in) or when the
-- work is marked done and the lines carry a real measurement — a PO's own
-- square feet on an untouched job never hide it.
alter table pact_jobs add column if not exists list_subtotal numeric;
alter table pact_jobs add column if not exists priced boolean default false;

-- the lines' subtotal (qty × price) — 0 when there are no lines or the value isn't a list
create or replace function public.pact_items_total(items jsonb) returns numeric
language sql immutable as $$
  select case when jsonb_typeof(items) = 'array' then coalesce((
    select sum(
      (case when (it->>'qty') ~ '^-?[0-9]+(\.[0-9]+)?$' then (it->>'qty')::numeric else 0 end)
      * (case when (it->>'unit_price') ~ '^-?[0-9]+(\.[0-9]+)?$' then (it->>'unit_price')::numeric else 0 end))
    from jsonb_array_elements(items) it), 0) else 0 end
$$;
-- a real measurement on the lines: square feet, or any count of ten or more
create or replace function public.pact_items_measured(items jsonb) returns boolean
language sql immutable as $$
  select case when jsonb_typeof(items) = 'array' then coalesce((
    select bool_or(
      (case when (it->>'qty') ~ '^-?[0-9]+(\.[0-9]+)?$' then (it->>'qty')::numeric else 0 end) >= 10
      or (coalesce(it->>'unit', '') ~* 'sf'
          and (case when (it->>'qty') ~ '^-?[0-9]+(\.[0-9]+)?$' then (it->>'qty')::numeric else 0 end) > 1))
    from jsonb_array_elements(items) it), false) else false end
$$;
create or replace function public.pact_job_priced() returns trigger
language plpgsql as $$
begin
  -- the app sends list_subtotal to say "these lines are the list's own"; the
  -- number itself is taken from the lines here, so the app's floating-point
  -- math and this exact math never disagree by a cent
  if new.list_subtotal is not null and (tg_op = 'INSERT' or new.list_subtotal is distinct from old.list_subtotal) then
    new.list_subtotal := round(public.pact_items_total(new.items), 2);
  end if;
  new.priced := new.invoice_sent is not null or coalesce(new.received, false)
    or case when new.list_subtotal is not null
            then round(public.pact_items_total(new.items), 2) <> round(new.list_subtotal, 2)
            else coalesce(new.work_done, false) and public.pact_items_measured(new.items) end;
  return new;
end $$;
drop trigger if exists pact_job_priced on pact_jobs;
create trigger pact_job_priced
  before insert or update of amount, list_subtotal, invoice_sent, received, work_done, items, priced on pact_jobs
  for each row execute function public.pact_job_priced();
-- the jobs already here: priced if an invoice went out, money came in, or the work is done on measured lines
update pact_jobs set priced = (invoice_sent is not null or coalesce(received, false) or (coalesce(work_done, false) and public.pact_items_measured(items)))
  where list_subtotal is null
    and priced is distinct from (invoice_sent is not null or coalesce(received, false) or (coalesce(work_done, false) and public.pact_items_measured(items)));

-- 16) One row per code in a contract's price book. The survey upload adds
--     the move-out release's lines to the book when they are missing; two
--     phones doing that in the same second must not leave a code in twice
--     (a doubled line doubles the sheet, its PDF and the release).
--     Duplicates already there are folded first, keeping the oldest row.
--     Lines with no code (a sheet whose Item column is the description) are
--     left alone — they are not duplicates of one another.
delete from contract_items a
  using contract_items b
  where a.contract_id = b.contract_id and a.code = b.code and a.code <> ''
    and (a.created_at, a.id) > (b.created_at, b.id);
create unique index if not exists contract_items_contract_code_uq on contract_items (contract_id, code) where code <> '';

-- 17) Invoice numbers are held until a job is priced.
--     A PO coming in gets no invoice number. The number is given out the
--     moment the job is PRICED (section 15: the lines add up to more than
--     the price list filled in on its own, an invoice went out, or money
--     came in) — so the run of numbers follows the invoices, not the POs,
--     and a PO that never turns into work never eats a number. One counter
--     for everyone: two phones pricing two jobs in the same second get two
--     numbers. The app asks for a number by hand when it builds an invoice
--     for a job the trigger hasn't numbered yet (pact_claim_invoice_no).
--     Jobs numbered before this section keep their numbers.
create or replace function public.pact_next_invoice_no() returns text
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  -- one at a time, whoever asks — the counter never hands out a twin
  perform pg_advisory_xact_lock(hashtext('pact_invoice_no'));
  -- a number typed by hand may carry a stray space (still the same number);
  -- one far too long to be ours (a date-style 20260921001) is outside the
  -- run, like the old "8300-1" style, and never breaks the counter
  select greatest(568, coalesce(max(trim(invoice_number)::bigint), 0)) + 1 into n
    from pact_jobs where trim(invoice_number) ~ '^[0-9]{1,9}$';
  return n::text;
end $$;
create or replace function public.pact_job_invoice_no() returns trigger
language plpgsql as $$
begin
  if coalesce(new.priced, false) and coalesce(trim(new.invoice_number), '') = '' then
    new.invoice_number := public.pact_next_invoice_no();
  end if;
  return new;
end $$;
-- named to run right after pact_job_priced (triggers fire in name order), so it sees the fresh flag
drop trigger if exists pact_job_priced_invoice on pact_jobs;
create trigger pact_job_priced_invoice
  before insert or update of amount, list_subtotal, invoice_sent, received, work_done, items, priced, invoice_number on pact_jobs
  for each row execute function public.pact_job_invoice_no();
create or replace function public.pact_claim_invoice_no(job uuid) returns text
language plpgsql as $$
declare cur text;
begin
  -- the job's row first, then the counter — the same order a pricing save
  -- takes them (the row, then the trigger's counter), so an invoice being
  -- built while the office prices the same job never deadlocks
  select coalesce(trim(invoice_number), '') into cur from pact_jobs where id = job for update;
  if not found then return null; end if;
  if cur = '' then
    cur := public.pact_next_invoice_no();
    update pact_jobs set invoice_number = cur where id = job;
  end if;
  return cur;
end $$;

-- 18) Each worker's language. The crew text goes out in English or
--     Spanish, worker by worker — set on Settings → Crew. Nothing set
--     reads as English.
alter table employees add column if not exists lang text default 'en';

-- 19) A crew text can be set up for later.
--     The office picks a time — tonight, or tomorrow morning — and the text
--     telling each worker which job to go to goes out then, written fresh at
--     that moment (so a job that moved in between says the new day). Empty
--     means "no text waiting"; it is cleared the moment the text goes out.
--     Texts go out on their own once CRON_SECRET and SUPABASE_SERVICE_ROLE_KEY
--     are set in Vercel; until then they go out while the portal is open.
alter table schedule_days add column if not exists send_at timestamptz;
create index if not exists schedule_days_send_at on schedule_days (send_at) where send_at is not null;

-- 20) Photos the crew texts back. A worker answers the crew text with
--     pictures; the company number hands them to the portal, which puts them
--     on the job that worker is on that day (or the PO they name in the
--     text). Each text that brings pictures is kept here, so the office sees
--     who sent what, can move a batch that landed on the wrong job, and picks
--     the job for any the portal couldn't place. The pictures themselves sit
--     with the job's other documents, so ⬇ Photos takes them too.
--     Needs SUPABASE_SERVICE_ROLE_KEY in Vercel, and the number pointed at
--     /api/sms-in in Twilio (Settings → System check says how).
create table if not exists texted_photos (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references employees(id) on delete set null,
  from_phone text default '',
  body text default '',
  photos jsonb default '[]'::jsonb,
  status text default 'held',   -- held (waiting for the office) · filed (on a job) · gone (thrown away) · note (a text with no pictures) · nobody / reply / seen / moved (section 21)
  pact_job_id uuid references pact_jobs(id) on delete set null,
  release_id uuid references releases(id) on delete set null,
  how text default '',          -- how it got to its job: number (named in a text), burst (sent right along with one that did), day (the one job that day), office
  msg_sid text,
  created_at timestamptz default now()
);
create unique index if not exists texted_photos_msg on texted_photos (msg_sid) where msg_sid is not null;
create index if not exists texted_photos_recent on texted_photos (created_at desc);
alter table texted_photos enable row level security;
-- the office reads them; every write comes from the server, which checks
-- who is asking (Twilio's signature, or an admin/office sign-in) first
drop policy if exists "texted_photos read" on texted_photos;
create policy "texted_photos read" on texted_photos for select
  using ((select public.my_role()) in ('admin','office'));
do $$ begin alter publication supabase_realtime add table texted_photos; exception when duplicate_object then null; end $$;
-- pictures onto a job (and off another) in one step: two texts landing in
-- the same second — a phone often splits five pictures into five texts —
-- each add theirs, and neither loses the other's. Only the server may call it.
create or replace function public.texted_photos_put(p_pact uuid, p_rel uuid, p_add jsonb, p_drop text[])
returns boolean language plpgsql security definer set search_path = public as $$
declare
  adds jsonb := case when jsonb_typeof(p_add) = 'array' then p_add else '[]'::jsonb end;
  gone text[] := coalesce(p_drop, '{}') || coalesce((select array_agg(x->>'path') from jsonb_array_elements(adds) x), '{}');
  hit int := 0;
begin
  if p_pact is not null then
    update pact_jobs set attachments = coalesce((
      select jsonb_agg(t.a order by t.o)
        from jsonb_array_elements(case when jsonb_typeof(attachments) = 'array' then attachments else '[]'::jsonb end) with ordinality t(a, o)
       where not (coalesce(t.a->>'path', '') = any(gone))), '[]'::jsonb) || adds
     where id = p_pact;
    get diagnostics hit = row_count;
  elsif p_rel is not null then
    update releases set attachments = coalesce((
      select jsonb_agg(t.a order by t.o)
        from jsonb_array_elements(case when jsonb_typeof(attachments) = 'array' then attachments else '[]'::jsonb end) with ordinality t(a, o)
       where not (coalesce(t.a->>'path', '') = any(gone))), '[]'::jsonb) || adds
     where id = p_rel;
    get diagnostics hit = row_count;
  end if;
  return hit > 0;
end $$;
revoke all on function public.texted_photos_put(uuid, uuid, jsonb, text[]) from public, anon, authenticated;
grant execute on function public.texted_photos_put(uuid, uuid, jsonb, text[]) to service_role;

-- 21) "Nobody home." A worker who can't get in (nobody answers, the tenant
--     can't do it today) texts the company number "no". The job gets a
--     ⚠ Nobody home mark — a line on the job's notes, and a notice on the
--     Schedule tabs — and the worker is sent their next job (another one
--     they have today, or their next day's job moved up to today). The mark
--     comes off by itself once the office gives the job a new day. Needs
--     section 20.
alter table texted_photos add column if not exists note text default '';   -- what the portal did about it: "Moved PO 220011 up from Wed Sep 23 and sent Jose"
alter table texted_photos add column if not exists day text;                -- the work day (New York) a door was reported on
create index if not exists texted_photos_open on texted_photos (status) where status in ('held', 'nobody', 'reply');
-- one report per door per day: two workers at the same door texting in the
-- same second can't both move the next job up — the second one is told it's
-- already reported
create unique index if not exists texted_photos_one_door on texted_photos (coalesce(pact_job_id, release_id), day)
  where status = 'nobody' and day is not null;
-- when each crew text went out from the company number: a plain "no" soon
-- after a text about tomorrow is an answer to that text, not a door
alter table schedule_days add column if not exists texted_at timestamptz;
-- a PACT job given a new day: its ⚠ is done with
create or replace function public.texted_nobody_moved() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.start_date is distinct from old.start_date then
    update texted_photos set status = 'moved' where pact_job_id = new.id and status = 'nobody';
  end if;
  return new;
end $$;
drop trigger if exists pact_job_nobody_moved on pact_jobs;
create trigger pact_job_nobody_moved
  after update of start_date on pact_jobs
  for each row execute function public.texted_nobody_moved();
-- a release put on a later day on the Schedule tab: the same
create or replace function public.texted_nobody_rebooked() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.release_id is not null then
    update texted_photos set status = 'moved'
     where release_id = new.release_id and status = 'nobody'
       and new.day > to_char(created_at at time zone 'America/New_York', 'YYYY-MM-DD');
  end if;
  return new;
end $$;
drop trigger if exists schedule_days_nobody_rebooked on schedule_days;
create trigger schedule_days_nobody_rebooked
  after insert on schedule_days
  for each row execute function public.texted_nobody_rebooked();
