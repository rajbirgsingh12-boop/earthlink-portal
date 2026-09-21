// The text a worker gets — one shape for every job, PACT or NYCHA, written
// in whole sentences a phone reads at a glance: who it's for, the day, where
// (the street, the building when the street isn't the whole story, the
// apartment), the work, a map. No PO or release number — the crew doesn't
// need one. A day change is the same message saying what changed. Each
// worker gets it in their own language: English, or Spanish.
import { mapLink } from "./mapLink";
export { mapLink };

export type Lang = "en" | "es";
// "es", "ES", "Español", "spanish" → Spanish; anything else (or nothing) → English
export const langOf = (v?: string | null): Lang => (/^(es|spa|esp)/i.test((v || "").trim()) ? "es" : "en");
export const LANG_LABEL: Record<Lang, string> = { en: "English", es: "Español" };

// "Wednesday, September 23" / "miércoles, 23 de septiembre" — the whole word, the way a person says it
export const longDay = (iso?: string | null, lang: Lang = "en") =>
  iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + "T00:00:00").toLocaleDateString(lang === "es" ? "es" : "en-US", { weekday: "long", month: "long", day: "numeric" }) : "";
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
};
export function crewText(t: CrewTextInput): string {
  const lang = langOf(t.lang);
  const first = flat(t.first);
  const street = flat(t.street);
  const building = flat(t.building);
  const apt = flat(t.apt).replace(/^apt\.?\s*/i, "");
  const work = flat(t.work).replace(/[.\s]+$/, "");
  // "Van Dyke (370 Blake Avenue, Brooklyn, NY 11212), Apt 4B" — the building only when the street doesn't already name it
  const showBuilding = !!building && !sameText(building, street) && !(street && street.toLowerCase().includes(building.toLowerCase()));
  const place = building && street ? (showBuilding ? `${building} (${street})` : street) : street || building;
  const where = [place, apt && `Apt ${apt}`].filter(Boolean).join(", ");
  const paras: string[] = [];
  if (lang === "es") {
    const hello = `Hola${first ? ` ${first}` : ""}, le habla Earth Link.`;
    if (t.moved) {
      const to = longDay(t.moved.to, "es"), from = longDay(t.moved.from, "es");
      paras.push(`${hello} El trabajo${where ? ` en ${where}` : ""} se cambió ${to ? `al ${to}` : "a otro día"}.${from ? ` Antes era el ${from}.` : ""}`);
    } else {
      const day = longDay(t.day, "es");
      paras.push(`${hello} Tiene trabajo${day ? ` el ${day}` : ""}${where ? ` en ${where}` : ""}.${day ? "" : " El día se le avisará pronto."}${where ? "" : " La dirección se le enviará después."}`);
    }
    if (work) paras.push(`El trabajo es: ${work}.`);
    if (street) paras.push(`Aquí está el mapa: ${mapLink(street)}`);
    return paras.join("\n\n");
  }
  const hello = `Hi${first ? ` ${first}` : ""}, this is Earth Link.`;
  if (t.moved) {
    const to = longDay(t.moved.to), from = longDay(t.moved.from);
    paras.push(`${hello} The job${where ? ` at ${where}` : ""} has moved to ${to || "a new day"}.${from ? ` It was on ${from}.` : ""}`);
  } else {
    const day = longDay(t.day);
    paras.push(`${hello} You are scheduled to work${day ? ` on ${day}` : ""}${where ? ` at ${where}` : ""}.${day ? "" : " The day will be set soon."}${where ? "" : " The address will follow."}`);
  }
  if (work) paras.push(`Here is the work: ${work}.`);
  if (street) paras.push(`Here is the map: ${mapLink(street)}`);
  return paras.join("\n\n");
}
