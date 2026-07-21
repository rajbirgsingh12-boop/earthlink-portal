-- ============================================================
-- UPGRADE: live updates (no refresh needed)
-- Paste into Supabase → SQL Editor → Run. Safe to run twice.
-- ============================================================
do $$ begin alter publication supabase_realtime add table releases; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table proposals; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table timesheet_entries; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table timesheet_weeks; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table pact_jobs; exception when duplicate_object then null; end $$;
