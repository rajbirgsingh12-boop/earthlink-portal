-- ============================================================
-- UPGRADE: NYCHA proposal (walk sheet) creator
-- Paste ALL of this into Supabase → SQL Editor → Run.
-- Safe to run more than once. Run AFTER upgrade_invoices_aging_docs.sql.
-- ============================================================

-- ---- per-contract price list (the full NYCHA catalog with line numbers) ----
create table if not exists contract_items (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references contracts(id) on delete cascade,
  line int default 0,
  code text default '',
  category text default '',
  description text default '',
  uom text default '',
  unit_price numeric default 0,
  created_at timestamptz default now()
);
create index if not exists contract_items_contract_idx on contract_items(contract_id);
alter table contract_items enable row level security;
drop policy if exists "contract_items read" on contract_items;
create policy "contract_items read" on contract_items for select
  using (auth.uid() is not null);
drop policy if exists "contract_items ins" on contract_items;
create policy "contract_items ins" on contract_items for insert
  with check (my_role() in ('admin','office'));
drop policy if exists "contract_items upd" on contract_items;
create policy "contract_items upd" on contract_items for update
  using (my_role() in ('admin','office'));
drop policy if exists "contract_items del" on contract_items;
create policy "contract_items del" on contract_items for delete
  using (my_role() in ('admin','office'));

-- ---- NYCHA walk-sheet fields on proposals (additive; the existing
--      proposals table and page keep working unchanged) ----
alter table proposals add column if not exists contract_id uuid references contracts(id);
alter table proposals add column if not exists development text default '';
alter table proposals add column if not exists address text default '';
alter table proposals add column if not exists apt text default '';
alter table proposals add column if not exists stairhall text default '';
alter table proposals add column if not exists walk_date text default '';
alter table proposals add column if not exists release_number text default '';
alter table proposals add column if not exists total numeric default 0;
alter table proposal_items add column if not exists category text default '';
alter table proposal_items add column if not exists line int default 0;
