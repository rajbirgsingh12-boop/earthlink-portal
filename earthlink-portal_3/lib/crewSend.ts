// Server-only: the crew texts out. Into each crew's group thread — the
// owner, the workers on the job and the company number (lib/groupText) —
// when the owner is in the threads; one to one (lib/twilio) otherwise, or
// for any job whose thread can't be made. One message per job per thread,
// greeting everyone in it; a crew that reads two languages gets both in one
// message. Each crew row is stamped TEXTED the moment its message goes.
import { ensureGroupWebhook, forgetGroup, groupFor, groupProblem, groupsOn, postToGroup } from "./groupText";
import { sendTexts, type TextOut, type TextReport } from "./twilio";
import { cleanPhone } from "./notify";
import type { Db } from "./photoStore";

export interface CrewOut extends TextOut { id?: string }
export interface CrewReport extends TextReport { grouped: number; groupProblem: string }
interface Row { id: string; day: string; employee_id: string; pact_job_id?: string | null; release_id?: string | null }
interface Emp { id: string; name?: string | null; phone?: string | null; active?: boolean | null }

const first = (e?: Emp | null) => (e?.name || "").trim().split(/\s+/)[0] || "";
const isEs = (body: string) => /^hola\b/i.test(body);
// "Jose", "Jose and Luis", "Jose, Luis and Sam"
export const nameList = (names: string[], lang: "en" | "es"): string => {
  const n = names.filter(Boolean);
  if (n.length <= 1) return n[0] || "";
  const and = lang === "es" ? "y" : "and";
  return `${n.slice(0, -1).join(", ")} ${and} ${n[n.length - 1]}`;
};
// the greeting names everyone in the thread: "Hi Jose and Luis, this is Earth Link."
export function groupGreeting(body: string, names: string[]): string {
  const es = isEs(body);
  const list = nameList(names, es ? "es" : "en");
  if (!list) return body;
  return es
    ? body.replace(/^Hola\b[^,.]*, le habla Earth Link\./, `Hola ${list}, le habla Earth Link.`)
    : body.replace(/^Hi\b[^,.]*, this is Earth Link\./, `Hi ${list}, this is Earth Link.`);
}
// one message for a crew that may read two languages: English first, Spanish under it
export function groupBody(bodies: string[], names: string[]): string {
  const en = bodies.find((b) => !isEs(b)), es = bodies.find(isEs);
  return [en, es].filter((b): b is string => !!b).map((b) => groupGreeting(b, names)).join("\n\n");
}

export async function sendCrew(db: Db | null, messages: CrewOut[], onSent: (m: CrewOut) => Promise<void>, origin: string): Promise<CrewReport> {
  const plain = async (ms: CrewOut[]): Promise<TextReport> => (ms.length ? sendTexts(ms, onSent) : { sent: 0, failed: [] });
  if (!groupsOn() || !db) return { ...(await plain(messages)), grouped: 0, groupProblem: groupProblem() };
  // which job each message is for, and everyone scheduled on that job that day
  const ids = messages.map((m) => m.id).filter((id): id is string => !!id);
  const rows = ids.length ? (await db.get<Row>(`schedule_days?id=in.(${ids.join(",")})&select=id,day,employee_id,pact_job_id,release_id`)).rows : [];
  const rowOf = new Map(rows.map((r) => [r.id, r]));
  const jobOfRow = (r: Row) => (r.pact_job_id ? `pact:${r.pact_job_id}` : r.release_id ? `rel:${r.release_id}` : "");
  const batches = new Map<string, { row: Row; msgs: CrewOut[] }>();
  const loose: CrewOut[] = [];
  for (const m of messages) {
    const r = m.id ? rowOf.get(m.id) : undefined;
    const key = r ? jobOfRow(r) : "";
    if (!r || !key) { loose.push(m); continue; }
    const b = batches.get(`${key}@${r.day}`) || { row: r, msgs: [] };
    b.msgs.push(m);
    batches.set(`${key}@${r.day}`, b);
  }
  const emps = (await db.get<Emp>("employees?select=id,name,phone,active")).rows;
  const empOf = new Map(emps.map((e) => [e.id, e]));
  let sent = 0, grouped = 0;
  const failed: TextReport["failed"] = [];
  let problem = "";
  if (batches.size) await ensureGroupWebhook(origin);
  for (const { row, msgs } of batches.values()) {
    const where = row.pact_job_id ? `pact_job_id=eq.${row.pact_job_id}` : `release_id=eq.${row.release_id}`;
    const crewRows = (await db.get<{ employee_id: string }>(`schedule_days?${where}&day=eq.${row.day}&select=employee_id&limit=50`)).rows;
    const crewIds = [...new Set([...crewRows.map((r) => r.employee_id), ...msgs.map((m) => rowOf.get(m.id!)!.employee_id)])];
    const crew = crewIds.map((id) => empOf.get(id)).filter((e): e is Emp => !!e);
    const phones = [...new Set(crew.map((e) => cleanPhone(e.phone || "")).filter(Boolean))];
    let made = await groupFor(phones);
    if ("error" in made) { problem = made.error; loose.push(...msgs); continue; }
    const body = groupBody(msgs.map((m) => m.body), crew.map(first));
    let took = await postToGroup(made.group.sid, body);
    if (!took) {
      // a thread remembered here but gone on Twilio's side: made again, once
      forgetGroup(made.group.key);
      made = await groupFor(phones);
      if ("error" in made) { problem = made.error; loose.push(...msgs); continue; }
      took = await postToGroup(made.group.sid, body);
    }
    if (took) {
      grouped += 1;
      for (const m of msgs) { sent += 1; await onSent(m).catch(() => {}); }
    } else {
      problem = `the thread didn't take the text — sent one to one instead`;
      loose.push(...msgs);
    }
  }
  const rest = await plain(loose);
  return { sent: sent + rest.sent, failed: [...failed, ...rest.failed], grouped, groupProblem: problem };
}
