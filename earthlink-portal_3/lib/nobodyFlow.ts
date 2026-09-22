// Server-only: a worker's "nobody home" text, carried out. lib/noAccess.ts
// decides (which job was missed, which is next, the words); this does it with
// the portal's own key: the missed job gets its ⚠ mark (a note on the job and
// a notice on the Schedule tabs — the office gives it a new day), the next job
// is found, moved up to today if it has to be, and the worker is told. The
// other worker at the same door, when that next job is their own next job
// too, is told the same way. Called from /api/sms-in.
//
// The order matters. The door is claimed first (one notice per job per day —
// two workers texting from the same door in the same second can't both act on
// it); the worker's answer goes out as soon as it's written (Twilio gives the
// whole page 15 seconds, and a co-worker's text or a slow translation must
// never cost the worker theirs); what the office reads is finished last.
import {
  ackText, coworkerText, movedUpNote, nextText, nobodyNote, noNextText, noMoveUpText, notTodayText, askWhichText, hintText, toldOfficeText, shortDay,
  bareNo, numbersIn, whichMissed, whichNext, LOOK_AHEAD_DAYS, SAME_DOOR_MS, DOOR_HOURS, MOVE_UP_UNTIL, type DayJob, type Next,
} from "./noAccess";
import { dayMinus, pactKey, relKey } from "./smsIn";
import { dueBody, dueWork, type DueJob } from "./dueText";
import { askClaudeSpanish, spanishWorkServer } from "./smartTranslate";
import { sendTexts, twilioConfigured } from "./twilio";
import { langOf } from "./crewText";
import { folderOf, type Db, type Photo } from "./photoStore";

export interface FlowEmp { id: string; name?: string | null; phone?: string | null; lang?: string | null; active?: boolean | null }
interface Row { id: string; day: string; employee_id: string; pact_job_id?: string | null; release_id?: string | null; texted?: boolean | null; texted_at?: string | null; description?: string | null; address?: string | null }
interface PJob extends DueJob { id: string; notes?: string | null }
interface Rel { id: string; rel_number?: string | null; location?: string | null; address?: string | null; canceled?: boolean; notes?: string | null }
interface Mark { id: string; pact_job_id?: string | null; release_id?: string | null; created_at?: string | null; status?: string | null; note?: string | null; employee_id?: string | null; how?: string | null }

const nyDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const nyTime = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(d);
const nyHour = (d: Date) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(d)) % 24;
const cleanPhone = (s?: string | null): string => {
  const d = (s || "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d.length > 11 ? `+${d}` : "";
};
const first = (e?: FlowEmp | null) => (e?.name || "").trim().split(/\s+/)[0] || "";
const ids = (xs: (string | null | undefined)[]) => [...new Set(xs.filter(Boolean) as string[])];
const appendLine = (notes: string | null | undefined, line: string) => `${(notes || "").trim()}${(notes || "").trim() ? "\n" : ""}${line}`;
const ROW_COLS = "id,day,employee_id,pact_job_id,release_id,texted,texted_at,description,address";
const jobOfMark = (n: Mark) => n.pact_job_id || n.release_id || "";

export type FlowResult = { handled: false } | { handled: true; reply: string; missed?: DayJob };

// crew rows, a few workers at once, from today to two weeks out — newest
// columns first, older databases' after
async function rowsFor(db: Db, empIds: string[], from: string, to: string): Promise<Row[]> {
  if (!empIds.length) return [];
  const q = (cols: string) => db.get<Row>(`schedule_days?employee_id=in.(${empIds.join(",")})&day=gte.${from}&day=lte.${to}&select=${cols}&order=day&limit=1000`);
  let got = await q(ROW_COLS);
  if (!got.ok) got = await q(ROW_COLS.replace(",texted_at", ""));
  if (!got.ok) got = await q(ROW_COLS.replace(",texted_at", "").replace("pact_job_id,", ""));
  return got.rows;
}

export async function nobodyFlow(db: Db, o: {
  emp: FlowEmp; emps: FlowEmp[]; body: string; from: string; sid: string; now: Date;
  proof?: (dir: string) => Promise<Photo[]>;   // the pictures that came with the text (the door, say), stored in that folder
}): Promise<FlowResult> {
  const { emp, now } = o;
  const today = nyDay(now);
  const lastDay = dayMinus(today, -LOOK_AHEAD_DAYS);
  const lang = emp.lang;
  const hour = nyHour(now);
  const bare = bareNo(o.body);

  // ---- the jobs we might need, loaded as we go ----
  const jobOf = new Map<string, PJob>();
  const relOf = new Map<string, Rel>();
  const loadJobs = async (rows: Row[]) => {
    const pIds = ids(rows.map((r) => r.pact_job_id)).filter((id) => !jobOf.has(id));
    const rIds = ids(rows.map((r) => r.release_id)).filter((id) => !relOf.has(id));
    const [pj, rl] = await Promise.all([
      pIds.length ? db.get<PJob>(`pact_jobs?id=in.(${pIds.join(",")})&select=id,po_number,job_number,address,development,property_unit,description,start_date,canceled,work_done,notes`) : Promise.resolve({ ok: true, rows: [] as PJob[] }),
      rIds.length ? db.get<Rel>(`releases?id=in.(${rIds.join(",")})&select=id,rel_number,location,address,canceled,notes`) : Promise.resolve({ ok: true, rows: [] as Rel[] }),
    ]);
    pj.rows.forEach((j) => jobOf.set(j.id, j));
    rl.rows.forEach((r) => relOf.set(r.id, r));
  };
  const dayJobs = (rows: Row[]): DayJob[] => {
    const out: DayJob[] = [];
    for (const r of rows) {
      if (r.pact_job_id) {
        const j = jobOf.get(r.pact_job_id);
        // a canceled or finished job isn't anyone's next job; a crew row left
        // on another day than its job's is stale
        if (!j || j.canceled || j.work_done || (j.start_date || "") !== r.day) continue;
        out.push({ ...pactKey(j), day: r.day, rowIds: [r.id] });
      } else if (r.release_id) {
        const x = relOf.get(r.release_id);
        if (!x || x.canceled) continue;
        out.push({ ...relKey(x), day: r.day, rowIds: [r.id] });
      }
    }
    return out;
  };
  const rows = await rowsFor(db, [emp.id], today, lastDay);
  await loadJobs(rows);
  const jobs = dayJobs(rows);
  const rowOf = new Map(rows.map((r) => [r.id, r]));

  // ---- today so far: doors reported (by anyone), their photos, their own answers ----
  const since = encodeURIComponent(new Date(now.getTime() - 26 * 3_600_000).toISOString());
  const marksQ = (cols: string) => db.get<Mark>(`texted_photos?how=eq.nobody&created_at=gte.${since}&select=${cols}&order=created_at.desc&limit=200`);
  let marksGot = await marksQ("id,pact_job_id,release_id,created_at,status,note,employee_id,how");
  if (!marksGot.ok) marksGot = await marksQ("id,pact_job_id,release_id,created_at,status,employee_id,how"); // before section 21: no note
  const photosGot = await db.get<Mark>(`texted_photos?employee_id=eq.${emp.id}&status=in.(filed,held)&created_at=gte.${since}&select=id,pact_job_id,release_id,created_at,status,how&order=created_at.desc&limit=100`);
  const todays = (n: Mark) => !!n.created_at && nyDay(new Date(n.created_at)) === today;
  const at = (n: Mark) => Date.parse(n.created_at || "") || 0;
  const marks = marksGot.rows.filter(todays);
  const notices = marks.filter((n) => n.status === "nobody" || n.status === "seen" || n.status === "moved");
  const mine = marks.filter((n) => n.employee_id === emp.id);           // every "nobody" answer this worker has had today
  const flagged = new Set(ids(notices.map(jobOfMark)));
  const myPhotos = photosGot.rows.filter((b) => todays(b) && b.how !== "noaccess");
  const visited = new Set(ids(myPhotos.filter((b) => b.status === "filed").map(jobOfMark)));
  const lastPhotos = Math.max(0, ...myPhotos.map(at));
  const lastMine = Math.max(0, ...mine.map(at));
  // the last thing we texted them was "got your photos", within half an hour
  const answerToPhotos = lastPhotos > lastMine && now.getTime() - lastPhotos < 30 * 60_000;
  // a door the other worker reported in the last twenty minutes, that this
  // worker hasn't had an answer about since
  const sameDoor = new Set(ids(notices.filter((n) => n.employee_id !== emp.id && now.getTime() - at(n) < SAME_DOOR_MS && lastMine < at(n)).map(jobOfMark)));

  // every answer leaves a row with Twilio's message id, so a message Twilio
  // delivers twice is only acted on once (/api/sms-in checks it first) — and
  // the next "no" knows what was last said to this worker
  const remember = () => db.insert("texted_photos", { employee_id: emp.id, from_phone: o.from, body: o.body, status: "note", how: "nobody", photos: [], msg_sid: o.sid || null });
  // a word for the office when there's nothing to move: kept on the Schedule tabs
  const tellOffice = async (note: string) => {
    const row = { employee_id: emp.id, from_phone: o.from, body: o.body, status: "reply", how: "nobody", photos: [], msg_sid: o.sid || null };
    if (!(await db.insert("texted_photos", { ...row, note }))) await db.insert("texted_photos", row);
  };

  // ---- not a door: the night, or a plain "no" answering a text about a later day ----
  if (hour < DOOR_HOURS.from || hour >= DOOR_HOURS.to) {
    await tellOffice(`Texted at ${nyTime(now)} — after hours, so nothing was changed`);
    return { handled: true, reply: toldOfficeText(lang) };
  }
  if (bare) {
    const told = rows.filter((r) => r.day > today && r.texted_at && now.getTime() - Date.parse(r.texted_at) < 3 * 3_600_000)
      .sort((a, b) => Date.parse(b.texted_at || "") - Date.parse(a.texted_at || ""))[0];
    if (told && Date.parse(told.texted_at || "") > Math.max(lastMine, lastPhotos)) {
      await tellOffice(`Answered the text about ${shortDay(told.day)} — nothing was changed`);
      return { handled: true, reply: toldOfficeText(lang) };
    }
  }

  const m = whichMissed({ body: o.body, today, jobs, flagged, visited, sameDoor, answerToPhotos });
  if (m.kind === "skip") {
    // with a number it's a photo fix, which /api/sms-in does; without one,
    // say how a door is reported, in case that's what they meant
    if (numbersIn(o.body).length) return { handled: false };
    const open = jobs.filter((j) => j.day === today && !flagged.has(j.id) && !visited.has(j.id));
    if (!open.length) return { handled: false };
    await remember();
    return { handled: true, reply: hintText(open, lang) };
  }
  if (m.kind === "ask") { await remember(); return { handled: true, reply: askWhichText(m.options, lang) }; }
  if (m.kind === "not_today") { await tellOffice(`Said nobody home at ${m.number} — not a job of theirs today`); return { handled: true, reply: notTodayText(m.number, lang) }; }
  if (m.kind === "nothing_today") { await tellOffice("No job of theirs today, so nothing was changed"); return { handled: true, reply: toldOfficeText(lang) }; }

  const missed = m.job;
  // ---- claim the door: one notice per job per day. The database refuses a
  // second one (RUN_ME section 21), so the other worker at the same door,
  // texting in the same second, takes the "already reported" road ----
  let already = m.already;
  let noticeId = "";
  if (!already) {
    const notice = {
      employee_id: emp.id, from_phone: o.from, body: o.body, status: "nobody", how: "nobody", photos: [], msg_sid: o.sid || null,
      pact_job_id: missed.kind === "pact" ? missed.id : null, release_id: missed.kind === "rel" ? missed.id : null,
    };
    let st = await db.insertStatus("texted_photos", { ...notice, day: today, note: "" });
    if (st === 400) st = await db.insertStatus("texted_photos", notice); // before section 21
    if (st === 409) { already = true; await remember(); }
    else if (st >= 200 && st < 300 && o.sid) {
      noticeId = (await db.get<{ id: string }>(`texted_photos?msg_sid=eq.${encodeURIComponent(o.sid)}&select=id&limit=1`)).rows[0]?.id || "";
    }
  } else {
    await remember();
  }

  // ---- their next job ----
  const flaggedOthers = new Set([...flagged].filter((id) => id !== missed.id));
  const next: Next = whichNext({ today, jobs, missed, flagged: flaggedOthers, visited, lastDay, moveUp: hour < MOVE_UP_UNTIL });
  const nj = next.kind === "none" ? null : next.job;
  const from = next.kind === "move_up" ? next.from : "";
  // the work line in each reader's language — Claude's Spanish once per line,
  // with 5 seconds to answer (the glossary's Spanish otherwise)
  const spanish = new Map<string, Promise<string>>();
  const workFor = (raw: string, l?: string | null) => {
    if (langOf(l) !== "es" || !raw) return Promise.resolve(raw);
    if (!spanish.has(raw)) spanish.set(raw, spanishWorkServer(raw, (t) => askClaudeSpanish(t, 5_000)));
    return spanish.get(raw)!;
  };
  const late = hour >= MOVE_UP_UNTIL;
  let nextMsg = late ? noMoveUpText(lang) : noNextText(lang);
  let summary = late ? `No other job for ${first(emp)} today (too late in the day to move one up)` : `No other job for ${first(emp)} — told to call the office`;
  const job = nj?.kind === "pact" ? jobOf.get(nj.id) : undefined;
  const rel = nj?.kind === "rel" ? relOf.get(nj.id) : undefined;
  const moved = next.kind === "move_up" ? { from, to: today } : null;
  let movedOk = false;
  if (nj && next.kind === "move_up") {
    if (job) {
      // the job and its crew are one thing: the job moves, and its crew rows
      // come with it (RUN_ME section 14's trigger — the second write covers a
      // database without it). Nothing else happens unless the job itself moved.
      if (await db.patch(`pact_jobs?id=eq.${job.id}&start_date=eq.${from}`, { start_date: today, notes: appendLine(job.notes, movedUpNote(from, today, missed.label)) })) {
        movedOk = (await db.get<{ id: string }>(`pact_jobs?id=eq.${job.id}&start_date=eq.${today}&select=id`)).rows.length > 0;
        if (movedOk) await db.patch(`schedule_days?pact_job_id=eq.${job.id}&day=eq.${from}`, { day: today, texted: false });
      }
    } else if (rel) {
      // a release is scheduled day by day: this worker's day on it moves up
      if (await db.patch(`schedule_days?id=in.(${nj.rowIds.join(",")})&day=eq.${from}`, { day: today, texted: false })) {
        movedOk = (await db.get<{ id: string }>(`schedule_days?id=in.(${nj.rowIds.join(",")})&day=eq.${today}&select=id`)).rows.length > 0;
        if (movedOk) await db.patch(`releases?id=eq.${rel.id}`, { notes: appendLine(rel.notes, movedUpNote(from, today, missed.label)) });
      }
    }
  }
  if (nj && (next.kind === "today" || movedOk)) {
    const row = rowOf.get(nj.rowIds[0])!;
    const crew = dueBody({ ...row, day: today }, { emp, job: job ? { ...job, start_date: today } : null, rel, work: await workFor(dueWork(row, job), lang), moved });
    nextMsg = nextText(crew, lang, true, nj.label);
    summary = next.kind === "today"
      ? `Sent ${first(emp)} on to ${nj.label}, their other job today`
      : `Moved ${nj.label} up from ${shortDay(from)} and sent ${first(emp)}`;
  } else if (nj) {
    nextMsg = noNextText(lang);
    summary = `Couldn't move ${nj.label} up — ${first(emp)} told to call the office`;
  }

  // ---- the worker's answer, now — before anything that could run long ----
  const reply = `${ackText(missed.label, lang)}\n\n${nextMsg}`;
  let replied = false;
  if (twilioConfigured() && cleanPhone(o.from)) replied = (await sendTexts([{ to: cleanPhone(o.from), body: reply }])).sent > 0;
  // they've been told: the row says so (and a text set for later is off)
  if (nj && (next.kind === "today" || movedOk)) {
    const told = job && next.kind === "move_up"
      ? `pact_job_id=eq.${job.id}&employee_id=eq.${emp.id}&day=eq.${today}`
      : `id=in.(${nj.rowIds.join(",")})`;
    if (!(await db.patch(`schedule_days?${told}`, { texted: true, send_at: null }))) await db.patch(`schedule_days?${told}`, { texted: true });
    await db.patch(`schedule_days?${told}`, { texted_at: now.toISOString() }); // before section 21 this one just doesn't take
  }

  // ---- the pictures that came with it (the door) go on the missed job ----
  const proof = o.proof ? await o.proof(folderOf(missed)) : [];
  if (proof.length) await db.attach(missed, proof, []);

  // ---- the other worker at the same door: told only when the job just moved
  // up is their own next job too, and they haven't texted about it themselves ----
  const sentTo: string[] = [];
  if (nj && next.kind === "move_up" && movedOk && !already) {
    const doorRows = (await db.get<Row>(`schedule_days?${missed.kind === "pact" ? `pact_job_id=eq.${missed.id}` : `release_id=eq.${missed.id}`}&day=eq.${today}&select=id,employee_id`)).rows;
    const others = ids(doorRows.map((r) => r.employee_id)).filter((id) => id !== emp.id);
    if (others.length) {
      // what's known of them right now (a text of their own in flight counts)
      const theirMarks = (await db.get<Mark>(`texted_photos?how=eq.nobody&employee_id=in.(${others.join(",")})&created_at=gte.${since}&select=employee_id,created_at`)).rows.filter(todays);
      const theirRows = await rowsFor(db, others, today, lastDay);
      await loadJobs(theirRows);
      const out: { to: string; id: string; body: string }[] = [];
      for (const cid of others) {
        const e = o.emps.find((x) => x.id === cid);
        if (!e || theirMarks.some((n) => n.employee_id === cid)) continue;
        // their own next, from their own day (the moved job counted where it was)
        const theirJobs = dayJobs(theirRows.filter((r) => r.employee_id === cid).map((r) => (r.pact_job_id === nj.id && r.day === today ? { ...r, day: from } : r)))
          .map((j) => (j.kind === "pact" && j.id === nj.id ? { ...j, day: from } : j));
        const theirVisited = new Set<string>();
        const theirNext = whichNext({ today, jobs: theirJobs, missed, flagged: flaggedOthers, visited: theirVisited, lastDay, moveUp: true });
        if (theirNext.kind !== "move_up" || theirNext.job.id !== nj.id || theirNext.from !== from) continue;
        const r = nj.kind === "pact"
          ? theirRows.find((x) => x.employee_id === cid && x.pact_job_id === nj.id)
          : theirRows.find((x) => x.employee_id === cid && x.release_id === nj.id && x.day === from);
        const to = cleanPhone(e.phone);
        if (!r || !to) continue;
        if (nj.kind === "rel" && !(await db.patch(`schedule_days?id=eq.${r.id}&day=eq.${from}`, { day: today, texted: false }))) continue;
        const crew = dueBody({ ...r, day: today }, { emp: e, job: job ? { ...job, start_date: today } : null, rel, work: await workFor(dueWork(r, job), e.lang), moved });
        out.push({ to, id: r.id, body: coworkerText(first(e), first(emp), missed.label, crew, e.lang, true, nj.label) });
      }
      if (out.length && twilioConfigured()) {
        await sendTexts(out, async (msg) => {
          sentTo.push(first(o.emps.find((x) => cleanPhone(x.phone) === msg.to)));
          await db.patch(`schedule_days?id=eq.${msg.id}`, { texted: true });
          await db.patch(`schedule_days?id=eq.${msg.id}`, { texted_at: now.toISOString() });
        });
      }
    }
  }
  const alsoSent = sentTo.filter(Boolean);
  if (alsoSent.length) summary = `${summary} and ${alsoSent.join(" and ")}`;

  // ---- what the office reads: the ⚠ line on the job (first report only),
  // and the notice says what the portal did ----
  if (!already) {
    const table = missed.kind === "pact" ? "pact_jobs" : "releases";
    const cur = (await db.get<{ notes?: string | null }>(`${table}?id=eq.${missed.id}&select=notes`)).rows[0];
    if (cur) await db.patch(`${table}?id=eq.${missed.id}`, { notes: appendLine(cur.notes, nobodyNote(today, first(emp), nyTime(now))) });
    if (noticeId && !(await db.patch(`texted_photos?id=eq.${noticeId}`, { note: summary, photos: proof }))) await db.patch(`texted_photos?id=eq.${noticeId}`, { photos: proof });
  } else {
    const open = notices.find((n) => jobOfMark(n) === missed.id && n.status === "nobody");
    if (open && !(open.note || "").includes(summary)) await db.patch(`texted_photos?id=eq.${open.id}`, { note: `${(open.note || "").trim()}${open.note ? " · " : ""}${summary}` });
  }
  return { handled: true, reply: replied ? "" : reply, missed };
}
