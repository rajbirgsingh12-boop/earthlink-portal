-- Worker phone numbers, used by the tap-to-text buttons in Payroll and PACT.
alter table employees add column if not exists phone text default '';
