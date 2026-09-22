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
  // the work's own last stop is kept ("Paint everything!" / a cut line's "…"); a period is added only where there is none
  const work = flat(t.work).replace(/[.\s]+$/, "");
  const stop = /[!?…]$/.test(work) ? "" : ".";
  // a "move" to the same day is not a move — the old day is not repeated
  const moved = t.moved && t.moved.from && t.moved.from === t.moved.to ? { to: t.moved.to } : t.moved;
  const ref = jobRef(t);
  // "Van Dyke (370 Blake Avenue, Brooklyn, NY 11212), Apt 4B" — the building only when the street doesn't already name it
  const showBuilding = !!building && !sameText(building, street) && !(street && street.toLowerCase().includes(building.toLowerCase()));
  const place = building && street ? (showBuilding ? `${building} (${street})` : street) : street || building;
  const where = [place, apt && `${lang === "es" ? "Apto" : "Apt"} ${apt}`].filter(Boolean).join(", ");
  const paras: string[] = [];
  if (lang === "es") {
    const hello = `Hola${first ? ` ${first}` : ""}, le habla Earth Link.`;
    if (moved) {
      const to = longDay(moved.to, "es"), from = longDay(moved.from, "es");
      paras.push(`${hello} El trabajo${where ? ` en ${where}` : ""} se cambió ${to ? `al ${to}` : "a otro día"}.${from ? ` Antes era el ${from}.` : ""}`);
    } else {
      const day = longDay(t.day, "es");
      paras.push(`${hello} Tiene trabajo${day ? ` el ${day}` : ""}${where ? ` en ${where}` : ""}.${day ? "" : " El día se le avisará pronto."}${where ? "" : " La dirección se le enviará después."}`);
    }
    if (work) paras.push(`El trabajo es: ${work}${stop}`);
    if (ref) paras.push(`Este trabajo es el ${ref}.`);
    if (street) paras.push(`Aquí está el mapa: ${mapLink(street)}`);
    return paras.join("\n\n");
  }
  const hello = `Hi${first ? ` ${first}` : ""}, this is Earth Link.`;
  if (moved) {
    const to = longDay(moved.to), from = longDay(moved.from);
    paras.push(`${hello} The job${where ? ` at ${where}` : ""} has moved to ${to || "a new day"}.${from ? ` It was on ${from}.` : ""}`);
  } else {
    const day = longDay(t.day);
    paras.push(`${hello} You are scheduled to work${day ? ` on ${day}` : ""}${where ? ` at ${where}` : ""}.${day ? "" : " The day will be set soon."}${where ? "" : " The address will follow."}`);
  }
  if (work) paras.push(`Here is the work: ${work}${stop}`);
  if (ref) paras.push(`This job is ${ref}.`);
  if (street) paras.push(`Here is the map: ${mapLink(street)}`);
  return paras.join("\n\n");
}
