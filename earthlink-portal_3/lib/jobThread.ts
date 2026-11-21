// Server-only: a PACT job's thread by text, done with the portal's own key.
// lib/jobFlow decides and words it; this reads and writes: where the job is
// today (the pictures of its current work day), the work-done mark on and
// off, a job that isn't finished running one more work day (Monday to
// Saturday, lib/workDays) with its crew told, a job finished early. Used by
// the inbox (lib/inbound.ts), the office's "put them on this job"
// (/api/texted-photos) and the morning run (lib/morning.ts).
import type { Db, Photo } from "./photoStore";
import {
  countKinds, doneNoteLine, endedNoteLine, firstBeforeAt, kindOfName, namesFrom, photoAt, stageOf, undoneNoteLine, unmarkedNoteLine,
  type Stage,
} from "./jobFlow";
import { continueDay, currentWorkDay, daysThrough, MAX_WORK_DAYS, nextWorkDay, workDaysOf } from "./workDays";
import { langOf } from "./crewText";
import { pactKey, type JobKey } from "./smsIn";
import { sendTexts, twilioConfigured, type TextOut } from "./twilio";
import type { SfLine } from "./measure";

export interface Emp { id: string; name?: string | null; phone?: string | null; lang?: string | null; active?: boolean | null }
export interface ThreadJob {
  id: string; po_number?: string | null; job_number?: string | null; address?: string | null; development?: string | null; property_unit?: string | null;
  description?: string | null; items?: SfLine[] | null;
  attachments?: { name: string; path: string }[] | null; notes?: string | null; tax_pct?: number | null;
  work_done?: boolean | null; canceled?: boolean | null; invoice_sent?: string | null; received?: boolean | null;
  start_date?: string | null; work_days?: number | null;
}
const THREAD_COLS = "id,po_number,job_number,address,development,property_unit,description,items,attachments,notes,tax_pct,work_done,canceled,invoice_sent,received,start_date";
// the job as the thread reads it; work_days is RUN_ME section 23's (one day without it)
export async function threadJob(db: Db, id: string): Promise<ThreadJob | null> {
  let got = await db.get<ThreadJob>(`pact_jobs?id=eq.${id}&select=${THREAD_COLS},work_days`);
  if (!got.ok) got = await db.get<ThreadJob>(`pact_jobs?id=eq.${id}&select=${THREAD_COLS}`);
  return got.rows[0] || null;
}
export const keyOf = (j: ThreadJob): JobKey => pactKey({ ...j, id: j.id });
// a job the office has billed: nothing a text says rewrites it
export const billed = (j: { invoice_sent?: string | null; received?: boolean | null }) => !!j.invoice_sent || !!j.received;
export const withNote = (notes: string | null | undefined, line: string) => `${(notes || "").trim()}${(notes || "").trim() ? "\n" : ""}${line}`;
export const firstName = (e?: { name?: string | null } | null) => (e?.name || "").trim().split(/\s+/)[0] || "";
export const nyDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
export const nyWhen = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d).replace(/,/g, "");
export const nyHour = (d: Date) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(d)) % 24;
// "Sat Nov 21", for the office's notes
export const shortDay = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(d).replace(/,/g, "");
};
export const cleanPhone = (s?: string | null): string => {
  const d = (s || "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d.length > 11 && d.length <= 15 && (s || "").trim().startsWith("+") ? `+${d}` : ""; // as lib/notify's
};

// a row for the office's card: without the note column before section 21,
// and without the message id when another row of this same text already
// carries it (one row per Twilio message id); the row still goes in
export async function putRow(db: Db, row: Record<string, unknown>): Promise<boolean> {
  let st = await db.insertStatus("texted_photos", row);
  if (st === 400 && "day" in row) { const { day: _d, ...rest } = row; void _d; row = rest; st = await db.insertStatus("texted_photos", row); }
  if (st === 400 && "note" in row) { const { note: _n, ...rest } = row; void _n; row = rest; st = await db.insertStatus("texted_photos", row); }
  if (st === 409 && row.msg_sid) st = await db.insertStatus("texted_photos", { ...row, msg_sid: null });
  return st >= 200 && st < 300;
}

// ---- a job's days ----
export const daysOfJob = (j: ThreadJob): string[] => workDaysOf(j.start_date, j.work_days);
export const namesOf = (j: ThreadJob) => (j.attachments || []).map((a) => a?.name || "");
// the job's pictures of the day they belong to (lib/workDays currentWorkDay):
// today on one of its days, its last day for pictures sent after it
export function dayPile(j: ThreadJob, today: string) {
  const cur = currentWorkDay(j.start_date, j.work_days, today);
  const names = namesFrom(namesOf(j), cur);
  return { cur, ...countKinds(names), firstBefore: firstBeforeAt(names) };
}
// Where the job is for this worker, today. The day's first pictures are the
// before pictures. Once the day has them, a worker's own first pictures are
// before pictures too when they come within two hours of the day's first
// (two workers at one door each start with theirs; a helper sending the
// finished work at 3 PM is not arriving), and more pictures from a worker
// within an hour of their own before pictures are still before pictures
// (the other room, ten minutes later); after that, after pictures.
const HELPER_MS = 2 * 3_600_000;
const SAME_START_MS = 60 * 60_000;
export async function stageFor(db: Db, j: ThreadJob, empId: string | null | undefined, now: Date, today: string): Promise<Stage> {
  const pile = dayPile(j, today);
  const s = stageOf(pile);
  if (s !== "after" || !empId) return s;
  const since = encodeURIComponent(new Date(now.getTime() - 10 * 86_400_000).toISOString());
  const mine = (await db.get<{ photos?: Photo[] | null; created_at?: string | null }>(`texted_photos?employee_id=eq.${empId}&pact_job_id=eq.${j.id}&status=eq.filed&created_at=gte.${since}&select=photos,created_at&order=created_at.desc&limit=50`)).rows
    .filter((r) => r.created_at && nyDay(new Date(r.created_at)) >= pile.cur && (r.photos || []).some((p) => kindOfName(p?.name || "") === "before"));
  if (!mine.length) return Number.isFinite(pile.firstBefore) && now.getTime() - pile.firstBefore <= HELPER_MS ? "before" : "after";
  const last = Math.max(...mine.map((r) => Date.parse(r.created_at || "") || 0));
  return now.getTime() - last <= SAME_START_MS ? "before" : "after";
}
// the job's days before today with no picture at all (a NOT DONE days late
// counts the days in between): then "day 3 of 4" would mean nothing to the crew
export const unworkedDays = (j: ThreadJob, today: string): string[] => {
  const seen = new Set(namesOf(j).map(photoAt).filter(Boolean).map((ms) => nyDay(new Date(ms))));
  return daysOfJob(j).filter((d) => d < today && !seen.has(d));
};
// the job's last work day, and whether today is before it (a job of more
// days, not on its last). `day` is 0 when its days can't be counted for the crew
export function onLastDay(j: ThreadJob, today: string): { last: string; before: boolean; day: number; of: number; next: string; nextN: number } {
  const days = daysOfJob(j);
  const last = days[days.length - 1] || today;
  const cur = currentWorkDay(j.start_date, j.work_days, today);
  const counted = !unworkedDays(j, today).length;
  const next = days.find((d) => d > today) || "";
  return { last, before: today < last && days.length > 1, day: counted ? days.indexOf(cur) + 1 || 1 : 0, of: days.length || 1, next, nextN: counted && next ? days.indexOf(next) + 1 : 0 };
}

// ---- the work-done mark ----
// on: the job is work done (the section 15 trigger prices it and section 17
// gives it its invoice number) and the office's card says it is ready to
// invoice. True when the mark was put on just now.
export async function markDone(db: Db, job: ThreadJob, emp: Emp, o: { from: string; now: Date; finish: string; sid?: string; how?: "photos" | "text" }): Promise<boolean> {
  if (job.work_done || job.canceled) return false;
  const who = firstName(emp);
  const line = doneNoteLine(who, nyWhen(o.now), o.how === "text");
  const patch = { work_done: true, notes: withNote(job.notes, line) };
  // finish_date is upgrade_schedule's column: without it the mark still goes on
  // only a job not already marked: two texts in the same second put one mark and one card on
  let put = await db.patchRows<{ id: string }>(`pact_jobs?id=eq.${job.id}&work_done=not.is.true`, { ...patch, finish_date: o.finish });
  if (!put.ok) put = await db.patchRows<{ id: string }>(`pact_jobs?id=eq.${job.id}&work_done=not.is.true`, patch);
  if (!put.ok || !put.rows.length) return false;
  job.work_done = true;
  job.notes = patch.notes;
  await putRow(db, { employee_id: emp.id, from_phone: o.from, body: "", status: "done", how: "done", pact_job_id: job.id, photos: [], note: line, msg_sid: o.sid || null });
  return true;
}
// off: the mark, the finish day and the "ready to invoice" card (RUN_ME
// section 23's trigger takes the card off too; this covers a database without it)
async function cardsOff(db: Db, jobId: string) {
  await db.patch(`texted_photos?pact_job_id=eq.${jobId}&status=eq.done`, { status: "seen" });
}
// AFTER photos moved off a job (the worker's "wrong job, it's 220011", the
// office's Wrong job?): a job marked done by them, with no after pictures
// left for its day, is not done after all. `movedAfter`: the pictures that
// moved were after pictures (before pictures moving off never touch the mark)
export async function clearDoneIfNoAfter(db: Db, jobId: string, toLabel: string, now: Date, today: string, movedAfter: boolean): Promise<void> {
  if (!movedAfter) return;
  const job = await threadJob(db, jobId);
  if (!job || !job.work_done || billed(job)) return;
  if (dayPile(job, today).afterN > 0) return;
  // only a mark the texted AFTER photos put on, never one the office set by
  // hand or a worker's DONE (the answer to the morning's question) put on
  const marks = (await db.get<{ note?: string | null }>(`texted_photos?pact_job_id=eq.${jobId}&how=eq.done&status=in.(done,seen)&select=note&order=created_at.desc&limit=1`)).rows;
  if (!marks.length || /texted DONE/.test(marks[0].note || "")) return;
  const notes = withNote(job.notes, unmarkedNoteLine(nyWhen(now), toLabel));
  if (!(await db.patch(`pact_jobs?id=eq.${jobId}`, { work_done: false, finish_date: "", notes })) && !(await db.patch(`pact_jobs?id=eq.${jobId}`, { work_done: false, notes }))) return;
  await cardsOff(db, jobId);
}

// ---- the crew of a job ----
interface CrewRowLite { id: string; employee_id: string; texted?: boolean | null }
export async function crewOf(db: Db, jobId: string): Promise<CrewRowLite[]> {
  return (await db.get<CrewRowLite>(`schedule_days?pact_job_id=eq.${jobId}&select=id,employee_id,texted`)).rows;
}
// the rest of the crew, told one to one from the company number: each in
// their language, the ones who were told about the job, with a phone
export async function textCrew(db: Db, jobId: string, emps: Emp[], skip: string[], body: (e: Emp) => string): Promise<string[]> {
  if (!twilioConfigured()) return [];
  const rows = await crewOf(db, jobId);
  const out: TextOut[] = [];
  const seen = new Set(skip);
  for (const r of rows) {
    if (seen.has(r.employee_id) || !r.texted) continue;
    seen.add(r.employee_id);
    const e = emps.find((x) => x.id === r.employee_id);
    const to = cleanPhone(e?.phone);
    if (!e || e.active === false || !to) continue;
    out.push({ to, body: body(e), who: (e.name || "").trim() || undefined });
  }
  if (!out.length) return [];
  const told: string[] = [];
  await sendTexts(out, async (m) => { const e = emps.find((x) => cleanPhone(x.phone) === m.to); if (e) told.push(firstName(e)); });
  return told;
}

// ---- NOT DONE: the job runs one more work day ----
export type Continued =
  | { kind: "billed" }                                   // invoiced: nothing changes, the office hears it
  | { kind: "still"; next: string; day: number; of: number }   // it was going on anyway (before its last day)
  | { kind: "added"; next: string; day: number; told: string[] } // one more work day, the crew told
  | { kind: "open" };                                    // not finished, and no day could be added: the office sets it
// `answered`: the morning's question was already answered by someone else on the crew
export async function continueJob(db: Db, job: ThreadJob, o: { emp: Emp; emps: Emp[]; now: Date; today: string; tell: boolean; answered?: boolean; words: (e: Emp, next: string, day: number) => string }): Promise<Continued> {
  if (billed(job)) return { kind: "billed" };
  const who = firstName(o.emp);
  const days = daysOfJob(job);
  const last = days[days.length - 1] || "";
  const wasDone = !!job.work_done;
  // a co-worker's NOT DONE (to the same question, or a moment ago) already ran
  // it on to today: the same day, not one more. Once today's AFTER photos are
  // in, or it's marked done again, a NOT DONE is about today and adds tomorrow
  if (last && last === o.today && !wasDone && dayPile(job, o.today).afterN === 0) {
    const since = encodeURIComponent(new Date(o.now.getTime() - 3 * 3_600_000).toISOString());
    const recent = o.answered || (await db.get<{ id: string }>(`texted_photos?pact_job_id=eq.${job.id}&how=eq.notdone&created_at=gte.${since}&select=id&limit=1`)).rows.length > 0;
    if (recent) return { kind: "still", next: last, day: unworkedDays(job, o.today).length ? 0 : days.length, of: days.length };
  }
  // still inside its days (NOT DONE on day 1 of 3): it was going on anyway
  if (last && o.today < last) {
    const next = days.find((d) => d > o.today) || last;
    if (wasDone) {
      const notes = withNote(job.notes, undoneNoteLine(who, nyWhen(o.now)));
      if (await db.patch(`pact_jobs?id=eq.${job.id}`, { work_done: false, finish_date: "", notes }) || await db.patch(`pact_jobs?id=eq.${job.id}`, { work_done: false, notes })) await cardsOff(db, job.id);
    }
    return { kind: "still", next, day: unworkedDays(job, o.today).length ? 0 : days.indexOf(next) + 1, of: days.length };
  }
  const next = last ? continueDay(last, o.today) : "";
  const n = next ? daysThrough(job.start_date || next, next) : 0;
  const notesWith = (nextDay: string) => withNote(job.notes, undoneNoteLine(who, nyWhen(o.now), nextDay ? shortDay(nextDay) : ""));
  const off = wasDone ? { work_done: false, finish_date: "" } : {};
  let added = false;
  if (next && n <= MAX_WORK_DAYS) added = await db.patch(`pact_jobs?id=eq.${job.id}`, { ...off, work_days: n, notes: notesWith(next) });
  if (!added) {
    // no day on the job, or a database without section 23: the mark still comes off
    const notes = notesWith("");
    if (wasDone && !(await db.patch(`pact_jobs?id=eq.${job.id}`, { ...off, notes }))) await db.patch(`pact_jobs?id=eq.${job.id}`, { work_done: false, notes });
    else if (!wasDone) await db.patch(`pact_jobs?id=eq.${job.id}`, { notes });
    if (wasDone) await cardsOff(db, job.id);
    return { kind: "open" };
  }
  if (wasDone) await cardsOff(db, job.id);
  job.work_days = n;
  // a day number only when the days run on without a gap (a NOT DONE days
  // late counts the days nobody worked: "day 4" would mean nothing to the crew)
  const day = next === nextWorkDay(last) && !unworkedDays(job, o.today).length ? n : 0;
  const told = o.tell ? await textCrew(db, job.id, o.emps, [o.emp.id], (e) => o.words(e, next, day)) : [];
  return { kind: "added", next, day, told };
}

// ---- ALL DONE before the last day: the days after today come off ----
export async function endEarly(db: Db, job: ThreadJob, o: { emp: Emp; emps: Emp[]; now: Date; today: string; tell: boolean; words: (e: Emp, dropped: string[]) => string }): Promise<string[]> {
  const days = daysOfJob(job);
  const dropped = days.filter((d) => d > o.today);
  if (!dropped.length || !job.start_date) return [];
  const n = o.today >= job.start_date ? daysThrough(job.start_date, o.today) : 1;
  const notes = withNote(job.notes, endedNoteLine(firstName(o.emp), nyWhen(o.now), dropped.map(shortDay).join(", ")));
  if (!(await db.patch(`pact_jobs?id=eq.${job.id}`, { work_days: n, notes }))) return [];
  job.work_days = n;
  job.notes = notes;
  if (o.tell) await textCrew(db, job.id, o.emps, [o.emp.id], (e) => o.words(e, dropped));
  return dropped;
}

// ---- the morning's "Finished?" question, still waiting for this worker ----
// (lib/morning.ts writes one marker row per worker asked, how 'asked')
// `closed`: also one already answered by someone else on the crew (open: false)
export async function openQuestion(db: Db, empId: string, now: Date, closed = false): Promise<{ jobId: string; day: string; at: number; open: boolean } | null> {
  const since = encodeURIComponent(new Date(now.getTime() - 3 * 86_400_000).toISOString());
  const r = (await db.get<{ pact_job_id?: string | null; day?: string | null; created_at?: string | null; status?: string | null }>(`texted_photos?employee_id=eq.${empId}&how=eq.asked&status=${closed ? "in.(note,seen)" : "eq.note"}&created_at=gte.${since}&select=pact_job_id,day,created_at,status&order=created_at.desc&limit=1`)).rows[0];
  return r?.pact_job_id ? { jobId: r.pact_job_id, day: r.day || "", at: Date.parse(r.created_at || "") || 0, open: r.status === "note" } : null;
}
// answered (by anyone on the crew, or by the job's pictures): the question and its markers close
export async function closeQuestion(db: Db, jobId: string): Promise<void> {
  await db.patch(`texted_photos?pact_job_id=eq.${jobId}&how=in.(finished,asked)&status=in.(reply,note)`, { status: "seen" });
}
export const langIsEs = (l?: string | null) => langOf(l) === "es";
