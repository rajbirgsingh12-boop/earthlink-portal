// A PACT job, start to finish, by text — one thread the worker follows from
// the company number, and everything they send lands on the job:
//
//   the crew text   → "When you get there, reply with BEFORE photos."
//   before photos   → on the job as before photos; "Now text the square feet
//                      for: Plaster. Like: plaster 120 sf."
//   measurements    → onto the job's lines (the proposal and the invoice are
//                      drawn from those lines, so they carry the number from
//                      then on); "When you finish, reply with AFTER photos."
//   after photos    → on the job as after photos; "Thanks, all set."
//
// Where the job is in that thread is read off the job itself — the photos it
// has and the lines still waiting for a number — never kept anywhere else, so
// a photo the office took and a number the office typed count the same as a
// texted one. Pure: no database, no Twilio. The route (/api/sms-in) does the
// reading and writing; this decides and writes the words.
import { langOf } from "./crewText";
import { isSfLine, roundSf, type SfLine } from "./measure";
import { normUnit } from "./priceBook";

export type Stage = "before" | "measure" | "after" | "done";
export type PhotoKind = "before" | "after";
export interface StageInput { beforeN: number; afterN: number; needSf: boolean }
// no before photos yet: the job hasn't started; a measured line still blank:
// the number is the next thing; then the after photos; then nothing more
export const stageOf = (s: StageInput): Stage => (s.beforeN === 0 ? "before" : s.needSf ? "measure" : s.afterN === 0 ? "after" : "done");

// the photo's own name says which it is; a job's documents sort on the prefix
export const isImageName = (n: string) => /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(n || "");
export const kindOfName = (n: string): PhotoKind | null => (/^before/i.test(n || "") ? "before" : /^after/i.test(n || "") ? "after" : null);
export const countKinds = (names: string[]): { beforeN: number; afterN: number } => ({
  beforeN: names.filter((n) => isImageName(n) && kindOfName(n) === "before").length,
  afterN: names.filter((n) => isImageName(n) && kindOfName(n) === "after").length,
});

// lower-case, accents off, one space — "¡ANTES!" reads as "antes"
const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

// Which pile a texted picture goes on. The worker's own word wins ("before",
// "antes"; "after", "done", "terminado"). Without one: the first pictures of
// a job are the before pictures, and a picture sent minutes after a before
// batch (one send, split by the phone) stays with it; once the job has its
// before pictures, pictures are after pictures.
export function photoKindFor(body: string, stage: Stage, burstKind?: PhotoKind | null): PhotoKind {
  const t = norm(body);
  if (/\b(before|antes|previo|al llegar)\b/.test(t)) return "before";
  if (/\b(after|despues|done|finished|terminado|terminada|terminamos|listo|acabado|final)\b/.test(t)) return "after";
  if (burstKind) return burstKind;
  return stage === "before" ? "before" : "after";
}

// ---- the lines a worker can measure ----
export interface MeasureLine { index: number; key: string; name: string; unit: "SF" | "LF"; qty: number; has: boolean; words: string[] }
const isLf = (u: string) => /^(LF|LIN\.? ?FT|LINEAR ?(FT|FEET)|L\.?F\.?)$/.test(normUnit(u || ""));
// what a line is called in a text, by its price-book key, then by its own words
const KEY_WORDS: Record<string, string[]> = {
  plaster: ["plaster", "plastering", "plastered", "yeso", "plastr"],
  wall_repair: ["scrape", "scraping", "wall repair", "repair", "raspar", "raspado"],
  popcorn: ["popcorn", "ceiling", "techo", "textured"],
  sheetrock: ["sheetrock", "sheet rock", "drywall", "dry wall", "rock", "gypsum", "tabla", "tablaroca"],
};
// plain words that carry no meaning of their own in a measurement text
const FILLER = new Set(["the", "a", "an", "of", "for", "is", "are", "was", "about", "approx", "approximately", "around", "total", "totals", "all", "in", "on", "at", "to", "it", "its", "ok", "okay", "measurements", "measurement", "measure", "measured", "medidas", "medida", "mide", "son", "es", "de", "del", "la", "el", "los", "las", "en", "por", "para", "un", "una", "unos", "unas", "y", "and", "sq", "ft", "feet", "foot", "sf", "sqft", "square", "pies", "cuadrados", "cuadrado", "lf", "linear", "lin", "p2", "ft2", "area", "areas", "job", "po", "here", "aqui", "whole", "entire", "throughout", "apartment", "apt", "room", "rooms", "cuarto", "cuartos", "wall", "walls", "pared", "paredes", "with", "con", "sin", "no", "yes", "si", "thanks", "gracias", "please", "porfavor", "favor"]);
const STOP = new Set([...FILLER, "existing", "new", "repairs", "repair", "throughout", "damaged", "areas", "area", "and", "or", "per", "each", "with", "small", "large", "removal", "remove", "install", "replace", "work", "labor", "material", "materials"]);
const shortName = (d: string): string => {
  const words = (d || "").replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const name = words.slice(0, 3).join(" ");
  return name.length > 40 ? name.slice(0, 40).trimEnd() : name;
};
const NAME_BY_KEY: Record<string, string> = { plaster: "Plaster", wall_repair: "Scrape and plaster", popcorn: "Popcorn ceiling", sheetrock: "Sheetrock" };
const ownWords = (d: string): string[] =>
  [...new Set(norm(d).replace(/\(.*?\)/g, " ").replace(/[^a-z0-9 ]/g, " ").split(" ").filter((w) => w.length >= 4 && !STOP.has(w)))];
export function measureLines(items: SfLine[]): MeasureLine[] {
  return items.map((it, index) => {
    const sf = isSfLine(it);
    if (!sf && !isLf(it.unit || "")) return null;
    const key = it.key || "";
    const qty = Number(it.qty) || 0;
    return {
      index, key, unit: (sf ? "SF" : "LF") as "SF" | "LF", qty,
      has: qty > 1,   // the list's own lines start at 1 — that is the blank
      name: NAME_BY_KEY[key] || shortName(it.description),
      words: [...(KEY_WORDS[key] || []), ...ownWords(it.description)],
    };
  }).filter((l): l is MeasureLine => !!l);
}
export const needSf = (items: SfLine[]): boolean => measureLines(items).some((l) => !l.has);

// ---- reading a measurement text ----
export type MeasureHit = { index: number; qty: number } | { index: -1; qty: number; plaster: true };
export type Parsed =
  | { kind: "none" }
  | { kind: "ok"; hits: MeasureHit[] }
  | { kind: "ask"; why: "which" | "unknown" | "noline"; word?: string; qty?: number };
const UNIT = String.raw`(?:sq\.?\s*ft\.?|sqft|sf|sq\.?|square\s*(?:ft|feet)|ft2|pies\s*cuadrados|pies2|p2|lf|lin\.?\s*ft\.?|linear\s*(?:ft|feet))`;
// "120", "120 sf", "1,200 sq ft", "10x12" (feet by feet), "120.5". The
// character before the number is caught, not looked behind for — this file
// is read by the browser too, and Safari before 16.4 won't load a lookbehind.
const NUM = new RegExp(String.raw`(^|[^\d.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s*(?:x|by|por)\s*(\d+(?:\.\d+)?))?\s*(${UNIT})?(?![a-z\d])`, "g");
const REF = /\b(?:p\.?\s*o\.?|release|rel\.?)\s*(?:number|no\.?|num|#)?\s*[#:\-]?\s*\d{1,12}\b/g;
const SPLIT = /\s*(?:,|;|\n|\+|\band\b|\by\b|\bplus\b|\balso\b)\s*/;
interface Clause { qty: number; unit: string; words: string[] }
function clausesOf(body: string): { clauses: Clause[]; sawNumber: boolean } {
  // a job's number said out loud is not a measurement — and neither is any
  // number long enough to be a PO on its own
  // ("1,200" is one number, not two clauses)
  const t = norm(body).replace(REF, " ").replace(/(\d),(\d{3})(?!\d)/g, "$1$2");
  const clauses: Clause[] = [];
  let sawNumber = false;
  for (const part of t.split(SPLIT)) {
    const nums = [...part.matchAll(NUM)];
    if (!nums.length) continue;
    const words = part.replace(NUM, "$1 ").replace(/[^a-z ]/g, " ").split(" ").filter((w) => w && !FILLER.has(w));
    for (const m of nums) {
      const whole = m[2].replace(/,/g, "");
      const unit = (m[5] || "").replace(/\s+|\./g, "");
      if (!unit && whole.length >= 5) continue; // a PO, a phone, a unit number — not square feet
      sawNumber = true;
      let qty = Number(`${whole}${m[3] ? `.${m[3]}` : ""}`);
      if (m[4]) qty = qty * Number(m[4]);
      if (!(qty > 0)) continue;
      clauses.push({ qty, unit, words });
    }
  }
  return { clauses, sawNumber };
}
const PLASTER_WORDS = new Set(["plaster", "plastering", "plastered", "yeso"]);
const lineFor = (words: string[], lines: MeasureLine[]): MeasureLine[] => {
  const hits = new Set<MeasureLine>();
  for (const w of words) {
    const stem = w.replace(/(ing|ed|es|s)$/, "");
    for (const l of lines) {
      if (l.words.some((a) => a === w || a === stem || (a.length >= 4 && (a.startsWith(w) || w.startsWith(a)) && Math.abs(a.length - w.length) <= 3))) hits.add(l);
    }
  }
  // a word that fits two lines picks the one whose own key says it first:
  // "plaster" is the Plaster line, not Scrape and plaster
  if (hits.size > 1) {
    const exact = [...hits].filter((l) => words.some((w) => (KEY_WORDS[l.key] || [])[0] === w));
    if (exact.length === 1) return exact;
  }
  return [...hits];
};
// `expecting`: the job is waiting for its numbers right now — then a text
// that is nothing but a number is the number ("120"); otherwise a bare
// number is never taken for square feet (it is a unit, a time, a count of pictures)
export function parseMeasures(body: string, lines: MeasureLine[], expecting: boolean): Parsed {
  const { clauses, sawNumber } = clausesOf(body);
  if (!sawNumber) return { kind: "none" };
  const hits: MeasureHit[] = [];
  const bare: Clause[] = [];
  for (const c of clauses) {
    if (c.words.length === 0) { bare.push(c); continue; }
    const found = lineFor(c.words, lines);
    if (found.length === 1) { hits.push({ index: found[0].index, qty: c.qty }); continue; }
    if (found.length > 1) return { kind: "ask", why: "which", qty: c.qty };
    // "plaster 120 sf" on a job with no plaster line: a Plaster line is added
    if (c.words.some((w) => PLASTER_WORDS.has(w)) && !lines.some((l) => l.words.includes("plaster"))) { hits.push({ index: -1, qty: c.qty, plaster: true }); continue; }
    // words that name nothing on this job — unless the clause is only a unit
    // and filler, which reads as a bare number
    const meaningful = c.words.filter((w) => !STOP.has(w));
    if (meaningful.length === 0) { bare.push(c); continue; }
    // "see you at 8", "running 20 min late": a number among words that name
    // no line, with no unit on it, is talk. With a unit it is a measurement
    // of something this job doesn't have a line for — and that is asked about.
    if (!c.unit) return { kind: "none" };
    return { kind: "ask", why: "unknown", word: meaningful[0], qty: c.qty };
  }
  if (bare.length) {
    const withUnit = bare.some((c) => !!c.unit);
    // a plain number with no unit, in a text that says anything else, is not a measurement
    if (!withUnit && (!expecting || norm(body).replace(REF, " ").replace(NUM, " ").replace(/[^a-z]/g, "").length > 0)) return hits.length ? { kind: "ok", hits } : { kind: "none" };
    if (lines.length === 0) return { kind: "ask", why: "noline", qty: bare[0].qty };
    const blank = lines.filter((l) => !l.has && !hits.some((h) => h.index === l.index));
    const target = blank.length === 1 ? blank[0] : lines.length === 1 ? lines[0] : null;
    if (!target || bare.length > 1) return { kind: "ask", why: "which", qty: bare[0].qty };
    hits.push({ index: target.index, qty: bare[0].qty });
  }
  if (!hits.length) return { kind: "none" };
  // the last word on a line wins when it is named twice
  const byIndex = new Map<number, MeasureHit>();
  for (const h of hits) byIndex.set(h.index, h);
  return { kind: "ok", hits: [...byIndex.values()] };
}

// ---- the numbers onto the job's lines ----
export interface Change { name: string; qty: number; was: number; unit: "SF" | "LF" }
export function applyMeasures(items: SfLine[], hits: MeasureHit[], plasterPrice = 0): { items: SfLine[]; changes: Change[] } {
  const next = items.map((it) => ({ ...it }));
  const changes: Change[] = [];
  const lines = measureLines(items);
  for (const h of hits) {
    const qty = roundSf(h.qty);
    if (h.index === -1) {
      next.push({ description: "Plaster", qty, unit: "SF", unit_price: plasterPrice, key: "plaster" });
      changes.push({ name: "Plaster", qty, was: 0, unit: "SF" });
      continue;
    }
    const l = lines.find((x) => x.index === h.index);
    if (!l || !next[h.index]) continue;
    const was = Number(next[h.index].qty) || 0;
    next[h.index] = { ...next[h.index], qty, unit: l.unit === "SF" && normUnit(next[h.index].unit || "") !== "SF" ? "SF" : next[h.index].unit };
    changes.push({ name: l.name, qty, was, unit: l.unit });
  }
  return { items: next, changes };
}

// ---- the words ----
const unitWord = (u: "SF" | "LF", lang: "en" | "es") => (u === "LF" ? (lang === "es" ? "pies lineales" : "linear ft") : lang === "es" ? "pies cuadrados" : "sq ft");
const example = (lines: MeasureLine[]): string => {
  const pick = (lines.filter((l) => !l.has).length ? lines.filter((l) => !l.has) : lines).slice(0, 2);
  if (!pick.length) return "plaster 120 sf";
  return pick.map((l, i) => `${l.name.toLowerCase().split(" ")[0]} ${i === 0 ? 120 : 40} ${l.unit === "LF" ? "lf" : "sf"}`).join(", ");
};
const list = (lines: MeasureLine[]) => lines.map((l) => l.name).join(", ");
// "3 BEFORE photos" / "3 fotos de ANTES"
const kindN = (n: number, kind: PhotoKind, lang: "en" | "es") =>
  lang === "es" ? `${n} foto${n === 1 ? "" : "s"} de ${kind === "before" ? "ANTES" : "DESPUES"}` : `${n} ${kind === "before" ? "BEFORE" : "AFTER"} photo${n === 1 ? "" : "s"}`;

// the line at the foot of the crew text: the three steps, in one breath
export function jobAsk(lang0: string | null | undefined, needsSf: boolean): string {
  const lang = langOf(lang0);
  if (lang === "es") return `Al llegar, responda con fotos de ANTES.${needsSf ? " Luego mande los pies cuadrados, como: plaster 120 sf." : ""} Al terminar, responda con fotos de DESPUES.`;
  return `When you get there, reply with BEFORE photos.${needsSf ? " Then text the square feet, like: plaster 120 sf." : ""} When you finish, reply with AFTER photos.`;
}
export const JOB_ASK_MARK = { en: "reply with BEFORE photos", es: "responda con fotos de ANTES" };
// the before pictures are on the job: what comes next
export function gotBeforeText(n: number, label: string, lines: MeasureLine[], lang0?: string | null): string {
  const lang = langOf(lang0);
  const blank = lines.filter((l) => !l.has);
  if (lang === "es") {
    return blank.length
      ? `Recibido: ${kindN(n, "before", lang)} en el ${label}. Ahora mande los pies cuadrados de: ${list(blank)}. Como: ${example(lines)}.`
      : `Recibido: ${kindN(n, "before", lang)} en el ${label}. Al terminar, responda con fotos de DESPUES.`;
  }
  return blank.length
    ? `Got ${kindN(n, "before", lang)} on ${label}. Now text the square feet for: ${list(blank)}. Like: ${example(lines)}.`
    : `Got ${kindN(n, "before", lang)} on ${label}. When you finish, reply with AFTER photos.`;
}
// the numbers are on the job's lines — and so on the proposal and the invoice
export function gotMeasureText(changes: Change[], label: string, stillBlank: MeasureLine[], lang0?: string | null): string {
  const lang = langOf(lang0);
  const got = changes.map((c) => `${c.name} ${c.qty} ${unitWord(c.unit, lang)}`).join(", ");
  if (lang === "es") {
    return `Anotado: ${got} en el ${label}. Ya está en la propuesta y la factura.${stillBlank.length ? ` Falta: ${list(stillBlank)}.` : " Al terminar, responda con fotos de DESPUES."}`;
  }
  return `Got it: ${got} on ${label}. It's on the proposal and the invoice.${stillBlank.length ? ` Still need: ${list(stillBlank)}.` : " When you finish, reply with AFTER photos."}`;
}
export function askMeasureText(p: Extract<Parsed, { kind: "ask" }>, label: string, lines: MeasureLine[], lang0?: string | null): string {
  const lang = langOf(lang0);
  const qty = p.qty ? `${roundSf(p.qty)} ${lang === "es" ? "pies cuadrados" : "sq ft"}` : "";
  if (p.why === "noline") {
    return lang === "es"
      ? `El ${label} no tiene una línea por pies cuadrados. Mande el número con el trabajo, como: plaster ${roundSf(p.qty || 120)} sf.`
      : `${label} has no square-foot line. Text the number with the work, like: plaster ${roundSf(p.qty || 120)} sf.`;
  }
  if (p.why === "unknown") {
    return lang === "es"
      ? `No veo "${p.word}" en el ${label}. Las líneas son: ${list(lines)}. Mande como: ${example(lines)}.`
      : `I don't see "${p.word}" on ${label}. The lines are: ${list(lines)}. Text it like: ${example(lines)}.`;
  }
  return lang === "es"
    ? `¿De qué línea ${qty ? `son los ${qty}` : "es"}? Mande como: ${example(lines)}.`
    : `Which line ${qty ? `is the ${qty} for` : "is it for"}? Text it like: ${example(lines)}.`;
}
// pictures and the square feet in one text: both landed
export function gotBothText(kind: PhotoKind, n: number, label: string, changes: Change[], stillBlank: MeasureLine[], lang0?: string | null): string {
  const lang = langOf(lang0);
  const got = changes.map((c) => `${c.name} ${c.qty} ${unitWord(c.unit, lang)}`).join(", ");
  if (lang === "es") {
    return `Recibido: ${kindN(n, kind, lang)} en el ${label}. Anotado: ${got}. Ya está en la propuesta y la factura.${stillBlank.length ? ` Falta: ${list(stillBlank)}.` : kind === "before" ? " Al terminar, responda con fotos de DESPUES." : " ¡Gracias, todo listo!"}`;
  }
  return `Got ${kindN(n, kind, lang)} on ${label}. Got it: ${got}. It's on the proposal and the invoice.${stillBlank.length ? ` Still need: ${list(stillBlank)}.` : kind === "before" ? " When you finish, reply with AFTER photos." : " Thanks, all set!"}`;
}
// a measurement with no one PACT job to put it on
export function askWhichJobText(lang0?: string | null): string {
  return langOf(lang0) === "es"
    ? "¿Para qué trabajo es esa medida? Mándela con el número de PO, como: PO 116843 plaster 120 sf."
    : "Which job is that measurement for? Text it with the PO number, like: PO 116843 plaster 120 sf.";
}
// the after pictures are on the job: the thread is done
export function gotAfterText(n: number, label: string, stillBlank: MeasureLine[], lang0?: string | null): string {
  const lang = langOf(lang0);
  if (lang === "es") return `Recibido: ${kindN(n, "after", lang)} en el ${label}. ¡Gracias, todo listo!${stillBlank.length ? ` No olvide los pies cuadrados de: ${list(stillBlank)} (como: ${example(stillBlank)}).` : ""}`;
  return `Got ${kindN(n, "after", lang)} on ${label}. Thanks, all set!${stillBlank.length ? ` Don't forget the square feet for: ${list(stillBlank)} (like: ${example(stillBlank)}).` : ""}`;
}
// the line on the job's notes and on the office's card
export const measureNoteLine = (changes: Change[], who: string, when: string): string =>
  `📏 ${when} · ${changes.map((c) => `${c.name} ${c.qty} ${c.unit === "LF" ? "lin ft" : "sq ft"}${c.was > 1 ? ` (was ${c.was})` : ""}`).join(", ")} · texted by ${who || "the crew"}`;
