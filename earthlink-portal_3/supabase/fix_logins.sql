-- ============================================================
-- FIX LOGINS WITHOUT EMAIL
-- Supabase's built-in mailer barely delivers anything until you connect
-- your own email service, so confirmation and reset emails may never
-- arrive. This file fixes stuck accounts directly — no email involved.
-- Paste into Supabase → SQL Editor → Run. Safe to run more than once.
-- ============================================================

-- 1) Un-stick every account that is waiting on a confirmation email
--    it will never get. After this they can sign in with their password.
update auth.users
   set email_confirmed_at = now()
 where email_confirmed_at is null;

-- 2) To set someone's password directly (instead of a reset email):
--    take the -- off the two lines below, put in the email and the new
--    password, and Run. Then delete the password from this window.
--
-- update auth.users
--    set encrypted_password = extensions.crypt('THE_NEW_PASSWORD', extensions.gen_salt('bf'))
--  where email = 'info@earthlinkgc.com';
