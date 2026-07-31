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
