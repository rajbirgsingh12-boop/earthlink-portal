# POs straight from Gmail

Partner POs that land in the company Gmail turn into PACT jobs on their own.
A PO that names a day goes onto the Schedule; one that doesn't shows under
**Need to schedule**. Every job made this way carries a 📧 chip and a note
saying it was read automatically — check the work lines before pricing or
sending anything.

## One-time setup (about 10 minutes)

### 1. Two settings in Vercel
Vercel → the project → Settings → Environment Variables → add:

| Name | Value |
| --- | --- |
| `PO_INTAKE_KEY` | any long random string (a password only the script and the site know) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → **service_role** key |

Then Deployments → ⋯ on the latest → **Redeploy** so the site picks them up.
Settings → Health check in the portal shows "Email PO intake (Gmail)" green once it has.

### 2. The Gmail script
1. Signed in to the company Gmail, open **script.google.com** → **New project**.
2. Delete what's in the editor, paste all of `scripts/gmail-po-intake.gs`.
3. At the top, set `SITE` to the portal's address and `KEY` to the same `PO_INTAKE_KEY`.
4. Pick **setup** in the function dropdown, press **Run**, allow the permissions Google asks for.

That's it. The script checks the inbox every 10 minutes. Threads it has handled
get the Gmail label **Earth Link/Imported**; remove that label from a thread to
make it go through again.

## What the site does with each PDF
- **Partner PO** → new job: partner, PO #, address, apartment, description, work lines, the PO's date onto the schedule. PDF attached to the job.
- **PO already a job** (typed by hand or uploaded from the phone) → the PDF is attached to that job, nothing new is made.
- **NYCHA blanket release** → skipped; those go on the Releases tab.
- **A scan, or not a PO** (a supplier invoice, a flyer) → skipped.

Only senders in the script's `SENDERS` list are looked at (Fairstead and Boulevard
to start). Add a new partner's name there when one comes on.
