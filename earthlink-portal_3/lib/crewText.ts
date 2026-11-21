// The text a worker gets — one shape for every job, PACT or NYCHA, written
// in whole sentences a phone reads at a glance: who it's for, the day, where
// (the street, the building when the street isn't the whole story, the
// apartment), the work, the job's number so anyone can say which job they
// mean, and a map. A day change is the same message saying what changed.
// Each worker gets it in their own language: English, or Spanish.
import { mapLink } from "./mapLink";
export { mapLink };

export type Lang = "en" | "es";
// "es", "ES", "Español", "spanish" → Spanish; anything else (or nothing) → English
export const langOf = (v?: string | null): Lang => (/^(es|spa|esp)/i.test((v || "").trim()) ? "es" : "en");
export const LANG_LABEL: Record<Lang, string> = { en: "English", es: "Español" };

// "Wednesday, September 23" / "miércoles, 23 de septiembre" — the whole word, the way a person says it
export const longDay = (iso?: string | null, lang: Lang = "en") =>
  iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(new Date(iso + "T00:00:00").getTime()) ? new Date(iso + "T00:00:00").toLocaleDateString(lang === "es" ? "es" : "en-US", { weekday: "long", month: "long", day: "numeric" }) : "";
const flat = (s?: string | null) => (s || "").replace(/\s+/g, " ").trim();
const sameText = (a: string, b: string) => flat(a).toLowerCase() === flat(b).toLowerCase();

export type CrewTextInput = {
  first?: string;                   // the worker's first name
  day?: string | null;              // "YYYY-MM-DD"
  street?: string | null;           // "370 Blake Avenue, Brooklyn, NY 11212"
  building?: string | null;         // the development or building name, when the street isn't the whole story
  apt?: string | null;
  work?: string | null;             // what they're going there to do
  moved?: { from?: string | null; to: string } | null;  // a day change: the new day, and the old one when known
  lang?: string | null;             // the worker's language — "es" for Spanish, else English
  po?: string | null;               // a PACT job's PO number
  release?: string | null;          // a NYCHA release number
  last?: string | null;             // a job that runs more than one day: its last work day (lib/workDays)
  days?: number | null;             // …and how many work days that is
};
// the job's own number, the way the office and the partners say it. "PO" and
// "release" stay as they are in Spanish — that is what everyone calls them.
const jobRef = (t: CrewTextInput): string => {
  const po = flat(t.po).replace(/^(po\s*#?|#)\s*/i, "");
  if (po) return `PO ${po}`;
  const rel = flat(t.release).replace(/^(release\s*#?|#)\s*/i, "");
  return rel ? `release ${rel}` : "";
};
export function crewText(t: CrewTextInput): string {
  const lang = langOf(t.lang);
  const first = flat(t.first);
  // a trailing period on a street or building would land mid-sentence
  const street = flat(t.street).replace(/[.\s]+$/, "");
  const building = flat(t.building).replace(/[.\s]+$/, "");
  // "Apt 4B", "Apartment 4B", "Unit 4B", "#4B" — the label is put on here, once
  const apt = flat(t.apt).replace(/^(apt\.?|apartment|unit|#)\s*/i, "");
  // the work's own last stop is kept ("Paint everything!" / a cut line's "…"); a period is added only where there is none.
  // A dash typed into a PO ("Bedroom – plaster") reads as a comma in a text
  const work = flat(t.work).replace(/\s*[\u2014\u2013]\s+|\s+[\u2014\u2013]\s*|\u2014/g, ", ").replace(/\u2013/g, "-").replace(/[.\s]+$/, "");
  const stop = /[!?…]$/.test(work) ? "" : ".";
  // a "move" to the same day is not a move — the old day is not repeated
  const moved = t.moved && t.moved.from && t.moved.from === t.moved.to ? { to: t.moved.to } : t.moved;
  const ref = jobRef(t);
  // more than one day: "Friday, November 20 to Monday, November 23 (3 days)"
  const days = Math.round(Number(t.days) || 1);
  const span = (from: string | null | undefined, es: boolean): string => {
    const a = longDay(from, es ? "es" : "en"), b = days > 1 ? longDay(t.last, es ? "es" : "en") : "";
    if (!a) return "";
    if (!b || t.last === from) return es ? `el ${a}` : `on ${a}`;
    return es ? `del ${a} al ${b} (${days} días)` : `${a} to ${b} (${days} days)`;
  };
  // "Van Dyke (370 Blake Avenue, Brooklyn, NY 11212), Apt 4B" — the building only when the street doesn't already name it
  const showBuilding = !!building && !sameText(building, street) && !(street && street.toLowerCase().includes(building.toLowerCase()));
  const place = building && street ? (showBuilding ? `${building} (${street})` : street) : street || building;
  const where = [place, apt && `${lang === "es" ? "Apto" : "Apt"} ${apt}`].filter(Boolean).join(", ");
  const paras: string[] = [];
  if (lang === "es") {
    const hello = `Hola${first ? ` ${first}` : ""}, le habla Earth Link.`;
    if (moved) {
      const to = longDay(moved.to, "es"), from = longDay(moved.from, "es");
      const more = days > 1 && t.last && t.last !== moved.to ? ` (${days} días, hasta el ${longDay(t.last, "es")})` : "";
      paras.push(`${hello} El trabajo${where ? ` en ${where}` : ""} se cambió ${to ? `al ${to}${more}` : "a otro día"}.${from ? ` Antes era el ${from}.` : ""}`);
    } else {
      const day = span(t.day, true);
      paras.push(`${hello} Tiene trabajo${day ? ` ${day}` : ""}${where ? ` en ${where}` : ""}.${day ? "" : " El día se le avisará pronto."}${where ? "" : " La dirección se le enviará después."}`);
    }
    if (work) paras.push(`El trabajo es: ${work}${stop}`);
    if (ref) paras.push(`Este trabajo es el ${ref}.`);
    if (street) paras.push(`Aquí está el mapa: ${mapLink(street)}`);
    return paras.join("\n\n");
  }
  const hello = `Hi${first ? ` ${first}` : ""}, this is Earth Link.`;
  if (moved) {
    const to = longDay(moved.to), from = longDay(moved.from);
    const more = days > 1 && t.last && t.last !== moved.to ? ` (${days} days, through ${longDay(t.last)})` : "";
    paras.push(`${hello} The job${where ? ` at ${where}` : ""} has moved to ${to ? `${to}${more}` : "a new day"}.${from ? ` It was on ${from}.` : ""}`);
  } else {
    const day = span(t.day, false);
    paras.push(`${hello} You are scheduled to work${day ? ` ${day}` : ""}${where ? ` at ${where}` : ""}.${day ? "" : " The day will be set soon."}${where ? "" : " The address will follow."}`);
  }
  if (work) paras.push(`Here is the work: ${work}${stop}`);
  if (ref) paras.push(`This job is ${ref}.`);
  if (street) paras.push(`Here is the map: ${mapLink(street)}`);
  return paras.join("\n\n");
}

// The job named in a reply to the crew: where it is, the way the crew knows
// it, with the job's number after it ("2205 Linden Blvd, Apt 4B (PO 9098)").
// Just the number when the job has no address on it. The street is the
// address up to its first comma; a job with no address goes by its building.
export const jobName = (j: { label: string; street?: string | null; apt?: string | null }, lang0?: string | null): string => {
  const lang = langOf(lang0);
  const street = flat(j.street).replace(/[.,\s]+$/, "");
  const apt = flat(j.apt).replace(/^(apt\.?|apartment|unit|#)\s*/i, "");
  // an address that already says the apartment ("2205 Linden Blvd Apt 4B", "… #4B") doesn't get it
  // twice; the same number as a house or street number ("41-10 12th St", apartment 10) is not it
  const aptSaid = !!apt && new RegExp(`(^|[^a-z0-9])(apt\\.?|apartment|unit|#)\\s*#?\\s*${apt.replace(/[^a-z0-9]/gi, (c) => `\\${c}`)}($|[^a-z0-9])`, "i").test(street);
  const where = street ? [street, apt && !aptSaid && `${lang === "es" ? "Apto" : "Apt"} ${apt}`].filter(Boolean).join(", ") : "";
  const label = flat(j.label);
  return where && label ? `${where} (${label})` : where || label;
};
// the street part of an address: "2205 Linden Blvd, Brooklyn, NY 11207" is "2205 Linden Blvd"
export const streetOf = (address?: string | null): string => flat(address).split(",")[0].replace(/[.\s]+$/, "");
// a job name in a sentence. "PO 9098" and "release 12" are numbers ("on PO
// 9098", "en el PO 9098"); an address is a place ("at 2205 Linden Blvd",
// "en 2205 Linden Blvd")
const isRef = (name: string) => /^(po|release)\b/i.test(flat(name));
export const atJob = (name: string, lang: Lang): string =>
  lang === "es" ? (isRef(name) ? `en el ${name}` : `en ${name}`) : isRef(name) ? `on ${name}` : `at ${name}`;
// as the subject of a sentence: "El PO 9098 ya está facturado" / "2205 Linden Blvd (PO 9098) ya está facturado"
export const theJob = (name: string, lang: Lang, start = false): string => {
  const s = lang === "es" && isRef(name) ? `el ${name}` : name;
  return start ? s.charAt(0).toUpperCase() + s.slice(1) : s;
};
export const ofJob = (name: string, lang: Lang): string => (lang === "es" ? (isRef(name) ? `del ${name}` : `de ${name}`) : atJob(name, lang));

// The line at the end of a text from the company number, once photos sent
// back to it go on the job (/api/sms-in) — added by the server, which is the
// only one that sends from that number. Language by the text's own greeting.
// how a worker says the photos are the finished work: every text that asks for photos ends with it
export const AFTER_HOW = { en: "When you finish, send the photos with the word AFTER.", es: "Al terminar, mande las fotos con la palabra DESPUES." };
// (photos are BEFORE unless the worker says AFTER: the same words as AFTER_HOW)
export const PHOTO_INVITE = {
  en: "Reply to this text with photos of the work: they go in BEFORE. When you finish, send the photos with the word AFTER.",
  es: "Responda a este mensaje con fotos del trabajo: van a ANTES. Al terminar, mande las fotos con la palabra DESPUES.",
};
// the invite as texts already out carried it (a text being re-sent is never asked twice)
const OLD_INVITE = { en: "Reply to this text with photos of the work.", es: "Responda a este mensaje con fotos del trabajo." };
// a PACT job's text carries the whole thread instead (lib/jobFlow's jobAsk:
// before photos, then after photos), never both
const hasAsk = (b: string) => b.includes(PHOTO_INVITE.en) || b.includes(PHOTO_INVITE.es) || b.includes(OLD_INVITE.en) || b.includes(OLD_INVITE.es)
  || /with the word AFTER|con la palabra DESPUES|reply with BEFORE photos|responda con fotos de ANTES/.test(b);
// Twilio takes 1,600 characters. A text over a limit gives up words from its
// LONGEST paragraph (the work line), cut at a word with "…" — the greeting,
// the map link and the ask at the end all stay whole. (A paragraph that is
// one unbroken run of characters is cut where it must be.)
export function fitText(body: string, max: number): string {
  let b = (body || "").trimEnd();
  for (let guard = 0; b.length > max && guard < 12; guard++) {
    const paras = b.split("\n\n");
    let i = 0;
    paras.forEach((p, k) => { if (p.length > paras[i].length) i = k; });
    const over = b.length - max;
    const p = paras[i].replace(/…$/, "");
    const keep = Math.max(0, p.length - over - 1);
    if (keep < 20) { b = b.slice(0, max - 1).replace(/\s+\S*$/, "").trimEnd() + "…"; break; }
    const cut = p.slice(0, keep);
    const atWord = cut.lastIndexOf(" ") > keep - 60 ? cut.slice(0, cut.lastIndexOf(" ")) : cut;
    paras[i] = `${atWord.replace(/[\s,;:]+$/, "")}…`;
    b = paras.join("\n\n");
  }
  return b;
}
export function withPhotoInvite(body: string): string {
  const b = (body || "").trimEnd();
  if (!b || hasAsk(b)) return b;
  return `${b}\n\n${/^hola\b/i.test(b.trimStart()) ? PHOTO_INVITE.es : PHOTO_INVITE.en}`;
}
// the same, with the PACT thread's ask (the words come from lib/jobFlow, so
// this file stays free of it: the browser's preview and the server both call this)
export function withJobAsk(body: string, ask: string): string {
  const b = (body || "").trimEnd();
  if (!b || !ask || hasAsk(b)) return b;
  return `${b}\n\n${ask}`;
}
