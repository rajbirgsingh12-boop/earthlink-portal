-- ============================================================
-- UPGRADE: show each person's email on the Settings page
-- Paste ALL of this into Supabase → SQL Editor → Run.
-- Safe to run more than once.
-- ============================================================
-- Emails live in auth.users, which the app is not allowed to read. This copies
-- each one onto the person's profile row — the table the Settings page already
-- reads — and keeps it there as accounts are added or their email changes.

alter table profiles add column if not exists email text default '';

-- ---- fill in everyone who already has an account ----
update profiles p
   set email = u.email
  from auth.users u
 where u.id = p.id
   and coalesce(p.email, '') is distinct from coalesce(u.email, '');

-- ---- a new signup carries its email onto the profile ----
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, email)
  values (new.id, split_part(new.email, '@', 1), new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---- and a changed email in the Supabase dashboard follows through ----
create or replace function public.sync_profile_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end $$;
drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row execute function public.sync_profile_email();

-- Nothing else changes: the existing policy already lets an admin update a
-- profile row, which is what the rename on the Settings page uses. A policy
-- letting people edit their own row is deliberately NOT added here — row-level
-- security cannot limit that to the name column, so it would also let anyone
-- hand themselves the admin role.
