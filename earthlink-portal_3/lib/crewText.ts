// The text a worker gets — one shape for every job, PACT or NYCHA, laid out
// so a phone reads it at a glance: who, the day, the street, the building,
// the apartment, the work, the job's number, a map. A day change is the same
// block with the day line saying what changed.
import { prettyDate } from "./docs";

export const mapLink = (addr: string) => `https://maps.google.com/?q=${encodeURIComponent(addr)}`;
// "Tue, Sep 23" — a crew wants the weekday
export const dayWord = (iso?: string | null) =>
  iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "";
const sameText = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

export type CrewTextInput = {
  first?: string;                   // the worker's first name
  day?: string | null;              // "YYYY-MM-DD"
  street?: string | null;           // "370 Blake Avenue, Brooklyn, NY 11212"
  building?: string | null;         // the development or building name, when the street isn't the whole story
  apt?: string | null;
  work?: string | null;             // what they're going there to do
  ref?: string | null;              // "PO 116843 · Beacon Mgmt", "NYCHA release #81"
  moved?: { from?: string | null; to: string } | null;  // a day change: the new day, and the old one when known
};
export function crewText(t: CrewTextInput): string {
  const first = (t.first || "").trim();
  const street = (t.street || "").replace(/\s+/g, " ").trim();
  const building = (t.building || "").replace(/\s+/g, " ").trim();
  const apt = (t.apt || "").trim();
  const work = (t.work || "").replace(/\s+/g, " ").trim();
  const ref = (t.ref || "").trim();
  const lines: string[] = [];
  if (t.moved) {
    lines.push(`Earth Link — ${first ? `${first}, ` : ""}day change:`);
  } else {
    lines.push(`Earth Link — ${first ? `${first}, ` : ""}you're on:`);
    lines.push(t.day ? dayWord(t.day) : "Day: to be set");
  }
  if (street) lines.push(street);
  if (building && !sameText(building, street) && !(street && street.toLowerCase().includes(building.toLowerCase()))) lines.push(street ? `${building} (building)` : building);
  if (!street && !building) lines.push("(no address on file)");
  if (apt) lines.push(`Apt ${apt}`);
  if (t.moved) lines.push(`Now: ${dayWord(t.moved.to)}${t.moved.from ? ` (was ${dayWord(t.moved.from)})` : ""}`);
  if (work) lines.push(`Work: ${work}`);
  if (ref) lines.push(ref);
  if (street) lines.push(`Map: ${mapLink(street)}`);
  return lines.join("\n");
}
// the day the way the rest of the app prints it, for anything that quotes a text
export const longDay = prettyDate;
