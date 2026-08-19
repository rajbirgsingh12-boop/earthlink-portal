-- PACT invoicing belongs to Admin 1 only
--
-- The portal already hides invoice numbers, invoice screens, invoice PDFs and
-- the money totals from the Admin 2 (office) account. This adds the same rule
-- in the database, so it holds even for someone poking at the API directly.
--
-- Safe to run more than once.

create or replace function pact_invoice_fields_admin_only()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if my_role() <> 'admin' and (
       new.invoice_number is distinct from old.invoice_number
    or new.invoice_sent   is distinct from old.invoice_sent
    or new.received       is distinct from old.received
    or new.paid_date      is distinct from old.paid_date
  ) then
    raise exception 'Only Admin 1 can change PACT invoicing (invoice number, invoiced, received, paid)';
  end if;
  return new;
end $$;

drop trigger if exists pact_invoice_fields_admin_only on pact_jobs;
create trigger pact_invoice_fields_admin_only
  before update on pact_jobs
  for each row execute function pact_invoice_fields_admin_only();
