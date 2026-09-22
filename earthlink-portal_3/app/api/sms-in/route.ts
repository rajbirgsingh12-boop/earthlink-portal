// The company number's inbox. Twilio sends every text the number gets to this
// page. A worker who answers the crew text with pictures gets them put on the
// job they're on (or the PO they name in the text); pictures the portal can't
// place wait for the office on the Schedule tabs. The worker gets a short
// answer saying where the pictures went, in their own language.
//
// To switch it on:
//   • Vercel → Settings → Environment Variables: SUPABASE_SERVICE_ROLE_KEY
//     (Supabase → Settings → API → service_role) — nobody is signed in when
//     Twilio calls — next to the TWILIO keys that already send the texts.
//   • Twilio console → Phone Numbers → the company number → Messaging →
//     "A message comes in": Webhook, HTTP POST,
//     https://<the portal's address>/api/sms-in
//   • Text the number once from any phone. From then on the crew texts end
//     with "Reply to this text with photos of the work."
// Every request is checked against TWILIO_AUTH_TOKEN, so nobody but Twilio
// can put pictures on a job through here. If Twilio signs a different address
// than this page sees (a custom domain in front, say), set TWILIO_WEBHOOK_URL
// to exactly what is typed in the Twilio console.
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import {
  mediaIn, pickJob, pactKey, relKey, photoKind, photoName, phoneKey, refsIn, replyText, twiml, validTwilio, dayMinus,
  type JobKey, type MineRow, type Params, type Reply,
} from "@/lib/smsIn";
import { fileBatch, folderOf, inboxOf, photosBackReady, serviceDb, type Batch, type Db, type Photo } from "@/lib/photoStore";

export const runtime = "nodejs";
export const maxDuration = 60;
const env = (k: string) => process.env[k] || "";
const answer = (msg?: string) => new NextResponse(twiml(msg), { status: 200, headers: { "Content-Type": "text/xml; charset=utf-8" } });
const say = (r: Reply, lang?: string | null) => answer(replyText(r, lang));
const nyDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const enc = encodeURIComponent;
interface Emp { id: string; name?: string | null; phone?: string | null; lang?: string | null; active?: boolean | null }

// every address Twilio may have signed for this request
function addressesOf(req: Request): string[] {
  const u = new URL(req.url);
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || u.host).split(",")[0].trim();
  const proto = (req.headers.get("x-forwarded-proto") || u.protocol.replace(":", "")).split(",")[0].trim();
  const path = u.pathname + u.search;
  const bare = host.replace(/:(443|80)$/, "");
  return [...new Set([env("TWILIO_WEBHOOK_URL"), `${proto}://${host}${path}`, `${proto}://${bare}${path}`, `${proto}://${bare}:${proto === "https" ? 443 : 80}${path}`, req.url].filter(Boolean))];
}

// A picture from Twilio. Only Twilio's own addresses are fetched, with the
// account's key; the picture itself sits on Twilio's storage, which gets no key.
async function fetchMedia(url: string): Promise<{ bytes: ArrayBuffer; type: string } | null> {
  const base = (env("TWILIO_API_BASE") || "https://api.twilio.com").replace(/\/+$/, "");
  if (!url.startsWith(`${base}/`)) return null;
  const auth = `Basic ${Buffer.from(`${env("TWILIO_ACCOUNT_SID")}:${env("TWILIO_AUTH_TOKEN")}`).toString("base64")}`;
  const signal = AbortSignal.timeout(11_000);
  try {
    let at = url;
    let r = await fetch(at, { headers: { Authorization: auth }, redirect: "manual", signal, cache: "no-store" });
    for (let hop = 0; hop < 4 && r.status >= 300 && r.status < 400; hop++) {
      const loc = r.headers.get("location");
      if (!loc) return null;
      const next = new URL(loc, at);
      if (next.protocol !== "https:" && !base.startsWith("http://")) return null;
      at = next.toString();
      r = await fetch(at, { headers: next.origin === new URL(base).origin ? { Authorization: auth } : {}, redirect: "manual", signal, cache: "no-store" });
    }
    if (!r.ok) return null;
    const bytes = await r.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > 25 * 1024 * 1024) return null;
    return { bytes, type: (r.headers.get("content-type") || "").split(";")[0].trim() };
  } catch { return null; }
}

// the jobs this worker is on, two weeks either side of today
async function jobsOf(db: Db, emp: Emp, today: string): Promise<{ rows: MineRow[]; mine: JobKey[] }> {
  const win = `employee_id=eq.${emp.id}&day=gte.${dayMinus(today, 14)}&day=lte.${dayMinus(today, -14)}`;
  let got = await db.get<MineRow>(`schedule_days?${win}&select=day,pact_job_id,release_id&limit=500`);
  if (!got.ok) got = await db.get<MineRow>(`schedule_days?${win}&select=day,release_id&limit=500`); // before PACT crews were on the schedule
  const rows = got.rows;
  const ids = (xs: (string | null | undefined)[]) => [...new Set(xs.filter(Boolean) as string[])];
  const pIds = ids(rows.map((r) => r.pact_job_id)), rIds = ids(rows.map((r) => r.release_id));
  const [p, r] = await Promise.all([
    pIds.length ? db.get<{ id: string; po_number?: string; job_number?: string }>(`pact_jobs?id=in.(${pIds.join(",")})&select=id,po_number,job_number`) : Promise.resolve({ ok: true, rows: [] }),
    rIds.length ? db.get<{ id: string; rel_number?: string }>(`releases?id=in.(${rIds.join(",")})&select=id,rel_number`) : Promise.resolve({ ok: true, rows: [] }),
  ]);
  return { rows, mine: [...p.rows.map(pactKey), ...r.rows.map(relKey)] };
}

// a PO named in the text that isn't one of this worker's jobs: any job in the portal with that PO
async function anyPoOf(db: Db, body: string, mine: JobKey[]): Promise<JobKey[]> {
  const want = refsIn(body).filter((r) => (r.said ? r.n.length >= 3 : r.n.length >= 5) && /^\d+$/.test(r.n) && !mine.some((j) => j.keys.includes(r.n)));
  if (!want.length) return [];
  const found = await Promise.all(want.slice(0, 3).map((r) =>
    db.get<{ id: string; po_number?: string; job_number?: string }>(`pact_jobs?or=(po_number.ilike.*${r.n}*,job_number.ilike.*${r.n}*)&canceled=not.is.true&select=id,po_number,job_number&limit=20`)));
  return found.flatMap((f) => f.rows.map(pactKey));
}

export async function GET() {
  // Settings reads this: can the portal take pictures in, and has a text come in yet
  const db = serviceDb();
  const ready = photosBackReady();
  const on = !!db && ready && (await db.get<{ id: string }>("texted_photos?select=id&limit=1")).rows.length > 0;
  return NextResponse.json({ ready, on });
}

export async function POST(req: Request) {
  const raw = await req.text().catch(() => "");
  const form = new URLSearchParams(raw);
  const params: Params = [...form.entries()];
  if (!validTwilio(env("TWILIO_AUTH_TOKEN"), addressesOf(req), params, req.headers.get("x-twilio-signature") || "")) {
    return new NextResponse("Not from Twilio", { status: 403 });
  }
  const db = serviceDb();
  if (!db) return answer(); // nowhere to put anything yet — say nothing

  const from = (form.get("From") || "").trim();
  const body = (form.get("Body") || "").slice(0, 1000);
  const sid = (form.get("MessageSid") || form.get("SmsMessageSid") || "").trim();
  const { photos, other } = mediaIn((k) => form.get(k));
  const now = new Date();
  const today = nyDay(now);
  const since = (ms: number) => enc(new Date(now.getTime() - ms).toISOString());

  // the same text twice (Twilio trying again) is not filed twice
  if (sid && (await db.get<{ id: string }>(`texted_photos?msg_sid=eq.${enc(sid)}&select=id&limit=1`)).rows.length) return answer();

  // who sent it — by the last ten digits of the phone
  let emps = await db.get<Emp>("employees?select=id,name,phone,lang,active");
  if (!emps.ok) emps = await db.get<Emp>("employees?select=id,name,phone,active"); // before the language column
  const key = phoneKey(from);
  const same = key.length === 10 ? emps.rows.filter((e) => phoneKey(e.phone) === key) : [];
  const emp = same.find((e) => e.active !== false) || same[0] || null;
  const lang = emp?.lang;

  // a text with no pictures
  if (photos.length === 0) {
    if (!emp) {
      // a phone nobody knows: one hello a day, which also tells Settings the number is pointed here
      if ((await db.get<{ id: string }>(`texted_photos?from_phone=eq.${enc(from)}&created_at=gte.${since(86_400_000)}&select=id&limit=1`)).rows.length) return answer();
      await db.insert("texted_photos", { from_phone: from, body, status: "note", msg_sid: sid || null });
      return say({ k: "stranger", n: 0 });
    }
    if (other > 0) return say({ k: "notphoto" }, lang);
    // a job's number: the pictures they just sent go there — ones still
    // waiting (two days), or ones put on the wrong job (the last two hours)
    const last = (await db.get<Batch>(`texted_photos?employee_id=eq.${emp.id}&or=(and(status.eq.held,created_at.gte.${since(2 * 86_400_000)}),and(status.eq.filed,created_at.gte.${since(2 * 3_600_000)}))&order=created_at.desc&limit=1&select=*`)).rows[0];
    if (!last || !refsIn(body).length) return answer(); // just talk ("ok", "on my way") — nothing to do
    const { rows, mine } = await jobsOf(db, emp, today);
    const pick = pickJob(body, rows, mine, today, await anyPoOf(db, body, mine));
    if (pick.kind !== "ask" && pick.why === "number") {
      const n = await fileBatch(db, last, pick);
      return n ? say({ k: "moved", n, label: pick.label }, lang) : answer();
    }
    if (pick.kind === "ask" && pick.why === "unknown" && last.status === "held") return say({ k: "unknown", number: pick.number || "" }, lang);
    return answer();
  }

  // pictures from a phone nobody knows: kept for the office, a few batches a day at most
  if (!emp) {
    const lately = await db.get<{ id: string }>(`texted_photos?employee_id=is.null&status=eq.held&created_at=gte.${since(86_400_000)}&select=id&limit=6`);
    if (!lately.ok || lately.rows.length >= 5) return answer();
  }
  let pick: ReturnType<typeof pickJob> = { kind: "ask", why: "none" };
  if (emp) {
    const { rows, mine } = await jobsOf(db, emp, today);
    pick = pickJob(body, rows, mine, today, await anyPoOf(db, body, mine));
  }
  const target = pick.kind === "ask" ? null : pick;
  const batchId = randomUUID();
  const dir = target ? folderOf(target) : inboxOf(batchId);
  const kind = photoKind(body);
  const first = (emp?.name || "").trim().split(/\s+/)[0] || "";

  // fetch each picture from Twilio and store it — all at once, so ten pictures
  // take about as long as one (Twilio waits 15 seconds for the answer)
  const stored = await Promise.all(photos.map(async (m, i): Promise<Photo | null> => {
    const got = await fetchMedia(m.url);
    if (!got) return null;
    const name = photoName(kind, now, first, sid, i, photos.length, m.ext);
    return (await db.upload(dir + name, got.bytes, got.type || m.type)) ? { name, path: dir + name } : null;
  }));
  const put = stored.filter((p): p is Photo => !!p);
  if (put.length === 0) return say({ k: "failed" }, lang);

  const row = { id: batchId, employee_id: emp?.id || null, from_phone: from, body, photos: put, msg_sid: sid || null };
  if (target) {
    if (!(await db.attach(target, put, []))) {
      // the job went away between the lookup and now — keep them for the office
      const inbox = inboxOf(batchId);
      const kept: Photo[] = [];
      for (const p of put) if (await db.move(p.path, inbox + p.name)) kept.push({ name: p.name, path: inbox + p.name });
      if (!(await db.insert("texted_photos", { ...row, photos: kept, status: "held" }))) await db.remove(kept.map((p) => p.path));
      return say({ k: "held", n: put.length }, lang);
    }
    await db.insert("texted_photos", { ...row, status: "filed", pact_job_id: target.kind === "pact" ? target.id : null, release_id: target.kind === "rel" ? target.id : null });
    return say({ k: "filed", n: put.length, label: target.label }, lang);
  }
  // nowhere to put them yet: they wait for the office — unless there's no
  // place to keep them waiting (RUN_ME section 20 not run), and then the
  // worker is asked to send them again with the number
  if (!(await db.insert("texted_photos", { ...row, status: "held" }))) {
    await db.remove(put.map((p) => p.path));
    return say({ k: "resend" }, lang);
  }
  if (!emp) return say({ k: "stranger", n: put.length });
  return pick.kind === "ask" && pick.why === "unknown" ? say({ k: "unknown", number: pick.number || "" }, lang) : say({ k: "held", n: put.length }, lang);
}
