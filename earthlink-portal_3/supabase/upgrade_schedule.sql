-- ============================================================
-- UPGRADE: schedule — crew assigned to each release
-- Paste into Supabase → SQL Editor → Run. Safe to run twice.
-- ============================================================
alter table releases add column if not exists crew jsonb default '[]'::jsonb;
