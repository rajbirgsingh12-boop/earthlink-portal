// The text a worker gets — one shape for every job, PACT or NYCHA, written
// in whole sentences a phone reads at a glance: who it's for, the day, where
// (the street, the building when the street isn't the whole story, the
// apartment), the work, the job's number, a map. A day change is the same
// message saying what changed.
import { mapLink } from "./mapLink";
export { mapLink };

// "Wednesday, September 23" — the whole word, the way a person says it
export const longDay = (iso?: string | null) =>
  iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : "";
const flat = (s?: string | null) => (s || "").replace(/\s+/g, " ").trim();
const sameText = (a: string, b: string) => flat(a).toLowerCase() === flat(b).toLowerCase();

export type CrewTextInput = {
  first?: string;                   // the worker's first name
  day?: string | null;              // "YYYY-MM-DD"
  street?: string | null;           // "370 Blake Avenue, Brooklyn, NY 11212"
  building?: string | null;         // the development or building name, when the street isn't the whole story
  apt?: string | null;
  work?: string | null;             // what they're going there to do
  ref?: string | null;              // "PO 116843 for Beacon Mgmt", "NYCHA release #81"
  moved?: { from?: string | null; to: string } | null;  // a day change: the new day, and the old one when known
};
export function crewText(t: CrewTextInput): string {
  const first = flat(t.first);
  const street = flat(t.street);
  const building = flat(t.building);
  const apt = flat(t.apt).replace(/^apt\.?\s*/i, "");
  const work = flat(t.work).replace(/[.\s]+$/, "");
  const ref = flat(t.ref).replace(/[.\s]+$/, "");
  const hello = `Hi${first ? ` ${first}` : ""}, this is Earth Link.`;
  // "Van Dyke (370 Blake Avenue, Brooklyn, NY 11212), Apt 4B" — the building only when the street doesn't already name it
  const showBuilding = !!building && !sameText(building, street) && !(street && street.toLowerCase().includes(building.toLowerCase()));
  const place = building && street ? (showBuilding ? `${building} (${street})` : street) : street || building;
  const where = [place, apt && `Apt ${apt}`].filter(Boolean).join(", ");
  const paras: string[] = [];
  if (t.moved) {
    const to = longDay(t.moved.to), from = longDay(t.moved.from);
    paras.push(`${hello} The job${where ? ` at ${where}` : ""} has moved to ${to || "a new day"}.${from ? ` It was on ${from}.` : ""}`);
  } else {
    const day = longDay(t.day);
    paras.push(`${hello} You are scheduled to work${day ? ` on ${day}` : ""}${where ? ` at ${where}` : ""}.${day ? "" : " The day will be set soon."}${where ? "" : " The address will follow."}`);
  }
  if (work) paras.push(`Here is the work: ${work}.`);
  if (ref) paras.push(`This is ${ref}.`);
  if (street) paras.push(`Here is the map: ${mapLink(street)}`);
  return paras.join("\n\n");
}
