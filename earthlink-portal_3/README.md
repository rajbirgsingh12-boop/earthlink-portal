# Earth Link Field Office — Portal (Complete build)

Multi-user portal: logins + roles (admin / office / foreman / accountant), releases with chase list + canceled handling + xlsx import/export + audit log, price book, proposals → invoices with print-to-PDF, client statements with aging, weekly payroll with OT math + accountant export, company letterhead settings.

## Deploy (≈20 minutes, one time, on a laptop)

**1. Supabase (database + logins) — free**
1. supabase.com → New project (name it earthlink, pick a strong DB password, region US East).
2. SQL Editor → New query → paste ALL of `supabase/schema.sql` → Run.
3. Authentication → Users → Add user → your email + a password.
4. Project Settings → API → copy the `Project URL` and `anon public` key.

**2. Put the code on GitHub**
1. github.com → New repository (private) → name `earthlink-portal`.
2. Upload this whole folder (or `git init && git add -A && git commit -m init && git push`).

**3. Vercel (hosting) — free**
1. vercel.com → Add New → Project → import the GitHub repo.
2. Environment Variables: `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (from step 1.4).
3. Deploy. You get a live URL like earthlink-portal.vercel.app (add a custom domain later in Vercel settings).

**4. First sign-in**
1. Open the URL → sign in with the user from step 1.3.
2. Back in Supabase SQL Editor, promote yourself:
   `update profiles set role = 'admin' where id = (select id from auth.users where email = 'YOUR_EMAIL');`
3. Refresh the portal → you now see the Users tab. Add teammates in Supabase (Auth → Add user), they sign in, you set their roles.

**5. Load your data**
Releases tab → Upload sheet → drop your contract xlsx (or the export from the Claude artifact — its Status column carries the canceled flags over automatically).

## Local dev (optional)
```
cp .env.example .env.local   # fill in the two values
npm install
npm run dev
```

## Roles
- **admin** — everything + Users tab + audit log
- **office** — contracts, releases, imports
- **foreman** — sees only releases assigned to them (assignment UI comes in Phase 4; until then foremen see nothing, which is correct)
- **accountant** — read-only

## After first sign-in, do these once
1. Settings tab → fill the letterhead (address, phone, license, terms).
2. Price Book → Upload sheet (your price list xlsx) or add items.
3. Releases → Upload sheet (contract xlsx, or the Claude artifact export — its Status column carries canceled flags).
4. Payroll → Crew → add workers and rates.

## Still on the roadmap (Phase 4 — build with Claude Code from PORTAL_SPEC.md)
Job photos, assigning releases to foremen + notifications, ceiling dashboard.
