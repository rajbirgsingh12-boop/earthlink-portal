// Server-only: the morning run over PACT jobs, from the daily timer
// (/api/text-due, about 6 to 7 AM New York time) or an open portal's catch-up.
// Once a day per job (pact_jobs.checked_day, RUN_ME section 23, is taken
// first, so the timer and a phone sweeping the same morning never both text):
//   • a job of more days, on its day 2 and on: each worker told about it gets
//     "Today is day 2 of 3 at 2205 Linden Blvd, Apt 4B (PO 116843). When you
//     get there, reply with photos (they go in BEFORE). When you leave, send
//     the photos with the word AFTER."
//   • the morning after a job's last day, when that day has no AFTER photos
//     and the job isn't marked done: each worker on it is asked "Did you
//     finish it yesterday? Reply DONE if it's finished, or NOT DONE if it
//     isn't", and the office's card shows the question until it's answered.
//     DONE marks it done; NOT DONE runs it one more work day (lib/inbound).
import type { Db } from "./photoStore";
import { dayReminderText, finishedQuestionText } from "./jobFlow";
import { billed, cleanPhone, dayPile, firstName, keyOf, nyDay, nyHour, putRow, shortDay, unworkedDays, type Emp, type ThreadJob } from "./jobThread";
import { jobName } from "./crewText";
import { dayMinus } from "./smsIn";
import { isSunday, workDaysOf } from "./workDays";
import { sendTexts, twilioConfigured, type TextOut } from "./twilio";

// the morning's hours: reminders until noon, the question until evening
const FROM_HOUR = 6, REMIND_UNTIL = 12, ASK_UNTIL = 18;
// a job whose last day is further back than this is the office's to chase, not the crew's
const ASK_BACK_DAYS = 3;
const COLS = "id,po_number,job_number,address,development,property_unit,start_date,work_days,checked_day,attachments,invoice_sent,received,work_done,canceled";
type MJob = ThreadJob & { checked_day?: string | null };

export async function morningRun(db: Db, now: Date, photosBack: boolean): Promise<{ reminded: number; asked: number }> {
  const none = { reminded: 0, asked: 0 };
  const today = nyDay(now);
  const hour = nyHour(now);
  // the crew can only answer when their texts come back to the portal
  if (hour < FROM_HOUR || hour >= ASK_UNTIL || !twilioConfigured() || !photosBack) return none;
  const got = await db.get<MJob>(`pact_jobs?canceled=not.is.true&work_done=not.is.true&start_date=gte.${dayMinus(today, 45)}&start_date=lte.${today}&checked_day=neq.${today}&select=${COLS}&limit=300`);
  if (!got.ok || !got.rows.length) return none; // before section 23 (no checked_day): nothing runs
  type Todo = { job: MJob; days: string[]; remind: boolean; ask: string };
  const todo: Todo[] = [];
  for (const job of got.rows) {
    const days = workDaysOf(job.start_date, job.work_days);
    if (!days.length) continue;
    const last = days[days.length - 1];
    const remind = hour < REMIND_UNTIL && days.includes(today) && today !== days[0];
    // (never on a Sunday: Monday asks, still inside the look-back)
    const ask = !isSunday(today) && last < today && last >= dayMinus(today, ASK_BACK_DAYS) && !billed(job) && dayPile(job, today).afterN === 0 ? last : "";
    if (remind || ask) todo.push({ job, days, remind, ask });
  }
  if (!todo.length) return none;
  let emps = await db.get<Emp>("employees?select=id,name,phone,lang,active");
  if (!emps.ok) emps = await db.get<Emp>("employees?select=id,name,phone,active");
  let reminded = 0, asked = 0;
  for (const t of todo) {
    // take the job for this morning: only one sweep gets it
    const claim = await db.patchRows<{ id: string }>(`pact_jobs?id=eq.${t.job.id}&checked_day=neq.${today}`, { checked_day: today });
    if (!claim.ok || !claim.rows.length) continue;
    const key = keyOf(t.job);
    // the crew who were told about the job, each once, with a phone
    type CrewRow = { employee_id: string; texted?: boolean | null; texted_at?: string | null };
    let got = await db.get<CrewRow>(`schedule_days?pact_job_id=eq.${t.job.id}&select=employee_id,texted,texted_at`);
    if (!got.ok) got = await db.get<CrewRow>(`schedule_days?pact_job_id=eq.${t.job.id}&select=employee_id,texted`);
    const crew: { e: Emp; to: string; toldToday: boolean }[] = [];
    for (const r of got.rows) {
      if (!r.texted || crew.some((c) => c.e.id === r.employee_id)) continue;
      const e = emps.rows.find((x) => x.id === r.employee_id);
      const to = cleanPhone(e?.phone);
      if (e && e.active !== false && to) crew.push({ e, to, toldToday: !!r.texted_at && nyDay(new Date(r.texted_at)) === today });
    }
    // (a worker whose crew text went out this morning, a helper set up for day 2, has just been told)
    const remindCrew = crew.filter((c) => !c.toldToday);
    if (t.remind && remindCrew.length) {
      // (no number when a day before today was never worked: it would be wrong)
      const day = unworkedDays(t.job, today).length ? 0 : t.days.indexOf(today) + 1;
      const out: TextOut[] = remindCrew.map(({ e, to }) => ({ to, who: (e.name || "").trim() || undefined, body: dayReminderText(firstName(e), jobName(key, e.lang), { day, of: t.days.length }, e.lang) }));
      reminded += (await sendTexts(out)).sent;
    }
    // (a job nobody was texted about isn't run by text: nothing to ask)
    if (t.ask && crew.length) {
      // a door nobody opened on that day is the office's already: not asked about
      // (one somebody got into after all is "opened", and is asked about)
      const door = (await db.get<{ id: string }>(`texted_photos?pact_job_id=eq.${t.job.id}&how=eq.nobody&status=in.(nobody,seen,moved)&day=eq.${t.ask}&select=id&limit=1`)).rows.length > 0;
      if (door) continue;
      // asked already, on an earlier morning: once per job and day; a worker
      // whose question didn't go out then is asked now, while it's still open
      const card = (await db.get<{ id: string; status?: string | null }>(`texted_photos?pact_job_id=eq.${t.job.id}&how=eq.finished&day=eq.${t.ask}&select=id,status&limit=1`)).rows[0];
      if (card && card.status !== "reply") continue;
      const askedBefore = card ? new Set((await db.get<{ employee_id?: string | null }>(`texted_photos?pact_job_id=eq.${t.job.id}&how=eq.asked&day=eq.${t.ask}&select=employee_id`)).rows.map((r) => r.employee_id || "")) : new Set<string>();
      const toAsk = crew.filter((c) => !askedBefore.has(c.e.id));
      if (!toAsk.length) continue;
      const out: TextOut[] = toAsk.map(({ e, to }) => ({ to, who: (e.name || "").trim() || undefined, body: finishedQuestionText(firstName(e), jobName(key, e.lang), t.ask, today, e.lang) }));
      const told: string[] = [];
      await sendTexts(out, async (m) => {
        const c = crew.find((x) => x.to === m.to);
        if (!c) return;
        told.push(firstName(c.e));
        // on each worker's record: their plain "yes" / "no" is the answer to this
        await putRow(db, { employee_id: c.e.id, from_phone: m.to, body: "", photos: [], status: "note", how: "asked", pact_job_id: t.job.id, day: t.ask });
        asked += 1;
      });
      // the question for the office's card, naming the ones Twilio took (none
      // took it: no card, and the next morning tries again inside the look-back)
      if (!told.length || card) continue;
      const note = `No AFTER photos ${shortDay(t.ask)} and it isn't marked done: asked ${told.filter(Boolean).join(" and ") || "the crew"} if it was finished`;
      const st = await db.insertStatus("texted_photos", { pact_job_id: t.job.id, from_phone: "", body: "", photos: [], status: "reply", how: "finished", day: t.ask, note });
      if (st === 400) await putRow(db, { pact_job_id: t.job.id, from_phone: "", body: "", photos: [], status: "reply", how: "finished", note });
    }
  }
  return { reminded, asked };
}
