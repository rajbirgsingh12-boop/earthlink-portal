// The company number's inbox, whichever way a text reaches it: a text to the
// number itself (app/api/sms-in, answered in TwiML) or a message in a crew's
// group thread (app/api/chat-in, answered into the thread). A worker who
// answers the crew text with pictures gets them put on the job they're on
// (or the PO they name in the text); pictures the portal can't place wait
// for the office on the Schedule tabs. The worker gets a short answer saying
// where the pictures went, in their own language. A worker who texts "no"
// (nobody home, the tenant can't do it today) gets their next job back, and
// the missed one is flagged for a new day (lib/nobodyFlow.ts). DONE and NOT
// DONE work on the job they mean: NOT DONE runs it one more work day with
// the same crew (lib/jobThread.ts). Where the pictures come from and how a
// later text goes back are the channel's (`fetchMedia`, `deliver`);
// everything else is the same for both.
import { randomUUID } from "crypto";
import { waitUntil } from "@vercel/functions";
import { twilioConfigured } from "@/lib/twilio";
import {
  pickJob, pactKey, relKey, photoName, phoneKey, refsIn, justANumber, replyText, dayMinus,
  type JobKey, type MediaIn, type MineRow, type Reply,
} from "@/lib/smsIn";
import { fileBatch, inboxOf, pileDir, type Batch, type Db, type Photo, type Target } from "@/lib/photoStore";
import { countOf, isMediaName, mediaWords, type MediaCount } from "@/lib/media";
import { bareNo, noAt, nobodyHome, toldOfficeText } from "@/lib/noAccess";
import { nobodyFlow } from "@/lib/nobodyFlow";
import {
  afterNextText, afterSaid, allDoneSaid, alreadyAfterText, alreadyDoneText, applyMeasures, askWhichJobText, captionKind, continuesText, crewContinuesText, crewEndedText, dayDoneText, doneMarkedText, doneSaid, doorGotText, endedEarlyText,
  finishedAskText, flippedText, gotAfterDayText, gotAfterText, gotBeforeAskText, gotBeforeText, gotBothText, gotMeasureText, gotPhotosText, heldAfterText, mixedCaption, invoicedNotDoneText, invoicedText, kindOfName, measureLines,
  measureNoteLine, namesFrom, noAfterDoneText, notDone, notDoneStrong, noWord, parseMeasures, photoAt, photoKindFor, releaseMeasureText, sendAfterText, staysOpenText, stillOnText,
  whichJobText, WRONG_JOB, yesWord,
  type Change, type DoneSaid, type MeasureLine, type PhotoKind,
} from "@/lib/jobFlow";
import {
  billed, cleanPhone, clearDoneIfNoAfter, closeQuestion, continueJob, dayPile, endEarly, firstName, keyOf, markDone, namesOf, nyDay, nyHour, nyWhen, onLastDay,
  openQuestion, putRow, shortDay, threadJob, type Emp, type ThreadJob,
} from "@/lib/jobThread";
import { atJob, jobName, langOf } from "@/lib/crewText";
import { workDaysOf } from "@/lib/workDays";
import { bookPrice } from "@/lib/priceServer";
import { roomsIn } from "@/lib/priceBook";
import { workLines, paperworkRepair } from "@/lib/paperwork";
import type { SfLine } from "@/lib/measure";

const env = (k: string) => process.env[k] || "";
// the answer to the worker: a string, or nothing (the channel sends it)
const answer = (msg?: string): string | undefined => msg || undefined;
const say = (r: Reply, lang?: string | null) => answer(replyText(r, lang));
// how a text goes back to the worker later (the settled count, the nobody-home answer): one-to-one, or into the thread it came from
export type Deliver = (to: string, body: string, who?: string) => Promise<boolean>;
export interface Inbound {
  from: string; body: string; sid: string; photos: MediaIn[]; other: number;
  fetchMedia: (url: string) => Promise<{ bytes: ArrayBuffer; type: string } | null>;
  deliver: Deliver;
  // the job the thread this came in on was last about: with two jobs that
  // day and no PO in the text, that is the one (a text to the number has none)
  jobHint?: { kind: "pact" | "rel"; id: string };
}
type Hint = Inbound["jobHint"];
// two jobs that day and nothing said: the thread's own job, when it is one of
// theirs today (a crew's thread runs on to its next job: tomorrow's is not
// today's). A guess, like the job texted last ("told"): before pictures may
// ride on it, finished work never marks a job done by it
const withHint = (p: ReturnType<typeof pickJob>, mine: JobKey[], hint: Hint | undefined, rows: MineRow[], today: string): ReturnType<typeof pickJob> => {
  if (p.kind !== "ask" || p.why !== "many" || !hint) return p;
  if (!rows.some((r) => r.day === today && (r.pact_job_id || r.release_id) === hint.id)) return p;
  const j = mine.find((x) => x.kind === hint.kind && x.id === hint.id);
  return j ? { kind: j.kind, id: j.id, label: j.label, street: j.street, apt: j.apt, why: "told" } : p;
};
// what came in and who from, for the owner's copy (app/api/sms-in)
export interface Seen { from: string; who: string; body: string; photos: number; other: number; videos?: number }
const enc = encodeURIComponent;

// what names a job in a reply: its number, and where it is
const PACT_KEY_COLS = "id,po_number,job_number,address,development,property_unit";
const REL_KEY_COLS = "id,rel_number,address,location";
interface PactRow { id: string; po_number?: string; job_number?: string; address?: string; development?: string; property_unit?: string; start_date?: string | null; work_days?: number | null }
interface RelRow { id: string; rel_number?: string; address?: string; location?: string }
// the jobs this worker is on, two weeks either side of today. A PACT job of
// more than one day is on each of its work days (lib/workDays): its crew row
// sits on its first day, so the rows are read from further back
async function jobsOf(db: Db, emp: Emp, today: string): Promise<{ rows: MineRow[]; mine: JobKey[] }> {
  const win = `employee_id=eq.${emp.id}&day=gte.${dayMinus(today, 45)}&day=lte.${dayMinus(today, -14)}`;
  let got = await db.get<MineRow>(`schedule_days?${win}&select=day,pact_job_id,release_id,texted_at,address&limit=500`);
  if (!got.ok) got = await db.get<MineRow>(`schedule_days?${win}&select=day,pact_job_id,release_id,texted_at&limit=500`); // no address on the crew rows
  if (!got.ok) got = await db.get<MineRow>(`schedule_days?${win}&select=day,pact_job_id,release_id&limit=500`); // before section 21: no texted_at
  if (!got.ok) got = await db.get<MineRow>(`schedule_days?${win}&select=day,release_id&limit=500`); // before PACT crews were on the schedule
  const ids = (xs: (string | null | undefined)[]) => [...new Set(xs.filter(Boolean) as string[])];
  const pIds = ids(got.rows.map((r) => r.pact_job_id)), rIds = ids(got.rows.map((r) => r.release_id));
  const pq = (cols: string) => db.get<PactRow>(`pact_jobs?id=in.(${pIds.join(",")})&select=${cols}`);
  const [p, r] = await Promise.all([
    pIds.length ? pq(`${PACT_KEY_COLS},start_date,work_days`).then((x) => (x.ok ? x : pq(`${PACT_KEY_COLS},start_date`))).then((x) => (x.ok ? x : pq(PACT_KEY_COLS))) : Promise.resolve({ ok: true, rows: [] as PactRow[] }),
    rIds.length ? db.get<RelRow>(`releases?id=in.(${rIds.join(",")})&select=${REL_KEY_COLS}`) : Promise.resolve({ ok: true, rows: [] as RelRow[] }),
  ]);
  const jobOf = new Map(p.rows.map((j) => [j.id, j]));
  const lo = dayMinus(today, 14), hi = dayMinus(today, -14);
  const rows: MineRow[] = [];
  for (const row of got.rows) {
    const j = row.pact_job_id ? jobOf.get(row.pact_job_id) : undefined;
    const days = j && (j.start_date || "") === row.day ? workDaysOf(j.start_date, j.work_days) : [row.day];
    // (a later day of the job keeps the text time only when it was sent that
    // day: the morning's day-1 text says nothing about day 2)
    for (const d of days) if (d >= lo && d <= hi) rows.push(d === row.day ? row : { ...row, day: d, texted_at: row.texted_at && nyDay(new Date(row.texted_at)) === d ? row.texted_at : null });
  }
  // a release is named by the street its crew text sent: the one typed on the
  // crew rows (this worker's, the day nearest today first), else the release's own
  const near = [...got.rows].sort((a, b) => Math.abs(Date.parse(a.day) - Date.parse(today)) - Math.abs(Date.parse(b.day) - Date.parse(today)));
  const rowAddr = (relId: string) => (near.find((x) => x.release_id === relId && (x.address || "").trim())?.address || "").trim();
  return { rows, mine: [...p.rows.map(pactKey), ...r.rows.map((x) => relKey({ ...x, address: rowAddr(x.id) || x.address }))] };
}

// a PO named in the text that isn't one of this worker's jobs: any job in the portal with that PO
async function anyPoOf(db: Db, body: string, mine: JobKey[]): Promise<JobKey[]> {
  const want = refsIn(body).filter((r) => (r.said ? r.n.length >= 3 : r.n.length >= 5) && /^\d+$/.test(r.n) && !mine.some((j) => j.keys.includes(r.n)));
  if (!want.length) return [];
  const found = await Promise.all(want.slice(0, 3).map((r) =>
    db.get<PactRow>(`pact_jobs?or=(po_number.ilike.*${r.n}*,job_number.ilike.*${r.n}*)&canceled=not.is.true&select=${PACT_KEY_COLS}&limit=20`)));
  return found.flatMap((f) => f.rows.map(pactKey));
}

// a phone often splits one send into several texts: ten minutes together is one burst
const BURST_MS = 10 * 60_000;
// pieces placed by the day's guess a moment before a piece that names the job are the same send
const SPLIT_MS = 90_000;
// …and only the first piece is answered in full, so a worker who sent five
// pictures could read "Got 1 BEFORE photo". Every piece that lands on a job
// checks back once the send has settled (no newer piece for a while): the
// newest piece counts the whole send (this piece and the pieces before it,
// each within ten minutes of the next, back to a text of theirs) and when
// that count is not what its own answer said, texts it once: "5 BEFORE
// photos on PO 116843 in all." Vercel keeps the function alive for this
// after the answer has gone back to Twilio (waitUntil); on a plain machine
// the promise simply runs on. A second look after a grace catches a piece
// whose pictures were still downloading at the first.
const SETTLE_MS = Math.max(500, Number(env("BURST_SETTLE_MS")) || 20_000);
const GRACE_MS = Math.min(SETTLE_MS, 12_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type SendRow = Batch & { msg_sid?: string | null };
async function settleBurst(db: Db, o: { emp: Emp; batchId: string; target: Target; kind: PhotoKind | null; said: MediaCount; lang?: string | null; from: string; now: Date; deliver: Deliver }): Promise<void> {
  try {
    const to = cleanPhone(o.from);
    if (!to || !twilioConfigured()) return;
    const since = enc(new Date(o.now.getTime() - 2 * 86_400_000).toISOString());
    const load = async () => (await db.get<SendRow>(`texted_photos?employee_id=eq.${o.emp.id}&status=in.(held,filed,measure,note,nobody,reply,seen,opened,moved,done)&created_at=gte.${since}&order=created_at.desc&select=id,status,how,photos,pact_job_id,release_id,created_at,msg_sid&limit=200`)).rows;
    const isPiece = (b: SendRow) => (b.status === "held" || b.status === "filed") && b.how !== "noaccess";
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
      // a text of theirs ends the send (a door's picture too); a row the portal
      // wrote for itself doesn't, and neither does an AFTER said about this send
      if (!isPiece(b)) { if (b.msg_sid && b.how !== "afterflip") break; continue; }
      send.push(b);
      at = t;
    }
    const same = send.filter((b) => b.status === "filed" && (b.photos || []).length
      && (o.target.kind === "pact" ? b.pact_job_id === o.target.id : b.release_id === o.target.id)
      && (!o.kind || kindOfName(b.photos![0].name) === o.kind));
    const all = countOf(same.flatMap((b) => (b.photos || []).map((p) => p?.name || "")));
    if (same.length < 2 || all.n < 2 || (all.n === o.said.n && all.v === o.said.v)) return; // one text, or its own answer already said the count
    await o.deliver(to, replyText({ k: "inall", n: all.n, v: all.v, label: jobName(o.target, o.lang), kind: o.kind }, o.lang), (o.emp.name || "").trim() || undefined);
  } catch { /* a count that didn't go out loses nothing: the pictures are on the job */ }
}
// the job a batch is on, named the way the worker says it
async function targetOf(db: Db, b: Batch): Promise<Target | null> {
  if (b.pact_job_id) {
    const j = (await db.get<PactRow>(`pact_jobs?id=eq.${b.pact_job_id}&select=${PACT_KEY_COLS}`)).rows[0];
    return j ? pactKey(j) : null;
  }
  if (b.release_id) {
    const r = (await db.get<RelRow>(`releases?id=eq.${b.release_id}&select=${REL_KEY_COLS}`)).rows[0];
    if (!r) return null;
    // the street its crew text sent, typed on a crew row (theirs first), else the release's own
    const who = b.employee_id ? `&employee_id=eq.${b.employee_id}` : "";
    const typed = (await db.get<{ address?: string }>(`schedule_days?release_id=eq.${b.release_id}${who}&address=neq.&select=address&order=day.desc&limit=1`)).rows[0]?.address;
    return relKey({ ...r, address: (typed || "").trim() || r.address });
  }
  return null;
}

// ---- AFTER: the worker says the photos are the finished work ----
// AFTER texted with no photos opens a window: the next send (the next photos,
// within half an hour) goes in AFTER, on the job the answer named. Rows of
// theirs mark it: how 'aftersay' (they texted AFTER) or 'afterwait' (the
// portal asked for the after photos); a window whose send came in is 'seen'.
const AFTER_WINDOW_MS = 30 * 60_000;
// a window for a job that isn't one of today's (the morning asked about
// yesterday's), while they have a job today: only the photos sent right away
const ELSEWHERE_WINDOW_MS = 10 * 60_000;
// AFTER (or DONE) texted after photos with no word: the send they just made
// (its newest piece in the last quarter hour) moves to AFTER
const FLIP_MS = 15 * 60_000;
// …a send from the last minute and a half is the one the word came with; with
// none, the word waits a moment for pictures still on their way (the phone
// sent the word and the pictures together, and the word got here first)
const FRESH_MS = 90_000;
const afterWaitMs = () => { const v = env("AFTER_WAIT_MS"); return v === "" ? 4_000 : Math.max(0, Number(v) || 0); };
// the arrival: nothing on the job's BEFORE pile that day from an hour or more before
const ARRIVAL_GAP_MS = 60 * 60_000;
// pictures within two minutes of a DONE the portal answered by asking for the
// after photos: the phone sent them with the DONE ("done sending", maybe)
const DONE_SENT_MS = 2 * 60_000;
const msOf = (r: { created_at?: string | null }) => Date.parse(r.created_at || "") || 0;
const isEs = (l?: string | null) => !!l && /^(es|spa|esp)/i.test(l);
const namesIn = (bs: { photos?: Photo[] | null }[]): string[] => bs.flatMap((b) => (b.photos || []).map((p) => p?.name || "")).filter(Boolean);
// a row's job columns: a PACT job's id, or a job of either kind
const jobCols = (job?: string | { kind: "pact" | "rel"; id: string } | null): Record<string, string> => (!job ? {} : typeof job === "string" ? { pact_job_id: job } : job.kind === "pact" ? { pact_job_id: job.id } : { release_id: job.id });

interface Win { jobId: string; kind: "pact" | "rel" | ""; how: string; at: number }
// the open window, if any: the job it's for (none: whichever job the photos land on)
async function afterWindow(db: Db, empId: string, now: Date): Promise<Win | null> {
  const w = (await db.get<{ pact_job_id?: string | null; release_id?: string | null; created_at?: string | null; how?: string | null }>(`texted_photos?employee_id=eq.${empId}&how=in.(aftersay,afterwait)&status=eq.note&created_at=gte.${enc(new Date(now.getTime() - AFTER_WINDOW_MS).toISOString())}&select=pact_job_id,release_id,created_at,how&order=created_at.desc&limit=1`)).rows[0];
  if (!w?.created_at) return null;
  // the send it was for came in already: a later send is BEFORE again (its own pieces stay with it as one send)
  const since = (await db.get<{ id: string; how?: string | null }>(`texted_photos?employee_id=eq.${empId}&status=in.(held,filed)&created_at=gt.${enc(w.created_at)}&select=id,how&limit=5`)).rows.filter((b) => b.how !== "noaccess");
  return since.length ? null : { jobId: w.pact_job_id || w.release_id || "", kind: w.pact_job_id ? "pact" : w.release_id ? "rel" : "", how: w.how || "", at: msOf(w) };
}
// the window's send came in while the word was still on its way: it's used
const closeWindows = (db: Db, empId: string, now: Date) =>
  db.patch(`texted_photos?employee_id=eq.${empId}&how=in.(aftersay,afterwait)&status=eq.note&created_at=gte.${enc(new Date(now.getTime() - AFTER_WINDOW_MS - 60_000).toISOString())}`, { status: "seen" });

// ---- the send they just made ----
// The newest pieces they texted (waiting for a number, or on a job; never a
// door's), each within ten minutes of the next, back to a text of theirs (an
// AFTER said about these doesn't end it), the newest in the last quarter
// hour. In a crew's thread (`jobId`): the pieces anyone posted on its job.
interface Sent {
  pieces: SendRow[];       // newest first
  held: boolean;           // waiting for their job's number
  newest: number; oldest: number;
  before: SendRow[];       // the pieces still on the BEFORE pile
  saidBefore: boolean;     // a caption said BEFORE: they meant it
  empId: string;           // who sent it
}
async function justSent(db: Db, o: { empId?: string; jobId?: string; now: Date }): Promise<Sent | null> {
  const since = enc(new Date(o.now.getTime() - 2 * 3_600_000).toISOString());
  const who = o.jobId ? `or=(pact_job_id.eq.${o.jobId},release_id.eq.${o.jobId})&status=in.(held,filed)` : `employee_id=eq.${o.empId}&status=in.(held,filed,measure,note,nobody,reply,seen,opened,moved,done)`;
  const rows = (await db.get<SendRow>(`texted_photos?${who}&created_at=gte.${since}&order=created_at.desc&select=*&limit=60`)).rows;
  const isBatch = (b: SendRow) => b.status === "held" || b.status === "filed";
  const isPiece = (b: SendRow) => isBatch(b) && b.how !== "noaccess" && (b.photos || []).length > 0;
  const top = rows.findIndex(isPiece);
  if (top < 0 || o.now.getTime() - msOf(rows[top]) > FLIP_MS) return null;
  const first = rows[top];
  const jobOf = (b: SendRow) => (b.status === "filed" ? b.pact_job_id || b.release_id || "" : "");
  const pieces: SendRow[] = [];
  let at = msOf(first);
  for (const b of rows.slice(top)) {
    if (!isPiece(b)) {
      // a text of theirs ends the send, and so does a door's picture; a row the
      // portal wrote for itself doesn't, nor an AFTER said about this send
      if (isBatch(b) || (b.msg_sid && b.how !== "afterflip")) break;
      continue;
    }
    if (at - msOf(b) > BURST_MS || jobOf(b) !== jobOf(first) || b.status !== first.status) break;
    pieces.push(b);
    at = msOf(b);
  }
  return {
    pieces, held: first.status === "held", newest: msOf(first), oldest: at,
    before: pieces.filter((b) => namesIn([b]).some((n) => kindOfName(n) === "before")),
    saidBefore: pieces.some((b) => captionKind(b.body || "") === "before"),
    empId: first.employee_id || "",
  };
}
// their photos waiting for a number (two days), not a door's: the newest of them, pieces within ten minutes of each other
async function waitingHeld(db: Db, empId: string, now: Date): Promise<Batch[]> {
  const rows = (await db.get<Batch>(`texted_photos?employee_id=eq.${empId}&status=eq.held&created_at=gte.${enc(new Date(now.getTime() - 2 * 86_400_000).toISOString())}&order=created_at.desc&limit=20&select=*`)).rows.filter((b) => b.how !== "noaccess");
  if (!rows.length) return [];
  const lastAt = msOf(rows[0]);
  return rows.filter((b) => msOf(b) >= lastAt - BURST_MS);
}
// held photos they said AFTER about: in AFTER, whichever job they go on
const markHeldAfter = async (db: Db, s: Sent) => { for (const b of s.pieces) await db.patch(`texted_photos?id=eq.${b.id}&status=eq.held`, { how: "after" }); };
// the job's pictures (a release's too)
async function namesOfJob(db: Db, t: Target, thread: ThreadJob | null): Promise<string[]> {
  if (thread) return namesOf(thread);
  if (t.kind === "pact") { const j = await threadJob(db, t.id); return j ? namesOf(j) : []; }
  return ((await db.get<{ attachments?: Photo[] | null }>(`releases?id=eq.${t.id}&select=attachments`)).rows[0]?.attachments || []).map((a) => a?.name || "");
}
// pictures with nothing on the job's BEFORE pile from its day an hour or more before them: the arrival
async function arrivalOnly(db: Db, t: Target, thread: ThreadJob | null, startMs: number, today: string): Promise<boolean> {
  const cur = thread ? dayPile(thread, today).cur : today;
  return !namesFrom(await namesOfJob(db, t, thread), cur).some((n) => isMediaName(n) && kindOfName(n) === "before" && photoAt(n) < startMs - ARRIVAL_GAP_MS);
}
// their jobs today (two of them make the day's job a guess)
async function todaysJobs(db: Db, emp: Emp, today: string): Promise<JobKey[]> {
  const { rows, mine } = await jobsOf(db, emp, today);
  const ids = new Set(rows.filter((r) => r.day === today).map((r) => r.pact_job_id || r.release_id || ""));
  return mine.filter((k) => ids.has(k.id));
}
// "116843 (2205 Linden Blvd, Apt 4B)": a job the way a worker answers with it
const optionOf = (k: JobKey, lang?: string | null) => { const place = jobName({ ...k, label: "" }, lang); return `${(k.label.match(/\d[\w-]*$/) || [k.label])[0]}${place ? ` (${place})` : ""}`; };
// the job a text names by its number ("AFTER 116843", "116843 done"): one of theirs, or any PO in the portal
async function namedJob(db: Db, o: Said): Promise<JobKey | null> {
  const refs = jobRefsOnly(o.body);
  if (!refs) return null;
  const { rows, mine } = await jobsOf(db, o.emp, o.today);
  const anyPo = await anyPoOf(db, refs, mine);
  const pick = pickJob(refs, rows, mine, o.today, anyPo);
  return pick.kind !== "ask" && pick.why === "number" ? [...mine, ...anyPo].find((k) => k.id === pick.id) || null : null;
}

interface Flip { text: string; c: MediaCount; t: Target; thread: ThreadJob | null; asked?: boolean }
// AFTER (or DONE) right after a send with nothing said: it moves to AFTER, and
// on the job's last day the job is marked work done ("all": ALL DONE, which
// the caller finishes). DONE right after the arrival photos can be "done
// sending": nothing moves, and they're asked
async function flipToAfter(db: Db, o: Said, s: Sent, why: "after" | "done" | "all"): Promise<Flip | null> {
  const t = await targetOf(db, s.pieces[0]);
  if (!t) return null;
  const thread = t.kind === "pact" ? await threadJob(db, t.id) : null;
  const lang = o.emp.lang;
  const name = jobName(t, lang);
  const c = countOf(namesIn(s.pieces));
  if (why === "done" && (await arrivalOnly(db, t, thread, s.oldest, o.today))) {
    await remember(db, o, "donetext", t);
    const one = c.n === 1;
    const text = isEs(lang)
      ? `Entendido. Si lo que acaba de mandar ${atJob(name, "es")} es el trabajo terminado, responda DESPUES.`
      : `Got it. If the ${one ? (c.v ? "video" : "photo") : mediaWords(c, "en")} you just sent ${atJob(name, "en")} ${one ? "is" : "are"} the finished work, reply AFTER.`;
    return { text, c, t, thread, asked: true };
  }
  let moved = 0;
  for (const b of [...s.before].reverse()) moved += await fileBatch(db, b, t, b.how || "day", "after");
  if (s.before.length && !moved) return null;
  await remember(db, o, "afterflip", t);
  // (a co-worker's, in the crew's thread)
  const who = s.empId && s.empId !== o.emp.id ? firstName(o.emps.find((e) => e.id === s.empId)) : "";
  // on a job only the day's guess picked, of two that day: they hear how to move them
  const hint = s.pieces.some((b) => b.how === "day") && (await todaysJobs(db, o.emp, o.today)).length > 1;
  if (!thread) return { text: flippedText(c, name, lang, false, { hint, who }), c, t, thread };
  await closeQuestion(db, thread.id);
  if (why === "all") return { text: flippedText(c, name, lang, false, { thanks: false, who }), c, t, thread };
  const L = onLastDay(thread, o.today);
  if (L.before) return { text: gotAfterDayText(c, name, { day: L.day, of: L.of, next: L.next, today: o.today }, lang), c, t, thread };
  const caption = s.pieces.map((b) => b.body || "").join(" ");
  const marked = !notDone(caption) && !mixedCaption(caption) ? await markDone(db, thread, o.emp, { from: o.from, now: o.now, finish: dayPile(thread, o.today).cur }) : false;
  return { text: flippedText(c, name, lang, marked, { hint, who }), c, t, thread };
}
// AFTER with nothing just sent: the next photos go in AFTER, on the job the
// text names, else their one job today, else the one of today's they last sent
// photos of (two today, none of them yet: wherever the photos land); with no
// job today, the job the morning asked about, or the last they sent photos of
async function openAfter(db: Db, o: Said, named: JobKey | null): Promise<string> {
  const lang = o.emp.lang;
  let job: JobKey | null = named;
  if (!job) {
    const today = await todaysJobs(db, o.emp, o.today);
    if (today.length === 1) job = today[0];
    else if (today.length > 1) {
      const last = (await db.get<{ pact_job_id?: string | null; release_id?: string | null; created_at?: string | null }>(`texted_photos?employee_id=eq.${o.emp.id}&status=eq.filed&created_at=gte.${enc(new Date(o.now.getTime() - 20 * 3_600_000).toISOString())}&select=pact_job_id,release_id,created_at&order=created_at.desc&limit=1`)).rows[0];
      const id = last && nyDay(new Date(msOf(last))) === o.today ? last.pact_job_id || last.release_id || "" : "";
      job = today.find((k) => k.id === id) || null;
    } else {
      const found = await jobToAnswer(db, { ...o, verb: "done" });
      if (found && "job" in found) job = keyOf(found.job);
    }
  }
  await putRow(db, { employee_id: o.emp.id, from_phone: o.from, body: o.body, status: "note", how: "aftersay", photos: [], msg_sid: o.sid || null, ...jobCols(job) });
  // pictures that got here while this was being written (sent with the word): they're the ones
  const s = await justSent(db, { empId: o.emp.id, now: o.now });
  if (s && !s.saidBefore && s.newest >= o.now.getTime() - FRESH_MS) {
    if (s.held) {
      await markHeldAfter(db, s);
      await closeWindows(db, o.emp.id, o.now);
      const opts = (await todaysJobs(db, o.emp, o.today)).slice(0, 3).map((k) => optionOf(k, lang));
      return heldAfterText(countOf(namesIn(s.pieces)), opts.length > 1 ? opts : [], lang);
    }
    if (s.before.length) {
      const f = await flipToAfter(db, { ...o, sid: "" }, s, "after");
      if (f) { await closeWindows(db, o.emp.id, o.now); return f.text; }
    }
  }
  return job ? afterNextText(jobName(job, lang), lang) : isEs(lang) ? "Entendido: las fotos que mande ahora van a DESPUES." : "OK: the photos you send now go in AFTER.";
}

// ---- AFTER and DONE texted with no photos ----
// AFTER: the photos waiting for a number, or the send they just made, are the
// after photos; with nothing sent, the next ones are. DONE: the send they just
// made is the finished work (unless it was the arrival: they're asked); the
// rest is doneIn's. A job the text names ("AFTER 116843", "116843 done") is
// the one: photos waiting for their number go on it in AFTER, the send just
// made on another job moves onto it in AFTER; a DONE about another job leaves
// the send where it is. Null: nothing here, the text goes on (doneIn, words).
async function afterOrDone(db: Db, o: Said, w: { after: boolean; done: DoneSaid }): Promise<string | null> {
  const lang = o.emp.lang;
  const named = await namedJob(db, o);
  if (named) {
    const held = await waitingHeld(db, o.emp.id, o.now);
    if (held.length) { const r = await placeOn(db, o, held, named, { force: "after", all: w.done === "all" }); if (r) return r; }
  }
  let s = await justSent(db, { empId: o.emp.id, now: o.now });
  const wait = afterWaitMs();
  if ((!s || s.newest < o.now.getTime() - FRESH_MS) && wait) {
    await sleep(wait);
    s = (await justSent(db, { empId: o.emp.id, now: o.now })) || s;
  }
  // in a crew's thread: the send just posted there, by anyone on the crew
  if (!s && o.hint) s = await justSent(db, { jobId: o.hint.id, now: o.now });
  if (s && !s.saidBefore) {
    const sendJob = s.held ? "" : s.pieces[0].pact_job_id || s.pieces[0].release_id || "";
    if (s.held) {
      if (w.after) {
        await markHeldAfter(db, s);
        await remember(db, o, "afterflip");
        const opts = (await todaysJobs(db, o.emp, o.today)).slice(0, 3).map((k) => optionOf(k, lang));
        return heldAfterText(countOf(namesIn(s.pieces)), opts.length > 1 ? opts : [], lang);
      }
    } else if (named && named.id !== sendJob) {
      // AFTER with another job's number: the send goes there, in AFTER (a DONE about another job is doneIn's)
      if (w.after) { const r = await placeOn(db, o, s.pieces, named, { force: "after" }); if (r) return r; }
    } else if (!s.before.length) {
      // in AFTER already: nothing to move (a DONE still marks the job, or ends it: doneIn)
      const t = w.after ? await targetOf(db, s.pieces[0]) : null;
      if (t) return alreadyAfterText(countOf(namesIn(s.pieces)), jobName(t, lang), lang);
    } else {
      const f = await flipToAfter(db, o, s, w.done === "all" ? "all" : w.after ? "after" : "done");
      if (f && w.done === "all" && f.thread) {
        const d = await doneIn(db, { ...o, sid: "" }, "all", f.thread);
        return d ? `${f.text} ${d}` : f.text;
      }
      if (f) return f.text;
    }
  }
  return w.after ? openAfter(db, o, named) : null;
}

// the job's work lines: a Sales Tax line left on them from an old PO read is
// paperwork, never measured, asked about or saved back (lib/paperwork.ts)
const itemsOf = (j: ThreadJob): SfLine[] => workLines(Array.isArray(j.items) ? j.items : []);
// the job a measurement is for: the PO said in the text, else the one job
// today; the square feet themselves ("120", "10x12") must not read as a job number
const jobRefsOnly = (body: string): string => [
  ...(body || "").matchAll(/\b(?:p\.?\s*o\.?|release|rel\.?)\s*(?:number|no\.?|num|#)?\s*[#:\-]?\s*\d{1,12}\b/gi),
  ...(body || "").matchAll(/\b\d{5,12}\b/g),
].map((m) => m[0]).join(" ");
// "plaster 120 sf": onto the job's lines, so the proposal and the invoice
// carry it; a note on the job and a line for the office. The reply, or
// nothing when the text wasn't a measurement. A bare number ("4521", "12")
// is never square feet: a measurement needs its line's word or a unit.
async function measureIn(db: Db, o: { emp: Emp; body: string; from: string; sid: string; now: Date; today: string; hint?: Hint }): Promise<string | null> {
  const lang = o.emp.lang;
  const { rows, mine } = await jobsOf(db, o.emp, o.today);
  const refs = jobRefsOnly(o.body);
  const anyPo = await anyPoOf(db, refs, mine);
  const pick = withHint(pickJob(refs, rows, mine, o.today, anyPo), mine, o.hint, rows, o.today);
  // this worker's job numbers are never read as square feet ("4521" after pictures)
  const ignore = [...mine, ...anyPo].flatMap((j) => j.keys);
  if (pick.kind === "rel") {
    // square feet on a release: the office prices releases, the words go to them
    if (parseMeasures(o.body, [], false, { ignore }).kind === "none") return null;
    await putRow(db, { employee_id: o.emp.id, from_phone: o.from, body: o.body, status: "reply", how: "measure", photos: [], release_id: pick.id, msg_sid: o.sid || null });
    return releaseMeasureText(jobName(pick, lang), lang);
  }
  if (pick.kind !== "pact") {
    // a measurement ("50 sf", "plaster 50") with no one job to put it on: say which
    return parseMeasures(o.body, [], false, { ignore }).kind !== "none" ? askWhichJobText(lang) : null;
  }
  const job = await threadJob(db, pick.id);
  if (!job) return null;
  const lines = measureLines(itemsOf(job));
  const parsed = parseMeasures(o.body, lines, false, { ignore });
  if (parsed.kind === "none") return null;
  if (billed(job)) return invoicedText(jobName(pick, lang), lang);
  if (parsed.kind === "ask") {
    // the crew is never asked about square feet: their words go to the office as they are
    await putRow(db, { employee_id: o.emp.id, from_phone: o.from, body: o.body, status: "reply", how: "measure", photos: [], pact_job_id: job.id, msg_sid: o.sid || null });
    return toldOfficeText(lang);
  }
  const done = await measureOnJob(db, job, parsed.hits, { ...o, sid: o.sid });
  if (!done) return lang && /^(es|spa|esp)/i.test(lang) ? "No se pudo guardar la medida. Por favor mándela otra vez." : "Couldn't save that measurement. Please text it again.";
  return gotMeasureText(done.changes, jobName(pick, lang), lang);
}
// the numbers onto the job: its lines, its billed total (as the page keeps
// it: never wiped by lines at no price), a 📏 line on its notes, and a row
// for the office. `sid` is left off a text that already filed its pictures
// under that id (one row per Twilio message id). Null when the save failed.
async function measureOnJob(db: Db, job: ThreadJob, hits: Parameters<typeof applyMeasures>[1], o: { emp: Emp; body: string; from: string; sid: string; now: Date }): Promise<{ changes: Change[]; stillBlank: MeasureLine[] } | null> {
  // a Plaster line the job never had: at the price Settings saved, not the built-in list's
  const newPlaster = hits.some((h) => h.index === -1);
  const plasterPrice = newPlaster ? await bookPrice("plaster") : 0;
  // …and the primer and paint that go with it, by the room the job's words name
  const prep = newPlaster ? { primer: await bookPrice("primer"), paint: await bookPrice("paint_sf"), rooms: roomsIn(job.description || "") } : undefined;
  const { items, changes } = applyMeasures(itemsOf(job), hits, plasterPrice, prep);
  if (!changes.length) return null;
  const sub = items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);
  // a Sales Tax line still saved on the job (itemsOf leaves it out) goes with
  // this save: the rate it names is kept on the job, as the page's repair would
  const ownRate = paperworkRepair(job).patch?.tax_pct;
  const tax = ownRate ?? (job.tax_pct === null || job.tax_pct === undefined ? 8.875 : Number(job.tax_pct));
  const line = measureNoteLine(changes, firstName(o.emp), nyWhen(o.now));
  const notes = `${(job.notes || "").trim()}${(job.notes || "").trim() ? "\n" : ""}${line}`;
  const saved = await db.patch(`pact_jobs?id=eq.${job.id}`, { items, notes, ...(ownRate !== undefined ? { tax_pct: ownRate } : {}), ...(sub > 0 ? { amount: Math.round(sub * (1 + tax / 100) * 100) / 100 } : {}) });
  if (!saved) return null;
  job.notes = notes;
  await putRow(db, { employee_id: o.emp.id, from_phone: o.from, body: o.body, status: "measure", how: "measure", pact_job_id: job.id, photos: [], msg_sid: o.sid || null, note: line });
  return { changes, stillBlank: measureLines(items).filter((l) => !l.has) };
}

// ---- DONE and NOT DONE: which job they mean ----
// 1. the PO in the text; 2. the thread's own job, when it is one of today's
// (a crew's thread is about one job; its last text can be tomorrow's); 3. the
// job the portal just asked them about ("If it isn't finished, reply NOT
// DONE", half an hour); 4. the job the morning asked them about
// ("Finished?"), while nothing came from them after it and they haven't
// moved on to another job today; 5. for NOT DONE, the job of theirs marked
// done in the last two hours, before they sent pictures anywhere else (or in
// the last three days, with no job today); 6. their job today (the one
// they're working on, of two); 7. none today: the job they last sent
// pictures of. Two it could be, and they're asked which, by number and address.
type Found = { job: ThreadJob; asked: boolean; askedDay: string; answered?: boolean } | { options: JobKey[] } | { unknown: string } | null;
// the portal's own prompts about a job, written as the worker's rows: not "something from them after the question"
const PROMPTED = new Set(["nodone", "answered"]);
async function jobToAnswer(db: Db, o: { emp: Emp; body: string; today: string; now: Date; verb: "done" | "notdone"; hint?: Hint }): Promise<Found> {
  const { rows, mine } = await jobsOf(db, o.emp, o.today);
  const refs = jobRefsOnly(o.body);
  if (refs) {
    const pick = pickJob(refs, rows, mine, o.today, await anyPoOf(db, refs, mine));
    if (pick.kind === "pact" && pick.why === "number") { const j = await threadJob(db, pick.id); if (j) return { job: j, asked: false, askedDay: "" }; }
    if (pick.kind === "ask" && pick.why === "unknown") return { unknown: pick.number || "" };
  }
  const todayIds = [...new Set(rows.filter((r) => r.day === o.today && r.pact_job_id).map((r) => r.pact_job_id as string))];
  if (o.hint?.kind === "pact" && todayIds.includes(o.hint.id)) {
    const j = await threadJob(db, o.hint.id);
    if (j && !j.canceled) return { job: j, asked: false, askedDay: "" };
  }
  const since = enc(new Date(o.now.getTime() - 3 * 86_400_000).toISOString());
  // what came from them lately (their own texts and pictures), newest first
  const own = (await db.get<{ how?: string | null; status?: string | null; pact_job_id?: string | null; release_id?: string | null; created_at?: string | null }>(`texted_photos?employee_id=eq.${o.emp.id}&msg_sid=not.is.null&created_at=gte.${since}&select=how,status,pact_job_id,release_id,created_at&order=created_at.desc&limit=30`)).rows;
  const at = (r: { created_at?: string | null }) => Date.parse(r.created_at || "") || 0;
  const q = await openQuestion(db, o.emp.id, o.now, true);
  // the portal just asked about a job ("If X isn't finished, reply NOT DONE"): that one
  const prompt = own[0] && PROMPTED.has(own[0].how || "") && own[0].pact_job_id && o.now.getTime() - at(own[0]) < 30 * 60_000 ? own[0].pact_job_id : "";
  if (prompt) {
    const j = await threadJob(db, prompt);
    if (j && !j.canceled) return { job: j, asked: !!q && q.jobId === j.id && q.open, askedDay: q && q.jobId === j.id ? q.day : "", answered: !!q && q.jobId === j.id && !q.open };
  }
  if (q) {
    const after = own.filter((r) => at(r) > q.at && !PROMPTED.has(r.how || ""));
    // pictures today on another job: they've moved on, and words about "done" are about that one
    const elsewhere = own.some((r) => r.status === "filed" && (r.pact_job_id || r.release_id) && (r.pact_job_id || "") !== q.jobId && nyDay(new Date(at(r))) === o.today);
    if (!after.length && (o.now.getTime() - q.at < 2 * 3_600_000 || !elsewhere)) {
      const j = await threadJob(db, q.jobId);
      if (j && !j.canceled) return { job: j, asked: q.open, askedDay: q.day, answered: !q.open };
    }
  }
  const pactIds = mine.filter((k) => k.kind === "pact").map((k) => k.id);
  if (o.verb === "notdone") {
    const who = pactIds.length ? `or=(employee_id.eq.${o.emp.id},pact_job_id.in.(${pactIds.join(",")}))` : `employee_id=eq.${o.emp.id}`;
    const d = (await db.get<{ pact_job_id?: string | null; created_at?: string | null }>(`texted_photos?how=eq.done&status=in.(done,seen)&${who}&created_at=gte.${since}&select=pact_job_id,created_at&order=created_at.desc&limit=1`)).rows[0];
    // pictures of another job since that mark: they've moved on
    const movedOn = !!d && own.some((r) => r.status === "filed" && at(r) > at(d) && (r.pact_job_id || r.release_id) && r.pact_job_id !== d.pact_job_id);
    // (today's job not started yet: a NOT DONE first thing is about yesterday's)
    const startedToday = own.some((r) => r.status === "filed" && nyDay(new Date(at(r))) === o.today);
    const fresh = !!d?.created_at && !movedOn && (o.now.getTime() - at(d) < 2 * 3_600_000 || !todayIds.length || (!startedToday && o.now.getTime() - at(d) < 24 * 3_600_000));
    if (d?.pact_job_id && fresh) { const j = await threadJob(db, d.pact_job_id); if (j && j.work_done && !j.canceled) return { job: j, asked: false, askedDay: "" }; }
  }
  const todays = (await Promise.all(todayIds.slice(0, 6).map((id) => threadJob(db, id)))).filter((j): j is ThreadJob => !!j && !j.canceled);
  const open = todays.filter((j) => !j.work_done);
  const cands = open.length ? open : todays;
  if (cands.length === 1) return { job: cands[0], asked: false, askedDay: "" };
  if (cands.length > 1) {
    const working = cands.filter((j) => { const p = dayPile(j, o.today); return p.beforeN > 0 && p.afterN === 0; });
    if (working.length === 1) return { job: working[0], asked: false, askedDay: "" };
    return { options: cands.map(keyOf) };
  }
  if (q && q.open) { const j = await threadJob(db, q.jobId); if (j && !j.canceled) return { job: j, asked: true, askedDay: q.day }; }
  const f = own.find((r) => r.status === "filed" && r.pact_job_id);
  if (f?.pact_job_id) { const j = await threadJob(db, f.pact_job_id); if (j && !j.canceled) return { job: j, asked: false, askedDay: "" }; }
  return null;
}
interface Said { emp: Emp; emps: Emp[]; body: string; from: string; sid: string; now: Date; today: string; hint?: Hint }
// a row for their text, so a retry of it is not acted on twice and the next text knows what was said
const remember = (db: Db, o: Said, how: string, job?: string | { kind: "pact" | "rel"; id: string } | null, note = "", status = "note") =>
  putRow(db, { employee_id: o.emp.id, from_phone: o.from, body: o.body, status, how, photos: [], msg_sid: o.sid || null, ...jobCols(job), ...(note ? { note } : {}) });

// NOT DONE: the mark comes off (when it's on) and the job runs one more work
// day, Monday to Saturday, with the same crew, who are texted. Every NOT DONE
// reaches the office's card.
// `job`: the job it's about is already known (pictures captioned "not done yet")
async function notDoneIn(db: Db, o: Said, known?: ThreadJob): Promise<string> {
  const lang = o.emp.lang;
  const found: Found = known ? { job: known, asked: false, askedDay: "" } : await jobToAnswer(db, { ...o, verb: "notdone" });
  if (!found || "unknown" in found) {
    await remember(db, o, "notdone", undefined, "Texted NOT DONE, the portal couldn't tell which job", "reply");
    return whichJobText("notdone", [], lang);
  }
  if ("options" in found) { await remember(db, o, "notdone"); return whichJobText("notdone", found.options, lang); }
  const job = found.job;
  const wasDone = !!job.work_done;
  const key = keyOf(job);
  const name = jobName(key, lang);
  const who = firstName(o.emp);
  await closeQuestion(db, job.id);
  const res = await continueJob(db, job, {
    emp: o.emp, emps: o.emps, now: o.now, today: o.today,
    // in a crew's thread the answer itself reaches the crew; a text to the number tells the rest one by one
    tell: !o.hint,
    answered: !!found.answered,
    words: (e, next, day) => crewContinuesText(firstName(e), jobName(key, e.lang), { next, today: o.today, day, who }, e.lang),
  });
  if (res.kind === "billed") {
    await remember(db, o, "notdone", job.id, `${who} texted NOT DONE, but it's already invoiced, so the work-done mark stays`, "reply");
    return invoicedNotDoneText(name, lang);
  }
  if (res.kind === "still") {
    await remember(db, o, "notdone", job.id, `${who} texted NOT DONE · it goes on ${shortDay(res.next)} (day ${res.day} of ${res.of})`, wasDone ? "reply" : "note");
    return stillOnText(name, { next: res.next, today: o.today, day: res.day, of: res.of }, lang);
  }
  if (res.kind === "open") {
    await remember(db, o, "notdone", job.id, `${who} texted NOT DONE · needs another day`, "reply");
    return staysOpenText(name, lang);
  }
  await remember(db, o, "notdone", job.id, `${who} texted NOT DONE · it continues ${shortDay(res.next)}${res.day ? ` (day ${res.day})` : ""}${res.told.length ? `, ${res.told.join(" and ")} texted too` : ""}`, "reply");
  return continuesText(name, { next: res.next, today: o.today, day: res.day }, lang);
}

// DONE (no pictures): the job is finished. The pictures are what finish a job,
// so a DONE nobody asked for, with no AFTER photos for the day, asks for them;
// the answer to the morning's "Finished?" marks it done. On a day before the
// job's last, DONE is the day's; ALL DONE finishes the job early.
// `known`: the job it's about is already known (ALL DONE right after its photos), read again here
async function doneIn(db: Db, o: Said, said: DoneSaid | "yes", known?: ThreadJob): Promise<string | null> {
  const lang = o.emp.lang;
  const again = known ? await threadJob(db, known.id) : null;
  const found: Found = known ? { job: again || known, asked: false, askedDay: "" } : await jobToAnswer(db, { ...o, verb: "done" });
  if (!found || "unknown" in found) return null; // no job to say it about: it's words for the office
  if ("options" in found) { await remember(db, o, "donetext"); return whichJobText("done", found.options, lang); }
  const job = found.job;
  const key = keyOf(job);
  const name = jobName(key, lang);
  if (job.work_done) { await closeQuestion(db, job.id); await remember(db, o, "donetext", job.id); return alreadyDoneText(name, lang); }
  const L = onLastDay(job, o.today);
  const hasAfter = dayPile(job, o.today).afterN > 0;
  if (L.before && said !== "all" && !found.asked) {
    // (no AFTER photos of the day yet: the next ones are)
    await remember(db, o, hasAfter ? "donetext" : "afterwait", job.id);
    return dayDoneText(name, { next: L.next, today: o.today, day: L.nextN, of: L.of }, lang, !hasAfter);
  }
  if (!found.asked && !hasAfter && said !== "all" && said !== "yes") { await remember(db, o, "afterwait", job.id); return sendAfterText(name, lang); }
  const who = firstName(o.emp);
  const dropped = L.before ? await endEarly(db, job, {
    emp: o.emp, emps: o.emps, now: o.now, today: o.today, tell: !o.hint,
    words: (e, d) => crewEndedText(firstName(e), jobName(key, e.lang), d, e.lang),
  }) : [];
  // the day it was finished: the day the morning asked about, else today (a
  // Sunday ALL DONE is its last work day before it)
  const worked = workDaysOf(job.start_date, job.work_days).filter((d) => d <= o.today);
  const finish = found.asked && found.askedDay && found.askedDay <= o.today ? found.askedDay : worked.length && !worked.includes(o.today) ? worked[worked.length - 1] : o.today;
  const marked = await markDone(db, job, o.emp, { from: o.from, now: o.now, finish, sid: o.sid, how: "text" });
  await closeQuestion(db, job.id);
  if (!marked) { await remember(db, o, "donetext", job.id, `${who} texted DONE · the work-done mark couldn't be saved`, "reply"); return toldOfficeText(lang); }
  // marked without its after photos: the next photos they send go in AFTER
  if (!hasAfter) await remember(db, o, "afterwait", job.id);
  return dropped.length ? endedEarlyText(name, dropped, lang, !hasAfter) : doneMarkedText(name, !hasAfter, lang);
}

// ---- a job's number for pictures: ones waiting for it, or a send on the wrong job ----
// They go onto the job it names. Each keeps its pile: one on a job already
// keeps it (one the portal put on the job it asked the after photos of goes
// back to what its words say), the ones waiting go together, in AFTER when an
// AFTER was said with any of them (or right after), else BEFORE. `force`:
// AFTER said with the number; `all`: ALL DONE with it. The answer is the
// thread's next step; null when nothing could move.
async function placeOn(db: Db, o: Said, group: Batch[], pick: Target, opt: { force?: "after"; all?: boolean } = {}): Promise<string | null> {
  const lang = o.emp.lang;
  const name = jobName(pick, lang);
  const onIt = (b: Batch) => b.status === "filed" && (pick.kind === "pact" ? b.pact_job_id === pick.id : b.release_id === pick.id);
  const toMove = group.filter((b) => !onIt(b) || (opt.force === "after" && namesIn([b]).some((n) => kindOfName(n) === "before")));
  if (!toMove.length) {
    const c = countOf(namesIn(group.filter(onIt)));
    return c.n ? replyText({ k: "moved", n: c.n, v: c.v, label: name }, lang) : null;
  }
  const thread = pick.kind === "pact" ? await threadJob(db, pick.id) : null;
  const heldAfter = group.some((b) => b.status === "held" && (b.how === "after" || captionKind(b.body || "") === "after"));
  const kindOf = (b: Batch): PhotoKind | undefined => {
    if (opt.force) return opt.force;
    if (b.status === "held") return heldAfter ? "after" : photoKindFor(b.body || "");
    // (on the job the portal asked the after photos of: away from it, they're what their words say)
    if (b.how === "window") return captionKind(b.body || "") || "before";
    return undefined;
  };
  // the jobs the moved pictures leave: one marked done by them isn't, without them
  const leaving = [...new Set(toMove.filter((b) => b.status === "filed" && b.pact_job_id && b.pact_job_id !== pick.id).map((b) => b.pact_job_id as string))];
  let n = 0;
  for (const b of [...toMove].reverse()) n += await fileBatch(db, b, pick, "number", kindOf(b));
  if (!n) return null;
  for (const id of leaving) await clearDoneIfNoAfter(db, id, jobName(pick, "en"), o.now, o.today, toMove.some((b) => b.pact_job_id === id && wasAfter(b)));
  // what is on the job now, of these, by pile
  const back = (await db.get<Batch>(`texted_photos?id=in.(${group.map((b) => b.id).join(",")})&select=id,status,photos,pact_job_id,release_id`)).rows.filter(onIt);
  const names = namesIn(back);
  const cb = countOf(names.filter((x) => kindOfName(x) !== "after")), ca = countOf(names.filter((x) => kindOfName(x) === "after"));
  if (!thread) {
    const kind = ca.n && !cb.n ? "after" : cb.n && !ca.n ? "before" : undefined;
    const all = { n: ca.n + cb.n, v: ca.v + cb.v };
    return replyText(kind ? { k: "filed", ...all, label: name, kind } : { k: "moved", ...all, label: name }, lang);
  }
  if (!ca.n) return gotBeforeText(cb, name, lang);
  const lead = cb.n ? `${gotPhotosText(cb, "before", name, lang)} ` : "";
  await closeQuestion(db, thread.id);
  // the words the pictures came with still count: "not done yet" runs it on, "kitchen done, starting the bath" asks
  const caption = toMove.map((b) => b.body || "").join(" ");
  if (notDoneStrong(caption)) return `${lead}${gotPhotosText(ca, "after", name, lang)} ${await notDoneIn(db, { ...o, sid: "" }, thread)}`;
  const L = onLastDay(thread, o.today);
  if (opt.all || (L.before && allDoneSaid(caption))) {
    const d = await doneIn(db, { ...o, sid: "" }, "all", thread);
    if (d) return `${lead}${gotPhotosText(ca, "after", name, lang)} ${d}`;
  }
  if (L.before) return `${lead}${gotAfterDayText(ca, name, { day: L.day, of: L.of, next: L.next, today: o.today }, lang)}`;
  if (mixedCaption(caption)) return `${lead}${gotPhotosText(ca, "after", name, lang)} ${finishedAskText(lang)}`;
  const marked = await markDone(db, thread, o.emp, { from: o.from, now: o.now, finish: dayPile(thread, o.today).cur });
  return `${lead}${gotAfterText(ca, name, lang, marked)}`;
}

// "ok", "thanks", "on my way": nothing to do and nothing for the office. Anything else a worker texts is kept for the office's card
const ACK = /^(ok(ay)?|k+|kk|okey|oki|thanks?( you)?( so much)?|thx|ty|tks|gracias|muchas gracias|mil gracias|yes|yeah|yep|yup|si|sí|got it|on my way|omw|otw|coming|here|aqui|aquí|llegando|voy|en camino|perfect|perfecto|bien|ok gracias|okay thanks|ok thanks|thank u|cool|great|good|bueno|vale|entendido|copy|roger|will do|claro|dale|listo|de nada|np|no problem|sure|alright|all right)$/;
const isAck = (body: string) => {
  if (/\d/.test(body || "")) return false; // a number means something: the office sees it
  const t = (body || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  return !t || ACK.test(t);
};
// a job of theirs today, other than `notId`, they haven't sent pictures from
// (and nobody reported): a plain "no" could be about that door
async function openDoorToday(db: Db, emp: Emp, notId: string, now: Date, today: string): Promise<JobKey | null> {
  const { rows, mine } = await jobsOf(db, emp, today);
  const ids = [...new Set(rows.filter((r) => r.day === today).map((r) => r.pact_job_id || r.release_id || "").filter((id) => id && id !== notId))];
  if (!ids.length) return null;
  const since = enc(new Date(now.getTime() - 20 * 3_600_000).toISOString());
  const seen = (await db.get<{ pact_job_id?: string | null; release_id?: string | null; status?: string | null; employee_id?: string | null; created_at?: string | null }>(`texted_photos?or=(employee_id.eq.${emp.id},status.eq.nobody)&created_at=gte.${since}&select=pact_job_id,release_id,status,employee_id,created_at&limit=200`)).rows
    .filter((r) => r.created_at && nyDay(new Date(r.created_at)) === today && (r.status === "filed" || r.status === "nobody"));
  const done = new Set(seen.map((r) => r.pact_job_id || r.release_id || ""));
  const id = ids.find((x) => !done.has(x));
  return id ? mine.find((k) => k.id === id) || null : null;
}
// a filed batch that was on the AFTER pile (before it moved)
const wasAfter = (b: Batch) => b.status === "filed" && (b.photos || []).some((p) => kindOfName(p?.name || "") === "after");
// the photos waiting on a door ("nobody home" with a picture, two jobs and no number): today's, newest first
async function heldDoor(db: Db, empId: string, now: Date): Promise<Batch | null> {
  const since = enc(new Date(now.getTime() - 20 * 3_600_000).toISOString());
  const b = (await db.get<Batch>(`texted_photos?employee_id=eq.${empId}&status=eq.held&how=eq.noaccess&created_at=gte.${since}&order=created_at.desc&limit=1&select=*`)).rows[0];
  return b && b.created_at && nyDay(new Date(b.created_at)) === nyDay(now) ? b : null;
}

// a text in: the answer to send back, or nothing. `seen` is filled in for the
// caller (who it was from, what it carried) once the text is known to be new.
export async function handleInbound(db: Db, inb: Inbound, seen: Seen): Promise<string | undefined> {
  const { from, body, sid, photos, other } = inb;
  const now = new Date();
  const today = nyDay(now);
  const since = (ms: number) => enc(new Date(now.getTime() - ms).toISOString());

  // the same text twice (Twilio trying again) is not filed twice
  if (sid && (await db.get<{ id: string }>(`texted_photos?msg_sid=eq.${enc(sid)}&select=id&limit=1`)).rows.length) return answer();
  Object.assign(seen, { from, body, photos: photos.length, other, videos: photos.filter((m) => /^video\//i.test(m.type)).length }); // (a retry is not copied twice)

  // who sent it: by the whole phone number, country code and all
  let emps = await db.get<Emp>("employees?select=id,name,phone,lang,active");
  if (!emps.ok) emps = await db.get<Emp>("employees?select=id,name,phone,active"); // before the language column
  const key = phoneKey(from);
  const same = key ? emps.rows.filter((e) => phoneKey(e.phone) === key) : [];
  // a phone on the crew list; a worker taken off the list is a stranger to the inbox
  const emp = same.find((e) => e.active !== false) || null;
  const lang = emp?.lang;
  seen.who = (emp?.name || "").trim();

  // a text with no pictures
  if (photos.length === 0) {
    if (!emp) {
      // a phone nobody knows: its words are kept for the office (a new phone,
      // a helper not added yet), a few a day; one hello a day, which also
      // tells Settings the number is pointed here
      const lately = (await db.get<{ id: string }>(`texted_photos?from_phone=eq.${enc(from)}&created_at=gte.${since(86_400_000)}&select=id&limit=20`)).rows.length;
      if (lately >= 20) return answer();
      await db.insert("texted_photos", { from_phone: from, body, status: isAck(body) ? "note" : "reply", how: "stranger", msg_sid: sid || null });
      return lately ? answer() : say({ k: "stranger", n: 0 });
    }
    // a voice note or a contact card on its own isn't kept; words sent with one are read as usual
    if (other > 0 && !body.trim()) return say({ k: "notphoto" }, lang);
    const said: Said = { emp, emps: emps.rows, body, from, sid, now, today, hint: inb.jobHint };

    // a plain yes / no: the answer to the morning's "Finished?" when that is
    // the last thing between the portal and them; right after the work-done
    // mark, a "no" is asked about (not finished, or a door?), never guessed
    // (the question goes one to one: a "yes" in a crew's thread is to the people in it)
    if ((yesWord(body) || noWord(body)) && !/\d/.test(body) && !inb.jobHint) {
      // (the AFTER windows the portal keeps for itself are not something said)
      const last = (await db.get<{ how?: string | null; status?: string | null; pact_job_id?: string | null; created_at?: string | null }>(`texted_photos?employee_id=eq.${emp.id}&or=(how.is.null,how.not.in.(afterwait,aftersay,afterflip))&select=how,status,pact_job_id,created_at&order=created_at.desc&limit=1`)).rows[0];
      const age = last?.created_at ? now.getTime() - Date.parse(last.created_at) : Infinity;
      const lastJob = last?.pact_job_id && age < 24 * 3_600_000 && (last.how === "asked" || (last.how === "done" && age < 2 * 3_600_000) || (last.how === "nodone" && age < 30 * 60_000)) ? await threadJob(db, last.pact_job_id) : null;
      if (lastJob && last) {
        const label = jobName(keyOf(lastJob), lang);
        // their other job today they haven't sent pictures of: a "no" could be that door
        const door = noWord(body) ? await openDoorToday(db, emp, lastJob.id, now, today) : null;
        const doorWords = door ? { name: jobName(door, lang), num: (door.label.match(/\d[\w-]*$/) || [""])[0] } : null;
        if (last.how === "nodone") {
          // a second plain "no" to "not finished, or nobody home?": asked again, nothing guessed
          await remember(db, said, "nodone", lastJob.id);
          return answer(noAfterDoneText(label, doorWords, lang));
        }
        if (last.how === "asked" && last.status === "note") {
          // the morning's question, still open: the answer to it, unless a "no" could be a door today
          if (yesWord(body)) { const r = await doneIn(db, said, "yes"); if (r) return answer(r); }
          else if (!door) return answer(await notDoneIn(db, said));
          else { await remember(db, said, "nodone", lastJob.id); return answer(noAfterDoneText(label, doorWords, lang)); }
        } else if (last.how === "asked") {
          // the question was answered already (a co-worker's DONE or NOT DONE): nothing is guessed again
          if (!(yesWord(body) && !lastJob.work_done)) await remember(db, said, "answered", lastJob.id);
          if (lastJob.work_done) return answer(yesWord(body) ? alreadyDoneText(label, lang) : noAfterDoneText(label, doorWords, lang));
          if (yesWord(body)) { await remember(db, said, "afterwait", lastJob.id); return answer(sendAfterText(label, lang)); }
          const L = onLastDay(lastJob, today);
          return answer(L.last >= today ? stillOnText(label, { next: L.last, today, day: L.day ? L.of : 0, of: L.of }, lang) : staysOpenText(label, lang));
        } else if (noWord(body) && lastJob.work_done) {
          // right after the work-done mark: not finished, or a door?
          await remember(db, said, "nodone", lastJob.id);
          return answer(noAfterDoneText(label, doorWords, lang));
        }
      }
    }
    // AFTER (or DONE) right after photos that said nothing: those photos are
    // the after photos. AFTER with nothing just sent: the next photos are
    const aft = afterSaid(body), dn = doneSaid(body);
    if (aft || dn) {
      const r = await afterOrDone(db, said, { after: aft, done: dn });
      if (r) return answer(r);
    }
    // "no" (or "nobody home") a moment after pictures with no words (the phone
    // sent the picture first): the pictures were of the door. They come off
    // the BEFORE pile onto the door's, so the door counts as not got into.
    // Only when that job is the door it can be: another job of theirs today
    // with no pictures (nobody reported) leaves it to "which one?"
    if ((bareNo(body) || nobodyHome(body)) && !/\d/.test(body)) {
      const s = await justSent(db, { empId: emp.id, now });
      const t = s && !s.held && now.getTime() - s.newest <= 5 * 60_000 && s.pieces.every((b) => !(b.body || "").trim()) && s.before.length === s.pieces.length ? await targetOf(db, s.pieces[0]) : null;
      if (s && t) {
        const col = t.kind === "pact" ? "pact_job_id" : "release_id";
        const ids = new Set(s.pieces.map((b) => b.id));
        const others = (await db.get<{ id: string; created_at?: string | null }>(`texted_photos?employee_id=eq.${emp.id}&status=eq.filed&${col}=eq.${t.id}&created_at=gte.${since(20 * 3_600_000)}&select=id,created_at`)).rows
          .filter((r) => !ids.has(r.id) && r.created_at && nyDay(new Date(r.created_at)) === today);
        if (!others.length && !(await openDoorToday(db, emp, t.id, now, today))) for (const b of [...s.pieces].reverse()) await fileBatch(db, b, t, "noaccess", "noaccess");
      }
    }
    // "no" / "nobody home" / "nadie": the job is flagged for a new day and
    // they get their next one (lib/nobodyFlow.ts). "NO 2205 Linden" is a door
    // only when the number is one of today's doors (the house or the apartment)
    const candidate = !nobodyHome(body) && noAt(body);
    if (nobodyHome(body) || candidate) {
      const flow = await nobodyFlow(db, { emp, emps: emps.rows, body, from, sid, now, say: inb.deliver, candidate });
      if (flow.handled) {
        // a picture of that door waiting for its number goes on it
        const door = flow.missed ? await heldDoor(db, emp.id, now) : null;
        if (door && flow.missed) await fileBatch(db, door, flow.missed, "noaccess");
        return answer(flow.reply);
      }
    }
    // the owner testing the number from a phone on the crew list still
    // switches it on, and hears back that it worked, that once
    const firstEver = !(await db.get<{ id: string }>("texted_photos?select=id&limit=1")).rows.length;
    if (firstEver) await db.insert("texted_photos", { employee_id: emp.id, from_phone: from, body, status: "note", msg_sid: sid || null });
    // "not done": it runs one more work day (lib/jobThread continueJob)
    if (notDone(body)) return answer(await notDoneIn(db, said));
    // "done", "terminé", "all done"
    const d = doneSaid(body);
    if (d) { const r = await doneIn(db, said, d); if (r) return answer(r); }
    // a number answering "which job has nobody home?" for the door picture they sent
    if (justANumber(body)) {
      const door = await heldDoor(db, emp.id, now);
      // (pictures waiting for a number since the door's: the number is theirs)
      const newer = door ? (await db.get<{ id: string; how?: string | null }>(`texted_photos?employee_id=eq.${emp.id}&status=eq.held&created_at=gt.${enc(door.created_at || "")}&select=id,how&limit=5`)).rows.some((b) => b.how !== "noaccess") : false;
      if (door && !newer) {
        const n = refsIn(body)[0]?.n || "";
        const flow = await nobodyFlow(db, { emp, emps: emps.rows, body: `NO ${n}`, from, sid, now, say: inb.deliver });
        if (flow.handled) {
          if (flow.missed) await fileBatch(db, door, flow.missed, "noaccess");
          return answer(flow.reply);
        }
      }
    }
    // the square feet, texted: onto the job's lines (lib/jobFlow), unless the
    // text is just a number and pictures of theirs are waiting for one: then
    // it is the job those pictures go on
    // (a door picture waiting for its number is not one of them)
    const heldWaiting = justANumber(body) && (await db.get<{ id: string; how?: string | null }>(`texted_photos?employee_id=eq.${emp.id}&status=eq.held&created_at=gte.${since(2 * 86_400_000)}&select=id,how&limit=20`)).rows.some((b) => b.how !== "noaccess");
    const measured = heldWaiting ? null : await measureIn(db, { emp, body, from, sid, now, today, hint: inb.jobHint });
    if (measured) return answer(measured);
    // anything else they say reaches the office's card (and a text to the
    // number hears that it did); "ok", "thanks" and the like are let be
    const words = async (): Promise<string | undefined> => {
      if (isAck(body)) return firstEver ? say({ k: "connected" }, lang) : answer();
      await remember(db, said, "words", undefined, "", "reply");
      return firstEver ? say({ k: "connected" }, lang) : inb.jobHint ? answer() : answer(toldOfficeText(lang));
    };
    // a job's number: the pictures they just sent go there: ones still
    // waiting (two days), or ones put on the wrong job (the last two hours).
    // Only a text that is just the number ("On my way to PO 116843" moves
    // nothing). "Just sent" is the last batch and any sent within ten minutes
    // of it (a phone often splits five pictures into five texts); a piece that
    // named its own job stays there, unless it's the newest (its PO typed wrong)
    if (!refsIn(body).length || !justANumber(body)) return words();
    const recent = (await db.get<Batch>(`texted_photos?employee_id=eq.${emp.id}&or=(and(status.eq.held,created_at.gte.${since(2 * 86_400_000)}),and(status.eq.filed,created_at.gte.${since(2 * 3_600_000)}))&order=created_at.desc&limit=20&select=*`)).rows
      .filter((b) => b.how !== "noaccess");
    if (!recent.length) return words();
    const lastAt = msOf(recent[0]) || now.getTime();
    const group = recent.filter((b, i) => msOf(b) >= lastAt - BURST_MS && (i === 0 || b.status === "held" || b.how !== "number"));
    const { rows, mine } = await jobsOf(db, emp, today);
    const pick = pickJob(body, rows, mine, today, await anyPoOf(db, body, mine));
    if (pick.kind !== "ask" && pick.why === "number") { const r = await placeOn(db, said, group, pick); return r ? answer(r) : words(); }
    if (pick.kind === "ask" && pick.why === "unknown" && group.some((b) => b.status === "held")) {
      const c = countOf(namesIn(group.filter((b) => b.status === "held")));
      return say({ k: "unknown", number: pick.number || "", n: c.n, v: c.v }, lang);
    }
    return words();
  }

  // fetch each picture from Twilio and store it in that folder, all at once,
  // so ten pictures take about as long as one (Twilio waits 15 seconds for the answer)
  const store = async (dir: string, kind: string): Promise<Photo[]> => (await Promise.all(photos.map(async (m, i): Promise<Photo | null> => {
    const got = await inb.fetchMedia(m.url);
    if (!got) return null;
    const name = photoName(kind, now, (emp?.name || "").trim().split(/\s+/)[0] || "", sid, i, photos.length, m.ext);
    return (await db.upload(dir + name, got.bytes, got.type || m.type)) ? { name, path: dir + name } : null;
  }))).filter((p): p is Photo => !!p);
  // their jobs (two weeks either side of today), and today's
  const jobs = emp ? await jobsOf(db, emp, today) : { rows: [] as MineRow[], mine: [] as JobKey[] };
  const todayIds = new Set(jobs.rows.filter((r) => r.day === today).map((r) => r.pact_job_id || r.release_id || "").filter(Boolean));

  // a picture of a door nobody opened: within five minutes of their own "no"
  // (a phone sends the words and the picture as two texts), or with the
  // door's words ("door", "puerta", "closed") while a door of theirs is
  // flagged today. It goes on that door's notice (a co-worker's, when they
  // reported it first)
  const doorWords = /\b(door|puerta|closed|cerrad[ao])\b/i.test(body);
  if (emp && !refsIn(body).length && (!body.trim() || doorWords)) {
    type Notice = { id: string; status?: string | null; pact_job_id?: string | null; release_id?: string | null; photos?: Photo[] | null; created_at?: string | null };
    const own = (await db.get<Notice>(`texted_photos?employee_id=eq.${emp.id}&how=eq.nobody&status=in.(nobody,note,reply)&msg_sid=not.is.null&created_at=gte.${since(5 * 60_000)}&select=id,status,pact_job_id,release_id,photos,created_at&order=created_at.desc&limit=1`)).rows[0];
    let n: Notice | undefined = own && own.status === "nobody" ? own : undefined;
    if (!n && (own || doorWords)) {
      const open = (await db.get<Notice>(`texted_photos?status=eq.nobody&how=eq.nobody&created_at=gte.${since(20 * 3_600_000)}&select=id,pact_job_id,release_id,photos,created_at&limit=20`)).rows
        .filter((x) => x.created_at && nyDay(new Date(x.created_at)) === today && todayIds.has(x.pact_job_id || x.release_id || ""));
      if (open.length === 1) n = open[0];
    }
    const t = n ? (n.pact_job_id ? { kind: "pact" as const, id: n.pact_job_id } : n.release_id ? { kind: "rel" as const, id: n.release_id } : null) : null;
    if (n && t && !(await sentNextDoor(db, emp.id, t, own?.created_at || n.created_at || ""))) {
      const put = await store(pileDir(t, "noaccess"), "noaccess");
      if (put.length && (await db.attach(t, put, []))) {
        await db.patch(`texted_photos?id=eq.${n.id}`, { photos: [...(n.photos || []), ...put] });
        await db.insert("texted_photos", { employee_id: emp.id, from_phone: from, body, photos: [], status: "note", how: "noaccess", msg_sid: sid || null, ...jobCols(t) });
        return answer(doorGotText(countOf(put.map((p) => p.name)), lang));
      }
      // (the job's documents wouldn't take them: the files go, and the pictures are placed the usual way)
      if (put.length) await db.remove(put.map((p) => p.path));
    }
  }
  // a picture of the door with "nobody home" (or a plain NO with the picture
  // of a door they haven't been through today): it goes on that job, and they
  // get their next one. A NO with pictures of a job they're working on is
  // not a door: those go on the job as usual.
  if (emp && nobodyHome(body)) {
    const plain = bareNo(body);
    const flow = await nobodyFlow(db, { emp, emps: emps.rows, body, from, sid, now, proof: (dir) => store(dir, "noaccess"), say: inb.deliver, photosIn: plain });
    if (flow.handled) {
      if (!flow.missed) {
        // which job wasn't clear: the pictures wait for the answer, as a door's (the answer asks)
        const batchId = randomUUID();
        const put = await store(inboxOf(batchId), "noaccess");
        if (put.length && !(await db.insert("texted_photos", { id: batchId, employee_id: emp.id, from_phone: from, body, photos: put, status: "held", how: "noaccess" }))) await db.remove(put.map((p) => p.path));
      }
      return answer(flow.reply);
    }
  }

  // what this phone sent in the last ten minutes: one phone often splits five
  // pictures into five texts, and only one of them carries the PO. (A door
  // picture waiting for its number is not part of any send.)
  let burst = (await db.get<Batch>(`texted_photos?${emp ? `employee_id=eq.${emp.id}` : `from_phone=eq.${enc(from)}`}&status=in.(held,filed)&created_at=gte.${since(BURST_MS)}&order=created_at.asc&select=*`)).rows
    .filter((b) => b.how !== "noaccess");
  // pictures from a phone nobody knows: kept for the office, a few sends a day
  // at most, but a send already under way keeps its pieces (up to ten)
  if (!emp) {
    const lately = await db.get<{ id: string }>(`texted_photos?employee_id=is.null&status=eq.held&created_at=gte.${since(86_400_000)}&select=id&limit=6`);
    if (!lately.ok) return answer();
    const firstPiece = burst.find((b) => b.status === "held");
    const underWay = !!firstPiece && now.getTime() - (Date.parse(firstPiece.created_at || "") || 0) <= BURST_MS && burst.length < 10;
    if (lately.rows.length >= 5 && !underWay) return answer();
  }
  // a text in between (the square feet, a "no") ends a send: pictures after
  // it are a new send, not the tail of the one before (an AFTER said about
  // the send doesn't: its next piece is the same send's)
  if (emp && burst.length) {
    // (a text of theirs, not a row the portal wrote for itself, which has no message id)
    const talk = (await db.get<{ created_at?: string | null }>(`texted_photos?employee_id=eq.${emp.id}&status=in.(measure,note,nobody,reply,seen,opened,moved,done)&msg_sid=not.is.null&or=(how.is.null,how.neq.afterflip)&created_at=gte.${since(BURST_MS)}&order=created_at.desc&select=created_at&limit=1`)).rows[0];
    if (talk?.created_at) burst = burst.filter((b) => (b.created_at || "") > talk.created_at!);
  }
  let pick: ReturnType<typeof pickJob> = { kind: "ask", why: "none" };
  let ignore: string[] = [];
  let todays: JobKey[] = [];
  if (emp) {
    const { rows, mine } = jobs;
    const anyPo = await anyPoOf(db, body, mine);
    pick = withHint(pickJob(body, rows, mine, today, anyPo, { photos: true }), mine, inb.jobHint, rows, today);
    // pictures posted in one job's thread are that job's, not the one texted last (still a guess for finished work)
    if (pick.kind !== "ask" && pick.why === "told" && inb.jobHint && inb.jobHint.id !== pick.id && todayIds.has(inb.jobHint.id)) {
      const h = mine.find((k) => k.kind === inb.jobHint!.kind && k.id === inb.jobHint!.id);
      if (h) pick = { kind: h.kind, id: h.id, label: h.label, street: h.street, apt: h.apt, why: "told" };
    }
    ignore = [...mine, ...anyPo].flatMap((j) => j.keys);
    todays = mine.filter((k) => todayIds.has(k.id));
  }
  // no number in this one, but the send it's part of named the job (or went
  // on the job an AFTER was asked for): the same job
  // (a number that fits nothing is never guessed past: the office sorts it)
  let how = pick.kind === "ask" ? "" : pick.why === "number" ? "number" : "day";
  const named = (k: ReturnType<typeof pickJob>) => (k.kind === "ask" ? k.why !== "unknown" : k.why !== "number");
  if (named(pick)) {
    const lead = [...burst].reverse().find((b) => b.status === "filed" && ["number", "burst", "window", "aftersaid"].includes(b.how || "") && (b.pact_job_id || b.release_id));
    const t = lead ? await targetOf(db, lead) : null;
    if (t && lead) { pick = { ...t, why: "number" }; how = lead.how === "window" || lead.how === "aftersaid" ? lead.how : "burst"; }
  }
  // which pile: BEFORE, unless they say AFTER (lib/jobFlow photoKindFor): the
  // word with them, AFTER texted just before (or a DONE answered by asking for
  // them), or the send they're in the middle of
  let win = emp ? await afterWindow(db, emp.id, now) : null;
  // (a window for a job that isn't one of today's, while they have one today: only for the photos sent right away)
  if (win && win.jobId && todayIds.size && !todayIds.has(win.jobId) && now.getTime() - win.at > ELSEWHERE_WINDOW_MS) win = null;
  // the job the answer named ("OK: the photos you send now go in AFTER at …",
  // "Send the photos of the finished work at …"): photos that name no job go there
  if (win && win.jobId && emp && named(pick)) {
    const w = win;
    const k = jobs.mine.find((x) => x.id === w.jobId) || (await targetOf(db, { id: "", pact_job_id: w.kind === "pact" ? w.jobId : null, release_id: w.kind === "rel" ? w.jobId : null }));
    if (k) { pick = { kind: k.kind, id: k.id, label: k.label, street: k.street, apt: k.apt, why: "number" }; how = w.how === "afterwait" ? "window" : "aftersaid"; }
  }
  let target = pick.kind === "ask" ? null : pick;
  const batchId = randomUUID();
  let thread: ThreadJob | null = target && target.kind === "pact" ? await threadJob(db, target.id) : null;
  const onTarget = (b: Batch) => !!target && (target.kind === "pact" ? b.pact_job_id === target.id : b.release_id === target.id);
  // this one named the job: the ones before it that were waiting go there too,
  // and the pieces of this same send the day's guess (or an AFTER's job) put on
  // another job a moment ago (the PO rode on the last piece)
  const strays = how === "number" ? burst.filter((b) => b.status === "held" || (b.status === "filed" && ["day", "window", "aftersaid"].includes(b.how || "") && !onTarget(b) && now.getTime() - msOf(b) <= SPLIT_MS)) : [];
  // the send's last piece: on this job, waiting, or coming over with this one
  const lastOfSend = [...burst].reverse().find((b) => (b.photos || []).length && (!target || b.status === "held" || onTarget(b) || strays.includes(b)));
  // a DONE a moment ago, answered by asking for the after photos, and nothing
  // on the job's day from an hour before: the phone sent these with the DONE
  // ("done sending", maybe). They stay BEFORE, and they're asked
  let askAfter = false;
  // (AFTER they texted is about the next send, wherever it goes; the after
  // photos the portal asked for after a DONE are that job's, not another's)
  let afterAsked = !!win && (win.how !== "afterwait" || !win.jobId || (!!target && target.id === win.jobId));
  if (win && win.how === "afterwait" && now.getTime() - win.at < DONE_SENT_MS && target && !captionKind(body) && (await arrivalOnly(db, target, thread, now.getTime(), today))) { afterAsked = false; askAfter = true; }
  let kind: PhotoKind = photoKindFor(body, { afterAsked, burst: lastOfSend ? kindOfName(lastOfSend.photos![0].name) : null });
  // held instead of guessed: "which job?", with the jobs it could be by name
  let holdFor: JobKey[] = [];
  if (thread && target && pick.kind !== "ask") {
    // finished work on a job picked by a guess (the job texted last, the
    // thread's own) never marks it done: the worker says which
    if (pick.why === "told" && kind === "after" && todays.length > 1) holdFor = todays;
    // finished work (they said AFTER) on their one job today, while a job of
    // theirs from the last few days was left open: it could be that one's
    else if (emp && kind === "after" && pick.why === "today" && how === "day") {
      const open = await openElsewhere(db, emp.id, target.id, now, today);
      if (open.length) holdFor = [{ kind: target.kind, id: target.id, label: target.label, street: target.street, apt: target.apt, keys: [] }, ...open];
    }
  }
  if (holdFor.length) { target = null; thread = null; }
  // into the job's folder for that pile (pact/<job>/before/, …/after/), or the inbox while it waits
  const dir = target ? pileDir(target, kind) : inboxOf(batchId);
  const put = await store(dir, kind);
  // a picture that didn't come through is said, by count, with whatever did,
  // even in a quiet piece; a phone nobody knows reads it in both languages
  const lostLine = (n: number) => (emp ? replyText({ k: "lost", n }, lang) : `${replyText({ k: "lost", n }, "en")} / ${replyText({ k: "lost", n }, "es")}`);
  if (put.length === 0) return answer(lostLine(photos.length));
  const lost = photos.length - put.length;
  const lostNote = lost > 0 ? lostLine(lost) : "";
  const said = (msg: string) => answer(lostNote ? `${msg}\n${lostNote}` : msg);
  const hush = () => answer(lostNote || undefined);

  const row = { id: batchId, employee_id: emp?.id || null, from_phone: from, body, photos: put, msg_sid: sid || null };
  // one answer per burst: the first text gets it, the rest go quietly, unless
  // a later one carries a number, and then it says where they all went; or
  // changes pile ("before" after after pictures), and then it says so
  const lastKind = (() => { const last = [...burst].reverse().find((b) => b.status === "filed" && (b.photos || []).length); return last ? kindOfName(last.photos![0].name) : null; })();
  const quietFor = (k: PhotoKind) => burst.length > 0 && refsIn(body).length === 0 && (!lastKind || lastKind === k);
  let quiet = quietFor(kind);
  // AFTER texted while these were on their way (the phone sent the word and
  // the pictures as two texts, both at once): these are the after pictures
  const lateAfter = async (): Promise<boolean> => {
    if (!emp || kind !== "before" || captionKind(body) || askAfter) return false;
    const late = (await db.get<{ id: string }>(`texted_photos?employee_id=eq.${emp.id}&how=in.(aftersay,afterwait,afterflip)&created_at=gte.${enc(new Date(now.getTime() - 2_000).toISOString())}&select=id&limit=1`)).rows.length > 0;
    if (late) await closeWindows(db, emp.id, now);
    return late;
  };
  if (target) {
    if (!(await db.attach(target, put, []))) {
      // the job went away between the lookup and now: keep them for the office
      const inbox = inboxOf(batchId);
      const kept: Photo[] = [];
      for (const p of put) if (await db.move(p.path, inbox + p.name)) kept.push({ name: p.name, path: inbox + p.name });
      if (!(await db.insert("texted_photos", { ...row, photos: kept, status: "held", ...(kind === "after" ? { how: "after" } : {}) }))) await db.remove(kept.map((p) => p.path));
      return quiet ? hush() : said(replyText({ k: "held", n: put.length, v: countOf(put.map((p) => p.name)).v }, lang));
    }
    await db.insert("texted_photos", { ...row, status: "filed", how, ...jobCols(target) });
    if (await lateAfter()) {
      const mine = (await db.get<Batch>(`texted_photos?id=eq.${batchId}&select=*`)).rows[0];
      if (mine && (await fileBatch(db, mine, target, how, "after"))) {
        kind = "after";
        quiet = quietFor(kind);
        const moved = (await db.get<{ photos?: Photo[] | null }>(`texted_photos?id=eq.${batchId}&select=photos`)).rows[0]?.photos;
        if (moved?.length) put.splice(0, put.length, ...moved);
      }
    }
    // they got in after all (a co-worker's "nobody home" this morning): the warning comes off
    if (emp) await doorOpened(db, target, emp, now, today);
    let moved = 0;
    if (strays.length) {
      const leaving = [...new Set(strays.filter((b) => b.status === "filed" && b.pact_job_id).map((b) => b.pact_job_id as string))];
      for (const b of strays) moved += await fileBatch(db, b, target, "number", kind);
      for (const id of leaving) await clearDoneIfNoAfter(db, id, jobName(target, "en"), now, today, strays.some((b) => b.pact_job_id === id && wasAfter(b)));
    }
    // AFTER said on this piece: the pieces of the same send a moment before,
    // on this job with nothing said, are the after pictures too
    if (kind === "after" && captionKind(body) === "after") {
      for (const b of burst) {
        if (b.status === "filed" && onTarget(b) && now.getTime() - msOf(b) <= SPLIT_MS && !captionKind(b.body || "") && namesIn([b]).every((x) => kindOfName(x) === "before")) moved += await fileBatch(db, b, target, b.how || how, "after");
      }
    }
    // the count: this piece and the send's pieces on this job and pile (read back: some just moved)
    const ids = [...new Set([batchId, ...burst.map((b) => b.id)])];
    const back = (await db.get<Batch>(`texted_photos?id=in.(${ids.join(",")})&select=id,status,photos,pact_job_id,release_id`)).rows;
    const counted = namesIn(back.filter((b) => b.status === "filed" && onTarget(b))).filter((x) => kindOfName(x) === kind);
    const c: MediaCount = countOf(counted.length ? counted : put.map((p) => p.name));
    // and once the send has settled, the newest piece texts the whole count if its answer didn't
    const settle = (saidC: MediaCount) => { if (emp) waitUntil(settleBurst(db, { emp, batchId, target: target!, kind, said: saidC, lang, from, now, deliver: inb.deliver })); };
    const none: MediaCount = { n: 0, v: 0 };
    const name = jobName(target, lang);
    if (askAfter) { settle(c); return said(gotBeforeAskText(c, name, lang)); }
    if (thread) {
      // square feet the worker sent with the pictures on their own ("plaster
      // 120 sf" + a photo; nobody asks for them). A bare number with pictures
      // is how many pictures, never square feet. Words about square feet the
      // portal can't read go to the office; the crew is never asked.
      const lines = measureLines(itemsOf(thread));
      const parsed = emp ? parseMeasures(body, lines, false, { ignore }) : { kind: "none" as const };
      const measured = parsed.kind === "ok" && !billed(thread) ? await measureOnJob(db, thread, parsed.hits, { emp: emp!, body, from, sid: "", now }) : null;
      if (parsed.kind === "ask" && emp) await putRow(db, { employee_id: emp.id, from_phone: from, body, status: "reply", how: "measure", photos: [], pact_job_id: thread.id });
      const asked = parsed.kind === "ok" && billed(thread) ? invoicedText(name, lang) : "";
      const said2: Said | null = emp ? { emp, emps: emps.rows, body, from, sid: "", now, today, hint: inb.jobHint } : null;
      // "not done, coming back tomorrow" with the pictures (after the morning):
      // never marked done; it runs one more work day ("llegamos, todavía no
      // empezamos" with the arrival pictures is just the arrival)
      if (said2 && notDoneStrong(body) && nyHour(now) >= 11) {
        settle(c);
        const got = gotPhotosText(c, kind, name, lang);
        const cont = await notDoneIn(db, said2, thread);
        return said(`${got} ${cont}`);
      }
      // after pictures: on the job's last day the job is work done, ready to
      // invoice; on a day before it, the day is done and it goes on
      const L = onLastDay(thread, today);
      if (kind === "after" && emp) await closeQuestion(db, thread.id);
      // ("all done" with them on a day before its last: finished early, the days after come off)
      if (said2 && kind === "after" && L.before && allDoneSaid(body)) {
        const d = await doneIn(db, said2, "all", thread);
        if (d) { settle(c); return said(`${gotPhotosText(c, kind, name, lang)} ${d}`); }
      }
      // ("kitchen done, starting the bathroom": finished work, maybe not the job: they're asked)
      const mixed = kind === "after" && !L.before && mixedCaption(body);
      const marked = kind === "after" && emp && !L.before && !mixed && !notDone(body) ? await markDone(db, thread, emp, { from, now, finish: dayPile(thread, today).cur }) : false;
      if (quiet && !moved && !measured && !marked && !asked) { settle(none); return hush(); }
      settle(c);
      // the thread's next step: the after pictures after the before pictures
      if (measured) return said(gotBothText(kind, c, name, measured.changes, lang, marked, lost));
      const next = kind === "before" ? gotBeforeText(c, name, lang)
        : L.before ? gotAfterDayText(c, name, { day: L.day, of: L.of, next: L.next, today }, lang, lost)
        : mixed ? `${gotPhotosText(c, kind, name, lang)} ${finishedAskText(lang)}`
        : gotAfterText(c, name, lang, marked, lost);
      // (finished work on a job only the day's guess picked, of two: how to move it)
      const guess = kind === "after" && pick.kind !== "ask" && pick.why === "told" ? ` ${WRONG_JOB[langOf(lang)]}` : "";
      return said(asked ? `${next}\n${asked}` : `${next}${guess}`);
    }
    if (quiet && !moved) { settle(none); return hush(); }
    settle(c);
    return said(replyText({ k: "filed", n: c.n, v: c.v, label: name, kind }, lang));
  }
  // nowhere to put them yet: they wait for the office (or for the number the
  // answer asks for), unless there's no place to keep them waiting (RUN_ME
  // section 20 not run), and then the worker is asked to send them again with the number
  // (an AFTER said with them, or texted just before, stays with them while they wait)
  if (!(await db.insert("texted_photos", { ...row, status: "held", ...(kind === "after" ? { how: "after" } : {}) }))) {
    await db.remove(put.map((p) => p.path));
    return say({ k: "resend" }, lang);
  }
  // (AFTER texted while they were on their way: they're the after pictures, wherever they go)
  if (await lateAfter()) { kind = "after"; await db.patch(`texted_photos?id=eq.${batchId}`, { how: "after" }); }
  if (quiet) return hush();
  const pc = countOf(put.map((p) => p.name));
  if (!emp) return said(replyText({ k: "stranger", n: pc.n, v: pc.v }));
  if (holdFor.length) return said(replyText({ k: "which", n: pc.n, v: pc.v, options: holdFor.slice(0, 3).map((k) => optionOf(k, lang)) }, lang));
  return said(replyText(pick.kind === "ask" && pick.why === "unknown" ? { k: "unknown", number: pick.number || "", n: pc.n, v: pc.v } : { k: "held", n: pc.n, v: pc.v }, lang));
}

// a PACT job of this worker's from the last few days that was left open: its
// last work day has passed, it has before pictures and no after pictures for
// that day, and it isn't marked done. (This worker sent pictures of it; the
// morning asked the crew about it; nobody answered yet.)
async function openElsewhere(db: Db, empId: string, notId: string, now: Date, today: string): Promise<JobKey[]> {
  const since = enc(new Date(now.getTime() - 4 * 86_400_000).toISOString());
  const rows = (await db.get<{ pact_job_id?: string | null; created_at?: string | null }>(`texted_photos?employee_id=eq.${empId}&status=eq.filed&pact_job_id=not.is.null&created_at=gte.${since}&select=pact_job_id,created_at&order=created_at.desc&limit=40`)).rows;
  // already sending pictures of this job today: they're here
  if (rows.some((r) => r.pact_job_id === notId && r.created_at && nyDay(new Date(r.created_at)) === today)) return [];
  const ids = [...new Set(rows.filter((r) => r.pact_job_id !== notId && r.created_at && nyDay(new Date(r.created_at)) < today).map((r) => r.pact_job_id as string))].slice(0, 3);
  const out: JobKey[] = [];
  for (const id of ids) {
    const j = await threadJob(db, id);
    if (!j || j.work_done || j.canceled) continue;
    const days = workDaysOf(j.start_date, j.work_days);
    const last = days[days.length - 1];
    if (!last || last >= today) continue;
    const p = dayPile(j, today);
    if (p.beforeN > 0 && p.afterN === 0) out.push(keyOf(j));
  }
  return out;
}
// after their "no", the portal sent them on to a job at the same street (4B, then 7C upstairs): their next pictures may be of it
async function sentNextDoor(db: Db, empId: string, door: { kind: "pact" | "rel"; id: string }, after: string): Promise<boolean> {
  const sent = (await db.get<{ pact_job_id?: string | null; release_id?: string | null }>(`texted_photos?employee_id=eq.${empId}&status=eq.note&how=eq.nobody&created_at=gte.${enc(after || new Date(0).toISOString())}&select=pact_job_id,release_id&order=created_at.desc&limit=1`)).rows[0];
  const to = sent?.pact_job_id ? { kind: "pact" as const, id: sent.pact_job_id } : sent?.release_id ? { kind: "rel" as const, id: sent.release_id } : null;
  if (!to || to.id === door.id) return false;
  const street = async (t: { kind: "pact" | "rel"; id: string }) => {
    const r = t.kind === "pact"
      ? (await db.get<{ address?: string | null; development?: string | null }>(`pact_jobs?id=eq.${t.id}&select=address,development`)).rows[0]
      : (await db.get<{ address?: string | null; location?: string | null }>(`releases?id=eq.${t.id}&select=address,location`)).rows[0] as { address?: string | null; development?: string | null } | undefined;
    return (((r?.address || r?.development || "") as string).split(",")[0] || "").toLowerCase().replace(/\s+/g, " ").trim();
  };
  const [a, b] = await Promise.all([street(door), street(to)]);
  return !!a && a === b;
}
// photos from a job someone texted "nobody home" about today: somebody got in.
// The ⚠ comes off, and the notice says so
async function doorOpened(db: Db, t: Target, emp: Emp, now: Date, today: string): Promise<void> {
  const col = t.kind === "pact" ? "pact_job_id" : "release_id";
  // (the reporter's own picture of the door, right after their "no", went on the notice: these are work pictures)
  const open = (await db.get<{ id: string; note?: string | null; created_at?: string | null }>(`texted_photos?${col}=eq.${t.id}&status=eq.nobody&select=id,note,created_at&limit=5`)).rows
    .filter((n) => n.created_at && nyDay(new Date(n.created_at)) === today);
  const when = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(now);
  for (const n of open) {
    const note = `${(n.note || "").trim()}${(n.note || "").trim() ? " · " : ""}${firstName(emp) || "The crew"} got in at ${when} and sent photos`;
    // "opened": off the calendar and the card like a seen one, but the morning still asks whether it got finished
    if (!(await db.patch(`texted_photos?id=eq.${n.id}`, { status: "opened", note }))) await db.patch(`texted_photos?id=eq.${n.id}`, { status: "opened" });
  }
}
