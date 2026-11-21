// The words of a crew text posted into a crew's group thread: one message
// that greets everyone in the thread, English first and Spanish under it
// when the crew reads both. Pure, with no server code in it, so the
// browser's "What they get" preview (components/CrewPanel) and the server's
// send (lib/crewSend) build the same message the same way.
import { fitText } from "./crewText";

export type ThreadLang = "en" | "es";
const TWILIO_MAX = 1600;

const isEs = (body: string) => /^hola\b/i.test(body);
// "Jose", "Jose and Luis", "Jose, Luis and Sam"
export const nameList = (names: string[], lang: ThreadLang): string => {
  const n = [...new Set(names.filter(Boolean))];
  if (n.length <= 1) return n[0] || "";
  const and = lang === "es" ? "y" : "and";
  return `${n.slice(0, -1).join(", ")} ${and} ${n[n.length - 1]}`;
};
// the greeting names everyone in the thread: "Hi Jose and Luis, this is
// Earth Link." And Spanish speaks to all of them ("les habla", "Tienen", "respondan")
// `all`: "Hi all" / "Hola a todos", when the names would make it too long for one text
export function groupGreeting(body: string, names: string[], all = false): string {
  const es = isEs(body);
  const list = all ? (es ? "a todos" : "all") : nameList(names, es ? "es" : "en");
  if (!list) return body;
  if (!es) return body.replace(/^Hi\b[^,]*?, this is Earth Link\./, `Hi ${list}, this is Earth Link.`);
  const many = all || new Set(names.filter(Boolean)).size > 1;
  let out = body.replace(/^Hola\b[^,]*?, le habla Earth Link\./, `Hola ${list}, ${many ? "les" : "le"} habla Earth Link.`);
  if (many) out = out.replace(/\bTiene trabajo\b/, "Tienen trabajo").replace(/\bresponda\b/g, "respondan").replace(/\bResponda\b/g, "Respondan").replace(/\bmande\b/g, "manden").replace(/\bse le avisará\b/g, "se les avisará").replace(/\bse le enviará\b/g, "se les enviará");
  return out;
}
// what a crew that may read two languages gets: English first, Spanish under
// it, in one message when that fits; otherwise one message each
export function groupBodies(bodies: string[], names: string[]): string[] {
  const en = bodies.find((b) => !isEs(b)), es = bodies.find(isEs);
  // (each part one text: a greeting too long for it says "Hi all", and a part still over is cut in its work line)
  const greet = (b: string) => { const g = groupGreeting(b, names); return g.length <= TWILIO_MAX ? g : fitText(groupGreeting(b, names, true), TWILIO_MAX); };
  const parts = [en, es].filter((b): b is string => !!b).map(greet);
  const joined = parts.join("\n\n");
  return parts.length > 1 && joined.length > TWILIO_MAX - 100 ? parts : parts.length ? [joined] : [];
}
export const groupBody = (bodies: string[], names: string[]): string => groupBodies(bodies, names).join("\n\n");

// The rule lib/crewSend follows, for the preview: a send goes into the
// thread only when it is for everyone who would be in that thread (on the
// job that day, still on the crew list, with a usable number). A send for
// part of the crew (a worker added later, a Resend to one) goes one to one,
// each worker in their own language, so nobody already told is texted again.
//   crew:    everyone who would be in the thread, by employee id, with a first name
//   sending: the workers this send is for, by employee id, with their language
//   bodyFor: one worker's text in that language, the ask already on it
// Returns the message (one part, or two when English and Spanish together
// pass Twilio's limit) and the languages in it; null when the send goes one
// to one.
export function threadPreview(
  crew: { id: string; first: string }[],
  sending: { id: string; lang: ThreadLang }[],
  bodyFor: (lang: ThreadLang) => string,
): { parts: string[]; langs: ThreadLang[] } | null {
  const inThread = sending.filter((s) => crew.some((c) => c.id === s.id));
  if (!inThread.length || crew.some((c) => !inThread.some((s) => s.id === c.id))) return null;
  const langs = (["en", "es"] as ThreadLang[]).filter((l) => inThread.some((s) => s.lang === l));
  return { parts: groupBodies(langs.map(bodyFor), crew.map((c) => c.first)), langs };
}
// the line under that preview, in plain words
export const threadNote = (p: { parts: string[]; langs: ThreadLang[] }): string =>
  `One message into the crew's thread (you, the crew and the company number)${p.langs.length > 1 ? ", English then Spanish" : p.langs[0] === "es" ? ", in Spanish" : ""}.${p.parts.length > 1 ? " It is too long for one text, so it goes as two." : " A message too long for one text goes as two."} If the thread can't be made, each worker gets their own text instead.`;
