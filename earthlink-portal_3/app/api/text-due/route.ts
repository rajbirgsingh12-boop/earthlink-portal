// Crew texts that were set up for later. Every row in the crew table can
// carry a time (RUN_ME section 19's send_at); when that time comes, the text
// is written fresh — so a job that moved in between says the new day — and
// sent from the company number.
//
// Two ways in, and it needs both:
//   • Vercel Cron calls it on a schedule with CRON_SECRET, so texts go out
//     whether or not anyone has the portal open. In Vercel → Settings →
//     Environment Variables add CRON_SECRET (any long random string) and
//     SUPABASE_SERVICE_ROLE_KEY (Supabase → Settings → API → service_role).
//     vercel.json runs it once a day, which is all a free Vercel plan
//     allows — a deploy is refused outright for anything more often. On a
//     paid plan change that schedule to "*/15 * * * *" and a text set for
//     a particular hour goes out on the quarter hour without anybody there.
//   • The portal itself calls it while someone has it open, with their own
//     sign-in. That is the catch-up when the cron isn't set up yet.
import { NextResponse } from "next/server";
import { langOf } from "@/lib/crewText";
import { dueBody, dueSkip, dueWork } from "@/lib/dueText";
import { spanishWorkServer } from "@/lib/smartTranslate";
import { sendTexts, twilioConfigured } from "@/lib/twilio";

export const runtime = "nodejs";
export const maxDuration = 60;
const env = (k: string) => process.env[k] || "";
const cleanPhone = (s: string): string => {
  const d = (s || "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d.length > 11 ? `+${d}` : "";
};
interface Row { id: string; day: string; employee_id: string; description?: string | null; address?: string | null; texted?: boolean; send_at?: string | null; release_id?: string | null; pact_job_id?: string | null }
interface Emp { id: string; name?: string | null; phone?: string | null; lang?: string | null }
interface Job { id: string; po_number?: string | null; job_number?: string | null; address?: string | null; development?: string | null; property_unit?: string | null; description?: string | null; start_date?: string | null; canceled?: boolean; work_done?: boolean }
interface Rel { id: string; rel_number?: string | null; location?: string | null; address?: string | null; canceled?: boolean }

// who is asking: Vercel's cron (and then the service key does the reading), or
// a signed-in admin/office person with the portal open (their own sign-in does)
async function authorize(req: Request): Promise<{ key: string; token: string } | { error: string; status: number }> {
  const supaUrl = env("NEXT_PUBLIC_SUPABASE_URL");
  const anon = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!supaUrl || !anon) return { error: "The portal's database isn't set up", status: 500 };
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const secret = env("CRON_SECRET");
  if (secret && bearer && bearer === secret) {
    const service = env("SUPABASE_SERVICE_ROLE_KEY");
    if (!service) return { error: "Add SUPABASE_SERVICE_ROLE_KEY in Vercel so scheduled texts can go out on their own", status: 500 };
    return { key: service, token: service };
  }
  if (!bearer) return { error: "Not signed in", status: 401 };
  const uRes = await fetch(`${supaUrl}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${bearer}` }, cache: "no-store" });
  if (!uRes.ok) return { error: "Not signed in", status: 401 };
  const user = (await uRes.json()) as { id?: string };
  if (!user.id) return { error: "Not signed in", status: 401 };
  const pRes = await fetch(`${supaUrl}/rest/v1/profiles?id=eq.${user.id}&select=role`, { headers: { apikey: anon, Authorization: `Bearer ${bearer}` }, cache: "no-store" });
  const role = (pRes.ok ? ((await pRes.json()) as { role?: string }[]) : [])[0]?.role || "";
  if (role !== "admin" && role !== "office") return { error: "Not allowed", status: 403 };
  return { key: anon, token: bearer };
}

// Vercel's cron calls GET (it never POSTs), so that is where the sweep runs
// for it. Without the cron's secret, GET is just the health answer the
// Settings page reads.
export async function GET(req: Request) {
  const secret = env("CRON_SECRET");
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (secret && bearer === secret) return sweep(req);
  return NextResponse.json({
    texting: twilioConfigured(),
    onItsOwn: !!(env("CRON_SECRET") && env("SUPABASE_SERVICE_ROLE_KEY")),
  });
}
// the portal, open on somebody's phone, catching up on anything due
export async function POST(req: Request) { return sweep(req); }

async function sweep(req: Request) {
  const who = await authorize(req);
  if ("error" in who) return NextResponse.json({ error: who.error }, { status: who.status });
  const supaUrl = env("NEXT_PUBLIC_SUPABASE_URL");
  const H = { apikey: who.key, Authorization: `Bearer ${who.token}`, "Content-Type": "application/json" };
  const get = async <T>(path: string): Promise<T[]> => {
    const r = await fetch(`${supaUrl}/rest/v1/${path}`, { headers: H, cache: "no-store" });
    return r.ok ? ((await r.json()) as T[]) : [];
  };
  const clear = async (ids: string[]) => {
    if (!ids.length) return;
    await fetch(`${supaUrl}/rest/v1/schedule_days?id=in.(${ids.join(",")})`, { method: "PATCH", headers: H, body: JSON.stringify({ send_at: null }) }).catch(() => {});
  };
  // Take the rows before sending: the stamp is cleared only on rows that
  // still had one, and the answer says which those were. The cron and a phone
  // with the portal open can sweep at the same moment; only one of them ends
  // up holding a row, so nobody is texted twice. A row whose send then fails
  // shows as not told — visible, and better than a double text.
  const claim = async (ids: string[]): Promise<Set<string>> => {
    if (!ids.length) return new Set();
    const r = await fetch(`${supaUrl}/rest/v1/schedule_days?id=in.(${ids.join(",")})&send_at=not.is.null&texted=is.false`, {
      method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify({ send_at: null }),
    }).catch(() => null);
    if (!r || !r.ok) return new Set();
    return new Set(((await r.json().catch(() => [])) as { id: string }[]).map((x) => x.id));
  };

  const now = new Date();
  const due = await get<Row>(`schedule_days?send_at=lte.${encodeURIComponent(now.toISOString())}&texted=is.false&select=id,day,employee_id,description,address,texted,send_at,release_id,pact_job_id&order=send_at&limit=200`);
  if (due.length === 0) return NextResponse.json({ sent: 0, missed: 0, failed: 0, due: 0 });
  if (!twilioConfigured()) {
    return NextResponse.json({ sent: 0, missed: 0, failed: 0, due: due.length, note: "The company texting number isn't set up, so a text can't go out on its own" });
  }

  const ids = (xs: (string | null | undefined)[]) => [...new Set(xs.filter(Boolean) as string[])];
  const [emps, jobs, rels] = await Promise.all([
    get<Emp>(`employees?id=in.(${ids(due.map((r) => r.employee_id)).join(",")})&select=id,name,phone,lang`),
    ids(due.map((r) => r.pact_job_id)).length
      ? get<Job>(`pact_jobs?id=in.(${ids(due.map((r) => r.pact_job_id)).join(",")})&select=id,po_number,job_number,address,development,property_unit,description,start_date,canceled,work_done`)
      : Promise.resolve([] as Job[]),
    ids(due.map((r) => r.release_id)).length
      ? get<Rel>(`releases?id=in.(${ids(due.map((r) => r.release_id)).join(",")})&select=id,rel_number,location,address,canceled`)
      : Promise.resolve([] as Rel[]),
  ]);
  const empOf = new Map(emps.map((e) => [e.id, e]));
  const jobOf = new Map(jobs.map((j) => [j.id, j]));
  const relOf = new Map(rels.map((r) => [r.id, r]));

  const missed: string[] = [];
  const out: { to: string; body: string; id: string }[] = [];
  for (const row of due) {
    const emp = empOf.get(row.employee_id);
    const job = row.pact_job_id ? jobOf.get(row.pact_job_id) : undefined;
    const rel = row.release_id ? relOf.get(row.release_id) : undefined;
    const phone = cleanPhone(emp?.phone || "");
    // the work is off, the day has gone by, nobody to text: the stamp comes
    // off and the crew shows as not told — never a text about a day that passed
    if (dueSkip(row, { emp, job, rel, phone, now })) { missed.push(row.id); continue; }
    const raw = dueWork(row, job);
    const work = langOf(emp!.lang) === "es" && raw ? await spanishWorkServer(raw) : raw;
    out.push({ to: phone, body: dueBody(row, { emp: emp!, job, rel, work }), id: row.id });
  }
  await clear(missed);
  if (out.length === 0) return NextResponse.json({ sent: 0, missed: missed.length, failed: 0, due: due.length });
  const held = await claim(out.map((m) => m.id));
  const mine = out.filter((m) => held.has(m.id));
  if (mine.length === 0) return NextResponse.json({ sent: 0, missed: missed.length, failed: 0, due: due.length });

  const { sent, failed } = await sendTexts(mine, async (m) => {
    await fetch(`${supaUrl}/rest/v1/schedule_days?id=eq.${m.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ texted: true }) }).catch(() => {});
  });
  return NextResponse.json({ sent, missed: missed.length, failed: failed.length, due: due.length, ...(failed.length ? { errors: failed.slice(0, 5) } : {}) });
}
