-- ============================================================
-- UPGRADE: partial payments — track how much NYCHA has paid
-- on each release, not just paid/unpaid
-- Paste into Supabase → SQL Editor → Run. Safe to run twice.
-- ============================================================
alter table releases add column if not exists amount_received numeric default 0;
