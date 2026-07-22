-- ============================================================
-- UPGRADE: per-entry classification on payroll hours
-- The same worker can count as a laborer on one job and a
-- plasterer on another — the classification typed on the entry
-- wins over the worker's default trade.
-- Paste into Supabase → SQL Editor → Run. Safe to run twice.
-- ============================================================
alter table timesheet_entries add column if not exists trade text;
