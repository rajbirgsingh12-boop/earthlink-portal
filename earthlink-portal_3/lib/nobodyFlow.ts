// Server-only: a worker's "nobody home" text, carried out. lib/noAccess.ts
// decides (which job was missed, which is next, the words); this does it with
// the portal's own key: the missed job gets its ⚠ mark (a note on the job and
// a notice on the Schedule tabs — the office gives it a new day), the next job
// is found, moved up to today if it has to be, and the worker's answer is
// written with it. The other worker at the same door, if the next job is
// theirs too, is texted the same way. Called from /api/sms-in.
import {
  ackText, coworkerText, movedUpNote, nextText, nobodyNote, noNextText, notTodayText, askWhichText, toldOfficeText, shortDay,
  whichMissed, whichNext, LOOK_AHEAD_DAYS, SAME_DOOR_MS, type DayJob, type Next,
} from "./noAccess";
import { dayMinus, pactKey, relKey } from "./smsIn";
import { dueBody, dueWork, type DueJob } from "./dueText";
import { askClaudeSpanish, spanishWorkServer } from "./smartTranslate";
import { sendTexts, twilioConfigured } from "./twilio";
import { langOf } from "./crewText";
import { folderOf, type Db, type Photo } from "./photoStore";

export interface FlowEmp { id: string; name?: string | null; phone?: string | null; lang?: string | null; active?: boolean | null }
interface Row { id: string; day: string; employee_id: string; pact_job_id?: string | null; release_id?: string | null; texted?: boolean | null; description?: string | null; address?: string | null }
interface PJob extends DueJob { id: string; notes?: string | null }
interface Rel { id: string; rel_number?: string | null; location?: string | null; address?: string | null; canceled?: boolean; notes?: string | null }
interface Notice { id: string; pact_job_id?: string | null; release_id?: string | null; created_at?: string | null; status?: string | null; note?: string | null; employee_id?: string | null; how?: string | null }

const nyDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const nyTime = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(d);
const cleanPhone = (s?: string | null): string => {
  const d = (s || "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d.length > 11 ? `+${d}` : "";
};
const first = (e?: FlowEmp | null) => (e?.name || "").trim().split(/\s+/)[0] || "";
const ids = (xs: (string | null | undefined)[]) => [...new Set(xs.filter(Boolean) as string[])];
const appendLine = (notes: string | null | undefined, line: string) => `${(notes || "").trim()}${(notes || "").trim() ? "\n" : ""}${line}`;
// the work line in the worker's own language — Claude's Spanish if it answers
// in time (Twilio waits 15 seconds for the whole answer), else the glossary's
const workFor = async (raw: string, lang?: string | null) =>
  langOf(lang) === "es" && raw ? spanishWorkServer(raw, (t) => askClaudeSpanish(t, 5_000)) : raw;

export type FlowResult = { handled: false } | { handled: true; reply: string; missed?: DayJob };

export async function nobodyFlow(db: Db, o: {
  emp: FlowEmp; emps: FlowEmp[]; body: string; from: string; sid: string; now: Date;
  proof?: (dir: string) => Promise<Photo[]>;   // the pictures that came with the text (the door, say), stored in that folder
}): Promise<FlowResult> {
  const { emp, now } = o;
  const today = nyDay(now);
  const lastDay = dayMinus(today, -LOOK_AHEAD_DAYS);
  const lang = emp.lang;

  // ---- what they're on, today and the next two weeks ----
  const win = `day=gte.${today}&day=lte.${lastDay}&select=id,day,employee_id,pact_job_id,release_id,texted,description,address&order=day&limit=500`;
  let got = await db.get<Row>(`schedule_days?employee_id=eq.${emp.id}&${win}`);
  if (!got.ok) got = await db.get<Row>(`schedule_days?employee_id=eq.${emp.id}&${win.replace("pact_job_id,", "")}`);
  const rows = got.rows;
  const pIds = ids(rows.map((r) => r.pact_job_id)), rIds = ids(rows.map((r) => r.release_id));
  const [pj, rl] = await Promise.all([
    pIds.length ? db.get<PJob>(`pact_jobs?id=in.(${pIds.join(",")})&select=id,po_number,job_number,address,development,property_unit,description,start_date,canceled,work_done,notes`) : Promise.resolve({ ok: true, rows: [] as PJob[] }),
    rIds.length ? db.get<Rel>(`releases?id=in.(${rIds.join(",")})&select=id,rel_number,location,address,canceled,notes`) : Promise.resolve({ ok: true, rows: [] as Rel[] }),
  ]);
  const jobOf = new Map(pj.rows.map((j) => [j.id, j]));
  const relOf = new Map(rl.rows.map((r) => [r.id, r]));
  const rowOf = new Map(rows.map((r) => [r.id, r]));
  const jobs: DayJob[] = [];
  for (const r of rows) {
    if (r.pact_job_id) {
      const j = jobOf.get(r.pact_job_id);
      // a canceled or finished job isn't anyone's next job; a crew row left on
      // another day than its job's is stale
      if (!j || j.canceled || j.work_done || (j.start_date || "") !== r.day) continue;
      jobs.push({ ...pactKey(j), day: r.day, rowIds: [r.id] });
    } else if (r.release_id) {
      const x = relOf.get(r.release_id);
      if (!x || x.canceled) continue;
      jobs.push({ ...relKey(x), day: r.day, rowIds: [r.id] });
    }
  }

  // ---- today so far: jobs flagged (by anyone), jobs they sent photos from ----
  const day0 = encodeURIComponent(new Date(now.getTime() - 26 * 3_600_000).toISOString());
  const [flaggedQ, mineQ] = await Promise.all([
    db.get<Notice>(`texted_photos?how=eq.nobody&status=in.(nobody,seen,moved)&created_at=gte.${day0}&select=id,pact_job_id,release_id,created_at,status,note,employee_id,how`),
    db.get<Notice>(`texted_photos?employee_id=eq.${emp.id}&status=eq.filed&created_at=gte.${day0}&select=id,pact_job_id,release_id,created_at,status,how`),
  ]);
  const todays = (n: Notice) => !!n.created_at && nyDay(new Date(n.created_at)) === today;
  const notices = flaggedQ.rows.filter(todays);
  const flagged = new Set(ids(notices.map((n) => n.pact_job_id || n.release_id)));
  const mine = mineQ.rows.filter((b) => todays(b) && b.how !== "noaccess");
  const visited = new Set(ids(mine.map((b) => b.pact_job_id || b.release_id)));
  const photosJustNow = mine.some((b) => now.getTime() - Date.parse(b.created_at || "") < 10 * 60_000);

  const justFlagged = new Set(ids(notices.filter((n) => now.getTime() - Date.parse(n.created_at || "") < SAME_DOOR_MS).map((n) => n.pact_job_id || n.release_id)));
  const m = whichMissed({ body: o.body, today, jobs, flagged, visited, justFlagged, photosJustNow });
  if (m.kind === "skip") return { handled: false };
  // a word for the office when there's nothing to move: kept on the Schedule tabs
  const tellOffice = async (note: string) => {
    const row = { employee_id: emp.id, from_phone: o.from, body: o.body, status: "reply", how: "nobody", photos: [], msg_sid: o.sid || null };
    if (!(await db.insert("texted_photos", { ...row, note }))) await db.insert("texted_photos", row);
  };
  // every answer leaves a row with Twilio's message id, so a message Twilio
  // delivers twice is only acted on once (/api/sms-in checks it first)
  const remember = () => db.insert("texted_photos", { employee_id: emp.id, from_phone: o.from, body: o.body, status: "note", how: "nobody", photos: [], msg_sid: o.sid || null });
  if (m.kind === "ask") { await remember(); return { handled: true, reply: askWhichText(m.options, lang) }; }
  if (m.kind === "not_today") { await tellOffice(`Said nobody home at ${m.number} — not a job of theirs today`); return { handled: true, reply: notTodayText(m.number, lang) }; }
  if (m.kind === "nothing_today") { await tellOffice("No job of theirs today, so nothing was changed"); return { handled: true, reply: toldOfficeText(lang) }; }

  const missed = m.job;
  // the other workers at the same door
  const missedRows = await db.get<Row>(`schedule_days?${missed.kind === "pact" ? `pact_job_id=eq.${missed.id}` : `release_id=eq.${missed.id}`}&day=eq.${today}&select=id,day,employee_id,pact_job_id,release_id,texted,description,address`);
  const atTheDoor = new Set(missedRows.rows.map((r) => r.employee_id).filter((id) => id !== emp.id));

  // ---- the pictures that came with it (the door) go on the missed job ----
  const proof = o.proof ? await o.proof(folderOf(missed)) : [];
  if (proof.length) await db.attach(missed, proof, []);

  // ---- their next job ----
  const next: Next = whichNext({ today, jobs, missed, flagged: new Set([...flagged].filter((id) => id !== missed.id)), visited, lastDay });
  let nextMsg = noNextText(lang);
  let summary = `No other job for ${first(emp)} — told to call the office`;
  const others: { e: FlowEmp; row: Row }[] = [];
  if (next.kind !== "none") {
    const j = next.job;
    const row = rowOf.get(j.rowIds[0])!;
    const job = j.kind === "pact" ? jobOf.get(j.id) : undefined;
    const rel = j.kind === "rel" ? relOf.get(j.id) : undefined;
    let moved: { from: string; to: string } | null = null;
    if (next.kind === "move_up") {
      moved = { from: next.from, to: today };
      if (job) {
        // the job and its crew are one thing: the job moves, and its crew rows
        // come with it (RUN_ME section 14's trigger; the second write covers a
        // database without it). Its other workers show as not told for the
        // office — the ones who were at the same door are texted below.
        await db.patch(`pact_jobs?id=eq.${job.id}`, { start_date: today, notes: appendLine(job.notes, movedUpNote(next.from, today, missed.label)) });
        await db.patch(`schedule_days?pact_job_id=eq.${job.id}&day=eq.${next.from}`, { day: today, texted: false });
        const crew = (await db.get<Row>(`schedule_days?pact_job_id=eq.${job.id}&day=eq.${today}&select=id,day,employee_id,pact_job_id,release_id,texted,description,address`)).rows;
        for (const r of crew) if (atTheDoor.has(r.employee_id)) { const e = o.emps.find((x) => x.id === r.employee_id); if (e) others.push({ e, row: r }); }
      } else if (rel) {
        // a release is scheduled day by day: this worker's day on it moves up,
        // with whoever else was at the same door and is on it that day too
        const theirs = (await db.get<Row>(`schedule_days?release_id=eq.${rel.id}&day=eq.${next.from}&select=id,day,employee_id,pact_job_id,release_id,texted,description,address`)).rows
          .filter((r) => r.employee_id === emp.id || atTheDoor.has(r.employee_id));
        if (theirs.length) await db.patch(`schedule_days?id=in.(${theirs.map((r) => r.id).join(",")})`, { day: today, texted: false });
        await db.patch(`releases?id=eq.${rel.id}`, { notes: appendLine(rel.notes, movedUpNote(next.from, today, missed.label)) });
        for (const r of theirs) if (r.employee_id !== emp.id) { const e = o.emps.find((x) => x.id === r.employee_id); if (e) others.push({ e, row: { ...r, day: today } }); }
      }
    }
    const dueRow = { ...row, day: today };
    const crewFor = async (e: FlowEmp, r: Row) => dueBody({ ...r, day: today }, { emp: e, job: job ? { ...job, start_date: today } : null, rel, work: await workFor(dueWork(r, job), e.lang), moved });
    nextMsg = nextText(await crewFor(emp, dueRow), lang, true, j.label);
    // they've been told: the row says so (and a text set for later is off)
    const told = next.kind === "move_up" && job
      ? `pact_job_id=eq.${job.id}&employee_id=eq.${emp.id}&day=eq.${today}`
      : `id=in.(${j.rowIds.join(",")})`;
    await db.patch(`schedule_days?${told}`, { texted: true, send_at: null }).then(async (ok) => { if (!ok) await db.patch(`schedule_days?${told}`, { texted: true }); });
    // the other worker(s) from the same door, on the same next job
    const outs = (await Promise.all(others.map(async ({ e, row: r }) => {
      const to = cleanPhone(e.phone);
      return to ? { to, id: r.id, body: coworkerText(first(e), first(emp), missed.label, await crewFor(e, r), e.lang, true, j.label) } : null;
    }))).filter((x): x is { to: string; id: string; body: string } => !!x);
    let sentTo: string[] = [];
    if (outs.length && twilioConfigured()) {
      await sendTexts(outs, async (msg) => {
        sentTo.push(first(o.emps.find((x) => cleanPhone(x.phone) === msg.to)));
        await db.patch(`schedule_days?id=eq.${msg.id}`, { texted: true });
      });
      sentTo = sentTo.filter(Boolean);
    }
    const names = [first(emp), ...sentTo].filter(Boolean).join(" and ");
    summary = next.kind === "today"
      ? `Sent ${first(emp)} on to ${j.label}, their other job today`
      : `Moved ${j.label} up from ${shortDay(next.from)} and sent ${names}`;
  }

  // ---- the ⚠ on the missed job: once a day per job — the second worker
  // at the same door adds where they were sent to the first one's notice ----
  if (m.already) {
    const open = notices.find((n) => (n.pact_job_id || n.release_id) === missed.id && n.status === "nobody");
    if (open && !(open.note || "").includes(summary)) await db.patch(`texted_photos?id=eq.${open.id}`, { note: `${(open.note || "").trim()}${open.note ? " · " : ""}${summary}` });
    await remember();
  } else {
    const table = missed.kind === "pact" ? "pact_jobs" : "releases";
    const cur = (await db.get<{ notes?: string | null }>(`${table}?id=eq.${missed.id}&select=notes`)).rows[0];
    if (cur) await db.patch(`${table}?id=eq.${missed.id}`, { notes: appendLine(cur.notes, nobodyNote(today, first(emp), nyTime(now))) });
    const row = {
      employee_id: emp.id, from_phone: o.from, body: o.body, status: "nobody", how: "nobody", photos: proof, msg_sid: o.sid || null,
      pact_job_id: missed.kind === "pact" ? missed.id : null, release_id: missed.kind === "rel" ? missed.id : null,
    };
    if (!(await db.insert("texted_photos", { ...row, note: summary }))) await db.insert("texted_photos", row);
  }
  return { handled: true, reply: `${ackText(missed.label, lang)}\n\n${nextMsg}`, missed };
}
