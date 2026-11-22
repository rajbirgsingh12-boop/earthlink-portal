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
  pickJob, pactKey, relKey, photoName, phoneKey, refsIn, justANumber, noPlace, replyText, dayMinus,
  type JobKey, type MediaIn, type MineRow, type Reply,
} from "@/lib/smsIn";
import { fileBatch, holdBatch, inboxOf, pileDir, type Batch, type Db, type FileOut, type Photo, type Target } from "@/lib/photoStore";
import { countOf, isMediaName, mediaWords, type MediaCount } from "@/lib/media";
import { bareNo, byAddress, noAt, nobodyHome, numbersIn, toldOfficeText } from "@/lib/noAccess";
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
import { AFTER_HOW, atJob, jobName, langOf } from "@/lib/crewText";
import { addWorkDays, currentWorkDay, workDaysOf } from "@/lib/workDays";
import { bookPrice } from "@/lib/priceServer";
import { roomsIn } from "@/lib/priceBook";
import { workLines, paperworkRepair } from "@/lib/paperwork";
import type { SfLine } from "@/lib/measure";

const env = (k: string) => process.env[k] || "";
// the answer to the worker: a string, or nothing (the channel sends it)
const answer = (msg?: string): string | undefined => msg || undefined;
const say = (r: Reply, lang?: string | null) => answer(replyText(r, lang));
// how a text goes back to the worker later (the settled count, the nobody-home answer): one-to-one, or into the thread it came from
// (`job`: the job the text sends them on to: a crew's thread is about it from then on)
export type Deliver = (to: string, body: string, who?: string, job?: { kind: "pact" | "rel"; id: string }) => Promise<boolean>;
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
  // (one with a dash or a letter in it, "220011-2", "A220011", is looked up by its digits: the portal keeps it as typed)
  const digits = [...(body || "").matchAll(/(\d{4,12})-[\dA-Za-z]|\b[A-Za-z](\d{4,11})\b/g)].map((m) => (m[1] || m[2]).replace(/^0+(?=\d)/, ""));
  const want = [...new Set([...refsIn(body).filter((r) => (r.said ? r.n.length >= 3 : r.n.length >= 5) && /^\d+$/.test(r.n)).map((r) => r.n), ...digits])].filter((n) => !mine.some((j) => j.keys.includes(n)));
  if (!want.length) return [];
  const found = await Promise.all(want.slice(0, 3).map((n) =>
    db.get<PactRow>(`pact_jobs?or=(po_number.ilike.*${n}*,job_number.ilike.*${n}*)&canceled=not.is.true&select=${PACT_KEY_COLS}&limit=20`)));
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
      // wrote for itself doesn't, and neither does an AFTER said about this
      // send (pictures more than a minute and a half after it are a new send)
      if (!isPiece(b)) { if (b.msg_sid && (!SAID_ABOUT.has(b.how || "") || msOf(rows[start]) - msOf(b) > FRESH_MS)) break; continue; }
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
// a word about the send just made (their AFTER that moved it, the portal's
// question about it): pictures up to a minute and a half after it are still
// that send, later ones a new one
const SAID_ABOUT = new Set(["afterflip", "afterask"]);
const isEs = (l?: string | null) => !!l && /^(es|spa|esp)/i.test(l);
const namesIn = (bs: { photos?: Photo[] | null }[]): string[] => bs.flatMap((b) => (b.photos || []).map((p) => p?.name || "")).filter(Boolean);
// a row's job columns: a PACT job's id, or a job of either kind
const jobCols = (job?: string | { kind: "pact" | "rel"; id: string } | null): Record<string, string> => (!job ? {} : typeof job === "string" ? { pact_job_id: job } : job.kind === "pact" ? { pact_job_id: job.id } : { release_id: job.id });

// (`named`: the AFTER said its job's number; `marked`: the DONE that opened it
// marked the job done; `movedOn`: their photos landed on another job since,
// so only photos they caption AFTER are its; `movedAny`: any did, even right
// after the word, so a piece naming another job by its number isn't its)
interface Win { id: string; jobId: string; kind: "pact" | "rel" | ""; how: string; at: number; empId: string; named: boolean; marked: boolean; movedOn: boolean; movedAny: boolean }
// the open window, if any: the job it's for (none: whichever job the photos
// land on). In a crew's thread (`threadJob`), also the one a co-worker opened
// on the thread's job (their AFTER, or their DONE the portal asked the photos for)
async function afterWindow(db: Db, empId: string, now: Date, threadJob?: string): Promise<Win | null> {
  type W = { id: string; employee_id?: string | null; pact_job_id?: string | null; release_id?: string | null; created_at?: string | null; how?: string | null; note?: string | null };
  const recent = enc(new Date(now.getTime() - AFTER_WINDOW_MS).toISOString());
  const open = async (who: string, closedBy: (w: W) => string): Promise<Win | null> => {
    const w = (await db.get<W>(`texted_photos?${who}&how=in.(aftersay,afterwait)&status=eq.note&created_at=gte.${recent}&select=id,employee_id,pact_job_id,release_id,created_at,how,note&order=created_at.desc&limit=1`)).rows[0];
    if (!w?.created_at) return null;
    // the send it was for came in already: a later send is BEFORE again (its
    // own pieces stay with it as one send). Pictures another job's number or
    // BEFORE put on that job, untouched by it, weren't its send (but they've
    // moved on); nor were pictures they captioned BEFORE
    const job = w.pact_job_id || w.release_id || "";
    const rows = (await db.get<Batch>(`texted_photos?${closedBy(w)}&status=in.(held,filed)&created_at=gt.${enc(w.created_at)}&select=id,how,status,photos,pact_job_id,release_id,body,created_at&limit=10`)).rows
      .filter((b) => b.how !== "noaccess");
    const elsewhere = (b: Batch) => !!job && b.status === "filed" && (b.pact_job_id || b.release_id) !== job && namesIn([b]).every((x) => kindOfName(x) !== "after");
    const since = rows.filter((b) => !elsewhere(b) && captionKind(b.body || "") !== "before");
    // (pictures on another job within two minutes of the word were sent from
    // where they said it: they show they've moved on only once the photos
    // sent right away are past, as for yesterday's window; later ones at once)
    const movedOn = rows.some((b) => elsewhere(b) && (msOf(b) - msOf(w) > DONE_SENT_MS || now.getTime() - msOf(w) > ELSEWHERE_WINDOW_MS));
    return since.length ? null : { id: w.id, jobId: job, kind: w.pact_job_id ? "pact" : w.release_id ? "rel" : "", how: w.how || "", at: msOf(w), empId: w.employee_id || empId, named: w.note === "named", marked: w.note === "marked", movedOn, movedAny: rows.some(elsewhere) };
  };
  const mine = await open(`employee_id=eq.${empId}`, () => `employee_id=eq.${empId}`);
  if (mine || !threadJob) return mine;
  const onJob = `pact_job_id.eq.${threadJob},release_id.eq.${threadJob}`;
  return open(`or=(${onJob})`, (w) => `or=(${w.employee_id ? `employee_id.eq.${w.employee_id},` : ""}${onJob})`);
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
  src: { empId?: string; jobId?: string };  // how it was read (to read it again)
}
// (`until`: the send as it stood then: the one a question asked about)
async function justSent(db: Db, o: { empId?: string; jobId?: string; now: Date; until?: number }): Promise<Sent | null> {
  const since = enc(new Date(o.now.getTime() - 2 * 3_600_000).toISOString());
  const who = o.jobId ? `or=(pact_job_id.eq.${o.jobId},release_id.eq.${o.jobId})&status=in.(held,filed)` : `employee_id=eq.${o.empId}&status=in.(held,filed,measure,note,nobody,reply,seen,opened,moved,done)`;
  const upTo = o.until ? `&created_at=lte.${enc(new Date(o.until).toISOString())}` : "";
  const rows = (await db.get<SendRow>(`texted_photos?${who}&created_at=gte.${since}${upTo}&order=created_at.desc&select=*&limit=60`)).rows;
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
      // (pictures more than a minute and a half after that AFTER are a new send)
      if (isBatch(b) || (b.msg_sid && (!SAID_ABOUT.has(b.how || "") || msOf(first) - msOf(b) > FRESH_MS))) break;
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
    src: o.jobId ? { jobId: o.jobId } : { empId: o.empId },
  };
}
// held photos they said AFTER (or DONE) about: in AFTER, whichever job they
// go on ('afterall': ALL DONE, so the job they go on ends early there too)
const HELD_AFTER = ["after", "afterall"];
const saidAfterHeld = (b: Batch) => b.status === "held" && HELD_AFTER.includes(b.how || "");
// (one another request is putting on a job that moment, the office's, keeps
// that request's claim and is waited for: false when one is on a job now)
const markHeldAfter = async (db: Db, s: Sent, how: "after" | "afterall" = "after"): Promise<boolean> => {
  let waiting = true, waits = 0;
  for (const b of s.pieces) {
    for (;;) {
      // (an ALL DONE said already stays one)
      const r = await db.patchRows<Batch>(`texted_photos?id=eq.${b.id}&status=eq.held&or=(how.is.null,how.not.in.(moving${how === "after" ? ",afterall" : ""}))`, { how });
      if (!r.ok || r.rows.length) break;
      const cur = (await db.get<Batch>(`texted_photos?id=eq.${b.id}&select=status,how`)).rows[0];
      if (!cur || cur.status !== "held") { waiting = false; break; }
      if (cur.how !== "moving") break;
      // (six seconds in all, as a claim is waited for; one still there then was
      // left by a request that went away, as claimBatch takes it: the word goes over it)
      if (++waits > 30) { if ((await db.patchRows<Batch>(`texted_photos?id=eq.${b.id}&status=eq.held&how=eq.moving`, { how })).rows.length || waits > 32) break; continue; }
      await sleep(200);
    }
  }
  return waiting;
};
// the held send marked so, or, put on a job that moment by the office, its own
// pieces as they are now (never other pictures on that job): the caller
// decides again where they are. Some put on a job while the rest still wait:
// those go in AFTER where they are, and the send is the ones still waiting
const heldOrPlaced = async (db: Db, s: Sent, how: "after" | "afterall" = "after"): Promise<Sent> => {
  if (await markHeldAfter(db, s, how)) return s;
  const rows = (await db.get<SendRow>(`texted_photos?id=in.(${s.pieces.map((b) => b.id).join(",")})&order=created_at.desc&select=*`)).rows;
  const held = rows.filter((b) => b.status === "held");
  const placed = rows.filter((b) => b.status === "filed" && (b.photos || []).length);
  const isBefore = (b: SendRow) => namesIn([b]).some((n) => kindOfName(n) === "before");
  const jobOf = (b: SendRow) => b.pact_job_id || b.release_id || "";
  // (none waiting: the send is on the job its newest piece went on; a piece put on another job goes in AFTER there)
  const main = held.length ? held : placed.filter((b) => jobOf(b) === jobOf(placed[0]));
  for (const b of placed.filter((x) => !main.includes(x) && isBefore(x))) { const t = await targetOf(db, b); if (t) await fileBatch(db, b, t, b.how || "day", "after"); }
  return main.length ? { ...s, pieces: main, held: held.length > 0, newest: msOf(main[0]), oldest: msOf(main[main.length - 1]), before: main.filter(isBefore) } : s;
};
// held photos they said ALL DONE about (and were asked "which job?"), when
// that is still the last thing they texted, two days at most: the send as it was then
async function heldAllAsked(db: Db, o: Said): Promise<Sent | null> {
  const since = enc(new Date(o.now.getTime() - 2 * 86_400_000).toISOString());
  const last = (await db.get<SendRow>(`texted_photos?employee_id=eq.${o.emp.id}&msg_sid=not.is.null&created_at=gte.${since}&order=created_at.desc&limit=1&select=id,status,how,body,pact_job_id,release_id,created_at`)).rows[0];
  const all = (b: Batch) => saidAfterHeld(b) && (b.how === "afterall" || allDoneSaid(b.body || ""));
  // (their ALL DONE about them: the row its answer left, with no job; or the words on a
  // piece of the send: a phone that splits it puts them on one piece; none captioned BEFORE)
  if (!last?.created_at || !((last.how === "afterflip" && !last.pact_job_id && !last.release_id) || (last.status === "held" && last.how !== "noaccess"))) return null;
  const s = await justSent(db, { empId: o.emp.id, now: new Date(msOf(last)), until: msOf(last) });
  return s && s.held && !s.saidBefore && s.pieces.some(all) ? s : null;
}
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
const optionOf = (k: JobKey, lang?: string | null) => { const place = jobName({ ...k, label: "" }, lang); return `${(k.label.match(/[A-Za-z]?\d[\w-]*$/) || [k.label])[0]}${place ? ` (${place})` : ""}`; };
// the job a text names by its number ("AFTER 116843", "116843 done"): one of theirs, or any PO in the portal
// ("unknown": the number said fits none of them)
async function namedJob(db: Db, o: Said): Promise<JobKey | "unknown" | null> {
  const refs = jobRefsOnly(o.body);
  if (!refs) return null;
  const { rows, mine } = await jobsOf(db, o.emp, o.today);
  const anyPo = await anyPoOf(db, refs, mine);
  const pick = pickJob(refs, rows, mine, o.today, anyPo);
  if (pick.kind === "ask" && pick.why === "unknown") return "unknown";
  return pick.kind !== "ask" && pick.why === "number" ? [...mine, ...anyPo].find((k) => k.id === pick.id) || null : null;
}

// (`already`: the photos' own request had just moved them, and it answers them)
interface Flip { text: string; c: MediaCount; t: Target; thread: ThreadJob | null; asked?: boolean; guessed?: boolean; already?: boolean }
// AFTER (or DONE) right after a send with nothing said: it moves to AFTER, and
// on the job's last day the job is marked work done ("all": ALL DONE, which
// the caller finishes). DONE right after the arrival photos can be "done
// sending": nothing moves, and they're asked. On a job only the day's guess
// picked (two jobs that day) they hear how to move them, and an ALL DONE ends
// nothing early: the day's reply asks for it again
async function flipToAfter(db: Db, o: Said, s: Sent, why: "after" | "done" | "all"): Promise<Flip | null> {
  const t = await targetOf(db, s.pieces[0]);
  if (!t) return null;
  const thread = t.kind === "pact" ? await threadJob(db, t.id) : null;
  const lang = o.emp.lang;
  const name = jobName(t, lang);
  const c = countOf(namesIn(s.pieces));
  // (a co-worker's, in the crew's thread)
  const who = s.empId && s.empId !== o.emp.id ? firstName(o.emps.find((e) => e.id === s.empId)) : "";
  if (why === "done" && (await arrivalOnly(db, t, thread, s.oldest, o.today))) {
    // (the row says what was asked: a "yes" to it is an AFTER)
    await remember(db, o, "afterask", t);
    const one = c.n === 1;
    const text = isEs(lang)
      ? `Entendido. Si lo que ${who ? `${who} acaba` : "acaba"} de mandar ${atJob(name, "es")} es el trabajo terminado, responda DESPUES.`
      : `Got it. If the ${one ? (c.v ? "video" : "photo") : mediaWords(c, "en")} ${who || "you"} just sent ${atJob(name, "en")} ${one ? "is" : "are"} the finished work, reply AFTER.`;
    return { text, c, t, thread, asked: true };
  }
  // (the word first: a piece of the send landing while these move sees it)
  await remember(db, o, "afterflip", t);
  const r = await intoAfter(db, s, t);
  if (s.before.length && !r.moved) return null;
  if (r.already) return { text: "", c, t, thread, already: true };
  // a piece of the same send that landed while these moved (a phone splits a
  // video off) follows them, and the answer counts it
  const all = [...s.pieces];
  for (let i = 0; i < 3; i++) {
    const again = await justSent(db, { ...s.src, now: new Date() });
    if (!again || again.held || !again.pieces.some((p) => p.id === s.pieces[0].id)) break;
    const late = again.before.filter((b) => !all.some((x) => x.id === b.id) && (b.pact_job_id || b.release_id) === t.id && !captionKind(b.body || ""));
    if (!late.length) break;
    if (!(await intoAfter(db, { ...again, before: late }, t)).moved) break;
    all.push(...late);
  }
  if (all.length > s.pieces.length) Object.assign(c, countOf(namesIn(all)));
  // on a job only the day's guess picked, of two that day: they hear how to move them
  const hint = s.pieces.some((b) => b.how === "day") && (await todaysJobs(db, o.emp, o.today)).length > 1;
  if (!thread) return { text: flippedText(c, name, lang, false, { hint, who }), c, t, thread, guessed: hint };
  await closeQuestion(db, thread.id);
  if (why === "all" && !hint) return { text: flippedText(c, name, lang, false, { thanks: false, who }), c, t, thread };
  const L = onLastDay(thread, o.today);
  if (L.before) return { text: `${gotAfterDayText(c, name, { day: L.day, of: L.of, next: L.next, today: o.today }, lang)}${hint ? ` ${WRONG_JOB[langOf(lang)]}` : ""}`, c, t, thread, guessed: hint };
  const caption = s.pieces.map((b) => b.body || "").join(" ");
  const marked = !notDone(caption) && !mixedCaption(caption) ? await markDone(db, thread, o.emp, { from: o.from, now: o.now, finish: dayPile(thread, o.today).cur }) : false;
  return { text: flippedText(c, name, lang, marked, { hint, who }), c, t, thread, guessed: hint };
}
// the portal's "If they're the finished work, reply AFTER" (how 'afterask'),
// still open: the last quarter hour, with nothing said since but pictures. In
// a crew's thread, one asked about the thread's job, whoever's DONE it answered
type Ask = { id: string; at: number; empId: string; job: { kind: "pact" | "rel"; id: string } | null };
async function openAsk(db: Db, empId: string, now: Date, threadId?: string): Promise<Ask | null> {
  type A = { id: string; employee_id?: string | null; pact_job_id?: string | null; release_id?: string | null; created_at?: string | null };
  const who = (also = "") => (threadId ? `or=(employee_id.eq.${empId},${also}pact_job_id.eq.${threadId},release_id.eq.${threadId})` : `employee_id=eq.${empId}`);
  const a = (await db.get<A>(`texted_photos?${who()}&how=eq.afterask&status=eq.note&created_at=gte.${enc(new Date(now.getTime() - FLIP_MS).toISOString())}&order=created_at.desc&limit=1&select=id,employee_id,pact_job_id,release_id,created_at`)).rows[0];
  if (!a?.created_at) return null;
  const job = a.pact_job_id ? { kind: "pact" as const, id: a.pact_job_id } : a.release_id ? { kind: "rel" as const, id: a.release_id } : null;
  if (threadId && job && job.id !== threadId) return null;
  const by = a.employee_id && a.employee_id !== empId ? `employee_id.eq.${a.employee_id},` : "";
  const since = (await db.get<{ status?: string | null }>(`texted_photos?${who(by)}&msg_sid=not.is.null&created_at=gt.${enc(a.created_at)}&select=status&limit=20`)).rows;
  if (since.some((r) => r.status !== "held" && r.status !== "filed")) return null;
  return { id: a.id, at: msOf(a), empId: a.employee_id || empId, job };
}
// a voice note or a file with the words: not kept, and they hear so
const notKeptLine = (other: number, lang?: string | null) => (!other ? "" : isEs(lang)
  ? `${other === 1 ? "La nota de voz o el archivo no se guarda" : "Las notas de voz o los archivos no se guardan"}: solo se guardan fotos y videos.`
  : `${other === 1 ? "The voice note or file isn't kept" : "The voice notes or files aren't kept"}: only photos and videos go on the job.`);

// the jobs with a "nobody home" notice still up today
async function flaggedToday(db: Db, ids: string[], now: Date, today: string): Promise<Set<string>> {
  const list = ids.filter(Boolean).join(",");
  if (!list) return new Set();
  const rows = (await db.get<{ pact_job_id?: string | null; release_id?: string | null; created_at?: string | null }>(`texted_photos?status=eq.nobody&how=eq.nobody&or=(pact_job_id.in.(${list}),release_id.in.(${list}))&created_at=gte.${enc(new Date(now.getTime() - 20 * 3_600_000).toISOString())}&select=pact_job_id,release_id,created_at&limit=20`)).rows;
  return new Set(rows.filter((r) => r.created_at && nyDay(new Date(r.created_at)) === today).map((r) => r.pact_job_id || r.release_id || ""));
}
// the job the morning's "Finished?" asked them about, while that question is
// the last thing between the portal and them (nothing from them since but
// the portal's own prompts) and, with a job of theirs today, it's still the
// morning's (two hours)
async function askedJob(db: Db, o: { emp: Emp; now: Date }, jobToday: boolean): Promise<ThreadJob | null> {
  const q = await openQuestion(db, o.emp.id, o.now);
  if (!q || (jobToday && o.now.getTime() - q.at > 2 * 3_600_000)) return null;
  const since = (await db.get<{ how?: string | null }>(`texted_photos?employee_id=eq.${o.emp.id}&msg_sid=not.is.null&created_at=gt.${enc(new Date(q.at).toISOString())}&select=how&limit=30`)).rows;
  if (since.some((r) => !PROMPTED.has(r.how || ""))) return null;
  const j = await threadJob(db, q.jobId);
  return j && !j.canceled ? j : null;
}
// AFTER with nothing just sent: the next photos go in AFTER, on the job the
// text names, else the crew thread's own job (one of today's), else the job
// the morning asked about (the AFTER answers it), else their one job today,
// else the one of today's they last sent photos of (not a door's: two today,
// none of them yet: wherever the photos land); with no job today, the job
// the morning asked about, or the last they sent photos of
async function openAfter(db: Db, o: Said, named: JobKey | null): Promise<string> {
  const lang = o.emp.lang;
  let job: JobKey | null = named;
  const today = job ? [] : await todaysJobs(db, o.emp, o.today);
  if (!job && o.hint) job = today.find((k) => k.kind === o.hint!.kind && k.id === o.hint!.id) || null;
  if (!job) { const q = await askedJob(db, o, today.length > 0); if (q) job = keyOf(q); }
  if (!job) {
    if (today.length === 1) job = today[0];
    else if (today.length > 1) {
      const last = (await db.get<{ pact_job_id?: string | null; release_id?: string | null; created_at?: string | null }>(`texted_photos?employee_id=eq.${o.emp.id}&status=eq.filed&or=(how.is.null,how.neq.noaccess)&created_at=gte.${enc(new Date(o.now.getTime() - 20 * 3_600_000).toISOString())}&select=pact_job_id,release_id,created_at&order=created_at.desc&limit=1`)).rows[0];
      const id = last && nyDay(new Date(msOf(last))) === o.today ? last.pact_job_id || last.release_id || "" : "";
      // (a door nobody opened today is no job's after photos)
      const doors = await flaggedToday(db, [id], o.now, o.today);
      job = today.find((k) => k.id === id && !doors.has(k.id)) || null;
    } else {
      const found = await jobToAnswer(db, { ...o, verb: "done" });
      if (found && "job" in found) job = keyOf(found.job);
    }
  }
  // (note "named": the AFTER said its job's number: photos naming another job aren't its send)
  await putRow(db, { employee_id: o.emp.id, from_phone: o.from, body: o.body, status: "note", how: "aftersay", photos: [], msg_sid: o.sid || null, ...jobCols(job), ...(named ? { note: "named" } : {}) });
  // pictures that got here while this was being written (sent with the word):
  // they're the ones (in a crew's thread, the newest posted there too)
  let s = await justSent(db, { empId: o.emp.id, now: o.now });
  if (o.hint) { const t = await justSent(db, { jobId: o.hint.id, now: o.now }); if (t && (!s || t.newest > s.newest)) s = t; }
  if (s && !s.saidBefore && s.newest >= o.now.getTime() - FRESH_MS) {
    // (on the job the AFTER named, whichever job they landed on)
    const sendJob = s.held ? "" : s.pieces[0].pact_job_id || s.pieces[0].release_id || "";
    if (named && sendJob !== named.id) {
      const r = await placeOn(db, { ...o, sid: "" }, s.pieces, named, { force: "after" });
      if (r) { await closeWindows(db, o.emp.id, o.now); return r; }
    }
    // (put on a job that moment by the office: in AFTER there, below)
    if (s.held) s = await heldOrPlaced(db, s);
    if (s.held) {
      await closeWindows(db, o.emp.id, o.now);
      const opts = (await todaysJobs(db, o.emp, o.today)).slice(0, 3).map((k) => optionOf(k, lang));
      return heldAfterText(countOf(namesIn(s.pieces)), opts.length > 1 ? opts : [], lang);
    }
    if (s.before.length) {
      const f = await flipToAfter(db, { ...o, sid: "" }, s, "after");
      if (f) { await closeWindows(db, o.emp.id, o.now); return f.already ? "" : f.text; }
    }
  }
  return job ? afterNextText(jobName(job, lang), lang) : isEs(lang) ? "Entendido: las fotos que mande ahora van a DESPUES." : "OK: the photos you send now go in AFTER.";
}
// DONE answered by asking for the after photos (or the day's): pictures of
// that job that got here while the answer was written (sent with the DONE,
// still downloading when it looked) are the ones, as with AFTER
async function sentWithDone(db: Db, o: Said, jobId: string): Promise<string | null> {
  let s = await justSent(db, { empId: o.emp.id, now: o.now });
  if (o.hint) { const t = await justSent(db, { jobId: o.hint.id, now: o.now }); if (t && (!s || t.newest > s.newest)) s = t; }
  if (!s || s.saidBefore || s.newest < o.now.getTime() - FRESH_MS) return null;
  const lang = o.emp.lang;
  // (put on a job that moment by the office: in AFTER there, below)
  if (s.held) s = await heldOrPlaced(db, s);
  if (s.held) {
    await closeWindows(db, o.emp.id, o.now);
    const opts = (await todaysJobs(db, o.emp, o.today)).slice(0, 3).map((k) => optionOf(k, lang));
    return heldAfterText(countOf(namesIn(s.pieces)), opts.length > 1 ? opts : [], lang);
  }
  if (!s.before.length || (s.pieces[0].pact_job_id || s.pieces[0].release_id || "") !== jobId) return null;
  const f = await flipToAfter(db, { ...o, sid: "" }, s, "done");
  if (!f) return null;
  await closeWindows(db, o.emp.id, o.now);
  return f.already ? "" : f.text;
}

// ---- AFTER and DONE texted with no photos ----
// AFTER: the photos waiting for a number, or the send they just made, are the
// after photos; with nothing sent, the next ones are. DONE: the send they just
// made is the finished work (unless it was the arrival: they're asked), and so
// are photos waiting for their number; the rest is doneIn's. A job the text
// names ("AFTER 116843", "116843 done") is the one: the photos they just sent,
// waiting for their number, go on it in AFTER (older ones waiting stay for
// the office), the send just made on another job moves onto it in AFTER; a
// DONE about another job leaves the send where it is. In a crew's thread the
// send is the newest posted there, theirs or a co-worker's. Null: nothing
// here, the text goes on (doneIn, words); "": done, and the photos' own
// answer (sent at the same moment) says it.
async function afterOrDone(db: Db, o: Said, w: { after: boolean; done: DoneSaid }): Promise<string | null> {
  const lang = o.emp.lang;
  const byNumber = await namedJob(db, o);
  // (a number given out loud that fits none of their jobs is never guessed past: the office sorts it)
  if (byNumber === "unknown") return null;
  const named = byNumber;
  let s = await justSent(db, { empId: o.emp.id, now: o.now });
  const wait = afterWaitMs();
  if ((!s || s.newest < o.now.getTime() - FRESH_MS) && wait) {
    await sleep(wait);
    s = (await justSent(db, { empId: o.emp.id, now: o.now })) || s;
  }
  if (o.hint) { const t = await justSent(db, { jobId: o.hint.id, now: o.now }); if (t && (!s || t.newest > s.newest)) s = t; }
  // (nothing sent just now, and the photos they said ALL DONE about still wait
  // for the number "which job?" asked them for: a DONE naming a job answers
  // it, as the bare number would, unless the morning asked about that job since)
  if (!s && named && (w.done === "done" || w.done === "all")) {
    const h = await heldAllAsked(db, o);
    const q = h ? await openQuestion(db, o.emp.id, o.now) : null;
    if (h && !(q && q.jobId === named.id && q.at > h.newest)) {
      const r = await placeOn(db, o, h.pieces, named, { force: "after", all: w.done === "all" });
      if (r) { await remember(db, o, "afterflip", named); return r; }
    }
  }
  if (s && !s.saidBefore) {
    if (s.held) {
      // (with the job's number: on it now; the row says so, so the next send isn't these)
      if (named) { const r = await placeOn(db, o, s.pieces, named, { force: "after", all: w.done === "all" }); if (r) { await remember(db, o, "afterflip", named); return r; } }
      // (put on a job that moment by the office: decided below, where they are now)
      s = await heldOrPlaced(db, s, w.done === "all" ? "afterall" : "after");
    }
    const sendJob = s.held ? "" : s.pieces[0].pact_job_id || s.pieces[0].release_id || "";
    if (s.held) {
      await remember(db, o, "afterflip");
      const opts = (await todaysJobs(db, o.emp, o.today)).slice(0, 3).map((k) => optionOf(k, lang));
      return heldAfterText(countOf(namesIn(s.pieces)), opts.length > 1 ? opts : [], lang);
    } else if (named && named.id !== sendJob) {
      // AFTER with another job's number: the send goes there, in AFTER (a DONE about another job is doneIn's)
      if (w.after) { const r = await placeOn(db, o, s.pieces, named, { force: "after" }); if (r) { await remember(db, o, "afterflip", named); return r; } }
    } else if (!s.before.length) {
      // in AFTER already: nothing to move (a DONE still marks the job, or ends it: doneIn)
      const t = w.after ? await targetOf(db, s.pieces[0]) : null;
      if (t) { await remember(db, o, "afterflip", t); return alreadyAfterText(countOf(namesIn(s.pieces)), jobName(t, lang), lang); }
    } else {
      // the morning's question about another job, asked today and still open:
      // a DONE right after the next job's arrival photos answers it
      if (!w.after && w.done === "done") {
        const q = await openQuestion(db, o.emp.id, o.now);
        const t = q && q.open && q.jobId !== sendJob && nyDay(new Date(q.at)) === o.today ? await targetOf(db, s.pieces[0]) : null;
        if (q && t && (await arrivalOnly(db, t, t.kind === "pact" ? await threadJob(db, t.id) : null, s.oldest, o.today))) {
          const qj = await threadJob(db, q.jobId);
          if (qj && !qj.canceled) { const d = await doneIn(db, o, w.done, qj, { day: q.day }); if (d !== null) return d; }
        }
      }
      // (ALL DONE said twice about the job the day's guess picked: it's meant)
      const prev = w.done === "all" ? (await db.get<{ how?: string | null; body?: string | null; pact_job_id?: string | null; status?: string | null }>(`texted_photos?employee_id=eq.${o.emp.id}&msg_sid=not.is.null&created_at=gte.${enc(new Date(o.now.getTime() - FLIP_MS).toISOString())}&order=created_at.desc&limit=8&select=how,body,pact_job_id,status`)).rows.find((r) => r.status !== "held" && r.status !== "filed") : undefined;
      const twice = !!prev && prev.how === "afterflip" && !!prev.pact_job_id && prev.pact_job_id === sendJob && doneSaid(prev.body || "") === "all";
      const f = await flipToAfter(db, o, s, w.done === "all" ? "all" : w.after ? "after" : "done");
      if (f?.already) return "";
      if (f && w.done === "all" && f.thread && !f.asked && (!f.guessed || twice)) {
        const d = await doneIn(db, { ...o, sid: "" }, "all", f.thread);
        // (the guess's "is the whole job finished?" was answered: the count, then the end)
        if (d && f.guessed) return `${gotPhotosText(f.c, "after", jobName(f.t, lang), lang)} ${d}`;
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
// ("#12" is a job's only alone or with one word, "AFTER #12", "#12 done": "bedroom #2" is a room)
const jobRefsOnly = (body: string): string => {
  const b = body || "";
  const short = b.replace(/#\s*\d{1,12}\b/g, " ").trim().split(/\s+/).filter(Boolean).length <= 1;
  return [
    // (with a dash or a letter after the label too, "PO220011-2", "release 12-A": whole, as afterSaid takes it)
    ...b.matchAll(/\b(?:p\.?\s*o\.?|release|rel\.?)\s*(?:number|no\.?|num|#)?\s*[#:\-]?\s*[a-z]?\d{1,12}(?:-[\da-z]{1,3})?\b/gi),
    ...[...b.matchAll(/(?:^|[^\w#])#\s*(\d{1,12})\b/g)].filter((m) => m[1].length >= 5 || short),
    // (not the digits of a PO with a dash in it: that one is read whole, below)
    ...b.matchAll(/\b\d{5,12}\b(?!-[\dA-Za-z]{1,3}\b)/g),
    // a PO with a dash or a letter in it ("DONE 220011-2", "A220011"), whole
    ...b.matchAll(/\b[A-Za-z]?\d{4,12}-[\dA-Za-z]{1,3}\b|\b[A-Za-z]\d{4,11}\b/g),
  ].map((m) => (m[1] ? `#${m[1]}` : m[0])).join(" ");
};
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
// (`rel`: DONE on a day their only job is a release: no work-done mark by text, its next photos go in AFTER)
type Found = { job: ThreadJob; asked: boolean; askedDay: string; answered?: boolean } | { options: JobKey[] } | { unknown: string } | { rel: JobKey } | null;
// the portal's own prompts about a job, written as the worker's rows: not "something from them after the question"
const PROMPTED = new Set(["nodone", "answered"]);
async function jobToAnswer(db: Db, o: { emp: Emp; body: string; today: string; now: Date; verb: "done" | "notdone"; hint?: Hint; all?: boolean }): Promise<Found> {
  const { rows, mine } = await jobsOf(db, o.emp, o.today);
  const refs = jobRefsOnly(o.body);
  const relOf = (id: string) => mine.find((k) => k.kind === "rel" && k.id === id);
  if (refs) {
    const pick = pickJob(refs, rows, mine, o.today, await anyPoOf(db, refs, mine));
    if (pick.kind === "pact" && pick.why === "number") { const j = await threadJob(db, pick.id); if (j) return { job: j, asked: false, askedDay: "" }; }
    // (a release's number: DONE puts its next photos in AFTER; NOT DONE about it is the office's)
    if (pick.kind === "rel" && pick.why === "number") { const k = relOf(pick.id); if (k) return { rel: k }; }
    if (pick.kind === "ask" && pick.why === "unknown") return { unknown: pick.number || "" };
  }
  const todayIds = [...new Set(rows.filter((r) => r.day === o.today && r.pact_job_id).map((r) => r.pact_job_id as string))];
  const relsToday = [...new Set(rows.filter((r) => r.day === o.today && r.release_id).map((r) => r.release_id as string))];
  if (o.hint?.kind === "pact" && todayIds.includes(o.hint.id)) {
    const j = await threadJob(db, o.hint.id);
    if (j && !j.canceled) return { job: j, asked: false, askedDay: "" };
  }
  if (o.hint?.kind === "rel" && relsToday.includes(o.hint.id)) { const k = relOf(o.hint.id); if (k) return { rel: k }; }
  const since = enc(new Date(o.now.getTime() - 3 * 86_400_000).toISOString());
  // what came from them lately (their own texts and pictures), newest first
  const own = (await db.get<{ how?: string | null; status?: string | null; pact_job_id?: string | null; release_id?: string | null; created_at?: string | null; photos?: Photo[] | null }>(`texted_photos?employee_id=eq.${o.emp.id}&msg_sid=not.is.null&created_at=gte.${since}&select=how,status,pact_job_id,release_id,created_at,photos&order=created_at.desc&limit=30`)).rows;
  const at = (r: { created_at?: string | null }) => Date.parse(r.created_at || "") || 0;
  const q = await openQuestion(db, o.emp.id, o.now, true);
  const withQ = (j: ThreadJob): Found => ({ job: j, asked: !!q && q.jobId === j.id && q.open, askedDay: q && q.jobId === j.id ? q.day : "", answered: !!q && q.jobId === j.id && !q.open });
  // the portal just asked about a job ("If X isn't finished, reply NOT DONE"): that one
  const prompt = own[0] && PROMPTED.has(own[0].how || "") && own[0].pact_job_id && o.now.getTime() - at(own[0]) < 30 * 60_000 ? own[0].pact_job_id : "";
  if (prompt) {
    const j = await threadJob(db, prompt);
    if (j && !j.canceled) return withQ(j);
  }
  // the job of the pictures they just sent (a quarter hour; not a door's): that one, a release's too
  const sent = own.find((r) => r.status === "filed" && (r.pact_job_id || r.release_id) && r.how !== "noaccess" && o.now.getTime() - at(r) < FLIP_MS);
  if (sent?.release_id && !sent.pact_job_id) { const k = relOf(sent.release_id); if (k) return { rel: k }; }
  if (sent?.pact_job_id) {
    const j = await threadJob(db, sent.pact_job_id);
    if (j && !j.canceled) return withQ(j);
  }
  // the portal's own last word to them, about one of today's jobs ("in AFTER
  // now … Reply ALL DONE", "If they're the finished work, reply AFTER"), the
  // last two hours: the job it was about, while it is still open
  const last = own[0];
  if (last && SAID_ABOUT.has(last.how || "") && o.now.getTime() - at(last) < 2 * 3_600_000) {
    if (last.pact_job_id && todayIds.includes(last.pact_job_id)) {
      const j = await threadJob(db, last.pact_job_id);
      if (j && !j.canceled && !j.work_done) return withQ(j);
    } else if (last.release_id && relsToday.includes(last.release_id)) { const k = relOf(last.release_id); if (k) return { rel: k }; }
  }
  if (q) {
    // (another job's BEFORE pictures since, the arrival at the next job, aren't an answer to it)
    const arrival = (r: (typeof own)[number]) => r.status === "filed" && (r.pact_job_id || r.release_id || "") !== q.jobId && namesIn([r]).every((x) => kindOfName(x) !== "after");
    const after = own.filter((r) => at(r) > q.at && !PROMPTED.has(r.how || "") && !arrival(r));
    // pictures today on another job: they've moved on, and words about "done" are about that one
    const elsewhere = own.some((r) => r.status === "filed" && (r.pact_job_id || r.release_id) && (r.pact_job_id || "") !== q.jobId && nyDay(new Date(at(r))) === o.today);
    if (!after.length && (o.now.getTime() - q.at < 2 * 3_600_000 || !elsewhere)) {
      const j = await threadJob(db, q.jobId);
      if (j && !j.canceled) return { job: j, asked: q.open, askedDay: q.day, answered: !q.open };
    }
  }
  const pactIds = mine.filter((k) => k.kind === "pact").map((k) => k.id);
  const todays = (await Promise.all(todayIds.slice(0, 6).map((id) => threadJob(db, id)))).filter((j): j is ThreadJob => !!j && !j.canceled);
  // (today's job not begun: no pictures of theirs today)
  const startedToday = own.some((r) => r.status === "filed" && nyDay(new Date(at(r))) === o.today);
  // the last day before today they sent pictures, and its job
  const lastFiled = own.find((r) => r.status === "filed" && r.how !== "noaccess" && r.pact_job_id && nyDay(new Date(at(r))) < o.today);
  const lastWorked = lastFiled ? nyDay(new Date(at(lastFiled))) : "";
  if (o.verb === "notdone") {
    const who = pactIds.length ? `or=(employee_id.eq.${o.emp.id},pact_job_id.in.(${pactIds.join(",")}))` : `employee_id=eq.${o.emp.id}`;
    const d = (await db.get<{ pact_job_id?: string | null; created_at?: string | null }>(`texted_photos?how=eq.done&status=in.(done,seen)&${who}&created_at=gte.${since}&select=pact_job_id,created_at&order=created_at.desc&limit=1`)).rows[0];
    // pictures of another job since that mark: they've moved on
    const movedOn = !!d && own.some((r) => r.status === "filed" && at(r) > at(d) && (r.pact_job_id || r.release_id) && r.pact_job_id !== d.pact_job_id);
    // (today's job not started yet: a NOT DONE first thing is about the last
    // day they worked: Saturday's on a Monday, or Friday's when nobody worked Saturday)
    const fresh = !!d?.created_at && !movedOn && (o.now.getTime() - at(d) < 2 * 3_600_000 || !todayIds.length || (!startedToday && nyDay(new Date(at(d))) >= (lastWorked || addWorkDays(o.today, -1))));
    if (d?.pact_job_id && fresh) { const j = await threadJob(db, d.pact_job_id); if (j && j.work_done && !j.canceled) return { job: j, asked: false, askedDay: "" }; }
    // today's job not begun, and the last day they worked was on another job: they're asked which
    if (!startedToday && lastFiled?.pact_job_id && todays.length && !todayIds.includes(lastFiled.pact_job_id)) {
      const lj = await threadJob(db, lastFiled.pact_job_id);
      if (lj && !lj.canceled && !billed(lj)) return { options: [keyOf(lj), ...todays.map(keyOf)] };
    }
  }
  const open = todays.filter((j) => !j.work_done);
  const cands = open.length ? open : todays;
  // a release today too: its pictures the newest today make it the release's;
  // otherwise NOT DONE is asked which (never a PACT job picked by a guess)
  const rels = relsToday.map(relOf).filter((k): k is JobKey => !!k);
  if (rels.length && cands.length) {
    const newest = own.find((r) => r.status === "filed" && r.how !== "noaccess" && (r.pact_job_id || r.release_id) && nyDay(new Date(at(r))) === o.today);
    if (newest?.release_id && !newest.pact_job_id) { const k = relOf(newest.release_id); if (k) return { rel: k }; }
    if (o.verb === "notdone" || !newest?.pact_job_id) return { options: [...cands.map(keyOf), ...rels] };
  }
  if (cands.length === 1) return { job: cands[0], asked: false, askedDay: "" };
  if (cands.length > 1) {
    // (ALL DONE ends a job: with two open today it's never a guess)
    const working = o.all ? [] : cands.filter((j) => { const p = dayPile(j, o.today); return p.beforeN > 0 && p.afterN === 0; });
    if (working.length === 1) return { job: working[0], asked: false, askedDay: "" };
    return { options: cands.map(keyOf) };
  }
  // a release today and no PACT job: the DONE is the release's, never an older PACT job's
  if (relsToday.length) return relsToday.length === 1 && rels[0] ? { rel: rels[0] } : null;
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
  // (a release runs on by the office: its words go to them)
  if (found && "rel" in found) {
    await remember(db, o, "notdone", found.rel, `${firstName(o.emp)} texted NOT DONE about ${found.rel.label}`, "reply");
    return toldOfficeText(lang);
  }
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
// `known`: the job it's about is already known (ALL DONE right after its
// photos, which finish it), read again here; `asked`: the morning asked about it
async function doneIn(db: Db, o: Said, said: DoneSaid | "yes", known?: ThreadJob, asked?: { day: string }): Promise<string | null> {
  const lang = o.emp.lang;
  const again = known ? await threadJob(db, known.id) : null;
  const found: Found = known ? { job: again || known, asked: !!asked, askedDay: asked?.day || "" } : await jobToAnswer(db, { ...o, verb: "done", all: said === "all" });
  if (!found || "unknown" in found) return null; // no job to say it about: it's words for the office
  // (the row says it was ALL DONE: the number that answers it finishes the job)
  if ("options" in found) { await remember(db, o, "donetext", undefined, said === "all" ? "all" : ""); return whichJobText(said === "all" ? "all" : "done", found.options, lang); }
  if ("rel" in found) {
    // a release isn't marked work done by text: its next photos go in AFTER (or the ones sent with this)
    await remember(db, o, "afterwait", found.rel);
    return (await sentWithDone(db, o, found.rel.id)) ?? afterNextText(jobName(found.rel, lang), lang);
  }
  const job = found.job;
  const key = keyOf(job);
  const name = jobName(key, lang);
  // a door nobody opened a moment ago ("no" with its picture, then "done"):
  // done there, not a finished job. Its words go to the office
  if (!known && !jobRefsOnly(o.body) && (await flaggedToday(db, [job.id], o.now, o.today)).size && (await doorJustNow(db, o.emp.id, job.id, o.now))) return null;
  if (job.work_done) { await closeQuestion(db, job.id); await remember(db, o, "donetext", job.id); return alreadyDoneText(name, lang); }
  const L = onLastDay(job, o.today);
  const hasAfter = dayPile(job, o.today).afterN > 0;
  if (L.before && said !== "all" && !found.asked) {
    // (no AFTER photos of the day yet: the next ones are)
    await remember(db, o, hasAfter ? "donetext" : "afterwait", job.id);
    return (!hasAfter ? await sentWithDone(db, o, job.id) : null) ?? dayDoneText(name, { next: L.next, today: o.today, day: L.nextN, of: L.of }, lang, !hasAfter);
  }
  if (!found.asked && !hasAfter && said !== "all" && said !== "yes") { await remember(db, o, "afterwait", job.id); return (await sentWithDone(db, o, job.id)) ?? sendAfterText(name, lang); }
  const who = firstName(o.emp);
  // marked without its after photos: the next photos they send go in AFTER
  // (the window opens first, so photos landing while it's marked see it)
  if (!hasAfter) await remember(db, o, "afterwait", job.id, "marked");
  const dropped = L.before ? await endEarly(db, job, {
    emp: o.emp, emps: o.emps, now: o.now, today: o.today, tell: !o.hint,
    words: (e, d) => crewEndedText(firstName(e), jobName(key, e.lang), d, e.lang),
  }) : [];
  // the day it was finished: the day the morning asked about, else today (a
  // Sunday ALL DONE is its last work day before it)
  const worked = workDaysOf(job.start_date, job.work_days).filter((d) => d <= o.today);
  const finish = found.asked && found.askedDay && found.askedDay <= o.today ? found.askedDay : worked.length && !worked.includes(o.today) ? worked[worked.length - 1] : o.today;
  // (photos that reached it finish it: the mark comes off if they move to another job)
  const marked = await markDone(db, job, o.emp, { from: o.from, now: o.now, finish, sid: o.sid, how: known && !asked ? "photos" : "text" });
  await closeQuestion(db, job.id);
  if (!marked) {
    // (the window opened for it closes: nothing was marked)
    if (!hasAfter) await db.patch(`texted_photos?employee_id=eq.${o.emp.id}&how=eq.afterwait&status=eq.note&note=eq.marked&pact_job_id=eq.${job.id}`, { status: "seen" });
    await remember(db, o, "donetext", job.id, `${who} texted DONE · the work-done mark couldn't be saved`, "reply");
    return toldOfficeText(lang);
  }
  // the photos sent with it, still on their way when it looked: in AFTER now
  const came = hasAfter ? null : await flipFresh(db, o, job);
  if (came) return `${gotPhotosText(came, "after", name, lang)} ${dropped.length ? endedEarlyText(name, dropped, lang) : doneMarkedText(name, false, lang)}`;
  return dropped.length ? endedEarlyText(name, dropped, lang, !hasAfter) : doneMarkedText(name, !hasAfter, lang);
}

// the send's BEFORE pieces into AFTER on its job. `already`: another request
// had just put them there (its answer says so)
async function intoAfter(db: Db, s: Sent, t: Target): Promise<{ moved: number; already: boolean }> {
  let moved = 0, already = s.before.length > 0;
  for (const b of [...s.before].reverse()) {
    const st: FileOut = {};
    moved += await fileBatch(db, b, t, b.how || "day", "after", st);
    already = already && !!st.already;
  }
  return { moved, already };
}
// the send just made on this job (the last minute and a half, nothing said
// BEFORE with it), into AFTER: the photos sent with a DONE that marked it
async function flipFresh(db: Db, o: Said, job: ThreadJob): Promise<MediaCount | null> {
  const s = await justSent(db, o.hint?.id === job.id ? { jobId: job.id, now: o.now } : { empId: o.emp.id, now: o.now });
  if (!s || s.held || s.saidBefore || s.newest < o.now.getTime() - FRESH_MS || !s.before.length || s.pieces[0].pact_job_id !== job.id) return null;
  const t = await targetOf(db, s.pieces[0]);
  if (!t) return null;
  const r = await intoAfter(db, s, t);
  if (!r.moved) return null;
  await closeWindows(db, o.emp.id, o.now);
  // (the photos' own answer said it already)
  return r.already ? null : countOf(namesIn(s.pieces));
}
// their "no" for this job's door a moment ago (half an hour), with nothing
// from them since but the door's pictures
async function doorJustNow(db: Db, empId: string, jobId: string, now: Date): Promise<boolean> {
  const rows = (await db.get<{ how?: string | null; pact_job_id?: string | null; release_id?: string | null }>(`texted_photos?employee_id=eq.${empId}&msg_sid=not.is.null&created_at=gte.${enc(new Date(now.getTime() - 30 * 60_000).toISOString())}&order=created_at.desc&select=how,pact_job_id,release_id&limit=10`)).rows;
  const r = rows.find((x) => x.how !== "noaccess");
  const on = r ? r.pact_job_id || r.release_id || "" : "";
  return !!r && r.how === "nobody" && (!on || on === jobId);
}

// ---- a job's number for pictures: ones waiting for it, or a send on the wrong job ----
// They go onto the job it names. Each keeps its pile: one on a job already
// keeps it (one the portal put on the job it asked the after photos of goes
// back to what its words say). The ones waiting go by what was said: a
// piece's own BEFORE or AFTER, else AFTER when an AFTER (or a DONE) was said
// with any of them or right after, else BEFORE; and a piece of the same send
// already on this job, with nothing said, goes with an AFTER said on a later
// piece. `force`: AFTER said with the number; `all`: ALL DONE with it (or
// said about the ones waiting); `noMark`: placed only (a NOT DONE answered
// by the number comes after). The answer is the thread's next step; null
// when nothing could move.
async function placeOn(db: Db, o: Said, group: Batch[], pick: Target, opt: { force?: "after"; all?: boolean; noMark?: boolean } = {}): Promise<string | null> {
  const lang = o.emp.lang;
  const name = jobName(pick, lang);
  const onIt = (b: Batch) => b.status === "filed" && (pick.kind === "pact" ? b.pact_job_id === pick.id : b.release_id === pick.id);
  const beforeNames = (b: Batch) => namesIn([b]).some((n) => kindOfName(n) === "before");
  const said = (b: Batch) => captionKind(b.body || "");
  const thread = pick.kind === "pact" ? await threadJob(db, pick.id) : null;
  const force = opt.force;
  // AFTER (or DONE, ALL DONE) said with the waiting ones, or right after them
  let heldAfter = group.some((b) => b.status === "held" && (saidAfterHeld(b) || said(b) === "after"));
  let heldAll = group.some((b) => b.status === "held" && b.how === "afterall");
  // the pieces of a send an AFTER on a waiting piece was said about, on a job with nothing said (this one or the guess's)
  const afterAt = group.filter((b) => b.status === "held" && (saidAfterHeld(b) || said(b) === "after")).map(msOf);
  const sameSend = (b: Batch) => b.status === "filed" && !said(b) && beforeNames(b) && afterAt.some((t) => Math.abs(t - msOf(b)) <= SPLIT_MS);
  const kindOf = (b: Batch): PhotoKind | undefined => {
    if (force) return force;
    if (b.status === "held") return saidAfterHeld(b) ? "after" : said(b) || (heldAfter ? "after" : "before");
    if (sameSend(b)) return "after";
    // (on the job the portal asked the after photos of: away from it, they're what their words say)
    if (b.how === "window") return said(b) || "before";
    return undefined;
  };
  const toMove = group.filter((b) => !onIt(b) || (force === "after" && beforeNames(b)) || sameSend(b));
  if (!toMove.length) {
    const c = countOf(namesIn(group.filter(onIt)));
    return c.n ? replyText({ k: "moved", n: c.n, v: c.v, label: name }, lang) : null;
  }
  // the jobs the moved pictures leave (as they were when they moved): one marked done by them isn't, without them
  const leaving = new Map<string, boolean>();
  let n = 0, newest = 0;
  for (const b0 of [...toMove].reverse()) {
    let b = b0;
    let st: FileOut = {};
    let got = await fileBatch(db, b, pick, "number", kindOf(b), st);
    // (moved a moment ago, by the office or another text of theirs: the number they sent still puts it here;
    // made a door's picture that moment, it waits for its door)
    if (st.changed) {
      const fresh = (await db.get<Batch>(`texted_photos?id=eq.${b0.id}&select=*`)).rows[0];
      if (fresh && (fresh.status === "held" || fresh.status === "filed") && fresh.how !== "noaccess" && !(onIt(fresh) && !(force === "after" && beforeNames(fresh)))) {
        b = fresh;
        // (an AFTER or ALL DONE said about it that moment counts as said with them)
        heldAfter ||= saidAfterHeld(fresh);
        heldAll ||= fresh.status === "held" && fresh.how === "afterall";
        st = {};
        got = await fileBatch(db, b, pick, "number", kindOf(b), st);
      }
    }
    if (got && st.from?.kind === "pact" && st.from.id !== pick.id) leaving.set(st.from.id, (leaving.get(st.from.id) || false) || wasAfter(b));
    n += got;
    if (got) newest = Math.max(newest, msOf(b));
  }
  if (!n) return null;
  for (const [id, after] of leaving) await clearDoneIfNoAfter(db, id, jobName(pick, "en"), o.now, o.today, after);
  // their own number put pictures on a job reported nobody home this morning: they got in
  // (pictures sent after the report: ones held from before it say nothing of it)
  await doorOpened(db, pick, o.emp, o.now, o.today, newest);
  // what is on the job now, of these, by pile
  const back = (await db.get<Batch>(`texted_photos?id=in.(${group.map((b) => b.id).join(",")})&select=id,status,photos,pact_job_id,release_id`)).rows.filter(onIt);
  const names = namesIn(back);
  const cb = countOf(names.filter((x) => kindOfName(x) !== "after")), ca = countOf(names.filter((x) => kindOfName(x) === "after"));
  // the after photos are in: an AFTER window still open is used
  if (ca.n) await closeWindows(db, o.emp.id, o.now);
  if (!thread) {
    const kind = ca.n && !cb.n ? "after" : cb.n && !ca.n ? "before" : undefined;
    const all = { n: ca.n + cb.n, v: ca.v + cb.v };
    return replyText(kind ? { k: "filed", ...all, label: name, kind } : { k: "moved", ...all, label: name }, lang);
  }
  if (!ca.n) return gotBeforeText(cb, name, lang);
  const lead = cb.n ? `${gotPhotosText(cb, "before", name, lang)} ` : "";
  await closeQuestion(db, thread.id);
  if (opt.noMark) return `${lead}${gotPhotosText(ca, "after", name, lang)}`;
  // the words the pictures came with still count: "not done yet" runs it on, "kitchen done, starting the bath" asks
  const caption = toMove.map((b) => b.body || "").join(" ");
  if (notDoneStrong(caption)) return `${lead}${gotPhotosText(ca, "after", name, lang)} ${await notDoneIn(db, { ...o, sid: "" }, thread)}`;
  // the day they were texted (photos held overnight are that day's), not the day the number came
  const sent = Math.min(...toMove.map(msOf).filter(Boolean)) || o.now.getTime();
  const day = nyDay(new Date(sent)) < o.today ? nyDay(new Date(sent)) : o.today;
  const L = onLastDay(thread, day);
  // (ALL DONE about them: finished the day they were texted)
  if (opt.all || heldAll || (L.before && allDoneSaid(caption))) {
    const d = await doneIn(db, { ...o, sid: "", today: day }, "all", thread);
    if (d) return `${lead}${gotPhotosText(ca, "after", name, lang)} ${d}`;
  }
  // (yesterday's after photos, placed today: it goes on today, or after today
  // once today's after photos are in)
  const next = day < o.today && dayPile(thread, o.today).afterN > 0 ? onLastDay(thread, o.today).next : L.next;
  if (L.before && next) return `${lead}${gotAfterDayText(ca, name, { day: L.day, of: L.of, next, today: o.today }, lang)}`;
  if (mixedCaption(caption)) return `${lead}${gotPhotosText(ca, "after", name, lang)} ${finishedAskText(lang)}`;
  const marked = await markDone(db, thread, o.emp, { from: o.from, now: o.now, finish: currentWorkDay(thread.start_date, thread.work_days, day) });
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
// the photos waiting on a door ("nobody home" with a picture, two jobs and no
// number; or pictures sent around their "no"): today's, newest first, the
// pieces of one send (half an hour). One whose door is known already (its
// job wouldn't take it) waits for the office, not for a number
async function heldDoors(db: Db, empId: string, now: Date): Promise<Batch[]> {
  const since = enc(new Date(now.getTime() - 20 * 3_600_000).toISOString());
  const rows = (await db.get<Batch>(`texted_photos?employee_id=eq.${empId}&status=eq.held&how=eq.noaccess&created_at=gte.${since}&order=created_at.desc&limit=10&select=*&pact_job_id=is.null&release_id=is.null`)).rows
    .filter((b) => b.created_at && nyDay(new Date(b.created_at)) === nyDay(now));
  const top = rows.length ? msOf(rows[0]) : 0;
  return rows.filter((b) => top - msOf(b) <= 30 * 60_000);
}
// a caption only about the door: "door", "puerta cerrada", "closed", "front
// door locked", "door's locked", "pic of the door", "video de la puerta",
// "puerta 4B", "cerrado con llave", "door again, nobody", "tocamos y nada": a
// door word (or closed, locked, the Spanish knock) and nothing about the work
// ("door frame done", "new door")
const DOOR_WORDS = new Set(["door", "doors", "puerta", "puertas", "closed", "locked", "shut", "cerrada", "cerrado", "cerradas", "cerrados", "tocamos", "toque"]);
const DOOR_FILL = new Set(["the", "la", "el", "las", "los", "a", "an", "front", "main", "principal", "entry", "entrance", "apartment", "apt", "unit", "their", "su", "his", "her", "its", "my", "of", "de", "del", "is", "was", "are", "esta", "estaba", "estan", "still", "again", "otra", "vez", "todavia", "aun", "here", "heres", "this", "aqui", "es", "nobody", "nadie", "no", "answer", "hay", "en", "casa", "home", "at", "with", "con", "llave", "and", "y", "pic", "pics", "picture", "pictures", "photo", "photos", "foto", "fotos", "video", "videos", "vid", "imagen", "image", "knocked", "knock", "nada", "contesta", "contestan", "responde"]);
const doorOnly = (body: string) => {
  const t = (body || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/['\u2019]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const words = t ? t.split(" ") : [];
  // (an apartment or a house number: "4B", "2205")
  return words.some((w) => DOOR_WORDS.has(w)) && words.every((w) => DOOR_WORDS.has(w) || DOOR_FILL.has(w) || /^\d{1,4}[a-z]{0,2}$|^[a-z]\d{1,4}$/.test(w));
};
// a "wrong job" fix said in so many words, not just the number
const FIX_WORDS = /\b(wrong|equivocad[oa]|right one|correct (?:po|one|job)|should be|el correcto)\b/i;

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
    // a voice note or a contact card isn't kept, and they hear so (words sent
    // with one are read as usual, and reach the office with a word about it)
    if (other > 0 && (!body.trim() || (isAck(body) && !yesWord(body)))) return say({ k: "notphoto" }, lang);
    const said: Said = { emp, emps: emps.rows, body, from, sid, now, today, hint: inb.jobHint };
    // (the answer to the words carries the voice note's line, unless it says it already)
    const told = { notKept: false };
    const r = await (async (): Promise<string | undefined> => {

    // the portal's "If they're the finished work, reply AFTER" a moment ago
    // (one to one, or in the crew's thread about its job): a yes, or AFTER,
    // moves the send it asked about to AFTER, however long ago it came; a no
    // keeps it in BEFORE, and is never a door nobody opened
    if (!/\d/.test(body) && (yesWord(body) || noWord(body) || afterSaid(body))) {
      const ask = await openAsk(db, emp.id, now, inb.jobHint?.id);
      if (ask) {
        await db.patch(`texted_photos?id=eq.${ask.id}&status=eq.note`, { status: "seen" });
        if (noWord(body)) {
          await remember(db, said, "askno", ask.job);
          return answer(isEs(lang) ? `Entendido, se quedan en ANTES. ${AFTER_HOW.es}` : `OK, they stay in BEFORE. ${AFTER_HOW.en}`);
        }
        const s = await justSent(db, { ...(inb.jobHint ? { jobId: inb.jobHint.id } : { empId: ask.empId }), now: new Date(ask.at), until: ask.at + FRESH_MS });
        if (s && s.before.length) {
          const f = await flipToAfter(db, said, s, "after");
          if (f) { await closeWindows(db, emp.id, now); return answer(f.already ? undefined : f.text); }
        }
      }
    }

    // a plain yes / no: the answer to the morning's "Finished?" when that is
    // the last thing between the portal and them; right after the work-done
    // mark, a "no" is asked about (not finished, or a door?), never guessed
    // (the question goes one to one: a "yes" in a crew's thread is to the people in it)
    if ((yesWord(body) || noWord(body)) && !/\d/.test(body) && !inb.jobHint) {
      // (the AFTER window the portal keeps for itself after a DONE is not
      // something said; their own AFTER is, and a yes after it isn't an answer to the morning)
      const last = (await db.get<{ how?: string | null; status?: string | null; pact_job_id?: string | null; created_at?: string | null }>(`texted_photos?employee_id=eq.${emp.id}&or=(how.is.null,how.neq.afterwait)&select=how,status,pact_job_id,created_at&order=created_at.desc&limit=1`)).rows[0];
      const age = last?.created_at ? now.getTime() - Date.parse(last.created_at) : Infinity;
      const lastJob = last?.pact_job_id && age < 24 * 3_600_000 && (last.how === "asked" || (last.how === "done" && age < 2 * 3_600_000) || (last.how === "nodone" && age < 30 * 60_000)) ? await threadJob(db, last.pact_job_id) : null;
      if (lastJob && last) {
        const label = jobName(keyOf(lastJob), lang);
        // their other job today they haven't sent pictures of: a "no" could be that door
        const door = noWord(body) ? await openDoorToday(db, emp, lastJob.id, now, today) : null;
        const doorWords = door ? { name: jobName(door, lang), num: (door.label.match(/[A-Za-z]?\d[\w-]*$/) || [""])[0] } : null;
        if (last.how === "nodone") {
          // a second plain "no" to "not finished, or nobody home?": asked again, nothing guessed
          await remember(db, said, "nodone", lastJob.id);
          return answer(noAfterDoneText(label, doorWords, lang));
        }
        if (last.how === "asked" && last.status === "note") {
          // the morning's question, still open: the answer to it, unless a "no" could be a door today
          if (yesWord(body)) { const r = await doneIn(db, said, "yes"); if (r !== null) return answer(r || undefined); }
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
      if (r !== null) return answer(r || undefined);
    }
    // "no" (or "nobody home", or "NO 116843" naming the job they went on) a
    // moment after pictures with no words but the door's (the phone sent the
    // picture first, or they sent the door's picture and then reported it, the
    // way the portal teaches): the pictures were of the door. Which door is
    // decided first (lib/nobodyFlow, with those pictures not counted as a job
    // they've been through), and they go on its Nobody home pile, off the job
    // the day's guess put them on (a co-worker's report they made "got in" is
    // up again). Which door it was isn't clear: they wait as the door's, for
    // its number. Pictures still waiting for their job's number wait as the
    // door's too (with "NO <one of today's jobs>" as well)
    let doorPieces: SendRow[] = [];
    let doorOn: Target | null = null;
    let doorNamed = false;
    // (a send from the last five minutes with no words but the door's, all in BEFORE)
    const doorSend = (s: Sent | null) => !!s && now.getTime() - s.newest <= 5 * 60_000 && s.pieces.every((b) => !(b.body || "").trim() || doorOnly(b.body || "")) && s.before.length === s.pieces.length;
    // (a piece like that sent with the word, that landed while the word was read)
    const withWord = (b: { body?: string | null; photos?: Photo[] | null; created_at?: string | null }) =>
      msOf(b) >= now.getTime() - 2_000 && (!(b.body || "").trim() || doorOnly(b.body || "")) && namesIn([b]).some((x) => kindOfName(x) === "before");
    if (nobodyHome(body)) {
      let s = await justSent(db, { empId: emp.id, now });
      // (nothing just sent: the door's picture may still be on its way, sent with the word)
      const wait = afterWaitMs();
      if ((!s || s.newest < now.getTime() - FRESH_MS) && wait) { await sleep(wait); s = (await justSent(db, { empId: emp.id, now })) || s; }
      const nums = numbersIn(body);
      const door = doorSend(s);
      // (the "no" names one of these jobs: its number, or its house or apartment, as nobodyFlow reads it)
      const names = (js: JobKey[]) => js.some((k) => (k.keys || []).some((x) => nums.includes(x))) || byAddress(body, js.map((k) => ({ ...k, day: today, rowIds: [] }))).length > 0;
      if (s && door && s.held) {
        if (!nums.length || names(await todaysJobs(db, emp, today))) for (const b of s.pieces) await db.patch(`texted_photos?id=eq.${b.id}&status=eq.held`, { how: "noaccess" });
      } else if (s && door) {
        const t = await targetOf(db, s.pieces[0]);
        const byNumber = s.pieces.every((b) => b.how === "number" || b.how === "burst");
        const own = !!t && names([t as JobKey]);
        // (pictures they put on a job by its number are that job's: a "no" that names another of today's jobs
        // is about that one; a count or a time names none: "knocked 3 times")
        const other = !!t && byNumber && !own && names((await todaysJobs(db, emp, today)).filter((k) => k.id !== t.id));
        if (t && !other) {
          doorPieces = s.pieces;
          doorOn = t;
          // (the job they're on is named: its number in the "no", the crew's thread, or the pictures' own number)
          doorNamed = own || inb.jobHint?.id === t.id || byNumber;
        }
      }
    }
    // "no" / "nobody home" / "nadie": the job is flagged for a new day and
    // they get their next one (lib/nobodyFlow.ts). "NO 2205 Linden" is a door
    // only when the number is one of today's doors (the house or the apartment)
    const candidate = !nobodyHome(body) && noAt(body);
    if (nobodyHome(body) || candidate) {
      const hint = inb.jobHint?.id || (doorNamed && doorOn ? doorOn.id : undefined);
      const doorIds = new Set(doorPieces.map((b) => b.id));
      const flow = await nobodyFlow(db, { emp, emps: emps.rows, body, from, sid, now, say: inb.deliver, candidate, hint, ignore: (b) => doorIds.has(b.id) || withWord(b) });
      if (flow.handled) {
        // (the door decided: pictures sent with the word that landed meanwhile are its too)
        if (nobodyHome(body) && (flow.missed || flow.asked)) {
          const s = await justSent(db, { empId: emp.id, now });
          if (s && doorSend(s) && s.pieces.some(withWord)) {
            // (one another request is moving right now, its own text say, is left to it)
            if (s.held) for (const b of s.pieces) await db.patch(`texted_photos?id=eq.${b.id}&status=eq.held&or=(how.is.null,how.neq.moving)`, { how: "noaccess" });
            else {
              // (only those, and the ones the first look took: older pieces of the send it left
              // on their job are that job's, and told nobodyFlow they had been there)
              const take = s.pieces.filter((b) => withWord(b) || doorIds.has(b.id));
              doorPieces = [...take, ...doorPieces.filter((d) => !take.some((b) => b.id === d.id))];
              doorOn = doorOn || (await targetOf(db, take[0]));
            }
          }
        }
        if (doorOn && doorPieces.length && (flow.missed || flow.asked)) {
          // (their own pictures of that job today, besides these: they got in there)
          const col = doorOn.kind === "pact" ? "pact_job_id" : "release_id";
          const ids = new Set(doorPieces.map((b) => b.id));
          const others = (await db.get<{ id: string; created_at?: string | null; how?: string | null }>(`texted_photos?employee_id=eq.${emp.id}&status=eq.filed&${col}=eq.${doorOn.id}&created_at=gte.${since(20 * 3_600_000)}&select=id,created_at,how`)).rows
            .filter((r) => !ids.has(r.id) && r.how !== "noaccess" && r.created_at && nyDay(new Date(r.created_at)) === today);
          let n = 0;
          if (flow.missed && (flow.missed.id !== doorOn.id || !others.length)) {
            for (const b of [...doorPieces].reverse()) n += await fileBatch(db, b, flow.missed, "noaccess", "noaccess");
          } else if (flow.asked && !others.length) {
            for (const b of doorPieces) n += await holdBatch(db, b, "noaccess");
          }
          if (n && !others.length) await doorShutAgain(db, doorOn, emp, today);
        }
        // the pictures of that door waiting for its number go on it
        if (flow.missed) for (const d of await heldDoors(db, emp.id, now)) await fileBatch(db, d, flow.missed, "noaccess", "noaccess");
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
    if (d) { const r = await doneIn(db, said, d); if (r !== null) return answer(r || undefined); }
    // a number answering "which job has nobody home?" for the door picture they sent
    if (justANumber(body)) {
      const doors = await heldDoors(db, emp.id, now);
      // (or the question itself, a moment ago, when the office has placed its picture already)
      const asked = doors.length ? undefined : (await db.get<{ note?: string | null; created_at?: string | null }>(`texted_photos?employee_id=eq.${emp.id}&how=eq.nobody&status=eq.note&msg_sid=not.is.null&created_at=gte.${since(30 * 60_000)}&order=created_at.desc&limit=1&select=note,created_at`)).rows.find((r) => /^Asked which job/.test(r.note || ""));
      const from0 = doors.length ? doors[0].created_at || "" : asked?.created_at || "";
      // (pictures since the door's, waiting or placed: the number is theirs; and
      // the question answered only while nothing came from them since but the
      // door's own pictures, which the office may have placed already. A send
      // they put on its job by its own number is not one a bare number moves,
      // unless it says the job was wrong: the door's picture is still waiting)
      // (the database looks, not a few rows read back: five pieces placed by their number would hide one still waiting)
      const newer = from0 ? (await db.get<{ id: string }>(`texted_photos?employee_id=eq.${emp.id}&status=in.(held,filed)&created_at=gt.${enc(from0)}&and=(or(how.is.null,how.neq.noaccess)${FIX_WORDS.test(body) ? "" : ",or(status.eq.held,how.is.null,how.not.in.(number,burst))"})&select=id&limit=1`)).rows.length > 0 : false;
      // (a send they put on a job by its own number is no answer either, as for newer)
      const talked = asked?.created_at ? (await db.get<{ id: string }>(`texted_photos?employee_id=eq.${emp.id}&msg_sid=not.is.null&created_at=gt.${enc(asked.created_at)}&and=(or(how.is.null,how.neq.noaccess)${FIX_WORDS.test(body) ? "" : ",or(status.neq.filed,how.is.null,how.not.in.(number,burst))"})&select=id&limit=1`)).rows.length > 0 : false;
      // (a PO with a dash or a letter, "220011-2": the whole of it, the way its key reads)
      const n = refsIn(noPlace(body)).map((r) => r.n).sort((a, b) => b.length - a.length)[0] || "";
      // (the job they put pictures on by its number since: they're at that one, it isn't the door)
      const there = async () => {
        const on = (await db.get<{ pact_job_id?: string | null; release_id?: string | null }>(`texted_photos?employee_id=eq.${emp.id}&status=eq.filed&how=in.(number,burst)&created_at=gt.${enc(from0)}&select=pact_job_id,release_id&limit=20`)).rows.map((b) => b.pact_job_id || b.release_id || "");
        return on.length > 0 && (await todaysJobs(db, emp, today)).some((k) => on.includes(k.id) && k.keys.includes(n));
      };
      if ((doors.length || (asked && !talked)) && !newer && !(await there())) {
        const flow = await nobodyFlow(db, { emp, emps: emps.rows, body: `NO ${n}`, from, sid, now, say: inb.deliver });
        if (flow.handled) {
          if (flow.missed) for (const d of doors) await fileBatch(db, d, flow.missed, "noaccess", "noaccess");
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
    // (a voice note or a file with the words: not kept, and they hear so)
    const notKept = other > 0 ? replyText({ k: "notphoto" }, lang) : "";
    const words = async (): Promise<string | undefined> => {
      told.notKept = other > 0;
      if (isAck(body)) return firstEver ? say({ k: "connected" }, lang) : answer(notKept || undefined);
      await remember(db, said, "words", undefined, notKept ? `Sent with ${other === 1 ? "a voice note or a file" : `${other} voice notes or files`} the portal can't keep` : "", "reply");
      if (firstEver) return say({ k: "connected" }, lang);
      if (notKept) return answer(isEs(lang)
        ? `Gracias, la oficina verá su texto, pero no ${other === 1 ? "la nota de voz o el archivo" : "las notas de voz o los archivos"}: solo se guardan fotos y videos.`
        : `Thanks, the office will see your text, but not the ${other === 1 ? "voice note or file" : "voice notes or files"}: only photos and videos go on the job.`);
      return inb.jobHint ? answer() : answer(toldOfficeText(lang));
    };
    // a job's number: the pictures they just sent go there: ones still
    // waiting (two days), or ones put on the wrong job (the last two hours).
    // Only a text that is just the number ("On my way to PO 116843" moves
    // nothing). "Just sent" is the last batch and any sent within ten minutes
    // of it (a phone often splits five pictures into five texts); a piece that
    // named its own job stays there, unless it's the newest (its PO typed wrong)
    // (the job's place copied with its number, as the question listed it, is the number)
    const nbody = noPlace(body);
    if (!refsIn(nbody).length || !justANumber(body)) return words();
    // the question their DONE or NOT DONE got a moment ago ("Which job is
    // finished? Reply like: DONE 116843 …"), the last thing from them: the
    // number answers it. Photos waiting for "which job?" from before it go on
    // the job too (their own pile; with NOT DONE, nothing is marked)
    const lastSaid = (await db.get<{ how?: string | null; note?: string | null; pact_job_id?: string | null; release_id?: string | null }>(`texted_photos?employee_id=eq.${emp.id}&msg_sid=not.is.null&created_at=gte.${since(30 * 60_000)}&order=created_at.desc&limit=1&select=how,note,pact_job_id,release_id`)).rows[0];
    if (lastSaid && (lastSaid.how === "donetext" || lastSaid.how === "notdone") && !lastSaid.pact_job_id && !lastSaid.release_id) {
      const { rows, mine } = await jobsOf(db, emp, today);
      const p = pickJob(nbody, rows, mine, today, await anyPoOf(db, nbody, mine));
      if (p.kind !== "ask" && p.why === "number") {
        const not = lastSaid.how === "notdone";
        const all = !not && lastSaid.note === "all";
        const held = (await db.get<Batch>(`texted_photos?employee_id=eq.${emp.id}&status=eq.held&created_at=gte.${since(2 * 3_600_000)}&order=created_at.desc&limit=20&select=*`)).rows.filter((b) => b.how !== "noaccess");
        const top = held.length ? msOf(held[0]) : 0;
        const placed = held.length ? await placeOn(db, { ...said, sid: "" }, held.filter((b) => top - msOf(b) <= BURST_MS), p, { noMark: not, all }) : null;
        if (!not && placed && p.kind === "pact" && (await threadJob(db, p.id))?.work_done) return answer(placed);
        const word = not ? "NOT DONE" : all ? "ALL DONE" : "DONE";
        const said2: Said = { ...said, body: `${word} ${p.label}` };
        const r2 = not ? await notDoneIn(db, said2) : await doneIn(db, said2, all ? "all" : "done");
        const both = [placed, r2].filter(Boolean).join(" ");
        if (both) return answer(both);
      }
    }
    const recent = (await db.get<Batch>(`texted_photos?employee_id=eq.${emp.id}&or=(and(status.eq.held,created_at.gte.${since(2 * 86_400_000)}),and(status.eq.filed,created_at.gte.${since(2 * 3_600_000)}))&order=created_at.desc&limit=20&select=*`)).rows
      .filter((b) => b.how !== "noaccess");
    if (!recent.length) return words();
    const lastAt = msOf(recent[0]) || now.getTime();
    // (the newest piece's own send: pieces a minute and a half apart, the PO on any of them)
    const send = new Set<string>();
    for (let i = 0, at = lastAt; i < recent.length && at - msOf(recent[i]) <= SPLIT_MS; at = msOf(recent[i]), i++) send.add(recent[i].id);
    // (pieces an earlier number answer placed stay where it put them: only the newest send moves with them)
    let group = recent.filter((b) => msOf(b) >= lastAt - BURST_MS && (send.has(b.id) || b.status === "held" || (b.how !== "number" && !refsIn(b.body || "").length)));
    // the newest send went on its job by its own number already (each of its
    // pieces), and older photos still wait for one (they were asked "Which
    // job?"): a bare number is theirs ("wrong job, it's 116843" is the way to
    // move the newest)
    const newest = recent.filter((b) => send.has(b.id));
    const waiting = recent.filter((b) => b.status === "held" && !send.has(b.id));
    if (!FIX_WORDS.test(body) && waiting.length && newest.length && newest.every((b) => b.status === "filed" && ["number", "burst"].includes(b.how || "")) && newest.some((b) => b.how === "number")) {
      const top = msOf(waiting[0]);
      group = waiting.filter((b) => top - msOf(b) <= BURST_MS);
    }
    const { rows, mine } = await jobsOf(db, emp, today);
    const pick = pickJob(nbody, rows, mine, today, await anyPoOf(db, nbody, mine));
    if (pick.kind !== "ask" && pick.why === "number") { const r = await placeOn(db, said, group, pick); return r ? answer(r) : words(); }
    if (pick.kind === "ask" && pick.why === "unknown" && group.some((b) => b.status === "held")) {
      const c = countOf(namesIn(group.filter((b) => b.status === "held")));
      return say({ k: "unknown", number: pick.number || "", n: c.n, v: c.v }, lang);
    }
    return words();
    })();
    const line = other > 0 && !told.notKept ? notKeptLine(other, lang) : "";
    if (!line) return r;
    // (in a crew's thread, nothing is posted for a voice note alone)
    return answer(r ? `${r}\n${line}` : inb.jobHint ? undefined : line);
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

  // a picture that didn't come through is said, by count, with whatever did,
  // even in a quiet piece; a phone nobody knows reads it in both languages
  const lostLine = (n: number) => (emp ? replyText({ k: "lost", n }, lang) : `${replyText({ k: "lost", n }, "en")} / ${replyText({ k: "lost", n }, "es")}`);
  const withLost = (msg: string, stored: number) => (photos.length > stored && stored > 0 ? `${msg}\n${lostLine(photos.length - stored)}` : msg);
  // the door's pictures of this send so far (a phone splits a video and a photo into two texts): the count in all
  // (theirs only: a co-worker's door pictures on the same notice aren't this send's; photoName carries the first name)
  const me = (emp?.name || "").trim().split(/\s+/)[0].toLowerCase().normalize("NFD").replace(/[^a-z]/g, "").slice(0, 12) || "crew";
  const doorCount = (names: string[]) => countOf(names.filter((x) => photoAt(x) >= now.getTime() - SPLIT_MS - 1_000 && x.split("_")[3] === me));

  // a picture of a door nobody opened: within five minutes of their own "no"
  // (a phone sends the words and the picture as two texts), or with only the
  // door's words ("door", "puerta cerrada", "closed") while a door of theirs
  // is flagged today. It goes on that door's notice (a co-worker's, when they
  // reported it first). Their "no" that asked "which job has nobody home?",
  // or came after hours, has no door yet, and two doors flagged today could
  // be either: the picture waits as the door's, for its number (or the
  // office). Words about the work ("door frame done", "after door
  // installed") make them work pictures, placed the usual way.
  const doorCap = doorOnly(body);
  if (emp && !refsIn(body).length && (!body.trim() || doorCap)) {
    type Notice = { id: string; status?: string | null; pact_job_id?: string | null; release_id?: string | null; photos?: Photo[] | null; created_at?: string | null; note?: string | null };
    const own = (await db.get<Notice>(`texted_photos?employee_id=eq.${emp.id}&how=eq.nobody&status=in.(nobody,note,reply)&msg_sid=not.is.null&created_at=gte.${since(5 * 60_000)}&select=id,status,pact_job_id,release_id,photos,created_at,note&order=created_at.desc&limit=1`)).rows[0];
    let n: Notice | undefined = own && own.status === "nobody" ? own : undefined;
    let hold = false;
    if (!n && (own || doorCap)) {
      const open = (await db.get<Notice>(`texted_photos?status=eq.nobody&how=eq.nobody&created_at=gte.${since(20 * 3_600_000)}&select=id,pact_job_id,release_id,photos,created_at&limit=20`)).rows
        .filter((x) => x.created_at && nyDay(new Date(x.created_at)) === today && todayIds.has(x.pact_job_id || x.release_id || ""));
      if (open.length === 1) n = open[0];
      else if (open.length > 1) hold = true;
      else if (own && !own.pact_job_id && !own.release_id && /^Asked which job|after hours/i.test(own.note || "")) hold = true;
    }
    const t = n ? (n.pact_job_id ? { kind: "pact" as const, id: n.pact_job_id } : n.release_id ? { kind: "rel" as const, id: n.release_id } : null) : null;
    // (kept for the office, or for the number, as a door's: one row of its own, this text's;
    // `job`: the door is known, so it waits for the office only)
    const holdDoor = async (put: Photo[], batchId = randomUUID(), job?: { kind: "pact" | "rel"; id: string }): Promise<string | undefined> => {
      const inbox = inboxOf(batchId);
      const kept: Photo[] = [];
      for (const p of put) if (p.path.startsWith(inbox) || (await db.move(p.path, inbox + p.name))) kept.push({ name: p.name, path: inbox + p.name });
      if (!kept.length || !(await db.insert("texted_photos", { id: batchId, employee_id: emp.id, from_phone: from, body, photos: kept, status: "held", how: "noaccess", msg_sid: sid || null, ...jobCols(job) }))) {
        await db.remove(kept.map((p) => p.path));
        return say({ k: "resend" }, lang);
      }
      const sent = (await db.get<Batch>(`texted_photos?employee_id=eq.${emp.id}&status=eq.held&how=eq.noaccess&created_at=gte.${since(SPLIT_MS)}&select=photos&limit=10`)).rows;
      const all = doorCount(namesIn(sent));
      return answer(withLost(doorGotText(all.n > kept.length ? all : countOf(kept.map((p) => p.name)), lang), kept.length));
    };
    if (hold) {
      const batchId = randomUUID();
      const put = await store(inboxOf(batchId), "noaccess");
      if (!put.length) return answer(lostLine(photos.length));
      return holdDoor(put, batchId);
    }
    if (n && t && !(await sentNextDoor(db, emp.id, t, own?.created_at || n.created_at || ""))) {
      const put = await store(pileDir(t, "noaccess"), "noaccess");
      if (!put.length) return answer(lostLine(photos.length));
      if (await db.attach(t, put, [])) {
        const all = [...(n.photos || []), ...put];
        await db.patch(`texted_photos?id=eq.${n.id}`, { photos: all });
        await db.insert("texted_photos", { employee_id: emp.id, from_phone: from, body, photos: [], status: "note", how: "noaccess", msg_sid: sid || null, ...jobCols(t) });
        const c = doorCount(all.map((p) => p.name));
        return answer(withLost(doorGotText(c.n > put.length ? c : countOf(put.map((p) => p.name)), lang), put.length));
      }
      // (the job's documents wouldn't take them: they wait for the office, as the door's)
      return holdDoor(put, undefined, t);
    }
  }
  // a picture of the door with "nobody home" (or a plain NO with the picture
  // of a door they haven't been through today): it goes on that job, and they
  // get their next one. A NO with pictures of a job they're working on is
  // not a door: those go on the job as usual.
  if (emp && nobodyHome(body)) {
    const plain = bareNo(body);
    let kept = -1;
    const flow = await nobodyFlow(db, { emp, emps: emps.rows, body, from, sid, now, proof: async (dir) => { const p = await store(dir, "noaccess"); kept = p.length; return p; }, say: inb.deliver, photosIn: plain, hint: inb.jobHint?.id });
    if (flow.handled) {
      if (!flow.missed) {
        // which job wasn't clear: the pictures wait for the answer, as a door's (the answer asks)
        const batchId = randomUUID();
        const put = await store(inboxOf(batchId), "noaccess");
        kept = put.length;
        if (put.length && !(await db.insert("texted_photos", { id: batchId, employee_id: emp.id, from_phone: from, body, photos: put, status: "held", how: "noaccess" }))) await db.remove(put.map((p) => p.path));
      }
      // (a picture that didn't come through: said, after the answer if that went out already)
      const lost = kept >= 0 && kept < photos.length ? lostLine(photos.length - kept) : "";
      return answer(flow.reply ? (lost ? `${flow.reply}\n${lost}` : flow.reply) : lost || undefined);
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
  // the send doesn't, for the minute and a half its pieces take to come in)
  if (emp && burst.length) {
    // (a text of theirs, not a row the portal wrote for itself, which has no message id)
    const talk = (await db.get<{ created_at?: string | null; how?: string | null }>(`texted_photos?employee_id=eq.${emp.id}&status=in.(measure,note,nobody,reply,seen,opened,moved,done)&msg_sid=not.is.null&or=(how.is.null,and(how.neq.afterflip,how.neq.afterask),created_at.lt.${since(FRESH_MS)})&created_at=gte.${since(BURST_MS)}&order=created_at.desc&select=created_at,how&limit=1`)).rows[0];
    // (an AFTER said about the send, a minute and a half ago or more: its pieces
    // are the ones up to a minute and a half after it, and these are a new send)
    const cut = talk?.created_at ? msOf(talk) + (SAID_ABOUT.has(talk.how || "") ? FRESH_MS : 0) : 0;
    if (cut) burst = burst.filter((b) => msOf(b) > cut);
  }
  let pick: ReturnType<typeof pickJob> = { kind: "ask", why: "none" };
  // (the job named by this text's own number)
  let ownNumber = false;
  let ignore: string[] = [];
  let todays: JobKey[] = [];
  // (the guess was a door reported shut today: asked which of today's jobs)
  let shutAsk = false;
  if (emp) {
    const { rows, mine } = jobs;
    const anyPo = await anyPoOf(db, body, mine);
    pick = withHint(pickJob(body, rows, mine, today, anyPo, { photos: true }), mine, inb.jobHint, rows, today);
    ownNumber = pick.kind !== "ask" && pick.why === "number";
    // pictures posted in one job's thread are that job's, not the one texted last (still a guess for finished work)
    if (pick.kind !== "ask" && pick.why === "told" && inb.jobHint && inb.jobHint.id !== pick.id && todayIds.has(inb.jobHint.id)) {
      const h = mine.find((k) => k.kind === inb.jobHint!.kind && k.id === inb.jobHint!.id);
      if (h) pick = { kind: h.kind, id: h.id, label: h.label, street: h.street, apt: h.apt, why: "told" };
    }
    ignore = [...mine, ...anyPo].flatMap((j) => j.keys);
    todays = mine.filter((k) => todayIds.has(k.id));
    // a guess (the job texted last, or the thread's) on a door the crew
    // reported nobody home at today, with another of today's jobs open: they're
    // asked which job, so a door nobody opened is never worked or finished by a guess
    if (pick.kind !== "ask" && pick.why === "told" && todays.length > 1 && (await doorShutToday(db, pick, today))) { pick = { kind: "ask", why: "many" }; shutAsk = true; }
  }
  // which pile: BEFORE, unless they say AFTER (lib/jobFlow photoKindFor): the
  // word with them, AFTER texted just before (or a DONE answered by asking for
  // them), or the send they're in the middle of
  // (in a crew's thread about one of today's jobs: a co-worker's window on it counts too)
  const threadToday = inb.jobHint && todayIds.has(inb.jobHint.id) ? inb.jobHint.id : "";
  let win = emp ? await afterWindow(db, emp.id, now, threadToday || undefined) : null;
  const cap = captionKind(body);
  // (a window for a job that isn't one of today's, while they have one today:
  // only for the photos sent right away, or the ones they caption AFTER)
  if (win && win.jobId && todayIds.size && !todayIds.has(win.jobId) && now.getTime() - win.at > ELSEWHERE_WINDOW_MS && cap !== "after") win = null;
  // (their photos went on another job since it opened: they've moved on, and only photos captioned AFTER are its)
  if (win && win.movedOn && cap !== "after") win = null;
  // pictures captioned BEFORE ("before", "just got here") are an arrival, not
  // the window's; pictures posted in one of today's jobs' threads are that
  // job's, whatever another job's window says
  if (win && (cap === "before" || (!!threadToday && !!win.jobId && win.jobId !== threadToday && !ownNumber))) win = null;
  // no number in this one, but the send it's part of named the job (or went
  // on the job an AFTER was asked for): the same job. With a window open for
  // another job, only a piece right behind it (a minute and a half) is
  // that send's: later ones are the window's
  // (a number that fits nothing is never guessed past: the office sorts it)
  let how = pick.kind === "ask" ? "" : pick.why === "number" ? "number" : "day";
  const named = (k: ReturnType<typeof pickJob>) => (k.kind === "ask" ? k.why !== "unknown" : k.why !== "number");
  if (named(pick)) {
    const lead = [...burst].reverse().find((b) => b.status === "filed" && ["number", "burst", "window", "aftersaid"].includes(b.how || "") && (b.pact_job_id || b.release_id));
    const away = !!lead && !!win && !!win.jobId && (lead.pact_job_id || lead.release_id) !== win.jobId && now.getTime() - msOf(lead) > SPLIT_MS;
    const t = lead && !away ? await targetOf(db, lead) : null;
    if (t && lead) { pick = { ...t, why: "number" }; how = lead.how === "window" || lead.how === "aftersaid" ? lead.how : "burst"; }
  }
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
  // (the pieces of this send just before this one, each within a minute and a half of the next)
  const chain = new Set<string>();
  for (let i = burst.length - 1, at = now.getTime(); i >= 0 && at - msOf(burst[i]) <= SPLIT_MS; at = msOf(burst[i]), i--) chain.add(burst[i].id);
  const strays = how === "number" ? burst.filter((b) => b.status === "held" || (b.status === "filed" && ["day", "window", "aftersaid"].includes(b.how || "") && !onTarget(b) && chain.has(b.id))) : [];
  // the send's last piece: on this job, waiting, or coming over with this one
  // (one waiting that they said AFTER about is in AFTER, wherever it goes)
  const lastOfSend = [...burst].reverse().find((b) => (b.photos || []).length && (!target || b.status === "held" || onTarget(b) || strays.includes(b)));
  const pileOfPiece = (b: Batch): PhotoKind | null => (saidAfterHeld(b) ? "after" : kindOfName(b.photos![0].name));
  // a DONE a moment ago, answered by asking for the after photos, and nothing
  // on the job's day from an hour before: the phone sent these with the DONE
  // ("done sending", maybe). They stay BEFORE, and they're asked
  let askAfter = false;
  // (the AFTER photos asked for, or said, are the window's job's; AFTER they
  // texted with no job named in it is about the next send, and so is one on a
  // job these photos name by their own number, unless their photos went on
  // another job since: they've moved on)
  let afterAsked = !!win && (!win.jobId || (!!target && target.id === win.jobId) || (win.how === "aftersay" && ownNumber && !win.named && !win.movedAny));
  // (not when the DONE marked the job done: those are the photos it asked for)
  if (win && win.how === "afterwait" && !win.marked && !thread?.work_done && now.getTime() - win.at < DONE_SENT_MS && target && (!win.jobId || target.id === win.jobId) && !cap && (await arrivalOnly(db, target, thread, now.getTime(), today))) { afterAsked = false; askAfter = true; }
  let kind: PhotoKind = photoKindFor(body, { afterAsked, burst: lastOfSend ? pileOfPiece(lastOfSend) : null });
  // held instead of guessed: "which job?", with the jobs it could be by name
  let holdFor: JobKey[] = [];
  if (thread && target && pick.kind !== "ask") {
    // finished work on a job picked by a guess (the job texted last, the
    // thread's own) never marks it done: the worker says which
    // (unless the send's piece before this one went on it by the guess and
    // their AFTER just moved it to AFTER there: this piece follows it, and the
    // "wrong job?" line they got is about both)
    const followsFlip = !!lastOfSend && lastOfSend.status === "filed" && onTarget(lastOfSend) && lastOfSend.how === "day" && pileOfPiece(lastOfSend) === "after";
    // (a door nobody opened today isn't a job it could be)
    if (pick.why === "told" && kind === "after" && todays.length > 1 && !followsFlip) {
      const doors = await flaggedToday(db, todays.map((k) => k.id), now, today);
      const could = todays.filter((k) => !doors.has(k.id));
      if (could.length !== 1 || could[0].id !== target.id) holdFor = could.length > 1 ? could : todays;
    }
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
  // the pictures as two texts, both at once), that the window above didn't
  // see: these are the after pictures (in a crew's thread, a co-worker's word
  // on its job too). One about another job isn't about these, unless it named
  // that job and only the day's guess put these here: they go there. A DONE's
  // ask for the after photos, with these the job's arrival (and the job not
  // marked by it), asks about them instead ("done sending", maybe), and so
  // does the portal's own question about the send. A piece of the same send
  // captioned AFTER that landed meanwhile takes these along
  type Late = { how: "after" | "ask"; to?: { kind: "pact" | "rel"; id: string } };
  const lateAfter = async (): Promise<Late | null> => {
    if (!emp || kind !== "before" || cap || askAfter) return null;
    const recent2 = enc(new Date(now.getTime() - 2_000).toISOString());
    const who = threadToday ? `or=(employee_id.eq.${emp.id},pact_job_id.eq.${threadToday},release_id.eq.${threadToday})` : `employee_id=eq.${emp.id}`;
    type LateRow = { id: string; how?: string | null; note?: string | null; pact_job_id?: string | null; release_id?: string | null };
    const rows = (await db.get<LateRow>(`texted_photos?${who}&how=in.(aftersay,afterwait,afterflip,afterask)&created_at=gte.${recent2}&order=created_at.desc&select=id,how,note,pact_job_id,release_id&limit=3`)).rows
      .filter((r) => r.id !== win?.id);
    const jobOfRow = (r: LateRow) => r.pact_job_id || r.release_id || "";
    let r = rows.find((x) => !target || !jobOfRow(x) || jobOfRow(x) === target.id);
    let to: Late["to"];
    if (!r) {
      // (on the day's guess: the job their AFTER named, or the one their DONE just marked, as its window would have put them)
      const named = rows.find((x) => ((x.how === "aftersay" && x.note === "named") || (x.how === "afterwait" && x.note === "marked")) && jobOfRow(x));
      if (named && (!target || how === "day")) { r = named; to = { kind: named.pact_job_id ? "pact" : "rel", id: jobOfRow(named) }; }
    }
    // (waiting for "which job?": the job their AFTER named, or the one their
    // DONE just marked, as its window would have put them; a number that fits nothing stays the office's)
    else if (!target && jobOfRow(r) && ((r.how === "aftersay" && r.note === "named") || (r.how === "afterwait" && r.note === "marked")) && !(pick.kind === "ask" && pick.why === "unknown")) to = { kind: r.pact_job_id ? "pact" : "rel", id: jobOfRow(r) };
    if (!r) {
      const mate = (await db.get<Batch>(`texted_photos?employee_id=eq.${emp.id}&status=in.(held,filed)&created_at=gte.${recent2}&id=neq.${batchId}&order=created_at.desc&limit=3&select=id,status,body,how,pact_job_id,release_id`)).rows
        .find((b) => (captionKind(b.body || "") === "after" || saidAfterHeld(b)) && (target ? b.status === "filed" && onTarget(b) : b.status === "held"));
      return mate ? { how: "after" } : null;
    }
    // (a window these used: closed, a co-worker's too)
    if (r.how === "aftersay" || r.how === "afterwait") await db.patch(`texted_photos?id=eq.${r.id}&status=eq.note`, { status: "seen" });
    await closeWindows(db, emp.id, now);
    if (r.how === "afterask") return { how: "ask" };
    if (r.how === "afterwait" && r.note !== "marked" && target && !to) {
      const th = thread ? await threadJob(db, thread.id) : null;
      if (!th?.work_done && (await arrivalOnly(db, target, th, now.getTime(), today))) return { how: "ask" };
    }
    return { how: "after", to };
  };
  // their "no" landed while these came in (the phone sent the words and the
  // picture as two texts): with no words but the door's, these are the door's.
  // A door they were asked about ("which job has nobody home?") or reported
  // after hours: they wait as the door's
  const lateDoor = async (): Promise<string | undefined | null> => {
    if (!emp || cap || (body.trim() && !doorCap) || refsIn(body).length) return null;
    type N = { id: string; status?: string | null; note?: string | null; pact_job_id?: string | null; release_id?: string | null };
    const n = (await db.get<N>(`texted_photos?employee_id=eq.${emp.id}&how=eq.nobody&status=in.(nobody,note,reply)&msg_sid=not.is.null&created_at=gte.${enc(new Date(now.getTime() - 2_000).toISOString())}&order=created_at.desc&limit=1&select=id,status,note,pact_job_id,release_id`)).rows[0];
    if (!n) return null;
    const mine = (await db.get<Batch>(`texted_photos?id=eq.${batchId}&select=*`)).rows[0];
    if (!mine) return null;
    if (n.status === "nobody" && (n.pact_job_id || n.release_id)) {
      const t2 = await targetOf(db, { id: "", pact_job_id: n.pact_job_id || null, release_id: n.pact_job_id ? null : n.release_id || null });
      if (!t2 || !(await fileBatch(db, mine, t2, "noaccess", "noaccess"))) return null;
      const back = (await db.get<Batch>(`texted_photos?id=eq.${batchId}&select=photos`)).rows[0]?.photos || [];
      return answer(withLost(doorGotText(countOf(back.map((p) => p.name)), lang), back.length));
    }
    if (n.status === "note" && !n.pact_job_id && !n.release_id && /^Asked which job|after hours/i.test(n.note || "")) {
      if (!(await holdBatch(db, mine, "noaccess"))) return null;
      return answer(withLost(doorGotText(countOf(put.map((p) => p.name)), lang), put.length));
    }
    return null;
  };
  // (the AFTER's own request moved these first: its answer is the one they get)
  let answeredThere = false;
  const movedToAfter = async () => namesIn((await db.get<Batch>(`texted_photos?id=eq.${batchId}&select=photos`)).rows).some((x) => kindOfName(x) === "after");
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
    // (a co-worker's window in the crew's thread, used by these: it's closed)
    if (emp && win && afterAsked && win.empId !== emp.id) await db.patch(`texted_photos?id=eq.${win.id}&status=eq.note`, { status: "seen" });
    // (their "no" came with these: the door's)
    const door = await lateDoor();
    if (door !== null) return door;
    const late = await lateAfter();
    if (late?.how === "ask") askAfter = true;
    else if (late?.how === "after") {
      const mine = (await db.get<Batch>(`texted_photos?id=eq.${batchId}&select=*`)).rows[0];
      const st: FileOut = {};
      // (the AFTER named another job, and only the guess put these here: they go there)
      const to = late.to && late.to.id !== target.id ? await targetOf(db, { id: "", pact_job_id: late.to.kind === "pact" ? late.to.id : null, release_id: late.to.kind === "rel" ? late.to.id : null }) : null;
      const flipped = !to && !!mine && namesIn([mine]).every((x) => kindOfName(x) === "after");
      if (mine && (flipped || (await fileBatch(db, mine, to || target, to ? "aftersaid" : how, "after", st)))) {
        kind = "after";
        if (to) { target = { kind: to.kind, id: to.id, label: to.label, street: to.street, apt: to.apt, why: "number" }; how = "aftersaid"; }
        // (read again: an ALL DONE at the same moment may have ended it)
        thread = target.kind === "pact" ? await threadJob(db, target.id) : null;
        quiet = quietFor(kind);
        answeredThere = flipped || !!st.already;
        const moved = (await db.get<{ photos?: Photo[] | null }>(`texted_photos?id=eq.${batchId}&select=photos`)).rows[0]?.photos;
        if (moved?.length) put.splice(0, put.length, ...moved);
      }
    }
    // they got in after all (a co-worker's "nobody home" this morning): the warning comes off
    if (emp) await doorOpened(db, target, emp, now, today);
    if (answeredThere && !strays.length) return hush();
    let moved = 0;
    // (an ALL DONE said about one that moved, as it was when it moved)
    let strayAll = false;
    if (strays.length) {
      // (the jobs they left, as each move found them: marked done by these, they aren't any more)
      const leaving = new Map<string, boolean>();
      for (const b0 of strays) {
        let b = b0;
        for (let i = 0; i < 2; i++) {
          const st: FileOut = {};
          // (one waiting they said AFTER about stays AFTER; one captioned keeps its own words)
          const n = await fileBatch(db, b, target, "number", saidAfterHeld(b) ? "after" : captionKind(b.body || "") || kind, st);
          moved += n;
          if (n && st.from?.kind === "pact") leaving.set(st.from.id, !!leaving.get(st.from.id) || wasAfter(b));
          if (n && b.how === "afterall") strayAll = true;
          // (said AFTER about that moment, still waiting: again, as it is now; one
          // another text put on a job that moment stays where that text put it,
          // and one their "no" made the door's waits for its door)
          if (!st.changed || b0.status !== "held") break;
          const fresh = (await db.get<Batch>(`texted_photos?id=eq.${b.id}&select=*`)).rows[0];
          if (!fresh || fresh.status !== "held" || fresh.how === "noaccess") break;
          b = fresh;
        }
      }
      for (const [id, after] of leaving) await clearDoneIfNoAfter(db, id, jobName(target, "en"), now, today, after);
    }
    // AFTER said on this piece: the pieces of the same send just before
    // (each within a minute and a half of the next), on this job with nothing
    // said, are the after pictures too
    if (kind === "after" && cap === "after") {
      for (const b of burst) {
        if (b.status === "filed" && onTarget(b) && chain.has(b.id) && !captionKind(b.body || "") && namesIn([b]).every((x) => kindOfName(x) === "before")) moved += await fileBatch(db, b, target, b.how || how, "after");
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
    if (askAfter) {
      // (the row says what was asked: a "yes" to it is an AFTER)
      if (emp) await putRow(db, { employee_id: emp.id, from_phone: from, body, status: "note", how: "afterask", photos: [], ...jobCols(target) });
      settle(c);
      return said(gotBeforeAskText(c, name, lang));
    }
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
      // ("all done" with them, or said about the ones waiting that came along: finished early, the days after come off)
      if (said2 && kind === "after" && L.before && (allDoneSaid(body) || strayAll)) {
        const d = await doneIn(db, said2, "all", thread);
        if (d) { settle(c); return said(`${gotPhotosText(c, kind, name, lang)} ${d}`); }
      }
      // ("kitchen done, starting the bathroom": finished work, maybe not the job: they're asked)
      const mixed = kind === "after" && !L.before && mixedCaption(body);
      const marked = kind === "after" && emp && !L.before && !mixed && !notDone(body) ? await markDone(db, thread, emp, { from, now, finish: dayPile(thread, today).cur }) : false;
      if (quiet && !moved && !measured && !marked && !asked) { settle(none); return hush(); }
      // (an AFTER texted with these moved them while this answer was made: its own answer says so)
      if (kind === "before" && (await movedToAfter())) return hush();
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
    if (kind === "before" && (await movedToAfter())) return hush();
    settle(c);
    return said(replyText({ k: "filed", n: c.n, v: c.v, label: name, kind }, lang));
  }
  // nowhere to put them yet: they wait for the office (or for the number the
  // answer asks for), unless there's no place to keep them waiting (RUN_ME
  // section 20 not run), and then the worker is asked to send them again with the number
  // (an AFTER said with them, or texted just before, stays with them while they wait)
  // (and an ALL DONE said about the send's piece before, waiting too, stays one)
  const heldHow = lastOfSend && lastOfSend.status === "held" && lastOfSend.how === "afterall" ? "afterall" : "after";
  if (!(await db.insert("texted_photos", { ...row, status: "held", ...(kind === "after" ? { how: heldHow } : {}) }))) {
    await db.remove(put.map((p) => p.path));
    return say({ k: "resend" }, lang);
  }
  // (their "no" came with these: the door's, waiting for its number)
  if (emp && !holdFor.length) { const door = await lateDoor(); if (door !== null) return door; }
  // (AFTER texted while they were on their way: they're the after pictures, wherever they go)
  const late = await lateAfter();
  if (late?.how === "after") {
    kind = "after";
    // (one another request is moving that moment keeps its claim; an ALL DONE said about them stays one)
    await db.patch(`texted_photos?id=eq.${batchId}&status=eq.held&or=(how.is.null,how.not.in.(moving,afterall))`, { how: "after" });
    // (the AFTER named their job: on it now, in AFTER, as its window would have put them)
    const to = late.to && emp ? await targetOf(db, { id: "", pact_job_id: late.to.kind === "pact" ? late.to.id : null, release_id: late.to.kind === "rel" ? late.to.id : null }) : null;
    const mine = to ? (await db.get<Batch>(`texted_photos?id=eq.${batchId}&select=*`)).rows[0] : undefined;
    if (to && emp && mine && (await fileBatch(db, mine, to, "aftersaid", "after"))) {
      // they got in after all (a co-worker's "nobody home" this morning): the warning comes off
      await doorOpened(db, to, emp, now, today);
      const c2 = countOf(put.map((p) => p.name));
      const name2 = jobName(to, lang);
      const th = to.kind === "pact" ? await threadJob(db, to.id) : null;
      if (!th) return said(replyText({ k: "filed", n: c2.n, v: c2.v, label: name2, kind: "after" }, lang));
      // (the words with them still count, as on that job: "not done yet" runs it on, "kitchen done, starting the bath" asks)
      if (notDoneStrong(body) && nyHour(now) >= 11) return said(`${gotPhotosText(c2, "after", name2, lang)} ${await notDoneIn(db, { emp, emps: emps.rows, body, from, sid: "", now, today, hint: inb.jobHint }, th)}`);
      await closeQuestion(db, th.id);
      const L2 = onLastDay(th, today);
      if (L2.before) return said(gotAfterDayText(c2, name2, { day: L2.day, of: L2.of, next: L2.next, today }, lang, lost));
      if (mixedCaption(body)) return said(`${gotPhotosText(c2, "after", name2, lang)} ${finishedAskText(lang)}`);
      const marked2 = !notDone(body) ? await markDone(db, th, emp, { from, now, finish: dayPile(th, today).cur }) : false;
      return said(gotAfterText(c2, name2, lang, marked2, lost));
    }
  }
  // (the send's piece before this one was put on its job by their number a
  // moment ago, while this one came in: this one goes with it, on its pile)
  const waitedWith = burst.filter((b) => b.status === "held" && chain.has(b.id)).map((b) => b.id);
  if (emp && !holdFor.length && waitedWith.length) {
    const mate = (await db.get<Batch>(`texted_photos?id=in.(${waitedWith.join(",")})&status=eq.filed&how=in.(number,burst)&order=created_at.desc&limit=1&select=*`)).rows[0];
    const t2 = mate ? await targetOf(db, mate) : null;
    const mine = t2 ? (await db.get<Batch>(`texted_photos?id=eq.${batchId}&select=*`)).rows[0] : undefined;
    const pile: PhotoKind = kind === "after" ? "after" : kindOfName((mate?.photos || [])[0]?.name || "") || "before";
    if (t2 && mine && (await fileBatch(db, mine, t2, "burst", pile))) {
      waitUntil(settleBurst(db, { emp, batchId, target: t2, kind: pile, said: { n: 0, v: 0 }, lang, from, now, deliver: inb.deliver }));
      return hush();
    }
  }
  // (quiet, unless this is the first piece of the send held to ask "which job?")
  if (quiet && !(holdFor.length && lastOfSend?.status !== "held")) return hush();
  const pc = countOf(put.map((p) => p.name));
  if (!emp) return said(replyText({ k: "stranger", n: pc.n, v: pc.v }));
  if (holdFor.length) return said(replyText({ k: "which", n: pc.n, v: pc.v, options: holdFor.slice(0, 3).map((k) => optionOf(k, lang)) }, lang));
  // (held for the shut door instead of the guess: the jobs it could be, the door's too, as above)
  if (shutAsk) return said(replyText({ k: "which", n: pc.n, v: pc.v, options: todays.slice(0, 3).map((k) => optionOf(k, lang)) }, lang));
  return said(replyText(pick.kind === "ask" && pick.why === "unknown" ? { k: "unknown", number: pick.number || "", n: pc.n, v: pc.v } : { k: "held", n: pc.n, v: pc.v }, lang));
}

// a PACT job of this worker's from the last few days that was left open: its
// last work day has passed, it has before pictures and no after pictures for
// that day, and it isn't marked done (or it is, by their DONE, and the portal
// is still waiting for the after photos it asked them for). (This worker sent
// pictures of it; the morning asked the crew about it; nobody answered yet.)
async function openElsewhere(db: Db, empId: string, notId: string, now: Date, today: string): Promise<JobKey[]> {
  const since = enc(new Date(now.getTime() - 4 * 86_400_000).toISOString());
  const rows = (await db.get<{ pact_job_id?: string | null; created_at?: string | null }>(`texted_photos?employee_id=eq.${empId}&status=eq.filed&pact_job_id=not.is.null&created_at=gte.${since}&select=pact_job_id,created_at&order=created_at.desc&limit=40`)).rows;
  // already sending pictures of this job today: they're here
  if (rows.some((r) => r.pact_job_id === notId && r.created_at && nyDay(new Date(r.created_at)) === today)) return [];
  const ids = [...new Set(rows.filter((r) => r.pact_job_id !== notId && r.created_at && nyDay(new Date(r.created_at)) < today).map((r) => r.pact_job_id as string))].slice(0, 3);
  // (the jobs the portal asked them for the after photos of, the last day)
  const asked = new Set((await db.get<{ pact_job_id?: string | null }>(`texted_photos?employee_id=eq.${empId}&how=eq.afterwait&pact_job_id=not.is.null&created_at=gte.${enc(new Date(now.getTime() - 86_400_000).toISOString())}&select=pact_job_id&limit=20`)).rows.map((r) => r.pact_job_id || ""));
  const out: JobKey[] = [];
  for (const id of ids) {
    const j = await threadJob(db, id);
    if (!j || j.canceled || (j.work_done && !asked.has(j.id)) || billed(j)) continue;
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
// the pictures that made a door "got in" were the door's after all (their
// "no" right after them): the notice is up again, without the "got in" line
async function doorShutAgain(db: Db, t: Target, emp: Emp, today: string): Promise<void> {
  const col = t.kind === "pact" ? "pact_job_id" : "release_id";
  const mark = `${firstName(emp) || "The crew"} got in at `;
  const open = (await db.get<{ id: string; note?: string | null; created_at?: string | null }>(`texted_photos?${col}=eq.${t.id}&status=eq.opened&how=eq.nobody&select=id,note,created_at&limit=5`)).rows
    .filter((n) => n.created_at && nyDay(new Date(n.created_at)) === today && (n.note || "").includes(mark));
  for (const n of open) {
    const note = (n.note || "").split(" · ").filter((x) => !x.startsWith(mark)).join(" · ");
    if (!(await db.patch(`texted_photos?id=eq.${n.id}`, { status: "nobody", note }))) await db.patch(`texted_photos?id=eq.${n.id}`, { status: "nobody" });
  }
}
// photos from a job someone texted "nobody home" about today: somebody got in.
// The ⚠ comes off, and the notice says so
// a "nobody home" notice on the job today that nobody has got in past
async function doorShutToday(db: Db, t: { kind: "pact" | "rel"; id: string }, today: string): Promise<boolean> {
  const col = t.kind === "pact" ? "pact_job_id" : "release_id";
  const rows = (await db.get<{ created_at?: string | null; employee_id?: string | null }>(`texted_photos?${col}=eq.${t.id}&how=eq.nobody&status=in.(nobody,seen,moved)&select=created_at,employee_id&order=created_at.desc&limit=5`)).rows;
  const n = rows.find((x) => !!x.created_at && nyDay(new Date(x.created_at)) === today);
  if (!n?.created_at) return false;
  // (pictures on the job since, not the door's: someone got in past it, the office's "Got it" or not;
  // the reporter's own of the minute after came with the "no", as doorOpened reads them)
  const got = (await db.get<{ created_at?: string | null; employee_id?: string | null }>(`texted_photos?${col}=eq.${t.id}&status=eq.filed&or=(how.is.null,how.neq.noaccess)&created_at=gt.${enc(n.created_at)}&select=created_at,employee_id&limit=20`)).rows;
  return !got.some((b) => !(b.employee_id === n.employee_id && msOf(b) - msOf(n) < 60_000));
}
// (`picsAt`: when the pictures were sent, for ones placed later by their number: a
// notice newer than they are stays up, they say nothing of anyone getting in after it)
async function doorOpened(db: Db, t: Target, emp: Emp, now: Date, today: string, picsAt?: number): Promise<void> {
  const col = t.kind === "pact" ? "pact_job_id" : "release_id";
  const at = picsAt ?? now.getTime();
  // (the reporter's own picture of the door, right after their "no", went on the notice: these are work pictures)
  // (nor their own "no" of the minute before these: the phone sent it with these)
  const open = (await db.get<{ id: string; note?: string | null; created_at?: string | null; employee_id?: string | null }>(`texted_photos?${col}=eq.${t.id}&status=eq.nobody&select=id,note,created_at,employee_id&limit=5`)).rows
    .filter((n) => n.created_at && nyDay(new Date(n.created_at)) === today && !(picsAt !== undefined && msOf(n) >= picsAt) && !(n.employee_id === emp.id && at - msOf(n) < 60_000));
  const when = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(now);
  for (const n of open) {
    const note = `${(n.note || "").trim()}${(n.note || "").trim() ? " · " : ""}${firstName(emp) || "The crew"} got in at ${when} and sent photos`;
    // "opened": off the calendar and the card like a seen one, but the morning still asks whether it got finished
    if (!(await db.patch(`texted_photos?id=eq.${n.id}`, { status: "opened", note }))) await db.patch(`texted_photos?id=eq.${n.id}`, { status: "opened" });
  }
}
