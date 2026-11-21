// Server-only: the crew texts out. Into each crew's group thread — the
// owner, the workers on the job and the company number (lib/groupText) —
// when the owner is in the threads and the send is for the whole crew; one
// to one (lib/twilio) otherwise, or for any job whose thread can't be made.
// One message per job per thread, greeting everyone in it; a crew that reads
// two languages gets both (in one message when it fits Twilio's 1,600, else
// one each). Each crew row is stamped TEXTED the moment its message goes. A
// thread that didn't answer (a timeout, a Twilio error) is never followed by
// the same text one to one — the message may have gone. The thread's own
// last messages are read first: what is there counts as sent. What still
// can't be told comes back as failed with `maybe`, the rows stay unstamped
// and the office is told to look at the thread, so nobody gets a text twice.
import { ensureGroupWebhook, forgetGroup, groupFor, groupLastError, groupPostsSince, groupProblem, groupsOn, postToGroupStatus, rememberGroupJob } from "./groupText";
import { sendTexts, type TextOut, type TextReport } from "./twilio";
import { cleanPhone } from "./notify";
import type { Db } from "./photoStore";
import { groupBodies } from "./groupWords";
// the words of a thread post live in lib/groupWords, so the browser's preview can build them too
export { nameList, groupGreeting, groupBodies, groupBody } from "./groupWords";

export interface CrewOut extends TextOut { id?: string }
// One that didn't go. `maybe`: it may have reached the crew all the same (a
// thread post Twilio didn't answer in time, or one that went in part way),
// so it must never be sent again on its own: app/api/text-due leaves its
// time off instead of putting it back, and the office is told to look at
// the crew's thread before sending again. Without `maybe`, Twilio said no
// before anything went out, and trying again is safe.
export interface CrewFail { to: string; error: string; id?: string; maybe?: boolean }
export interface CrewReport extends TextReport { failed: CrewFail[]; grouped: number; groupProblem: string }
interface Row { id: string; day: string; employee_id: string; pact_job_id?: string | null; release_id?: string | null }
interface Emp { id: string; name?: string | null; phone?: string | null; active?: boolean | null }

const first = (e?: Emp | null) => (e?.name || "").trim().split(/\s+/)[0] || "";
// the same words, whatever spacing Twilio hands back
const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
// the thread is read back only while there is time for it: the routes that
// send have a minute in all, and a Twilio that is timing out would
// otherwise spend it on reads
const CHECK_WITHIN_MS = 35_000;

interface Batch { row: Row; msgs: CrewOut[] }
interface Outcome { sent: number; grouped: boolean; failed: CrewFail[]; loose: CrewOut[]; problem: string }

export async function sendCrew(db: Db | null, messages: CrewOut[], onSent: (m: CrewOut) => Promise<void>, origin: string): Promise<CrewReport> {
  const plain = async (ms: CrewOut[]): Promise<TextReport> => (ms.length ? sendTexts(ms, onSent) : { sent: 0, failed: [] });
  if (!groupsOn() || !db) return { ...(await plain(messages)), grouped: 0, groupProblem: groupProblem() };
  const began = Date.now();
  // which job each message is for, and everyone scheduled on that job that day
  const ids = messages.map((m) => m.id).filter((id): id is string => !!id);
  const rows = ids.length ? (await db.get<Row>(`schedule_days?id=in.(${ids.join(",")})&select=id,day,employee_id,pact_job_id,release_id`)).rows : [];
  const rowOf = new Map(rows.map((r) => [r.id, r]));
  const jobOfRow = (r: Row) => (r.pact_job_id ? `pact:${r.pact_job_id}` : r.release_id ? `rel:${r.release_id}` : "");
  const batches = new Map<string, Batch>();
  const loose: CrewOut[] = [];
  for (const m of messages) {
    const r = m.id ? rowOf.get(m.id) : undefined;
    const k = r ? jobOfRow(r) : "";
    if (!r || !k) { loose.push(m); continue; }
    const b = batches.get(`${k}@${r.day}`) || { row: r, msgs: [] };
    b.msgs.push(m);
    batches.set(`${k}@${r.day}`, b);
  }
  // the threads must be able to report back before anything goes into one
  if (batches.size && !(await ensureGroupWebhook(origin))) {
    return { ...(await plain(messages)), grouped: 0, groupProblem: groupLastError() || "Twilio couldn't be told where the threads report, so the texts went one to one" };
  }
  const emps = (await db.get<Emp>("employees?select=id,name,phone,active")).rows;
  const empOf = new Map(emps.map((e) => [e.id, e]));
  const one = async ({ row, msgs }: Batch): Promise<Outcome> => {
    const none: Outcome = { sent: 0, grouped: false, failed: [], loose: [], problem: "" };
    const where = row.pact_job_id ? `pact_job_id=eq.${row.pact_job_id}` : `release_id=eq.${row.release_id}`;
    const crewRows = (await db.get<{ employee_id: string }>(`schedule_days?${where}&day=eq.${row.day}&select=employee_id&limit=50`)).rows;
    const workerOf = (m: CrewOut) => rowOf.get(m.id!)!.employee_id;
    const crewIds = [...new Set([...crewRows.map((r) => r.employee_id), ...msgs.map(workerOf)])];
    // the people in the thread: on the crew list, still with us, with a phone
    const crew = crewIds.map((id) => empOf.get(id)).filter((e): e is Emp => !!e && e.active !== false && !!cleanPhone(e.phone || ""));
    // a worker whose message is here but who can't be in the thread (off the
    // crew list, no usable number) is never marked texted by the thread: their
    // text goes one to one and is stamped only when Twilio takes it
    const inThread = msgs.filter((m) => crew.some((e) => e.id === workerOf(m)));
    const dropped = msgs.filter((m) => !inThread.includes(m));
    if (!inThread.length) return { ...none, loose: msgs };
    // A post reaches everyone in the thread. So it goes there only when this
    // send is for every one of them; a send for part of the crew (a worker
    // added later, a Resend to one, a crew where only some were set up for
    // later) goes one to one, each worker in their own language: nobody
    // outside this send gets it, and nobody already told gets it again in
    // somebody else's language. Compared by worker, not by count, so one
    // worker with two messages here can't stand in for another.
    if (crew.some((e) => !inThread.some((m) => workerOf(m) === e.id))) return { ...none, loose: msgs };
    const phones = [...new Set(crew.map((e) => cleanPhone(e.phone || "")))];
    let made = await groupFor(phones);
    if ("error" in made) return { ...none, loose: msgs, problem: made.error };
    const bodies = groupBodies(inThread.map((m) => m.body), crew.map(first));
    // the parts in order: how many are in when one isn't, and Twilio's answer to that one
    const postAll = async (sid: string): Promise<{ landed: number; status: number }> => {
      for (let i = 0; i < bodies.length; i++) { const r = await postToGroupStatus(sid, bodies[i]); if (!r.ok) return { landed: i, status: r.status }; }
      return { landed: bodies.length, status: 201 };
    };
    const started = Date.now();
    let p = await postAll(made.group.sid);
    if (p.landed === 0 && p.status === 404) {
      // a thread remembered here but gone on Twilio's side: made again, once
      forgetGroup(made.group.key);
      made = await groupFor(phones);
      if ("error" in made) return { ...none, loose: msgs, problem: made.error };
      p = await postAll(made.group.sid);
    }
    // Twilio didn't answer in time (0) or had trouble of its own (5xx), or
    // one part went in and the next didn't: the post may be in the thread
    // all the same. The thread's own last messages say what is there. Every
    // part there: it went. Some there: only the missing ones go in after
    // them. None there, or the thread can't be read: it may still land, so
    // nothing is posted again and it comes back as maybe.
    let unsure = p.landed < bodies.length && (p.landed > 0 || p.status === 0 || p.status >= 500);
    if (unsure && Date.now() - began < CHECK_WITHIN_MS) {
      await new Promise((res) => setTimeout(res, 1_000)); // a post Twilio was still taking is in by now
      const seen = await groupPostsSince(made.group.sid, started - 60_000);
      if (seen) {
        const missing = bodies.map((_, i) => i).filter((i) => i >= p.landed && !seen.some((s) => same(s, bodies[i])));
        const someIn = p.landed > 0 || missing.length < bodies.length - p.landed;
        if (!missing.length) unsure = false;
        else if (someIn) {
          let all = true;
          for (const i of missing) { if (!(await postToGroupStatus(made.group.sid, bodies[i])).ok) { all = false; break; } }
          if (all) unsure = false;
        }
      }
      if (!unsure) p = { landed: bodies.length, status: 201 };
    }
    if (p.landed < bodies.length) {
      const words = groupLastError() || `Twilio ${p.status || "didn't answer"}`;
      const why = unsure
        ? `Twilio didn't say whether the crew's thread took the text (${words}), so it may have gone: check the crew's thread before sending again`
        : `the crew's thread didn't take the text (${words}). Nothing went out; try again in a minute`;
      return { ...none, failed: inThread.map((m) => ({ to: m.to, id: m.id, error: why, ...(unsure ? { maybe: true } : {}) })), loose: dropped, problem: why };
    }
    const job = row.pact_job_id ? { kind: "pact" as const, id: row.pact_job_id } : row.release_id ? { kind: "rel" as const, id: row.release_id } : undefined;
    await rememberGroupJob(made.group.sid, made.group.members, job);
    for (const m of inThread) await onSent(m).catch(() => {});
    return { ...none, sent: inThread.length, grouped: true, loose: dropped };
  };
  // a few threads at a time: a long crew list stays well inside the route's minute
  const outcomes: Outcome[] = [];
  const work = [...batches.values()];
  for (let i = 0; i < work.length; i += 4) outcomes.push(...(await Promise.all(work.slice(i, i + 4).map(one))));
  let problem = "";
  for (const o of outcomes) { loose.push(...o.loose); if (o.problem) problem = o.problem; }
  const rest = await plain(loose);
  return {
    sent: outcomes.reduce((n, o) => n + o.sent, 0) + rest.sent,
    failed: [...outcomes.flatMap((o) => o.failed), ...rest.failed],
    grouped: outcomes.filter((o) => o.grouped).length,
    groupProblem: problem,
  };
}
