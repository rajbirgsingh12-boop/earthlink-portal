// Server-only: the crew texts out. Into each crew's group thread — the
// owner, the workers on the job and the company number (lib/groupText) —
// when the owner is in the threads; one to one (lib/twilio) otherwise, or
// for any job whose thread can't be made. One message per job per thread,
// greeting everyone in it; a crew that reads two languages gets both (in
// one message when it fits Twilio's 1,600, else one each). Each crew row is
// stamped TEXTED the moment its message goes. A thread that didn't answer
// (a timeout, a Twilio error) is never followed by the same text one to
// one — the message may have gone — the rows stay unstamped and the office
// is told, so nobody gets a text twice.
import { ensureGroupWebhook, forgetGroup, groupFor, groupLastError, groupProblem, groupsOn, postToGroupStatus, rememberGroupJob } from "./groupText";
import { sendTexts, type TextOut, type TextReport } from "./twilio";
import { cleanPhone } from "./notify";
import type { Db } from "./photoStore";

export interface CrewOut extends TextOut { id?: string }
export interface CrewReport extends TextReport { grouped: number; groupProblem: string }
interface Row { id: string; day: string; employee_id: string; pact_job_id?: string | null; release_id?: string | null }
interface Emp { id: string; name?: string | null; phone?: string | null; active?: boolean | null }
const TWILIO_MAX = 1600;

const first = (e?: Emp | null) => (e?.name || "").trim().split(/\s+/)[0] || "";
const isEs = (body: string) => /^hola\b/i.test(body);
// "Jose", "Jose and Luis", "Jose, Luis and Sam"
export const nameList = (names: string[], lang: "en" | "es"): string => {
  const n = [...new Set(names.filter(Boolean))];
  if (n.length <= 1) return n[0] || "";
  const and = lang === "es" ? "y" : "and";
  return `${n.slice(0, -1).join(", ")} ${and} ${n[n.length - 1]}`;
};
// the greeting names everyone in the thread: "Hi Jose and Luis, this is
// Earth Link." — and Spanish speaks to all of them ("les habla", "Tienen", "respondan")
export function groupGreeting(body: string, names: string[]): string {
  const es = isEs(body);
  const list = nameList(names, es ? "es" : "en");
  if (!list) return body;
  if (!es) return body.replace(/^Hi\b[^,]*?, this is Earth Link\./, `Hi ${list}, this is Earth Link.`);
  const many = new Set(names.filter(Boolean)).size > 1;
  let out = body.replace(/^Hola\b[^,]*?, le habla Earth Link\./, `Hola ${list}, ${many ? "les" : "le"} habla Earth Link.`);
  if (many) out = out.replace(/\bTiene trabajo\b/, "Tienen trabajo").replace(/\bresponda\b/g, "respondan").replace(/\bResponda\b/g, "Respondan").replace(/\bmande\b/g, "manden").replace(/\bse le avisará\b/g, "se les avisará").replace(/\bse le enviará\b/g, "se les enviará");
  return out;
}
// what a crew that may read two languages gets: English first, Spanish under
// it, in one message when that fits — otherwise one message each
export function groupBodies(bodies: string[], names: string[]): string[] {
  const en = bodies.find((b) => !isEs(b)), es = bodies.find(isEs);
  const parts = [en, es].filter((b): b is string => !!b).map((b) => groupGreeting(b, names));
  const joined = parts.join("\n\n");
  return parts.length > 1 && joined.length > TWILIO_MAX - 100 ? parts : parts.length ? [joined] : [];
}
export const groupBody = (bodies: string[], names: string[]): string => groupBodies(bodies, names).join("\n\n");

interface Batch { row: Row; msgs: CrewOut[] }
interface Outcome { sent: number; grouped: boolean; failed: TextReport["failed"]; loose: CrewOut[]; problem: string }

export async function sendCrew(db: Db | null, messages: CrewOut[], onSent: (m: CrewOut) => Promise<void>, origin: string): Promise<CrewReport> {
  const plain = async (ms: CrewOut[]): Promise<TextReport> => (ms.length ? sendTexts(ms, onSent) : { sent: 0, failed: [] });
  if (!groupsOn() || !db) return { ...(await plain(messages)), grouped: 0, groupProblem: groupProblem() };
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
    const crewIds = [...new Set([...crewRows.map((r) => r.employee_id), ...msgs.map((m) => rowOf.get(m.id!)!.employee_id)])];
    // the people in the thread: on the crew list, still with us, with a phone
    const crew = crewIds.map((id) => empOf.get(id)).filter((e): e is Emp => !!e && e.active !== false && !!cleanPhone(e.phone || ""));
    // a worker whose message is here but who can't be in the thread (off the
    // crew list, no usable number) is never marked texted by the thread: their
    // text goes one to one and is stamped only when Twilio takes it
    const inThread = msgs.filter((m) => crew.some((e) => e.id === rowOf.get(m.id!)!.employee_id));
    const dropped = msgs.filter((m) => !inThread.includes(m));
    if (!inThread.length) return { ...none, loose: msgs };
    const phones = [...new Set(crew.map((e) => cleanPhone(e.phone || "")))];
    let made = await groupFor(phones);
    if ("error" in made) return { ...none, loose: msgs, problem: made.error };
    const bodies = groupBodies(inThread.map((m) => m.body), crew.map(first));
    const postAll = async (sid: string) => {
      for (const b of bodies) { const r = await postToGroupStatus(sid, b); if (!r.ok) return r; }
      return { ok: true, status: 201 };
    };
    let r = await postAll(made.group.sid);
    if (!r.ok && r.status === 404) {
      // a thread remembered here but gone on Twilio's side: made again, once
      forgetGroup(made.group.key);
      made = await groupFor(phones);
      if ("error" in made) return { ...none, loose: msgs, problem: made.error };
      r = await postAll(made.group.sid);
    }
    if (!r.ok) {
      const why = `the thread didn't take the text (${groupLastError() || `Twilio ${r.status || "didn't answer"}`}). Not sent again another way, so nobody gets it twice; try again in a minute`;
      return { ...none, failed: inThread.map((m) => ({ to: m.to, id: m.id, error: why })), loose: dropped, problem: why };
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
