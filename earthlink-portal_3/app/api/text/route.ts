// The "text machine": sends crew texts from the company's Twilio number so
// nothing goes out from anyone's personal phone. Configured entirely by env
// vars in Vercel — until they're set, POST answers 501 and the Schedule tab
// falls back to opening the phone's own Messages app.
//
// Vercel → Project → Settings → Environment Variables:
//   TWILIO_ACCOUNT_SID   — from the Twilio console dashboard
//   TWILIO_AUTH_TOKEN    — same place
//   TWILIO_FROM          — the purchased number, e.g. +18885551234
//   (or TWILIO_MESSAGING_SERVICE_SID instead of TWILIO_FROM)
import { lastWorkDay } from "@/lib/workDays";
import { NextResponse } from "next/server";
import { copyProblem, copyTo, twilioConfigured, twilioProblem } from "@/lib/twilio";
import { sendCrew, type CrewFail, type CrewOut } from "@/lib/crewSend";
import { cleanPhone } from "@/lib/notify";
import { groupLastError, groupProblem, groupsOn, publicOrigin } from "@/lib/groupText";
import { photosBackOn, serviceDb } from "@/lib/photoStore";
import { fitText, withJobAsk, withPhotoInvite } from "@/lib/crewText";
import { jobAsk } from "@/lib/jobFlow";
import { nyDay } from "@/lib/sendLater";
import type { SfLine } from "@/lib/measure";

// a full 100-message batch takes ~30s of sequential Twilio calls — don't let
// the platform kill the function mid-loop
export const maxDuration = 60;

const env = (k: string) => process.env[k] || "";
// the keys themselves live in lib/twilio, which /api/text-due sends through too
const configured = twilioConfigured;

// spend guard: even a signed-in account can't fire more than 200 texts an hour
// (a 20-man crew texted daily is ~20 — this only stops runaways and stolen sessions)
const sentLog = new Map<string, number[]>();
const overLimit = (userId: string, count: number) => {
  const now = Date.now();
  const kept = (sentLog.get(userId) || []).filter((t) => now - t < 3600_000);
  if (kept.length + count > 200) { sentLog.set(userId, kept); return true; }
  for (let i = 0; i < count; i++) kept.push(now);
  sentLog.set(userId, kept);
  return false;
};

// photosIn: a picture texted back to the company number lands on the job
// (/api/sms-in), so the texts end by asking for them. problem: a key that is
// there but typed wrong (Settings → System check shows it)
export async function GET(req: Request) {
  const photosIn = configured() && (await photosBackOn());
  // ?job=<id>: the ask (before photos, after photos) as that job's crew text will carry it, in
  // both languages — read as the portal itself, so only the words leave here
  const job = (new URL(req.url).searchParams.get("job") || "").trim();
  let ask: { en: string; es: string } | undefined;
  if (job && /^[0-9a-f-]{36}$/i.test(job)) {
    const svc = serviceDb();
    const row = svc ? (await svc.get<{ items?: unknown }>(`pact_jobs?id=eq.${job}&select=items`)).rows[0] : undefined;
    const items = row && Array.isArray(row.items) ? (row.items as SfLine[]) : null;
    ask = { en: jobAsk("en", items ?? true), es: jobAsk("es", items ?? true) };
  }
  return NextResponse.json({ configured: configured(), photosIn, problem: twilioProblem() || copyProblem(), copy: !!copyTo(), group: groupsOn(), groupProblem: groupProblem() || groupLastError(), ...(ask ? { ask } : {}) });
}

export async function POST(req: Request) {
  if (!configured()) {
    return NextResponse.json({ configured: false, error: "The company texting number isn't set up yet" }, { status: 501 });
  }
  // only signed-in admin/office users may send — the token is the caller's
  // own Supabase session, checked against Supabase before anything goes out
  const supaUrl = env("NEXT_PUBLIC_SUPABASE_URL");
  const anon = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || !supaUrl || !anon) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const uRes = await fetch(`${supaUrl}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!uRes.ok) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const user = (await uRes.json()) as { id?: string };
  if (!user.id) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const pRes = await fetch(`${supaUrl}/rest/v1/profiles?id=eq.${user.id}&select=role`, {
    headers: { apikey: anon, Authorization: `Bearer ${token}` }, cache: "no-store",
  });
  const profs = pRes.ok ? ((await pRes.json()) as { role?: string }[]) : [];
  const role = profs[0]?.role || "";
  if (role !== "admin" && role !== "office") return NextResponse.json({ error: "Not allowed" }, { status: 403 });

  let body: { messages?: { to?: string; body?: string; id?: string }[]; skipTexted?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Bad request" }, { status: 400 }); }
  let messages = (body.messages || [])
    .map((m) => ({ to: String(m.to || "").trim(), body: fitText(String(m.body || "").trim(), 1400), id: String(m.id || "").trim() }))
    .filter((m) => /^\+\d{10,15}$/.test(m.to) && m.body);
  if (messages.length === 0 || messages.length > 100) {
    return NextResponse.json({ error: "Nothing to send (check the phone numbers)" }, { status: 400 });
  }
  const supaHeaders = { apikey: anon, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  // read as the portal itself when it can (the caller is already a checked
  // admin/office sign-in; nothing read here goes back to them), else as them.
  // null when the read itself failed, so a failed read never looks like "none"
  const svc = serviceDb();
  const read = async <T>(path: string): Promise<T[] | null> => {
    if (svc) { const r = await svc.get<T>(path); return r.ok ? r.rows : null; }
    const r = await fetch(`${supaUrl}/rest/v1/${path}`, { headers: supaHeaders, cache: "no-store" }).catch(() => null);
    return r && r.ok ? ((await r.json().catch(() => null)) as T[] | null) : null;
  };
  // each message's crew row and its PACT job: the day the text is about, and the job's lines for the ask
  const ids = [...new Set(messages.map((m) => m.id).filter(Boolean))];
  const rowOf = new Map<string, DayRow>();
  const jobOf = new Map<string, DayJob>();
  if (ids.length) {
    (await read<DayRow>(`schedule_days?id=in.(${ids.join(",")})&select=id,day,pact_job_id,release_id`) || []).forEach((r) => rowOf.set(r.id, r));
    const jobIds = [...new Set([...rowOf.values()].map((r) => r.pact_job_id).filter((j): j is string => !!j))];
    if (jobIds.length) {
      // work_days (a job that runs several days) is newer than the rest: a
      // database without it is read again without it, and the job is one day
      const q = `pact_jobs?id=in.(${jobIds.join(",")})&select=id,items,start_date`;
      ((await read<DayJob>(`${q},work_days`)) ?? (await read<DayJob>(q)) ?? []).forEach((j) => jobOf.set(j.id, j));
    }
  }
  // Never a text about a work day that has gone by: the day the text names
  // (a PACT job's day, else the row's own; the job's last day when it runs
  // several) is checked against today in New York. Today itself still goes.
  // Each one held back is said, so the office sees why rather than nothing.
  const today = nyDay(new Date());
  const refused: CrewFail[] = [];
  messages = messages.filter((m) => {
    const r = m.id ? rowOf.get(m.id) : undefined;
    const last = r ? lastDayOf(r, r.pact_job_id ? jobOf.get(r.pact_job_id) : undefined) : "";
    if (!last || last >= today) return true;
    refused.push({ to: m.to, id: m.id, error: "that work day has passed" });
    return false;
  });
  if (messages.length === 0) return NextResponse.json({ configured: true, sent: 0, skipped: 0, failed: refused });

  // Retry safety, and one sender per row: each row is taken with one
  // conditional write (TEXTED where it wasn't) and only the rows that write
  // hands back are sent. A lost response (a dead spot mid-send) and a retry,
  // a second phone tapping at the same moment, and the sweep for texts set
  // up for later (app/api/text-due, which takes only rows not TEXTED) can't
  // all send the same row: whoever takes it first sends it. A row taken here
  // that Twilio doesn't take is let go again below, so it shows as not told.
  // Only with skipTexted: a Resend (the NYCHA Schedule's, to one already
  // TEXTED) goes out on purpose to a row that is already marked.
  let skipped = 0;
  let held: string[] = [];
  const release = async (rel: string[]) => {
    if (!rel.length) return;
    await fetch(`${supaUrl}/rest/v1/schedule_days?id=in.(${rel.join(",")})`, { method: "PATCH", headers: supaHeaders, body: JSON.stringify({ texted: false }) }).catch(() => {});
  };
  if (body.skipTexted) {
    const want = [...new Set(messages.map((m) => m.id).filter(Boolean))];
    if (want.length > 0) {
      const cRes = await fetch(`${supaUrl}/rest/v1/schedule_days?id=in.(${want.join(",")})&texted=is.false&select=id`, {
        method: "PATCH", headers: { ...supaHeaders, Prefer: "return=representation" }, body: JSON.stringify({ texted: true }), cache: "no-store",
      }).catch(() => null);
      // nothing is sent on a guess: without the database's answer a retry could text the crew twice
      if (!cRes || !cRes.ok) return NextResponse.json({ error: "Couldn't check who was already texted, so nothing went out. Check your signal and try again." }, { status: 503 });
      held = ((await cRes.json().catch(() => [])) as { id: string }[]).map((r) => r.id);
      skipped = messages.filter((m) => m.id && !held.includes(m.id)).length;
      messages = messages.filter((m) => !m.id || held.includes(m.id));
    }
    if (messages.length === 0) return NextResponse.json({ configured: true, sent: 0, skipped, failed: refused });
  }
  if (overLimit(user.id, messages.length)) {
    await release(held);
    return NextResponse.json({ error: "Texting limit reached for this hour, try again later" }, { status: 429 });
  }

  // from here on, every row taken above is either stamped by Twilio taking
  // its text or let go in the finally, whatever happens in between
  const took = new Set<string>();
  try {
    // once pictures texted back go on the job, the text asks for them — a PACT
    // job's text asks for the whole thread (before photos, then after photos);
    // a release's just for photos
    if (await photosBackOn()) {
      messages = messages.map((m) => {
        const r = m.id ? rowOf.get(m.id) : undefined;
        if (!r?.pact_job_id) return { ...m, body: withPhotoInvite(m.body) };
        // the job's own lines decide the ask; a job that couldn't be read gets the general one
        const j = jobOf.get(r.pact_job_id);
        return { ...m, body: withJobAsk(m.body, jobAsk(/^hola\b/i.test(m.body) ? "es" : "en", j ? Number(j.work_days) || 1 : true)) };
      });
    }
    // whatever was added, Twilio's 1,600 holds (the work line gives, never the ask)
    messages = messages.map((m) => ({ ...m, body: fitText(m.body, 1600) }));
    // the owner's copy says who the text went to, by name
    const names = copyTo() && serviceDb() ? (await serviceDb()!.get<{ name?: string; phone?: string }>("employees?select=name,phone&active=not.is.false")).rows : [];
    const nameOf = new Map<string, string>();
    for (const e of names) { const ph = cleanPhone(e.phone || ""), nm = (e.name || "").trim(); if (ph && nm && !nameOf.has(ph)) nameOf.set(ph, nm); }
    const outgoing: CrewOut[] = messages.map((m) => { const who = nameOf.get(m.to); return who ? { ...m, who } : m; });
    // the send itself, and the TEXTED mark the moment Twilio takes each one —
    // even if the phone never sees this response, a retry knows who was texted
    const { sent, failed, grouped, groupProblem: gp } = await sendCrew(serviceDb(), outgoing, async (m) => {
      if (!m.id) return;
      took.add(m.id);
      await fetch(`${supaUrl}/rest/v1/schedule_days?id=eq.${m.id}`, {
        method: "PATCH", headers: supaHeaders, body: JSON.stringify({ texted: true }),
      }).catch(() => {});
      // when it went (RUN_ME section 21) — its own write, so a database without the column still gets the TEXTED mark
      await fetch(`${supaUrl}/rest/v1/schedule_days?id=eq.${m.id}`, {
        method: "PATCH", headers: supaHeaders, body: JSON.stringify({ texted_at: new Date().toISOString() }),
      }).catch(() => {});
    }, publicOrigin(req));
    // one that may have reached the crew (a thread that didn't answer in
    // time) loses any time it was set up for, so it never goes out again on
    // its own; the office is told to look at the thread. Its own write: a
    // database before RUN_ME section 19 has no such column.
    const maybe = [...new Set(failed.filter((f) => f.maybe && f.id).map((f) => f.id as string))];
    if (maybe.length) await fetch(`${supaUrl}/rest/v1/schedule_days?id=in.(${maybe.join(",")})`, { method: "PATCH", headers: supaHeaders, body: JSON.stringify({ send_at: null }) }).catch(() => {});
    return NextResponse.json({ configured: true, sent, skipped, failed: [...refused, ...failed], grouped, ...(gp ? { groupProblem: gp } : {}) });
  } finally {
    // taken but not sent (Twilio said no, the thread may have it, or
    // something broke): not TEXTED, so the row shows who still needs telling
    await release(held.filter((id) => !took.has(id)));
  }
}

interface DayRow { id: string; day?: string | null; pact_job_id?: string | null; release_id?: string | null }
interface DayJob { id: string; items?: unknown; start_date?: string | null; work_days?: number | null }
// the last day of a job that runs `days` work days from `start`, Monday to
// Saturday (a Sunday is skipped, never counted). The same rule as
// the last day a crew text can still be about: a PACT job's day (its last
// work day when it runs several), else the row's own day. "" when unknown.
const lastDayOf = (r: DayRow, job?: DayJob): string => {
  const day = ((job?.start_date || r.day || "") as string).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  return job?.start_date && Number(job.work_days) > 1 ? lastWorkDay(day, Number(job.work_days)) || day : day;
};
