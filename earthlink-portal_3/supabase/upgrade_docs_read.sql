-- Documents & photos: reading requires an office role, not just any sign-in —
-- except a foreman may read files under a release assigned to them (their own
-- job photos and scope documents; paths are "<release id>/<file>").
-- (Uploads stay open to signed-in users so field photos keep working.)
drop policy if exists "docs read" on storage.objects;
create policy "docs read" on storage.objects for select
  using (bucket_id = 'docs' and (
    public.my_role() in ('admin','office','accountant')
    or exists (
      select 1 from public.releases r
      where r.id::text = (storage.foldername(name))[1] and r.assigned_to = auth.uid()
    )
  ));
