-- ============================================================
-- UPGRADE: invoice generator + payment aging + document storage
-- Paste ALL of this into Supabase → SQL Editor → Run. Safe to run
-- more than once, and safe on a database that already has some of it.
-- ============================================================

-- ---- line items imported from a NYCHA release PDF ----
create table if not exists release_items (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references releases(id) on delete cascade,
  line int default 0,
  code text default '',
  description text default '',
  qty numeric default 0,
  uom text default '',
  unit_price numeric default 0,
  amount numeric default 0
);
create index if not exists release_items_release_idx on release_items(release_id);
alter table release_items enable row level security;
drop policy if exists "release_items read" on release_items;
create policy "release_items read" on release_items for select
  using (my_role() in ('admin','office','accountant') or exists (
    select 1 from releases r where r.id = release_items.release_id and r.assigned_to = auth.uid()));
drop policy if exists "release_items ins" on release_items;
create policy "release_items ins" on release_items for insert
  with check (my_role() in ('admin','office'));
drop policy if exists "release_items upd" on release_items;
create policy "release_items upd" on release_items for update
  using (my_role() in ('admin','office'));
drop policy if exists "release_items del" on release_items;
create policy "release_items del" on release_items for delete
  using (my_role() in ('admin','office'));

-- ---- releases: aging dates, address, attached documents ----
alter table releases add column if not exists address text default '';
alter table releases add column if not exists invoice_sent date;
alter table releases add column if not exists paid_date date;
alter table releases add column if not exists attachments jsonb default '[]'::jsonb;

-- ---- invoices: NYCHA header fields ----
alter table invoices add column if not exists release_id uuid references releases(id) on delete set null;
alter table invoices add column if not exists contract_number text default '';
alter table invoices add column if not exists release_number text default '';
alter table invoices add column if not exists development text default '';
alter table invoices add column if not exists work_order text default '';
alter table invoices add column if not exists period_from date;
alter table invoices add column if not exists period_to date;
alter table invoice_items add column if not exists category text default '';

-- ---- private storage bucket for release documents ----
insert into storage.buckets (id, name, public) values ('docs', 'docs', false)
  on conflict (id) do nothing;
drop policy if exists "docs read" on storage.objects;
create policy "docs read" on storage.objects for select
  using (bucket_id = 'docs' and auth.uid() is not null);
drop policy if exists "docs write" on storage.objects;
create policy "docs write" on storage.objects for insert
  with check (bucket_id = 'docs' and public.my_role() in ('admin','office'));
drop policy if exists "docs delete" on storage.objects;
create policy "docs delete" on storage.objects for delete
  using (bucket_id = 'docs' and public.my_role() in ('admin','office'));
