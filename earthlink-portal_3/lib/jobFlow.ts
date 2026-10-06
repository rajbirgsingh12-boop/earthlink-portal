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
  popcorn: ["popcorn", "textured", "texturizado"],
  sheetrock: ["sheetrock", "sheet rock", "drywall", "dry wall", "rock", "gypsum", "tabla", "tablaroca"],
};
// plain words that carry no meaning of their own in a measurement text
const FILLER = new Set(["the", "a", "an", "of", "for", "is", "are", "was", "about", "approx", "approximately", "around", "total", "totals", "all", "in", "on", "at", "to", "it", "its", "ok", "okay", "measurements", "measurement", "measure", "measured", "medidas", "medida", "mide", "son", "es", "de", "del", "la", "el", "los", "las", "en", "por", "para", "un", "una", "unos", "unas", "y", "and", "sq", "ft", "feet", "foot", "sf", "sqft", "square", "pies", "cuadrados", "cuadrado", "lf", "linear", "lin", "p2", "ft2", "area", "areas", "job", "po", "here", "aqui", "whole", "entire", "throughout", "apartment", "apt", "room", "rooms", "cuarto", "cuartos", "wall", "walls", "pared", "paredes", "ceiling", "ceilings", "techo", "techos", "bedroom", "bedrooms", "bathroom", "bathrooms", "bath", "kitchen", "living", "livingroom", "hallway", "hall", "closet", "foyer", "recamara", "recamaras", "dormitorio", "bano", "banos", "cocina", "sala", "pasillo", "with", "con", "sin", "no", "yes", "si", "thanks", "gracias", "please", "porfavor", "favor"]);
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
// A number is believed only when it is clearly a measurement of a line this
// job has: "plaster 120 sf", "yeso 10x12", "2 walls 10 x 8 sheetrock". A
// number that is a job number, an apartment, a time, a count of pictures, or
// talk ("see you at 8") is passed over, never written on a line. Anything
// in between is asked about, not guessed — a wrong number is a wrong bill.
export type MeasureHit = { index: number; qty: number } | { index: -1; qty: number; plaster: true };
export type Parsed =
  | { kind: "none" }
  | { kind: "ok"; hits: MeasureHit[] }
  | { kind: "ask"; why: "which" | "unknown" | "noline" | "unit" | "big"; word?: string; qty?: number; line?: string; was?: number };
export interface ParseOptions { ignore?: string[] }   // numbers that are job numbers to this worker — never square feet
const SQ_UNIT = String.raw`sqft|sq\s*ft|sq\s*feet|sf|square\s*(?:ft|feet|foot)|ft2|pies\s*cuadrados|pies2|p2`;
const LF_UNIT = String.raw`lf|lin\s*ft|linear\s*(?:ft|feet|foot)|pies\s*lineales`;
const M2_UNIT = String.raw`m2|sqm|sq\s*m|square\s*met(?:er|re)s?|metros\s*cuadrados|mts2`;
const UNIT = `(?:${SQ_UNIT}|${LF_UNIT}|${M2_UNIT})`;
const SQFT_PER_M2 = 10.7639;
const N = String.raw`(\d+(?:\.\d+)?)`;
// "10x12", "10 by 12 ft", "10' x 8'", with an optional count in front: "2 walls 10x8"
// every number is read from its own start: "4b", "2nd", "x8" inside a word are not numbers
const EDGE = String.raw`(^|[^\d.a-z])`;
const DIMS = new RegExp(String.raw`${EDGE}(?:(\d{1,2})\s*(?:walls?|paredes?|sides?|lados?|ceilings?|techos?|rooms?|cuartos?|areas?|spots?|pieces?|pcs?|x|times|veces)\s*(?:of|de|at|a|@)?\s*)?${N}\s*(?:ft|feet|pies|')?\s*(?:x|by|por)\s*${N}\s*(?:ft|feet|pies|')?(?:\s*(${UNIT}))?(?![a-z\d])`, "g");
const NUM_UNIT = new RegExp(String.raw`${EDGE}${N}\s*(${UNIT})(?![a-z\d])`, "g");
const BARE = new RegExp(String.raw`${EDGE}(\d+(?:\.\d+)?)(?![a-z\d.])`, "g");
// a count or an address number stays one when a measurement follows it ("2 walls 10x8", "floor 120 sf")
const NOT_TAIL = String.raw`(?!\s*(?:of|de|at|a|@)?\s*(?:${UNIT}\b|\d+(?:\.\d+)?\s*(?:ft|feet|pies|')?\s*(?:x|by|por)\s*\d))`;
// a number that is something else, taken out before any reading:
//   a job number said out loud, a time, a price, a date, a percentage,
//   "apt 302" / "unit 4" / "#12", "3 pics", "2 coats", "8 hours"
const REF = /\b(?:p\.?\s*o\.?|release|rel\.?)\s*(?:number|no\.?|num|#)?\s*[#:\-]?\s*\d{1,12}\b/g;
const NOT_A_MEASURE: RegExp[] = [
  /\b\d{1,2}:\d{2}\b(?:\s*(?:am|pm))?/g, /\b\d{1,2}\s*(?:am|pm)\b/g, /\$\s*\d+(?:\.\d+)?/g, /\b\d+(?:\.\d+)?\s*%/g,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, /\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g,
  new RegExp(String.raw`\b(?:apt|apartment|unit|apto|apartamento|depto|departamento|room|rm|floor|fl|piso|suite|ste|bldg|building|edificio|house|casa|no|num|number|numero|job|trabajo)\.?\s*#?\s*\d{1,6}[a-z]?\b${NOT_TAIL}`, "g"),
  new RegExp(String.raw`#\s*\d{1,6}[a-z]?\b${NOT_TAIL}`, "g"),
  new RegExp(String.raw`\b\d{1,3}\s*(?:pics?|pictures?|photos?|fotos?|imagenes?|imgs?|coats?|capas?|manos?|hours?|hrs?|horas?|days?|dias?|min|mins|minutes?|minutos?|bags?|bolsas?|buckets?|cubetas?|cans?|latas?|boxes?|cajas?|guys?|people|men|hombres|personas?|workers?|trabajadores?|doors?|puertas?|windows?|ventanas?|rooms?|cuartos?|bedrooms?|recamaras?|bathrooms?|banos?|closets?|floors?|pisos?|apts?|apartments?|apartamentos?|units?|outlets?|switches?|lights?|luces?|sheets?|hojas?|boards?|tablas?|tiles?|losas?|pieces?|piezas?|pcs?|each|ea|c\/u|times|veces|trips?|viajes?|holes?|hoyos?|agujeros?|spots?|patches?|parches?)\b${NOT_TAIL}`, "g"),
];
// "sq. ft." keeps its dots so a sentence break ". " is just that
const unDot = (t: string) => t.replace(/\bsq\.\s*ft\.?/g, "sqft").replace(/\blin\.\s*ft\.?/g, "linft").replace(/\bft\./g, "ft");
const SPLIT = /\s*(?:,|;|\n|\+|\.\s+|\band\b|\by\b|\bplus\b|\balso\b|\bmas\b|\btambien\b)\s*/;
const MAX_TEXTED_SQFT = 5000;   // no apartment wall is bigger — lib/measure's cap, for texted numbers too
interface Clause { nums: { qty: number; explicit: boolean }[]; words: string[]; text: string }
// the text, cleaned and cut into clauses, each with the numbers that could
// be measurements and the plain words left around them
export function clausesOf(body: string, ignore: string[] = []): Clause[] {
  let t = unDot((body || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""))
    .replace(/(\d),(\d{3})(?!\d)/g, "$1$2")   // 1,200 is one number
    .replace(REF, " ");
  for (const re of NOT_A_MEASURE) t = t.replace(re, " ");
  // this worker's job numbers, said bare ("4521" after pictures), are not square feet
  for (const k of ignore) if (/^\d{3,}$/.test(k)) t = t.replace(new RegExp(String.raw`(^|[^\d.])${k}(?![\d.])`, "g"), "$1 ");
  const out: Clause[] = [];
  for (const part0 of t.split(SPLIT)) {
    const part = part0.replace(/\s+/g, " ").trim();
    if (!part) continue;
    const nums: Clause["nums"] = [];
    let rest = part;
    const metric = (unit?: string) => !!unit && new RegExp(`^(?:${M2_UNIT})$`).test(unit.replace(/\s+/g, ""));
    rest = rest.replace(DIMS, (_m, pre, count, a, b, unit) => {
      const qty = Number(a) * Number(b) * (count ? Number(count) : 1) * (metric(unit) ? SQFT_PER_M2 : 1);
      if (qty > 0) nums.push({ qty, explicit: true });
      return `${pre} `;
    });
    rest = rest.replace(NUM_UNIT, (_m, pre, n, unit) => {
      const qty = Number(n) * (metric(unit) ? SQFT_PER_M2 : 1);
      if (qty > 0) nums.push({ qty, explicit: true });
      return `${pre} `;
    });
    rest = rest.replace(BARE, (_m, pre, n) => {
      if (n.replace(/\.\d+$/, "").length >= 5) return `${pre} `;   // a PO, a phone number — never square feet on its own
      const qty = Number(n);
      if (qty > 0) nums.push({ qty, explicit: false });
      return `${pre} `;
    });
    const words = rest.replace(/[^a-z ]/g, " ").split(" ").filter((w) => w && !FILLER.has(w));
    out.push({ nums, words, text: part });
  }
  return out;
}
const PLASTER_WORDS = new Set(["plaster", "plastering", "plastered", "yeso"]);
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "");
// does a texted word name this line — its key's words or its own, by the
// whole word or its stem; a prefix only when both are real words of about the same length
const names = (w: string, a: string) =>
  a === w || a === stem(w) || stem(a) === stem(w) || (a.length >= 4 && w.length >= 4 && (a.startsWith(w) || w.startsWith(a)) && Math.abs(a.length - w.length) <= 2);
const lineFor = (words: string[], lines: MeasureLine[]): MeasureLine[] => {
  const hits = new Set<MeasureLine>();
  for (const w of words) for (const l of lines) if (l.words.some((a) => names(w, a))) hits.add(l);
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
export function parseMeasures(body: string, lines: MeasureLine[], expecting: boolean, opts: ParseOptions = {}): Parsed {
  const clauses = clausesOf(body, opts.ignore || []);
  if (!clauses.some((c) => c.nums.length)) return { kind: "none" };
  const sums = new Map<number, { qty: number; explicit: boolean; line: MeasureLine | null }>();
  const add = (index: number, line: MeasureLine | null, n: { qty: number; explicit: boolean }) => {
    const cur = sums.get(index) || { qty: 0, explicit: true, line };
    sums.set(index, { qty: cur.qty + n.qty, explicit: cur.explicit && n.explicit, line });
  };
  const bare: Clause[] = [];
  for (const c of clauses) {
    if (!c.nums.length) continue;   // talk around the numbers ("thanks", "2 pics")
    if (c.words.length === 0) { bare.push(c); continue; }
    const found = lineFor(c.words, lines);
    // "plaster 120 sf" on a job with no plaster line: a Plaster line is added
    const newPlaster = !found.length && c.words.some((w) => PLASTER_WORDS.has(w)) && !lines.some((l) => l.words.includes("plaster"));
    if (found.length > 1) return { kind: "ask", why: "which", qty: c.nums[0].qty };
    if (found.length === 1 || newPlaster) {
      // "plaster 120 140": two numbers for one line in one breath — which?
      if (c.nums.length > 1) return { kind: "ask", why: "which", qty: c.nums[0].qty, line: found[0]?.name || "Plaster" };
      add(newPlaster ? -1 : found[0].index, found[0] || null, c.nums[0]);
      continue;
    }
    // words that name nothing on this job — unless the clause is only a unit
    // and filler, which reads as a bare number
    const meaningful = c.words.filter((w) => !STOP.has(w));
    if (meaningful.length === 0) { bare.push(c); continue; }
    // "see you at 8", "running 20 min late": a number among words that name
    // no line, with no unit on it, is talk and skipped. With a unit it is a
    // measurement of something this job has no line for — and that is asked about.
    if (c.nums.some((n) => n.explicit)) return { kind: "ask", why: "unknown", word: meaningful[0], qty: c.nums.find((n) => n.explicit)!.qty };
  }
  if (bare.length) {
    const nums = bare.flatMap((c) => c.nums);
    const withUnit = nums.some((n) => n.explicit);
    // a plain number with no unit, in a text that says anything else, is not a measurement
    const onlyNumbers = clauses.every((c) => c.words.length === 0 || c.words.every((w) => STOP.has(w)));
    if (!withUnit && (!expecting || !onlyNumbers)) return sums.size ? finish(sums) : { kind: "none" };
    // a number beside a named line's number ("plaster 120 sf, 300 total"): which line is the loose one for?
    if (sums.size) return { kind: "ask", why: "which", qty: nums[0].qty };
    if (lines.length === 0) return { kind: "ask", why: "noline", qty: nums[0].qty };
    const blank = lines.filter((l) => !l.has);
    const target = blank.length === 1 ? blank[0] : lines.length === 1 ? lines[0] : null;
    if (!target || nums.length > 1) return { kind: "ask", why: "which", qty: nums[0].qty };
    add(target.index, target, nums[0]);
  }
  if (!sums.size) return { kind: "none" };
  return finish(sums);
}
// the lines named: the same line twice in one text adds up ("plaster 10x8,
// plaster 12x8"); a line that already carries a number is only changed by a
// number with its unit on it; nothing bigger than any apartment goes on
function finish(sums: Map<number, { qty: number; explicit: boolean; line: MeasureLine | null }>): Parsed {
  const hits: MeasureHit[] = [];
  for (const [index, s] of sums) {
    const qty = Math.round(s.qty * 100) / 100;
    if (qty > MAX_TEXTED_SQFT) return { kind: "ask", why: "big", qty, line: s.line?.name || "Plaster" };
    if (s.line && s.line.has && !s.explicit) return { kind: "ask", why: "unit", qty, line: s.line.name, was: s.line.qty };
    hits.push(index === -1 ? { index: -1, qty, plaster: true } : { index, qty });
  }
  return { kind: "ok", hits };
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
  if (p.why === "unit") {
    const have = `${p.was || 0} ${lang === "es" ? "pies cuadrados" : "sq ft"}`;
    const ex = `${(p.line || "plaster").toLowerCase().split(" ")[0]} ${roundSf(p.qty || 130)} sf`;
    return lang === "es"
      ? `${p.line || "Esa línea"} ya tiene ${have} en el ${label}. Para cambiarlo, mándelo con la unidad, como: ${ex}.`
      : `${p.line || "That line"} already has ${have} on ${label}. To change it, text it with the unit, like: ${ex}.`;
  }
  if (p.why === "big") {
    return lang === "es"
      ? `${qty} para ${p.line || "esa línea"} es más que cualquier apartamento. Revise el número y mándelo otra vez.`
      : `${qty} for ${p.line || "that line"} is more than any apartment. Check the number and text it again.`;
  }
  if (p.why === "which" && p.line) {
    return lang === "es"
      ? `Dos números para ${p.line}. Mande uno solo, como: ${example(lines)}.`
      : `Two numbers for ${p.line}. Text just one, like: ${example(lines)}.`;
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
// `lost`: pictures in the text that didn't come through — then nothing is "all set"
export function gotBothText(kind: PhotoKind, n: number, label: string, changes: Change[], stillBlank: MeasureLine[], lang0?: string | null, marked = false, lost = 0): string {
  const lang = langOf(lang0);
  const got = changes.map((c) => `${c.name} ${c.qty} ${unitWord(c.unit, lang)}`).join(", ");
  const tail = marked ? ` ${MARKED_DONE[lang]}` : "";
  const thanks = lost ? "" : lang === "es" ? " ¡Gracias, todo listo!" : " Thanks, all set!";
  if (lang === "es") {
    return `Recibido: ${kindN(n, kind, lang)} en el ${label}. Anotado: ${got}. Ya está en la propuesta y la factura.${stillBlank.length ? ` Falta: ${list(stillBlank)}.` : kind === "before" ? " Al terminar, responda con fotos de DESPUES." : thanks}${tail}`;
  }
  return `Got ${kindN(n, kind, lang)} on ${label}. Got it: ${got}. It's on the proposal and the invoice.${stillBlank.length ? ` Still need: ${list(stillBlank)}.` : kind === "before" ? " When you finish, reply with AFTER photos." : thanks}${tail}`;
}
// a measurement with no one PACT job to put it on
export function askWhichJobText(lang0?: string | null): string {
  return langOf(lang0) === "es"
    ? "¿Para qué trabajo es esa medida? Mándela con el número de PO, como: PO 116843 plaster 120 sf."
    : "Which job is that measurement for? Text it with the PO number, like: PO 116843 plaster 120 sf.";
}
// a measurement for a job the office already billed: the lines are not touched
export function invoicedText(label: string, lang0?: string | null): string {
  return langOf(lang0) === "es"
    ? `El ${label} ya está facturado, así que sus líneas no cambian. La oficina puede cambiarlo desde Billing.`
    : `${label} is already invoiced, so its lines don't change. The office can change it from Billing.`;
}
// square feet for a release: releases are priced by the office, so the words go to them
export function releaseMeasureText(label: string, lang0?: string | null): string {
  return langOf(lang0) === "es"
    ? `Recibido. Los pies cuadrados del ${label} los ve la oficina; verán su mensaje.`
    : `Got it. Square feet on ${label} go to the office, and they'll see your text.`;
}
// the after pictures are on the job: the thread is done — and the job is
// marked work done, which the worker is told, with the way to take it back
export const MARKED_DONE = { en: "Marked work done. Not finished? Reply NOT DONE.", es: "Marcado como terminado. ¿No terminó? Responda NO TERMINADO." };
export function gotAfterText(n: number, label: string, stillBlank: MeasureLine[], lang0?: string | null, marked = false, lost = 0): string {
  const lang = langOf(lang0);
  const tail = marked ? ` ${MARKED_DONE[lang]}` : "";
  const thanks = lost ? "" : lang === "es" ? " ¡Gracias, todo listo!" : " Thanks, all set!";
  if (lang === "es") return `Recibido: ${kindN(n, "after", lang)} en el ${label}.${thanks}${stillBlank.length ? ` No olvide los pies cuadrados de: ${list(stillBlank)} (como: ${example(stillBlank)}).` : ""}${tail}`;
  return `Got ${kindN(n, "after", lang)} on ${label}.${thanks}${stillBlank.length ? ` Don't forget the square feet for: ${list(stillBlank)} (like: ${example(stillBlank)}).` : ""}${tail}`;
}
// "not done", "no terminado": the worker takes the work-done mark back
export const notDone = (body: string): boolean =>
  /\b(not done|not finished|not complete|not completed|still working|still going|no terminado|no termine|no terminamos|no hemos terminado|no esta terminado|no esta listo|todavia no|aun no)\b/.test(norm(body));
export function backInProgressText(label: string, lang0?: string | null): string {
  return langOf(lang0) === "es"
    ? `OK, el ${label} sigue en proceso. Responda con fotos de DESPUES al terminar.`
    : `OK, ${label} is back in progress. Reply with AFTER photos when it's finished.`;
}
export function nothingToUndoText(lang0?: string | null): string {
  return langOf(lang0) === "es" ? "Ningún trabajo suyo está marcado como terminado ahora." : "No job of yours is marked done right now.";
}
// the lines on the job's notes
export const doneNoteLine = (who: string, when: string): string => `✅ ${when} · work done, after photos texted by ${who || "the crew"} · ready to invoice`;
export const undoneNoteLine = (who: string, when: string): string => `↩ ${when} · back in progress, ${who || "the crew"} texted NOT DONE`;
// the line on the job's notes and on the office's card
export const measureNoteLine = (changes: Change[], who: string, when: string): string =>
  `📏 ${when} · ${changes.map((c) => `${c.name} ${c.qty} ${c.unit === "LF" ? "lin ft" : "sq ft"}${c.was > 1 ? ` (was ${c.was})` : ""}`).join(", ")} · texted by ${who || "the crew"}`;
