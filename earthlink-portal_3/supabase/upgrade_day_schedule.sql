-- Day-by-day crew schedule: assign workers to a release for a specific date,
-- with a work description — powers the Schedule tab and its tap-to-text.
create table if not exists schedule_days (
  id uuid primary key default gen_random_uuid(),
  day text not null,                                   -- the date being scheduled (YYYY-MM-DD)
  release_id uuid references releases(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  description text default '',
  address text default '',
  texted boolean default false,
  created_at timestamptz default now()
);
-- if the table already exists from an earlier run, the address column rides in here
alter table schedule_days add column if not exists address text default '';
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

-- phone numbers ride along (same as upgrade_worker_phone.sql, safe to re-run)
alter table employees add column if not exists phone text default '';
