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
import { NextResponse } from "next/server";
import { copyProblem, copyTo, sendTexts, twilioConfigured, twilioProblem } from "@/lib/twilio";
import { photosBackOn, serviceDb } from "@/lib/photoStore";
import { withJobAsk, withPhotoInvite } from "@/lib/crewText";
import { jobAsk, needSf } from "@/lib/jobFlow";

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
export async function GET() {
  return NextResponse.json({ configured: configured(), photosIn: configured() && (await photosBackOn()), problem: twilioProblem() || copyProblem(), copy: !!copyTo() });
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
    .map((m) => ({ to: String(m.to || "").trim(), body: String(m.body || "").trim().slice(0, 1000), id: String(m.id || "").trim() }))
    .filter((m) => /^\+\d{10,15}$/.test(m.to) && m.body);
  if (messages.length === 0 || messages.length > 100) {
    return NextResponse.json({ error: "Nothing to send (check the phone numbers)" }, { status: 400 });
  }
  // retry safety: rows already stamped TEXTED in the database are skipped, so a
  // lost response (dead spot mid-send) never leads to double-texting the crew
  const supaHeaders = { apikey: anon, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  let skipped = 0;
  if (body.skipTexted) {
    const ids = messages.map((m) => m.id).filter(Boolean);
    if (ids.length > 0) {
      const tRes = await fetch(`${supaUrl}/rest/v1/schedule_days?id=in.(${ids.join(",")})&select=id,texted`, { headers: supaHeaders, cache: "no-store" });
      if (tRes.ok) {
        const done = new Set(((await tRes.json()) as { id: string; texted?: boolean }[]).filter((r) => r.texted).map((r) => r.id));
        skipped = messages.filter((m) => m.id && done.has(m.id)).length;
        messages = messages.filter((m) => !m.id || !done.has(m.id));
      }
    }
    if (messages.length === 0) return NextResponse.json({ configured: true, sent: 0, skipped, failed: [] });
  }
  if (overLimit(user.id, messages.length)) {
    return NextResponse.json({ error: "Texting limit reached for this hour — try again later" }, { status: 429 });
  }

  // once pictures texted back go on the job, the text asks for them — a PACT
  // job's text asks for the whole thread (before photos, the square feet when
  // a line is waiting for them, after photos); a release's just for photos
  if (await photosBackOn()) {
    const ids = messages.map((m) => m.id).filter(Boolean);
    const jobOfRow = new Map<string, string>();
    const sfOfJob = new Map<string, boolean>();
    if (ids.length) {
      // read as the portal itself when it can (the caller is already a checked
      // admin/office sign-in; nothing read here goes back to them), else as them
      const svc = serviceDb();
      const read = async <T>(path: string): Promise<T[]> => {
        if (svc) return (await svc.get<T>(path)).rows;
        const r = await fetch(`${supaUrl}/rest/v1/${path}`, { headers: supaHeaders, cache: "no-store" }).catch(() => null);
        return r && r.ok ? ((await r.json().catch(() => [])) as T[]) : [];
      };
      const rows = await read<{ id: string; pact_job_id?: string | null }>(`schedule_days?id=in.(${ids.join(",")})&select=id,pact_job_id`);
      rows.forEach((r) => { if (r.pact_job_id) jobOfRow.set(r.id, r.pact_job_id); });
      const jobIds = [...new Set(jobOfRow.values())];
      if (jobIds.length) {
        const jobs = await read<{ id: string; items?: unknown }>(`pact_jobs?id=in.(${jobIds.join(",")})&select=id,items`);
        jobs.forEach((j) => sfOfJob.set(j.id, needSf(Array.isArray(j.items) ? j.items : [])));
      }
    }
    messages = messages.map((m) => {
      const job = m.id ? jobOfRow.get(m.id) : undefined;
      return { ...m, body: job ? withJobAsk(m.body, jobAsk(/^hola\b/i.test(m.body) ? "es" : "en", sfOfJob.get(job) ?? true)) : withPhotoInvite(m.body) };
    });
  }
  // the send itself, and the TEXTED mark the moment Twilio takes each one —
  // even if the phone never sees this response, a retry knows who was texted
  const { sent, failed } = await sendTexts(messages, async (m) => {
    if (!m.id) return;
    await fetch(`${supaUrl}/rest/v1/schedule_days?id=eq.${m.id}`, {
      method: "PATCH", headers: supaHeaders, body: JSON.stringify({ texted: true }),
    }).catch(() => {});
    // when it went (RUN_ME section 21) — its own write, so a database without the column still gets the TEXTED mark
    await fetch(`${supaUrl}/rest/v1/schedule_days?id=eq.${m.id}`, {
      method: "PATCH", headers: supaHeaders, body: JSON.stringify({ texted_at: new Date().toISOString() }),
    }).catch(() => {});
  });
  return NextResponse.json({ configured: true, sent, skipped, failed });
}
