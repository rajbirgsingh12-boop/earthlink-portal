-- Storage meter: lets the Settings page show how much of the file storage is
-- used, so upgrading the Supabase plan is a decision made on real numbers.
create or replace function public.storage_usage()
returns json
language sql
security definer
set search_path = ''
as $$
  select json_build_object(
    'bytes', coalesce(sum((metadata->>'size')::bigint), 0),
    'files', count(*)
  )
  from storage.objects
  where bucket_id = 'docs';
$$;
revoke all on function public.storage_usage() from public;
grant execute on function public.storage_usage() to authenticated;
