-- ============================================================
-- UPGRADE: schedule — crew + start/finish dates on releases,
-- start/finish dates on PACT jobs
-- Paste into Supabase → SQL Editor → Run. Safe to run twice.
-- ============================================================
alter table releases add column if not exists crew jsonb default '[]'::jsonb;
alter table releases add column if not exists start_date text default '';
alter table releases add column if not exists finish_date text default '';
alter table pact_jobs add column if not exists start_date text default '';
alter table pact_jobs add column if not exists finish_date text default '';
