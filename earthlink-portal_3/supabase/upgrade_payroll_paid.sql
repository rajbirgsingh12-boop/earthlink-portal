-- ============================================================
-- UPGRADE: worker payment tracking on payroll weeks
-- Paste into Supabase → SQL Editor → Run. Safe to run twice.
-- ============================================================
alter table timesheet_weeks add column if not exists paid_map jsonb default '{}'::jsonb;
