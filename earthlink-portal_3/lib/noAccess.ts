// "Nobody home." A worker at the door texts the company number "no" (or
// "nobody home", "nadie", "no abre"…): the job they couldn't get into is
// flagged for the office to give a new day, and they are sent their next
// job — another one they have today, or else their next day's job, moved up
// to today. This file is the deciding part: what the text means, which job
// was missed, which job is next, and the words sent back. No database, no
// network — /api/sms-in (lib/nobodyFlow.ts) does the doing.
import { normPo } from "./po";
import { langOf, longDay, PHOTO_INVITE, type Lang } from "./crewText";

// lower case, no accents, no punctuation: "¡No abrió!" → "no abrio"
const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[’‘`´]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

// Said in so many words, English or Spanish — about the door or the tenant,
// never just any "no": "Home Depot not open", "no está el material", "hoy no
// puedo, estoy enfermo", "the delivery got cancelled" are not a door.
const WHO = "(tenant|tenants|resident|they|she|he|lady|guy|owner|family|people)";
const SAID = new RegExp([
  "\\b(nobody|no ?one|no body)('?s)? (is )?(home|there|here|answer\\w*|opens?|opened|opening|came|coming)\\b",
  "\\bnot (at )?home\\b",
  "\\bno answer( (at|from) (the )?(door|apt|apartment|unit|tenant))?$",
  "\\bno (access|entry)( (to|at|for) (the )?(apt|apartment|unit))?$",
  "\\b(tenant )?no show$",
  "\\b(can'?t|cannot|couldn'?t|could not) get in(side)?\\b", "\\b(can'?t|cannot|couldn'?t|could not) get access\\b",
  `\\b${WHO}( is| are|'s|'re)? (won'?t|will not|didn'?t|did not|doesn'?t|does not|not|isn'?t|aren'?t|never) ?(open\\w*|answer\\w*|home|there|here|in)\\b`,
  "\\b(won'?t|will not|didn'?t|did not|doesn'?t|does not|not) (open|opening|answer\\w*) (the |my |our )?door\\b",
  `\\b${WHO} (won'?t|will not|not|didn'?t) let(ting)? (us|me) in\\b`, "\\bdoor (is )?(locked|closed)\\b",
  `\\b${WHO} (cancel\\w*|said no|says no|refus\\w*)\\b`, `\\b${WHO} (said|says) (not today|tomorrow|another day)\\b`,
  `\\b${WHO} (can'?t|cannot|can not) (do it |make it |do |make )?today\\b`,
  `\\b${WHO} (want|wants|asked|asks|need|needs)( us| me)? to reschedul\\w*`, `\\b${WHO} reschedul\\w*`,
  "\\b(appointment|appt) (got |was |is )?cancel+\\w*",
  // español
  "\\bnadie\\b",
  "^(el |la )?(inquilin[oa]s?|senor(a|es)?|duen[oa]s?|familia)? ?no (esta|estan|estaba|estaban)( (en casa|aqui|ahi|alli|nadie))?$",
  "\\bno (esta|estan|estaba|estaban) (en casa|nadie)\\b",
  "\\bno (abre|abren|abrio|abrieron|abrian)\\b", "\\bno (me|nos) (abre|abren|abrio|abrieron|deja|dejan|dejaron) ?(entrar)?\\b",
  "\\bno (contesta|contestan|contesto|contestaron|responde|responden|respondio)( (la puerta|el inquilino|la inquilina))?$",
  "\\bno (se puede|puedo|podemos|pudimos|pude) entrar( (al|en el) (apartamento|apto|apt|departamento|unidad))?$",
  "\\b(inquilin[oa]s?|senor(a)?|la familia) cancel\\w*", "\\b(la )?cita (se )?cancel\\w*",
  "\\bno (puede|pueden) hoy\\b", "\\bhoy no (puede|pueden)\\b", "\\binquilin[oa]s? no\\b",
].join("|"));
// a plain "no" — alone, or with the job's number: "no", "NO 116843", "nope", "nah"
const BARE = /^(no+|nope|nah|nada|no po|no no)$/;
// "no problem", "no worries" — a no that isn't about the door
const NOT_IT = /\b(no problem|no prob|no worries|no worry|no hay problema|no te preocupes|no se preocupe|no pasa nada|wrong job|equivocad\w*)\b/;

const withoutNumbers = (t: string) => t.replace(/\b(po|p o|release|rel|#)\b/g, " ").replace(/\d+/g, " ").replace(/\s+/g, " ").trim();
// the text says nobody let them in (or the tenant can't do it today)
export function nobodyHome(body: string): boolean {
  const t = norm(body);
  if (!t) return false;
  if (SAID.test(t)) return true;
  return !NOT_IT.test(t) && BARE.test(withoutNumbers(t));
}
// …and it's just "no" (with or without a number): that can also be an answer
// to the text before it, so it counts only when it can't be anything else
export const bareNo = (body: string): boolean => {
  const t = norm(body);
  return !!t && !SAID.test(t) && BARE.test(withoutNumbers(t));
};
// every number in the text, stripped like a PO ("NO 0116843" → "116843")
export const numbersIn = (body: string): string[] => [...new Set(((body || "").match(/\d{1,12}/g) || []).map((n) => normPo(n)).filter(Boolean))];

// ---- which job, which next ----
export interface DayJob {
  kind: "pact" | "rel"; id: string; label: string; keys: string[];
  day: string;            // the day the worker is on it
  rowIds: string[];       // this worker's crew rows for it that day
}
// the order a day's jobs are gone through: the calendar's (PO / release number)
export const byLabel = (a: DayJob, b: DayJob) => a.label.localeCompare(b.label, undefined, { numeric: true });
const dedupe = (xs: DayJob[]) => {
  const m = new Map<string, DayJob>();
  for (const j of xs) {
    const k = `${j.kind}:${j.id}:${j.day}`;
    const had = m.get(k);
    if (had) had.rowIds = [...new Set([...had.rowIds, ...j.rowIds])]; else m.set(k, { ...j, rowIds: [...j.rowIds] });
  }
  return [...m.values()];
};

export type Missed =
  | { kind: "missed"; job: DayJob; already: boolean }   // already: someone flagged it today (the other worker at the same door)
  | { kind: "ask"; options: DayJob[] }                  // two jobs still open today, and no number to say which
  | { kind: "not_today"; number: string }                // a number that isn't one of today's jobs
  | { kind: "nothing_today" }                            // no job of theirs today (a "no" to tomorrow's text, say)
  | { kind: "skip" };                                   // a plain "no" right after their photos: an answer to that, not the door

// The job they couldn't get into:
//  • a number in the text that is one of today's jobs;
//  • else the one job of theirs today still open (not photographed today,
//    not already flagged) — two open, and they're asked which;
//  • else, when every job today is already flagged, the flagged one (the
//    other worker at the same door said it first) — they still need a next job.
export const SAME_DOOR_MS = 20 * 60_000;
// the day's hours for a door: before 6 AM or from 7 PM on, a "no" is not one
// (it's an answer to the evening text about tomorrow, most likely) — and a
// next day's job is moved up to today only until 2 PM, while there's a day left to work
export const DOOR_HOURS = { from: 6, to: 19 };
export const MOVE_UP_UNTIL = 14;
export function whichMissed(ctx: {
  body: string; today: string; jobs: DayJob[];            // this worker's jobs, today and after
  flagged: Set<string>; visited: Set<string>;               // job ids flagged / photographed today
  sameDoor?: Set<string>;                                   // …flagged in the last twenty minutes by the other worker at that door, not yet answered by this one
  answerToPhotos: boolean;                                  // the last thing we texted them was "got your photos" (half an hour at most)
}): Missed {
  const today = dedupe(ctx.jobs.filter((j) => j.day === ctx.today)).sort(byLabel);
  const nums = numbersIn(ctx.body);
  // "No" / "No, 116900" right after "Got it — 3 photos on PO 116843 … wrong
  // job? reply with the right PO": that's about the photos, not a door
  if (bareNo(ctx.body) && ctx.answerToPhotos) return { kind: "skip" };
  if (nums.length) {
    const hit = today.filter((j) => j.keys.some((k) => nums.includes(k)));
    if (hit.length === 1) return { kind: "missed", job: hit[0], already: ctx.flagged.has(hit[0].id) };
    if (hit.length > 1) return { kind: "ask", options: hit };
    // "nobody home apt 4" is not a job number; "NO 116900" is — and it isn't today's
    const big = nums.find((n) => n.length >= 4);
    if (big) return { kind: "not_today", number: big };
  }
  if (today.length === 0) return { kind: "nothing_today" };
  // a door the other worker reported in the last twenty minutes, that they
  // were at too: this "no" is about it — not about the job the portal just
  // sent them on to, which they can't have reached yet
  const same = today.filter((j) => ctx.sameDoor?.has(j.id));
  if (same.length) return { kind: "missed", job: same[same.length - 1], already: true };
  const open = today.filter((j) => !ctx.flagged.has(j.id) && !ctx.visited.has(j.id));
  if (open.length === 1) return { kind: "missed", job: open[0], already: false };
  if (open.length > 1) return { kind: "ask", options: open };
  const flaggedToday = today.filter((j) => ctx.flagged.has(j.id));
  if (flaggedToday.length) return { kind: "missed", job: flaggedToday[flaggedToday.length - 1], already: true };
  return { kind: "nothing_today" }; // they've sent photos from every job today: that "no" is about something else
}

export type Next =
  | { kind: "today"; job: DayJob }
  | { kind: "move_up"; job: DayJob; from: string }
  | { kind: "none" };
export const LOOK_AHEAD_DAYS = 14;
// Their next job: another of today's still open, in the calendar's order;
// else the first job of their next working day (in the next two weeks),
// which moves up to today.
export function whichNext(ctx: { today: string; jobs: DayJob[]; missed: DayJob; flagged: Set<string>; visited: Set<string>; lastDay: string; moveUp?: boolean }): Next {
  const all = dedupe(ctx.jobs);
  const todayOpen = all.filter((j) => j.day === ctx.today && j.id !== ctx.missed.id && !ctx.flagged.has(j.id) && !ctx.visited.has(j.id)).sort(byLabel);
  if (todayOpen.length) return { kind: "today", job: todayOpen[0] };
  if (ctx.moveUp === false) return { kind: "none" };
  // a later day's job — not one they're already on today (a release that runs
  // several days), not one they were at or that was reported empty today
  const onToday = new Set(all.filter((j) => j.day === ctx.today).map((j) => j.id));
  const later = all.filter((j) => j.day > ctx.today && j.day <= ctx.lastDay && j.id !== ctx.missed.id
    && !onToday.has(j.id) && !ctx.flagged.has(j.id) && !ctx.visited.has(j.id));
  if (!later.length) return { kind: "none" };
  const first = later.map((j) => j.day).sort()[0];
  const job = later.filter((j) => j.day === first).sort(byLabel)[0];
  return { kind: "move_up", job, from: first };
}

// ---- the words ----
const said = (label: string, lang: Lang) => (lang === "es" ? `el ${label}` : label);
export function ackText(label: string, lang0?: string | null): string {
  const lang = langOf(lang0);
  return lang === "es"
    ? `Entendido — no había nadie en ${said(label, lang)}. La oficina le dará otro día.`
    : `Got it — nobody home at ${label}. The office will give it a new day.`;
}
// "Hi Jose, this is Earth Link. You are scheduled…" → "You are scheduled…" —
// it rides under the "got it" in the same text
const noGreeting = (crew: string) => crew.replace(/^(Hi|Hola)\b[^.]*?, (this is|le habla) Earth Link\.\s*/, "");
// …ending with how to say that one's a no too — the number makes it certain
export function nextText(crew: string, lang0?: string | null, invite = true, label = ""): string {
  const lang = langOf(lang0);
  const body = noGreeting(crew);
  const num = (label.match(/\d[\w-]*$/) || [""])[0];
  const again = num ? (lang === "es" ? `¿Tampoco hay nadie allí? Responda NO ${num}.` : `Nobody home there either? Reply NO ${num}.`) : "";
  return `${lang === "es" ? "Su próximo trabajo" : "Your next job"}: ${body}${invite ? `\n\n${PHOTO_INVITE[lang]}` : ""}${again ? `\n${again}` : ""}`;
}
export function noNextText(lang0?: string | null): string {
  return langOf(lang0) === "es" ? "No tiene otro trabajo en el horario. Llame a la oficina." : "You have no other job on the schedule. Call the office.";
}
// the other worker at the same door, told by the portal
export function coworkerText(first: string, reporter: string, missedLabel: string, crew: string, lang0?: string | null, invite = true, nextLabel = ""): string {
  const lang = langOf(lang0);
  const hi = lang === "es"
    ? `Hola${first ? ` ${first}` : ""}, le habla Earth Link. ${reporter ? `${reporter} avisó que no` : "No"} había nadie en ${said(missedLabel, lang)}; la oficina le dará otro día.`
    : `Hi${first ? ` ${first}` : ""}, this is Earth Link. ${reporter ? `${reporter} let us know nobody` : "Nobody"} was home at ${missedLabel}; the office will give it a new day.`;
  return `${hi}\n\n${nextText(crew, lang, invite, nextLabel)}`;
}
// two jobs still open today: which one?
export function askWhichText(options: DayJob[], lang0?: string | null): string {
  const lang = langOf(lang0);
  const nums = options.map((j) => `NO ${(j.label.match(/\d[\w-]*$/) || [j.label])[0]}`);
  const list = nums.length === 2 ? `${nums[0]} ${lang === "es" ? "o" : "or"} ${nums[1]}` : nums.join(", ");
  return lang === "es"
    ? `¿En qué trabajo no hay nadie? Responda NO con el número, así: ${list}.`
    : `Which job has nobody home? Reply NO with its number, like: ${list}.`;
}
// a plain "no" that could be about the photos just sent: how to report a door
export function hintText(options: DayJob[], lang0?: string | null): string {
  const lang = langOf(lang0);
  const nums = options.slice(0, 2).map((j) => `NO ${(j.label.match(/\d[\w-]*$/) || [j.label])[0]}`);
  const list = nums.length === 2 ? `${nums[0]} ${lang === "es" ? "o" : "or"} ${nums[1]}` : nums[0];
  return lang === "es"
    ? `Si no hay nadie en un trabajo, responda NO con su número, así: ${list}.`
    : `If nobody's home at a job, reply NO with its number, like: ${list}.`;
}
export function noMoveUpText(lang0?: string | null): string {
  return langOf(lang0) === "es" ? "No tiene otro trabajo hoy. Su próximo trabajo sigue en su día." : "You have no other job today. Your next job stays on its day.";
}
export function notTodayText(number: string, lang0?: string | null): string {
  return langOf(lang0) === "es"
    ? `${number} no está en su horario de hoy. La oficina verá su mensaje.`
    : `${number} isn't on your schedule today. The office will see your message.`;
}
export function toldOfficeText(lang0?: string | null): string {
  return langOf(lang0) === "es" ? "Gracias — la oficina verá su mensaje." : "Thanks — the office will see your message.";
}

// the line on the job's own notes, and on the job that moved up
export const shortDay = (iso: string) => {
  const d = longDay(iso);
  return d ? d.replace(/^(\w{3})\w*, (\w{3})\w* (\d+)$/, "$1 $2 $3") : iso;
};
export const nobodyNote = (day: string, who: string, time: string) => `⚠ Nobody home ${shortDay(day)} — ${who || "the crew"} texted${time ? ` at ${time}` : ""}`;
export const movedUpNote = (from: string, to: string, missedLabel: string) => `📅 Moved up to ${shortDay(to)} from ${shortDay(from)} — nobody home at ${missedLabel}`;
