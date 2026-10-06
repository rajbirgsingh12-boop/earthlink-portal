// The company number's inbox. Twilio sends every text the number gets to this
// page. A worker who answers the crew text with pictures gets them put on the
// job they're on (or the PO they name in the text); pictures the portal can't
// place wait for the office on the Schedule tabs. The worker gets a short
// answer saying where the pictures went, in their own language. A worker who
// texts "no" (nobody home, the tenant can't do it today) gets their next job
// back, and the missed one is flagged for a new day (lib/nobodyFlow.ts).
//
// To switch it on:
//   • Vercel → Settings → Environment Variables: SUPABASE_SERVICE_ROLE_KEY
//     (Supabase → Settings → API → service_role) — nobody is signed in when
//     Twilio calls — next to the TWILIO keys that already send the texts.
//   • Twilio console → Phone Numbers → the company number → Messaging →
//     "A message comes in": Webhook, HTTP POST,
//     https://<the portal's address>/api/sms-in (no slash at the end). A
//     number inside a Messaging Service is governed by the service instead:
//     Messaging → Services → the service → Integration → "Send a webhook"
//     to the same address, or "Defer to sender's webhook".
//   • Text the number once from any phone. From then on the crew texts end
//     with "Reply to this text with photos of the work."
// Every request is checked against TWILIO_AUTH_TOKEN, so nobody but Twilio
// can put pictures on a job through here. If Twilio signs a different address
// than this page sees (a custom domain in front, say), set TWILIO_WEBHOOK_URL
// to exactly what is typed in the Twilio console.
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { waitUntil } from "@vercel/functions";
import { sendTexts, twilioConfigured } from "@/lib/twilio";
import {
  mediaIn, pickJob, pactKey, relKey, photoKind, photoName, phoneKey, refsIn, justANumber, replyText, twiml, validTwilio, dayMinus,
  type JobKey, type MineRow, type Params, type Reply,
} from "@/lib/smsIn";
import { fileBatch, folderOf, inboxOf, photosBackReady, serviceDb, type Batch, type Db, type Photo, type Target } from "@/lib/photoStore";
import { bareNo, nobodyHome } from "@/lib/noAccess";
import { nobodyFlow } from "@/lib/nobodyFlow";
import {
  applyMeasures, askMeasureText, askWhichJobText, backInProgressText, countKinds, doneNoteLine, gotAfterText, gotBeforeText, gotBothText, gotMeasureText, invoicedText, kindOfName, measureLines, measureNoteLine, notDone, nothingToUndoText, parseMeasures, photoKindFor, releaseMeasureText, stageOf, undoneNoteLine,
  type Change, type MeasureLine, type PhotoKind, type Stage,
} from "@/lib/jobFlow";
import { bookPrice } from "@/lib/priceServer";
import type { SfLine } from "@/lib/measure";

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

// a phone often splits one send into several texts: ten minutes together is one burst
const BURST_MS = 10 * 60_000;
// …and only the first piece is answered in full, so a worker who sent five
// pictures could read "Got 1 BEFORE photo". Every piece that lands on a job
// checks back once the send has settled (no newer piece for a while): the
// newest piece counts the whole send — this piece and the pieces before it,
// each within ten minutes of the next, back to a text of theirs — and when
// that count is not what its own answer said, texts it once: "5 BEFORE
// photos on PO 116843 in all." Vercel keeps the function alive for this
// after the answer has gone back to Twilio (waitUntil); on a plain machine
// the promise simply runs on. A second look after a grace catches a piece
// whose pictures were still downloading at the first.
const SETTLE_MS = Math.max(500, Number(env("BURST_SETTLE_MS")) || 20_000);
const GRACE_MS = Math.min(SETTLE_MS, 12_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanPhone = (s?: string | null): string => {
  const d = (s || "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d.length > 11 && d.length <= 15 && (s || "").trim().startsWith("+") ? `+${d}` : ""; // as lib/notify's
};
type SendRow = Batch & { msg_sid?: string | null };
async function settleBurst(db: Db, o: { emp: Emp; batchId: string; target: Target; kind: PhotoKind | null; said: number; lang?: string | null; from: string; now: Date }): Promise<void> {
  try {
    const to = cleanPhone(o.from);
    if (!to || !twilioConfigured()) return;
    const since = enc(new Date(o.now.getTime() - 2 * 86_400_000).toISOString());
    const load = async () => (await db.get<SendRow>(`texted_photos?employee_id=eq.${o.emp.id}&status=in.(held,filed,measure,note,nobody,reply,seen)&created_at=gte.${since}&order=created_at.desc&select=id,status,photos,pact_job_id,release_id,created_at,msg_sid&limit=200`)).rows;
    const isPiece = (b: SendRow) => b.status === "held" || b.status === "filed";
    await sleep(SETTLE_MS);
    let rows = await load();
    if (rows.find(isPiece)?.id !== o.batchId) return; // a newer piece: it speaks
    await sleep(GRACE_MS);
    rows = await load();
    if (rows.find(isPiece)?.id !== o.batchId) return;
    // the send, walked back from this piece
    const start = rows.findIndex((b) => b.id === o.batchId);
    if (start < 0) return;
    const send: SendRow[] = [];
    let at = Date.parse(rows[start].created_at || "") || o.now.getTime();
    for (const b of rows.slice(start)) {
      const t = Date.parse(b.created_at || "") || 0;
      if (at - t > BURST_MS) break;
      if (!isPiece(b)) { if (b.msg_sid) break; continue; } // a text of theirs ends the send; a row the portal wrote for itself doesn't
      send.push(b);
      at = t;
    }
    const same = send.filter((b) => b.status === "filed" && (b.photos || []).length
      && (o.target.kind === "pact" ? b.pact_job_id === o.target.id : b.release_id === o.target.id)
      && (!o.kind || kindOfName(b.photos![0].name) === o.kind));
    const total = same.reduce((n, b) => n + (b.photos || []).length, 0);
    if (same.length < 2 || total < 2 || total === o.said) return; // one text, or its own answer already said the count
    await sendTexts([{ to, body: replyText({ k: "inall", n: total, label: o.target.label, kind: o.kind }, o.lang) }]);
  } catch { /* a count that didn't go out loses nothing: the pictures are on the job */ }
}
// the job a batch is on, named the way the worker says it
async function targetOf(db: Db, b: Batch): Promise<Target | null> {
  if (b.pact_job_id) {
    const j = (await db.get<{ id: string; po_number?: string; job_number?: string }>(`pact_jobs?id=eq.${b.pact_job_id}&select=id,po_number,job_number`)).rows[0];
    return j ? pactKey(j) : null;
  }
  if (b.release_id) {
    const r = (await db.get<{ id: string; rel_number?: string }>(`releases?id=eq.${b.release_id}&select=id,rel_number`)).rows[0];
    return r ? relKey(r) : null;
  }
  return null;
}

// ---- a PACT job's thread (lib/jobFlow): where the job is, and a measurement texted in ----
interface ThreadJob { id: string; po_number?: string | null; job_number?: string | null; items?: SfLine[] | null; attachments?: { name: string; path: string }[] | null; notes?: string | null; tax_pct?: number | null; work_done?: boolean | null; canceled?: boolean | null; invoice_sent?: string | null; received?: boolean | null }
const threadJob = async (db: Db, id: string): Promise<ThreadJob | null> =>
  (await db.get<ThreadJob>(`pact_jobs?id=eq.${id}&select=id,po_number,job_number,items,attachments,notes,tax_pct,work_done,canceled,invoice_sent,received`)).rows[0] || null;
// a job the office has billed: a texted number never rewrites its lines
const billed = (j: ThreadJob) => !!j.invoice_sent || !!j.received;
const withNote = (notes: string | null | undefined, line: string) => `${(notes || "").trim()}${(notes || "").trim() ? "\n" : ""}${line}`;
// a row for the office's card: without the note column before section 21,
// and without the message id when another row of this same text already
// carries it (one row per Twilio message id) — the row still goes in
async function putRow(db: Db, row: Record<string, unknown>): Promise<boolean> {
  let st = await db.insertStatus("texted_photos", row);
  if (st === 400 && "note" in row) { const { note: _n, ...rest } = row; void _n; row = rest; st = await db.insertStatus("texted_photos", row); }
  if (st === 409 && row.msg_sid) st = await db.insertStatus("texted_photos", { ...row, msg_sid: null });
  return st >= 200 && st < 300;
}
// the after pictures are in: the job is work done (the section 15 trigger
// prices it and section 17 gives it its invoice number) and the office's
// card says it is ready to invoice. True when the mark was put on just now.
async function markDone(db: Db, job: ThreadJob, emp: Emp, from: string, now: Date, today: string): Promise<boolean> {
  if (job.work_done || job.canceled) return false;
  const who = (emp.name || "").trim().split(/\s+/)[0] || "";
  const line = doneNoteLine(who, nyWhen(now));
  const patch = { work_done: true, notes: withNote(job.notes, line) };
  // finish_date is upgrade_schedule's column — without it the mark still goes on
  if (!(await db.patch(`pact_jobs?id=eq.${job.id}`, { ...patch, finish_date: today })) && !(await db.patch(`pact_jobs?id=eq.${job.id}`, patch))) return false;
  await putRow(db, { employee_id: emp.id, from_phone: from, body: "", status: "done", how: "done", pact_job_id: job.id, photos: [], note: line });
  return true;
}
// "not done": the mark comes off again, and the office's card forgets it
async function unmarkDone(db: Db, o: { emp: Emp; body: string; now: Date; today: string }): Promise<string> {
  const lang = o.emp.lang;
  const { rows, mine } = await jobsOf(db, o.emp, o.today);
  const refs = jobRefsOnly(o.body);
  const pick = pickJob(refs, rows, mine, o.today, await anyPoOf(db, refs, mine));
  const job = pick.kind === "pact" ? await threadJob(db, pick.id) : null;
  if (!job || !job.work_done) return nothingToUndoText(lang);
  const who = (o.emp.name || "").trim().split(/\s+/)[0] || "";
  if (!(await db.patch(`pact_jobs?id=eq.${job.id}`, { work_done: false, notes: withNote(job.notes, undoneNoteLine(who, nyWhen(o.now))) }))) return nothingToUndoText(lang);
  await db.patch(`texted_photos?pact_job_id=eq.${job.id}&status=eq.done`, { status: "seen" });
  return backInProgressText(pick.kind === "pact" ? pick.label : "", lang);
}
const itemsOf = (j: ThreadJob): SfLine[] => (Array.isArray(j.items) ? j.items : []);
const namesOf = (j: ThreadJob) => (j.attachments || []).map((a) => a?.name || "");
const stageOfJob = (j: ThreadJob) => stageOf({ ...countKinds(namesOf(j)), needSf: measureLines(itemsOf(j)).some((l) => !l.has) });
// where the job is for this worker: a worker's own first pictures of a job
// are before pictures (two workers at one door each start with theirs), as
// long as nobody has sent its after pictures yet
async function stageFor(db: Db, j: ThreadJob, empId?: string | null): Promise<Stage> {
  const s = stageOfJob(j);
  if (s === "before" || !empId || countKinds(namesOf(j)).afterN > 0) return s;
  const mine = (await db.get<{ photos?: Photo[] | null }>(`texted_photos?employee_id=eq.${empId}&pact_job_id=eq.${j.id}&status=eq.filed&select=photos&limit=50`)).rows;
  return mine.some((r) => (r.photos || []).some((p) => kindOfName(p?.name || "") === "before")) ? s : "before";
}
// the job a measurement is for: the PO said in the text, else the one job
// today — the square feet themselves ("120", "10x12") must not read as a job number
const jobRefsOnly = (body: string): string => [
  ...(body || "").matchAll(/\b(?:p\.?\s*o\.?|release|rel\.?)\s*(?:number|no\.?|num|#)?\s*[#:\-]?\s*\d{1,12}\b/gi),
  ...(body || "").matchAll(/\b\d{5,12}\b/g),
].map((m) => m[0]).join(" ");
const nyWhen = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d).replace(/,/g, "");
// "plaster 120 sf": onto the job's lines, so the proposal and the invoice
// carry it; a note on the job and a line for the office. The reply, or
// nothing when the text wasn't a measurement.
async function measureIn(db: Db, o: { emp: Emp; body: string; from: string; sid: string; now: Date; today: string }): Promise<string | null> {
  const lang = o.emp.lang;
  const { rows, mine } = await jobsOf(db, o.emp, o.today);
  const refs = jobRefsOnly(o.body);
  const anyPo = await anyPoOf(db, refs, mine);
  const pick = pickJob(refs, rows, mine, o.today, anyPo);
  // this worker's job numbers are never read as square feet ("4521" after pictures)
  const ignore = [...mine, ...anyPo].flatMap((j) => j.keys);
  if (pick.kind === "rel") {
    // square feet on a release: the office prices releases — the words go to them
    if (parseMeasures(o.body, [], false, { ignore }).kind === "none") return null;
    await putRow(db, { employee_id: o.emp.id, from_phone: o.from, body: o.body, status: "reply", how: "measure", photos: [], release_id: pick.id, msg_sid: o.sid || null });
    return releaseMeasureText(pick.label, lang);
  }
  if (pick.kind !== "pact") {
    // a measurement ("50 sf", "plaster 50") with no one job to put it on: say which
    return parseMeasures(o.body, [], false, { ignore }).kind !== "none" ? askWhichJobText(lang) : null;
  }
  const job = await threadJob(db, pick.id);
  if (!job) return null;
  const lines = measureLines(itemsOf(job));
  const parsed = parseMeasures(o.body, lines, lines.some((l) => !l.has), { ignore });
  if (parsed.kind === "none") return null;
  if (billed(job)) return invoicedText(pick.label, lang);
  if (parsed.kind === "ask") return askMeasureText(parsed, pick.label, lines, lang);
  const done = await measureOnJob(db, job, parsed.hits, { ...o, sid: o.sid });
  if (!done) return lang && /^(es|spa|esp)/i.test(lang) ? "No se pudo guardar la medida. Por favor mándela otra vez." : "Couldn't save that measurement. Please text it again.";
  return gotMeasureText(done.changes, pick.label, done.stillBlank, lang);
}
// the numbers onto the job: its lines, its billed total (as the page keeps
// it: never wiped by lines at no price), a 📏 line on its notes, and a row
// for the office. `sid` is left off a text that already filed its pictures
// under that id — one row per Twilio message id. Null when the save failed.
async function measureOnJob(db: Db, job: ThreadJob, hits: Parameters<typeof applyMeasures>[1], o: { emp: Emp; body: string; from: string; sid: string; now: Date }): Promise<{ changes: Change[]; stillBlank: MeasureLine[] } | null> {
  // a Plaster line the job never had: at the price Settings saved, not the built-in list's
  const plasterPrice = hits.some((h) => h.index === -1) ? await bookPrice("plaster") : 0;
  const { items, changes } = applyMeasures(itemsOf(job), hits, plasterPrice);
  if (!changes.length) return null;
  const sub = items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);
  const tax = job.tax_pct === null || job.tax_pct === undefined ? 8.875 : Number(job.tax_pct);
  const who = (o.emp.name || "").trim().split(/\s+/)[0] || "";
  const line = measureNoteLine(changes, who, nyWhen(o.now));
  const notes = `${(job.notes || "").trim()}${(job.notes || "").trim() ? "\n" : ""}${line}`;
  const saved = await db.patch(`pact_jobs?id=eq.${job.id}`, { items, notes, ...(sub > 0 ? { amount: Math.round(sub * (1 + tax / 100) * 100) / 100 } : {}) });
  if (!saved) return null;
  await putRow(db, { employee_id: o.emp.id, from_phone: o.from, body: o.body, status: "measure", how: "measure", pact_job_id: job.id, photos: [], msg_sid: o.sid || null, note: line });
  return { changes, stillBlank: measureLines(items).filter((l) => !l.has) };
}

export async function GET() {
  // Settings reads this: can the portal take pictures in, has a text come in
  // yet — and when not, which piece is missing
  const db = serviceDb();
  const ready = photosBackReady();
  const first = db ? await db.get<{ id: string }>("texted_photos?select=id&limit=1") : null;
  const on = !!db && ready && !!first && first.rows.length > 0;
  const why = on ? "" : !db ? "SUPABASE_SERVICE_ROLE_KEY isn't in Vercel yet (then Redeploy)"
    : !env("TWILIO_AUTH_TOKEN") ? "TWILIO_AUTH_TOKEN isn't in Vercel yet (then Redeploy)"
    : first && !first.ok ? "the texted_photos table isn't there yet — paste RUN_ME.sql (section 20) in Supabase"
    : "no text has reached the portal yet — check the webhook in Twilio, then text the company number once";
  return NextResponse.json({ ready, on, why });
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

  // who sent it — by the whole phone number, country code and all
  let emps = await db.get<Emp>("employees?select=id,name,phone,lang,active");
  if (!emps.ok) emps = await db.get<Emp>("employees?select=id,name,phone,active"); // before the language column
  const key = phoneKey(from);
  const same = key ? emps.rows.filter((e) => phoneKey(e.phone) === key) : [];
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
    // "no" / "nobody home" / "nadie": the job is flagged for a new day and
    // they get their next one (lib/nobodyFlow.ts)
    if (nobodyHome(body)) {
      const flow = await nobodyFlow(db, { emp, emps: emps.rows, body, from, sid, now });
      if (flow.handled) return answer(flow.reply);
    }
    // the owner testing the number from a phone on the crew list still
    // switches it on — and hears back that it worked, that once
    const firstEver = !(await db.get<{ id: string }>("texted_photos?select=id&limit=1")).rows.length;
    if (firstEver) await db.insert("texted_photos", { employee_id: emp.id, from_phone: from, body, status: "note", msg_sid: sid || null });
    // "not done": the work-done mark the after pictures put on comes off
    if (notDone(body)) return answer(await unmarkDone(db, { emp, body, now, today }));
    // the square feet, texted: onto the job's lines (lib/jobFlow) — unless the
    // text is just a number and pictures of theirs are waiting for one: then
    // it is the job those pictures go on
    const heldWaiting = justANumber(body) && (await db.get<{ id: string }>(`texted_photos?employee_id=eq.${emp.id}&status=eq.held&created_at=gte.${since(2 * 86_400_000)}&select=id&limit=1`)).rows.length > 0;
    const measured = heldWaiting ? null : await measureIn(db, { emp, body, from, sid, now, today });
    if (measured) return answer(measured);
    // a job's number: the pictures they just sent go there — ones still
    // waiting (two days), or ones put on the wrong job (the last two hours;
    // only when the text is just the number). "Just sent" is the last batch
    // and any sent within ten minutes of it — a phone often splits five
    // pictures into five texts.
    if (!refsIn(body).length) return firstEver ? say({ k: "connected" }, lang) : answer(); // just talk ("ok", "on my way") — nothing to do
    const fixing = justANumber(body);
    const recent = (await db.get<Batch>(`texted_photos?employee_id=eq.${emp.id}&or=(and(status.eq.held,created_at.gte.${since(2 * 86_400_000)}),and(status.eq.filed,created_at.gte.${since(2 * 3_600_000)}))&order=created_at.desc&limit=20&select=*`)).rows
      .filter((b) => fixing || b.status === "held");
    if (!recent.length) return answer();
    const lastAt = Date.parse(recent[0].created_at || "") || now.getTime();
    const group = recent.filter((b) => (Date.parse(b.created_at || "") || 0) >= lastAt - BURST_MS);
    const { rows, mine } = await jobsOf(db, emp, today);
    const pick = pickJob(body, rows, mine, today, await anyPoOf(db, body, mine));
    if (pick.kind !== "ask" && pick.why === "number") {
      // pictures already on the job they name stay as they are (the PO said
      // twice is not a move); the rest go onto it — on a PACT job, onto the
      // pile the job's thread is at (its first pictures are before
      // pictures), and the answer is the thread's next step
      const onIt = (b: Batch) => b.status === "filed" && (pick.kind === "pact" ? b.pact_job_id === pick.id : b.release_id === pick.id);
      const already = group.filter(onIt).reduce((s, b) => s + (b.photos || []).length, 0);
      const toMove = group.filter((b) => !onIt(b));
      if (!toMove.length) return already ? say({ k: "moved", n: already, label: pick.label }, lang) : answer();
      const thread = pick.kind === "pact" ? await threadJob(db, pick.id) : null;
      const kind: PhotoKind | undefined = thread ? photoKindFor(toMove.map((b) => b.body || "").join(" "), await stageFor(db, thread, emp.id), null) : undefined;
      let n = 0;
      for (const b of [...toMove].reverse()) n += await fileBatch(db, b, pick, "number", kind);
      if (!n) return answer();
      if (!thread || !kind) return say({ k: "moved", n: n + already, label: pick.label }, lang);
      const lines = measureLines(itemsOf(thread));
      if (kind === "before") return answer(gotBeforeText(n + already, pick.label, lines, lang));
      return answer(gotAfterText(n + already, pick.label, lines.filter((l) => !l.has), lang, await markDone(db, thread, emp, from, now, today)));
    }
    if (pick.kind === "ask" && pick.why === "unknown" && group.some((b) => b.status === "held")) return say({ k: "unknown", number: pick.number || "" }, lang);
    return answer();
  }

  // fetch each picture from Twilio and store it in that folder — all at once,
  // so ten pictures take about as long as one (Twilio waits 15 seconds for the answer)
  const store = async (dir: string, kind: string): Promise<Photo[]> => (await Promise.all(photos.map(async (m, i): Promise<Photo | null> => {
    const got = await fetchMedia(m.url);
    if (!got) return null;
    const name = photoName(kind, now, (emp?.name || "").trim().split(/\s+/)[0] || "", sid, i, photos.length, m.ext);
    return (await db.upload(dir + name, got.bytes, got.type || m.type)) ? { name, path: dir + name } : null;
  }))).filter((p): p is Photo => !!p);

  // a picture of the door with "nobody home": it goes on that job, and they get their next one
  if (emp && nobodyHome(body) && !bareNo(body)) {
    const flow = await nobodyFlow(db, { emp, emps: emps.rows, body, from, sid, now, proof: (dir) => store(dir, "noaccess") });
    if (flow.handled) {
      if (!flow.missed) {
        // which job wasn't clear: the pictures wait for the office, quietly (the answer asks)
        const batchId = randomUUID();
        const put = await store(inboxOf(batchId), "noaccess");
        if (put.length && !(await db.insert("texted_photos", { id: batchId, employee_id: emp.id, from_phone: from, body, photos: put, status: "held" }))) await db.remove(put.map((p) => p.path));
      }
      return answer(flow.reply);
    }
  }

  // pictures from a phone nobody knows: kept for the office, a few batches a day at most
  if (!emp) {
    const lately = await db.get<{ id: string }>(`texted_photos?employee_id=is.null&status=eq.held&created_at=gte.${since(86_400_000)}&select=id&limit=6`);
    if (!lately.ok || lately.rows.length >= 5) return answer();
  }
  // what this phone sent in the last ten minutes: one phone often splits five
  // pictures into five texts, and only one of them carries the PO
  let burst = (await db.get<Batch>(`texted_photos?${emp ? `employee_id=eq.${emp.id}` : `from_phone=eq.${enc(from)}`}&status=in.(held,filed)&created_at=gte.${since(BURST_MS)}&order=created_at.asc&select=*`)).rows;
  // a text in between (the square feet, a "no") ends a send: pictures after
  // it are a new send, not the tail of the one before
  if (emp && burst.length) {
    // (a text of theirs — not a row the portal wrote for itself, which has no message id)
    const talk = (await db.get<{ created_at?: string | null }>(`texted_photos?employee_id=eq.${emp.id}&status=in.(measure,note,nobody,reply,seen)&msg_sid=not.is.null&created_at=gte.${since(BURST_MS)}&order=created_at.desc&select=created_at&limit=1`)).rows[0];
    if (talk?.created_at) burst = burst.filter((b) => (b.created_at || "") > talk.created_at!);
  }
  let pick: ReturnType<typeof pickJob> = { kind: "ask", why: "none" };
  let ignore: string[] = [];
  if (emp) {
    const { rows, mine } = await jobsOf(db, emp, today);
    const anyPo = await anyPoOf(db, body, mine);
    pick = pickJob(body, rows, mine, today, anyPo);
    ignore = [...mine, ...anyPo].flatMap((j) => j.keys);
  }
  // no number in this one, but the one before it named the job: same job
  // (a number that fits nothing is never guessed past — the office sorts it)
  let how = pick.kind === "ask" ? "" : pick.why === "number" ? "number" : "day";
  if (pick.kind === "ask" ? pick.why !== "unknown" : pick.why !== "number") {
    const named = [...burst].reverse().find((b) => b.status === "filed" && b.how === "number" && (b.pact_job_id || b.release_id));
    const t = named ? await targetOf(db, named) : null;
    if (t) { pick = { ...t, why: "number" }; how = "burst"; }
  }
  const target = pick.kind === "ask" ? null : pick;
  const batchId = randomUUID();
  const dir = target ? folderOf(target) : inboxOf(batchId);
  // which pile: on a PACT job, where the job is in its thread decides (the
  // first pictures are the before pictures; a split send stays together);
  // elsewhere the worker's own word, else after
  let kind: PhotoKind = photoKind(body);
  let thread: ThreadJob | null = null;
  if (target && target.kind === "pact") {
    thread = await threadJob(db, target.id);
    if (thread) {
      const last = [...burst].reverse().find((b) => b.status === "filed" && b.pact_job_id === target.id && (b.photos || []).length);
      kind = photoKindFor(body, await stageFor(db, thread, emp?.id), last ? kindOfName(last.photos![0].name) : null);
    }
  }
  const put = await store(dir, kind);
  // a picture that didn't come through is said, by count, with whatever did —
  // even in a quiet piece; a phone nobody knows reads it in both languages
  const lostLine = (n: number) => (emp ? replyText({ k: "lost", n }, lang) : `${replyText({ k: "lost", n }, "en")} / ${replyText({ k: "lost", n }, "es")}`);
  if (put.length === 0) return answer(lostLine(photos.length));
  const lost = photos.length - put.length;
  const lostNote = lost > 0 ? lostLine(lost) : "";
  const said = (msg: string) => answer(lostNote ? `${msg}\n${lostNote}` : msg);
  const hush = () => answer(lostNote || undefined);

  const row = { id: batchId, employee_id: emp?.id || null, from_phone: from, body, photos: put, msg_sid: sid || null };
  // one answer per burst: the first text gets it, the rest go quietly — unless
  // a later one carries a number, and then it says where they all went; or
  // changes pile ("before" after after pictures), and then it says so
  const lastKind = (() => { const last = [...burst].reverse().find((b) => b.status === "filed" && (b.photos || []).length); return last ? kindOfName(last.photos![0].name) : null; })();
  const quiet = burst.length > 0 && refsIn(body).length === 0 && (!thread || !lastKind || lastKind === kind);
  if (target) {
    if (!(await db.attach(target, put, []))) {
      // the job went away between the lookup and now — keep them for the office
      const inbox = inboxOf(batchId);
      const kept: Photo[] = [];
      for (const p of put) if (await db.move(p.path, inbox + p.name)) kept.push({ name: p.name, path: inbox + p.name });
      if (!(await db.insert("texted_photos", { ...row, photos: kept, status: "held" }))) await db.remove(kept.map((p) => p.path));
      return quiet ? hush() : said(replyText({ k: "held", n: put.length }, lang));
    }
    await db.insert("texted_photos", { ...row, status: "filed", how, pact_job_id: target.kind === "pact" ? target.id : null, release_id: target.kind === "rel" ? target.id : null });
    // this one named the job: the ones before it that were waiting go there too
    let moved = 0;
    if (how === "number") for (const b of burst) if (b.status === "held") moved += await fileBatch(db, b, target, "number", thread ? kind : undefined);
    // the pieces of this send already on this job and pile: an answered piece
    // speaks for them too ("Got 3 BEFORE photos" when the PO rode on the third)
    const prior = burst.filter((b) => b.status === "filed" && (b.photos || []).length
      && (target.kind === "pact" ? b.pact_job_id === target.id : b.release_id === target.id)
      && (!thread || kindOfName(b.photos![0].name) === kind)).reduce((s, b) => s + (b.photos || []).length, 0);
    const n = put.length + moved + prior;
    // and once the send has settled, the newest piece texts the whole count if its answer didn't
    const settle = (saidN: number) => { if (emp) waitUntil(settleBurst(db, { emp, batchId, target, kind: thread ? kind : null, said: saidN, lang, from, now })); };
    if (thread) {
      // the square feet, when they came with the pictures ("plaster 120 sf" +
      // a photo). A bare number with pictures is how many pictures, never square feet.
      const lines = measureLines(itemsOf(thread));
      const parsed = emp ? parseMeasures(body, lines, false, { ignore }) : { kind: "none" as const };
      const measured = parsed.kind === "ok" && !billed(thread) ? await measureOnJob(db, thread, parsed.hits, { emp: emp!, body, from, sid: "", now }) : null;
      const asked = parsed.kind === "ask" ? askMeasureText(parsed, target.label, lines, lang) : parsed.kind === "ok" && billed(thread) ? invoicedText(target.label, lang) : "";
      // after pictures: the job is work done, ready to invoice
      const marked = kind === "after" && emp ? await markDone(db, thread, emp, from, now, today) : false;
      if (quiet && !moved && !measured && !marked && !asked) { settle(0); return hush(); }
      settle(n);
      // the thread's next step: the square feet after the before pictures, the after pictures after that
      if (measured) return said(gotBothText(kind, n, target.label, measured.changes, measured.stillBlank, lang, marked, lost));
      const next = kind === "before" ? gotBeforeText(n, target.label, lines, lang) : gotAfterText(n, target.label, lines.filter((l) => !l.has), lang, marked, lost);
      return said(asked ? `${next}\n${asked}` : next);
    }
    if (quiet && !moved) { settle(0); return hush(); }
    settle(n);
    return said(replyText({ k: "filed", n, label: target.label }, lang));
  }
  // nowhere to put them yet: they wait for the office — unless there's no
  // place to keep them waiting (RUN_ME section 20 not run), and then the
  // worker is asked to send them again with the number
  if (!(await db.insert("texted_photos", { ...row, status: "held" }))) {
    await db.remove(put.map((p) => p.path));
    return say({ k: "resend" }, lang);
  }
  if (quiet) return hush();
  if (!emp) return said(replyText({ k: "stranger", n: put.length }));
  return said(replyText(pick.kind === "ask" && pick.why === "unknown" ? { k: "unknown", number: pick.number || "" } : { k: "held", n: put.length }, lang));
}
