-- ============================================================
-- UPGRADE: PACT proposals — track when one goes out
-- Paste ALL of this into Supabase → SQL Editor → Run. Safe to run twice.
-- ============================================================

-- the date the proposal letter was sent to the partner, so a quote waiting on
-- a signature is visible the same way an unpaid invoice is
alter table pact_jobs add column if not exists proposal_sent date;
