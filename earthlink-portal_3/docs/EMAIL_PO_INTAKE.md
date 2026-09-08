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
get the Gmail label **EarthLink-Imported**; remove that label from a thread to
make it go through again.

Only emails that arrive from the day you run **setup** onward are looked at —
everything older is already handled by hand. (Run **setup** again to reset that day.)

## The smart reader
With `ANTHROPIC_API_KEY` set in Vercel (Settings → Health check shows "Smart PO
reader (Claude)" green), Claude reads each PO PDF itself — any partner's layout —
and the rule reader cross-checks it: the PO number must be printed on the page and
the money must add up, or the rules read is used instead. Every job's note says
which reader it came from. Without the key, POs read by the rules as before.

## What the site does with each PDF
- **Partner PO** → new job: partner, PO #, address, apartment, description, work lines, the PO's date onto the schedule. PDF attached to the job.
- **PO already a job** (typed by hand or uploaded from the phone) → the PDF is attached to that job, nothing new is made.
- **NYCHA blanket release** → skipped; those go on the Releases tab.
- **A scan, or not a PO** (a supplier invoice, a flyer) → skipped.

Every email with a PDF is looked at; the site only makes jobs out of real POs.
To cut noise, put partner names in the script's `SENDERS` list.

## Not working?
In the script editor pick **testNow** and Run, then open the log (Executions,
or View → Logs). It says in plain words what's wrong: the site redirecting to
another address, the intake switched off in Vercel, a key mismatch, or simply
nothing in the inbox to import.
