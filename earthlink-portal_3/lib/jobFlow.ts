// A PACT job, start to finish, by text: one thread the worker follows from
// the company number, and everything they send lands on the job:
//
//   the crew text   → "When you get there, reply with photos: they go in
//                      BEFORE. When you finish, send the photos with the word AFTER."
//   photos          → BEFORE, always, unless the worker says AFTER
//   AFTER + photos  → on the job as after photos; "Thanks, all set."
//
// The worker says AFTER one of three ways: the word with the photos
// ("after", "done", "despues", "terminado"), the word texted just before the
// photos (the next photos go in AFTER), or the word texted just after them
// (the photos they just sent move to AFTER). Nothing else ever makes a
// photo an after photo: no clock, no count, no guess. Videos go the same way.
//
// The crew is never asked for square feet: the office measures. A number a
// worker texts on their own ("plaster 120 sf") still goes onto the job's
// lines, as it always has. Every reply names the job by its address
// (lib/crewText jobName), the caller passes that name in as `label`.
//
// Pure: no database, no Twilio. The route (/api/sms-in) does the reading and
// writing; this decides and writes the words.
import { AFTER_HOW, atJob, jobName, langOf, longDay, ofJob, theJob } from "./crewText";
import { asCount, isMediaName, mediaWords, type MediaCount } from "./media";
import { isSfLine, roundSf, type SfLine } from "./measure";
import { normUnit } from "./priceBook";

export type Stage = "before" | "after" | "done";
export type PhotoKind = "before" | "after";
export interface StageInput { beforeN: number; afterN: number }
// no before photos yet: the job hasn't started; then the after photos; then nothing more
export const stageOf = (s: StageInput): Stage => (s.beforeN === 0 ? "before" : s.afterN === 0 ? "after" : "done");

// the photo's (or video's) own name says which it is; a job's documents sort on the prefix
export { isImageName } from "./media";
export const kindOfName = (n: string): PhotoKind | null => (/^before(?![a-z])/i.test(n || "") ? "before" : /^after(?![a-z])/i.test(n || "") ? "after" : null);
export const countKinds = (names: string[]): { beforeN: number; afterN: number } => ({
  beforeN: names.filter((n) => isMediaName(n) && kindOfName(n) === "before").length,
  afterN: names.filter((n) => isMediaName(n) && kindOfName(n) === "after").length,
});

// lower-case, accents off, one space — "¡ANTES!" reads as "antes"
const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

// Which pile a texted picture (or video) goes on. BEFORE, unless the worker
// says AFTER:
//   • the word with them: "after", "despues", "done", "finished",
//     "terminado", "listo" (but "not done yet", "no terminado" never is);
//     two pile words, the first said wins ("all done, way better than
//     before" is AFTER; "Before. Will send after when done" is BEFORE, and
//     what they'll do later says nothing about these);
//   • AFTER texted just before them (`afterAsked`: the next photos go in AFTER);
//   • the rest of a send whose first piece was AFTER (`burst`: one send, split by the phone).
// Nothing else: no clock, no count of photos, no guess.
const BEFORE_WORDS = /\b(before|antes|previo|al llegar)\b/;
// arriving, starting: these are the arrival (and so is everything else)
// …said with the pictures, the arrival is the BEFORE pile's ("just got here", "ya llegamos")
const ARRIVED = /\b(llegamos|llegue|llegando|arrived|arriving|just got here|got here|we're here|we are here|i'm here|i am here|im here|estamos aqui|starting|started|start|empezando|empezamos|empezar|comenzando|comenzamos|comenzar)\b/;
// …and getting ready to start: then "listo" means ready, not finished
const STARTING = /\b(llegamos|llegue|llegando|arrived|arriving|starting|started|start|empezando|empezamos|empezar|comenzando|comenzamos|comenzar|ready to|set up|setting up)\b/;
// ("final" only with the pictures: "final photos", "fotos finales"; a "final
// coat" is still to come)
const AFTER_WORDS = /\b(after|despues|final (?:photos?|pics?|pix|pictures?|videos?|fotos?)|(?:fotos?|videos?) finale?s?)\b/;
// …or the caption is that one word: "Final"
const FINAL_ONLY = /^finale?s?\W*$/;
const DONE_WORDS = /\b(done|finished|finish|complete|completed|terminado|terminada|terminados|terminamos|termine|termino|acabado|acabamos|acabe)\b/;
// "listo", "all set": finished, unless they're ready to start ("listos para
// empezar", "all set up", "ya llegamos, listos")
const READY_WORDS = /\b(listo|lista|listos|listas|all set)\b/;
// a word about the work that isn't finished yet: "almost done", "about to
// finish", "half done", "first coat done", "done with the first coat",
// "casi terminamos", "ya mero terminamos", "terminamos la primera parte",
// "la mitad terminada", "por terminar"
const DONE_W = "done|finished|finish|complete|completed|terminado|terminada|terminados|terminadas|terminar|terminamos|termine|termino|acabado|acabada|acabamos|acabar|listo|lista|listos|listas";
const NOT_YET_DONE = new RegExp(String.raw`\b(?:(?:almost|nearly|about to|about|close to|half|halfway|mostly|partly|partially|first coat|1st coat|one coat|first part|first half|casi|ya mero|ya merito|medio|primera mano|primera capa|primera parte|una mano|la mitad|mitad)\s+(?:[a-z']+\s+){0,3}?(?:${DONE_W})|(?:${DONE_W})\s+(?:with\s+|con\s+)?(?:the\s+|la\s+|el\s+|lo\s+)?(?:first|1st|primera|primer|half|mitad)(?!\s+(?:dia|day)\b)(?:\s+(?:coat|part|parte|mano|capa|layer|round|half|room|cuarto|side|lado|section|seccion))?|por terminar|por acabar|falta poco|(?:got|trying|need|needs|have|has)\s+to\s+(?:finish|complete)|gotta\s+(?:finish|complete))\b`, "g");
// …and so done: "50% done", "90% terminado" (all of it, "100%", is a finish)
const PART_DONE = new RegExp(String.raw`\b[1-9]?\d\s*(?:%|percent\b|por ciento\b)(?:\s*(?:[a-z']+\s+){0,2}?(?:${DONE_W})\b)?`, "g");
// "after" and "después" as a time ("back after lunch", "after we eat",
// "back after my break", "después del almuerzo seguimos", "después de
// almorzar"): when, not which pile. The rest of that part of the sentence
// goes with it ("después de comer terminamos" is later). Work already done
// ("after we finished the kitchen", "después que terminamos") is the pile
const PAST_WORK = "[a-z]+ed|done|was|were|did|had|terminamos|terminaron|termine|termino|acabamos|acabaron|acabe|limpiamos|pintamos|arreglamos|instalamos|cambiamos|hicimos";
const AFTER_TIME = new RegExp(String.raw`\b(?:after|despues)\s+(?:(?:the|a|an|my|our|his|her|their|your)\s+|de(?:l)?\s+(?:(?:la|las|los|el|mi|mis|nuestro|nuestra|nuestros|nuestras|su|sus|tu|tus)\s+)?)?(?:lunch break|lunch|break|breakfast|dinner|noon|tomorrow|tonight|that|this|an hour|a while|eating|\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2}|\d{1,2}(?!\s*(?:coats?|capas?|manos?|layers?|rooms?|cuartos?|walls?|paredes|[\d:]))|almuerzo|almorzar|comer|comida|desayuno|desayunar|cena|cenar|descanso|descansar|lonche|mediodia|manana|la tarde|un rato|eso|esto|una hora|(?:we|i|they|you|he|she|que)\b(?!\s+(?:[a-z']+\s+)?(?:${PAST_WORK})\b))\b[^.,;!?]*`, "g");
// what they'll do later, or still have to ("when we finish I'll send the
// after photos", "should be done by 3", "need to finish the trim", "hay que
// terminar", "cuando terminemos le mando las de despues") says nothing
// about these pictures
const LATER = /\b(when|once|cuando|will|i'?ll|we'?ll|going to|gonna|should|hope|hopefully|need to|needs to|have to|has to|gotta|trying to|try to|voy a|vamos a|le mando|les mando|te mando|mandare|mandamos|luego|deberia|deberiamos|espero|esperamos|tengo que|tenemos que|tiene que|tienen que|hay que)\b[^.,;!?]*/g;
// …and a finish still to come: "done in 30 min", "finished by 4", "done by
// three", "done soon", "finish tomorrow", "listo en una hora", "listo para
// las tres" ("finished at 4" and "terminamos a las 3" already happened; "todo
// listo para mañana" is the day's: ready for tomorrow)
const AT_W = "\\d|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|midnight|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|mediodia)\\b|an?\\s+(?:hour|few|couple|min)|half an hour|un[ao]?\\s+(?:hora|rato|minutos?)|media hora";
const DONE_SOON = new RegExp(String.raw`\b(?:(?:done|finished|finish|complete|terminado|terminada|terminamos|terminar|listo|lista|acabamos|acabar)\s+(?:(?:in|en|by|para las|para la|como en)\s+(?:${AT_W})|(?:very\s+|real\s+|muy\s+)?(?:soon|shortly|pronto|ahorita)\b)|(?:done|finished|finish|complete|completed|terminado|terminada|terminamos|terminar|termino|acabamos|acabar|acabo)\s+(?:(?!see\b|you\b|for\b|por\b|hasta\b|nos\b|back\b|para\b|pa\b)[a-z']+\s+){0,2}(?:tomorrow|manana)\b)[^.,;!?]*`, "g");
// the words a pile or a finished job is read from, without the ones that
// aren't about these pictures or a finish ("almost done", "done by 3", "when
// we finish", "after lunch", "listos para empezar", "all set up")
const unfinishedOff = (t: string): string => t
  .replace(LATER, " ").replace(NOT_YET_DONE, " ").replace(PART_DONE, " ").replace(DONE_SOON, " ").replace(AFTER_TIME, " ")
  .replace(/\b(listo|lista|listos|listas)\s+(para|pa)\b/g, " ").replace(/\ball set up\b/g, " ").replace(/\s+/g, " ").trim();
// the caption's own say: "after", "before", or nothing
export function captionKind(body: string): PhotoKind | null {
  const neg = notDone(body);
  const t = unfinishedOff(neg ? norm(straight(body)).replace(NOT_DONE_G, " ") : norm(straight(body)));
  const at = (re: RegExp) => { const m = re.exec(t); return m ? m.index : Infinity; };
  // (a start with a finish said after it: "started at 8, finished at 4" is the finish)
  const arrived = at(ARRIVED), doneAt = neg ? Infinity : at(DONE_WORDS);
  const before = Math.min(at(BEFORE_WORDS), doneAt > arrived && doneAt < Infinity ? Infinity : arrived);
  // ("listo" with the arrival is "ready", not "finished")
  const ready = STARTING.test(t) ? Infinity : at(READY_WORDS);
  const after = FINAL_ONLY.test(t) ? 0 : Math.min(neg ? Infinity : Math.min(at(DONE_WORDS), ready), at(AFTER_WORDS));
  if (before < after) return "before";
  if (after < Infinity) return "after";
  return null;
}
export function photoKindFor(body: string, o: { burst?: PhotoKind | null; afterAsked?: boolean } = {}): PhotoKind {
  const said = captionKind(body);
  if (said) return said;
  if (o.afterAsked) return "after";
  if (o.burst) return o.burst;
  return "before";
}
// a text with no pictures that says the next ones (or the ones just sent) are
// AFTER photos: "AFTER", "after photos", "here are the after", "fotos de
// despues", "las de despues". A sentence about something else ("after lunch
// I'll be there") is not it
const AFTER_FILLER = new Set(["the", "these", "those", "here", "are", "is", "heres", "here's", "next", "now", "ok", "okay", "estas", "esas", "son", "aqui", "aca", "estan", "van", "ahi", "las", "los", "la", "el", "de", "del", "fotos", "foto", "photos", "photo", "pics", "pic", "pix", "pictures", "picture", "videos", "video", "vids", "vid", "clips", "clip", "imagenes", "imagen", "coming", "incoming", "ahora", "of", "y", "and", "go", "goes", "mis", "my", "our", "nuestras", "sending", "send", "mando", "mandando", "for", "para"]);
// a job's number said with it ("AFTER 116843", "after PO 116843", "116843
// after", "despues release 12"): the word is about that job. Any other number
// ("after 3", "después de las 3") is a time, and the text isn't the word
const JOB_REF = /\b(?:p\.?\s*o\.?|release|rel\.?)\s*(?:number|no\.?|num|#)?\s*[#:-]?\s*\d{1,12}\b|#\s*\d{1,12}\b|\b\d{5,12}\b/gi;
export function afterSaid(body: string): boolean {
  const raw = (body || "").trim();
  if (!raw || raw.includes("?") || notDone(raw) || raw.length > 40) return false;
  const rest = straight(raw).replace(JOB_REF, " ");
  if (/\d/.test(rest)) return false;
  const words = norm(rest).replace(/[^a-z' ]/g, " ").split(" ").filter(Boolean);
  const left = words.filter((w) => !AFTER_FILLER.has(w));
  return left.length === 1 && (left[0] === "after" || left[0] === "despues");
}
// a caption that says something got done and something is starting, or is
// still left ("kitchen done, starting the bathroom", "kitchen done, still
// need the bathroom", "terminamos la cocina, falta el baño"): finished work
// maybe, the job maybe not. Its pictures never mark the job done on their
// own: the worker is asked
export const mixedCaption = (body: string): boolean => {
  if (notDone(body)) return false;
  const t = norm(body);
  const done = DONE_WORDS.exec(t) || READY_WORDS.exec(t);
  if (!done) return false;
  // (a start said before the finish is the whole day: "started at 8, finished at 4")
  const started = /\b(arrived|started|llegamos|llegue|empezamos|comenzamos)\b/.exec(t);
  const arrive = /\b(llegando|arriving|starting|empezando|comenzando)\b/.test(t) || (!!started && started.index > done.index);
  return arrive || /\b(now|next|ahora|sigue|siguiente|then|still (?:need|needs|have|has|got|gotta|to)|falta|faltan|pending|pendiente|pendientes|todavia (?:falta|faltan|queda|quedan))\b/.test(t);
};
// …and the question it gets
export function finishedAskText(lang0?: string | null): string {
  return langOf(lang0) === "es"
    ? "¿Está terminado todo el trabajo? Responda TERMINADO si lo está, o NO TERMINADO si no."
    : "Is the whole job finished? Reply DONE if it is, or NOT DONE if it isn't.";
}

// ---- a job's days (lib/workDays): the photos of one day ----
// the time in a photo's name ("before_2026-11-20_143012_jose_x7k2.jpg" is
// 14:30:12 UTC), the way the inbox and the office's own uploads both stamp it
export const photoAt = (name: string): number => {
  const m = (name || "").match(/^(?:before|after|noaccess)_(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})/i);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) : 0;
};
const nyDayOf = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
// the pictures of one work day, and the ones after it (sent the evening
// after, or the next morning): a picture with no time in its name belongs to no day
export const namesFrom = (names: string[], day: string): string[] => names.filter((n) => { const at = photoAt(n); return !!at && nyDayOf(at) >= day; });
// the first before picture of those: when the day's crew got there
export const firstBeforeAt = (names: string[]): number =>
  Math.min(Infinity, ...names.filter((n) => isMediaName(n) && kindOfName(n) === "before").map(photoAt).filter(Boolean));
// ---- the lines a worker can measure ----
export type LineUnit = "SF" | "LF" | "ROOM";
export interface MeasureLine { index: number; key: string; name: string; unit: LineUnit; qty: number; has: boolean; words: string[] }
const isLf = (u: string) => /^(LF|LIN\.? ?FT|LINEAR ?(FT|FEET)|L\.?F\.?)$/.test(normUnit(u || ""));
// what a line is called in a text, by its price-book key, then by its own words
const KEY_WORDS: Record<string, string[]> = {
  plaster: ["plaster", "plastering", "plastered", "yeso", "plastr"],
  wall_repair: ["scrape", "scraping", "wall repair", "repair", "raspar", "raspado"],
  popcorn: ["popcorn", "textured", "texturizado"],
  sheetrock: ["sheetrock", "sheet rock", "drywall", "dry wall", "rock", "gypsum", "tabla", "tablaroca"],
  paint_sf: ["paint", "painting", "painted", "pintura", "pintar", "pintamos", "pintado"],
  primer: ["primer", "prime", "priming", "primed", "imprimar", "imprimador", "sellador"],
};
// plain words that carry no meaning of their own in a measurement text
const FILLER = new Set(["the", "a", "an", "of", "for", "is", "are", "was", "about", "approx", "approximately", "around", "total", "totals", "all", "in", "on", "at", "to", "it", "its", "ok", "okay", "measurements", "measurement", "measure", "measured", "medidas", "medida", "mide", "son", "es", "de", "del", "la", "el", "los", "las", "en", "por", "para", "un", "una", "unos", "unas", "y", "and", "sq", "ft", "feet", "foot", "sf", "sqft", "square", "pies", "cuadrados", "cuadrado", "lf", "linear", "lin", "p2", "ft2", "area", "areas", "job", "po", "here", "aqui", "whole", "entire", "throughout", "apartment", "apt", "room", "rooms", "cuarto", "cuartos", "wall", "walls", "pared", "paredes", "ceiling", "ceilings", "techo", "techos", "bedroom", "bedrooms", "bathroom", "bathrooms", "bath", "kitchen", "living", "livingroom", "hallway", "hall", "closet", "foyer", "recamara", "recamaras", "dormitorio", "bano", "banos", "cocina", "sala", "pasillo", "with", "con", "sin", "no", "yes", "si", "thanks", "gracias", "please", "porfavor", "favor"]);
const STOP = new Set([...FILLER, "existing", "new", "repairs", "repair", "throughout", "damaged", "areas", "area", "and", "or", "per", "each", "with", "small", "large", "removal", "remove", "install", "replace", "work", "labor", "material", "materials"]);
const shortName = (d: string): string => {
  const words = (d || "").replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const name = words.slice(0, 3).join(" ");
  return name.length > 40 ? name.slice(0, 40).trimEnd() : name;
};
const NAME_BY_KEY: Record<string, string> = { plaster: "Plaster", wall_repair: "Scrape and plaster", popcorn: "Popcorn ceiling", sheetrock: "Sheetrock", paint_sf: "Paint", primer: "Primer" };
// priming and painting are by the room: a worker texts how many ("paint 3 rooms")
const isRoom = (it: SfLine) => normUnit(it.unit || "") === "ROOM" || it.key === "paint_sf" || it.key === "primer";
const ownWords = (d: string): string[] =>
  [...new Set(norm(d).replace(/\(.*?\)/g, " ").replace(/[^a-z0-9 ]/g, " ").split(" ").filter((w) => w.length >= 4 && !STOP.has(w)))];
export function measureLines(items: SfLine[]): MeasureLine[] {
  return items.map((it, index) => {
    const sf = isSfLine(it);
    const room = !sf && isRoom(it);
    if (!sf && !room && !isLf(it.unit || "")) return null;
    const key = it.key || "";
    const qty = Number(it.qty) || 0;
    return {
      index, key, unit: (sf ? "SF" : room ? "ROOM" : "LF") as LineUnit, qty,
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
  | { kind: "ask"; why: "which" | "unknown" | "noline" | "unit" | "big" | "kind"; word?: string; qty?: number; line?: string; was?: number; rooms?: boolean; want?: LineUnit };
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
// "3 rooms", "2 cuartos": how many rooms, for the lines priced by the room
const ROOM_UNIT = String.raw`rooms?|rms?|cuartos?|habitaci(?:on|ones)|recamaras?|dormitorios?|bedrooms?|bathrooms?|banos?`;
const ROOM_NUM = new RegExp(String.raw`${EDGE}(\d{1,2})\s*(?:${ROOM_UNIT})\b(?!\s*(?:apartment|apt|unit)\b)`, "g");
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
  // "2 more buckets", "3 extra gallons": supplies, never a measurement
  /\b\d{1,3}\s*(?:more|extra|other|mas|otr[oa]s?)\b(?:\s+(?!(?:sf|sq|sqft|square|lf|linear|pies)\b)[a-z]+){0,3}/g,
  new RegExp(String.raw`\b\d{1,3}\s*(?:pics?|pictures?|photos?|fotos?|imagenes?|imgs?|coats?|capas?|manos?|hours?|hrs?|horas?|days?|dias?|min|mins|minutes?|minutos?|bags?|bolsas?|buckets?|cubetas?|cans?|latas?|boxes?|cajas?|gallons?|gal|galones?|galon|quarts?|rolls?|rollos?|tubes?|tubos?|pails?|tubs?|jugs?|bottles?|botellas?|brushes?|brochas?|rollers?|rodillos?|guys?|people|men|hombres|personas?|workers?|trabajadores?|doors?|puertas?|windows?|ventanas?|closets?|floors?|pisos?|apts?|apartments?|apartamentos?|units?|outlets?|switches?|lights?|luces?|sheets?|hojas?|boards?|tablas?|tiles?|losas?|pieces?|piezas?|pcs?|each|ea|c\/u|times|veces|trips?|viajes?|holes?|hoyos?|agujeros?|spots?|patches?|parches?)\b${NOT_TAIL}`, "g"),
];
// "sq. ft." keeps its dots so a sentence break ". " is just that
const unDot = (t: string) => t.replace(/\bsq\.\s*ft\.?/g, "sqft").replace(/\blin\.\s*ft\.?/g, "linft").replace(/\bft\./g, "ft");
const SPLIT = /\s*(?:,|;|\n|\+|\.\s+|\band\b|\by\b|\bplus\b|\balso\b|\bmas\b|\btambien\b)\s*/;
const SUPPLY = /\b(need|needs|needed|bring|buy|order|grab|pick up|get me|send me|send more|necesito|necesitamos|necesita|necesitan|traer|traiga|traigan|trae|comprar|compra|compren|falta|faltan|hace falta|mandar|mande|manden)\b/;
const MAX_TEXTED_SQFT = 5000;   // no apartment wall is bigger — lib/measure's cap, for texted numbers too
interface Clause { nums: { qty: number; explicit: boolean; rooms?: boolean }[]; words: string[]; text: string }
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
    rest = rest.replace(ROOM_NUM, (_m, pre, n) => {
      const qty = Number(n);
      if (qty > 0) nums.push({ qty, explicit: true, rooms: true });
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
  // a count of rooms means nothing on a job with no line by the room
  if (!lines.some((l) => l.unit === "ROOM")) for (const c of clauses) c.nums = c.nums.filter((n) => !n.rooms);
  if (!clauses.some((c) => c.nums.length)) return { kind: "none" };
  const sums = new Map<number, { qty: number; explicit: boolean; line: MeasureLine | null }>();
  const add = (index: number, line: MeasureLine | null, n: { qty: number; explicit: boolean }) => {
    const cur = sums.get(index) || { qty: 0, explicit: true, line };
    sums.set(index, { qty: cur.qty + n.qty, explicit: cur.explicit && n.explicit, line });
  };
  // square feet on a line by the room, rooms on a line by the foot: asked, never written
  const wrongKind = (l: MeasureLine, n: Clause["nums"][number]): Parsed | null => {
    if (n.rooms && l.unit !== "ROOM") return { kind: "ask", why: "kind", line: l.name, want: l.unit, qty: n.qty, rooms: true };
    if (!n.rooms && n.explicit && l.unit === "ROOM") return { kind: "ask", why: "kind", line: l.name, want: "ROOM", qty: n.qty };
    return null;
  };
  const bare: Clause[] = [];
  for (const c of clauses) {
    // "need 2 buckets of plaster", "bring 3 for the paint": what to bring, not
    // what was done; a number with its unit ("we need 120 sf of plaster") still counts
    if (SUPPLY.test(c.text)) c.nums = c.nums.filter((n) => n.explicit);
    if (!c.nums.length) continue;   // talk around the numbers ("thanks", "2 pics")
    if (c.words.length === 0) { bare.push(c); continue; }
    const found = lineFor(c.words, lines);
    // "plaster 120 sf" on a job with no plaster line: a Plaster line is added
    const newPlaster = !found.length && c.words.some((w) => PLASTER_WORDS.has(w)) && !lines.some((l) => l.words.includes("plaster"));
    if (found.length > 1) return { kind: "ask", why: "which", qty: c.nums[0].qty, ...(c.nums[0].rooms ? { rooms: true } : {}) };
    if (found.length === 1 || newPlaster) {
      // "plaster 120 140": two numbers for one line in one breath — which?
      if (c.nums.length > 1) return { kind: "ask", why: "which", qty: c.nums[0].qty, line: found[0]?.name || "Plaster" };
      if (found[0]) { const bad = wrongKind(found[0], c.nums[0]); if (bad) return bad; }
      if (newPlaster && c.nums[0].rooms) return { kind: "ask", why: "kind", line: "Plaster", want: "SF", qty: c.nums[0].qty, rooms: true };
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
    // "3 rooms" on its own: every line by the room — the ones still blank, else all of them
    const roomNums = nums.filter((n) => n.rooms);
    if (roomNums.length) {
      if (roomNums.length > 1 || nums.length > 1) return { kind: "ask", why: "which", qty: roomNums[0].qty, rooms: true };
      const roomLines = lines.filter((l) => l.unit === "ROOM" && !sums.has(l.index));
      const take = roomLines.filter((l) => !l.has).length ? roomLines.filter((l) => !l.has) : roomLines;
      for (const l of take) add(l.index, l, roomNums[0]);
      return sums.size ? finish(sums, lines) : { kind: "none" };
    }
    const withUnit = nums.some((n) => n.explicit);
    // a plain number with no unit, in a text that says anything else, is not a measurement
    const onlyNumbers = clauses.every((c) => c.words.length === 0 || c.words.every((w) => STOP.has(w)));
    if (!withUnit && (!expecting || !onlyNumbers)) return sums.size ? finish(sums, lines) : { kind: "none" };
    // a number beside a named line's number ("plaster 120 sf, 300 total"): which line is the loose one for?
    if (sums.size) return { kind: "ask", why: "which", qty: nums[0].qty };
    if (lines.length === 0) return { kind: "ask", why: "noline", qty: nums[0].qty };
    const blank = lines.filter((l) => !l.has);
    const target = blank.length === 1 ? blank[0] : lines.length === 1 ? lines[0] : null;
    if (!target || nums.length > 1) return { kind: "ask", why: "which", qty: nums[0].qty };
    const bad = wrongKind(target, nums[0]);
    if (bad) return bad;
    add(target.index, target, nums[0]);
  }
  if (!sums.size) return { kind: "none" };
  return finish(sums, lines);
}
// the lines named: the same line twice in one text adds up ("plaster 10x8,
// plaster 12x8"); a line that already carries a number is only changed by a
// number with its unit on it; nothing bigger than any apartment goes on
const MAX_ROOMS = 20;
function finish(sums: Map<number, { qty: number; explicit: boolean; line: MeasureLine | null }>, lines: MeasureLine[] = []): Parsed {
  const hits: MeasureHit[] = [];
  for (const [index, s] of sums) {
    const qty = Math.round(s.qty * 100) / 100;
    const byRoom = s.line?.unit === "ROOM" ? { rooms: true as const } : {};
    if (s.line?.unit === "ROOM" ? qty > MAX_ROOMS : qty > MAX_TEXTED_SQFT) return { kind: "ask", why: "big", qty, line: s.line?.name || "Plaster", ...byRoom };
    if (s.line && s.line.has && !s.explicit) return { kind: "ask", why: "unit", qty, line: s.line.name, was: s.line.qty, ...byRoom };
    hits.push(index === -1 ? { index: -1, qty, plaster: true } : { index, qty });
  }
  // paint and primer go together by the room: the rooms said for one are the other's too, while it is blank
  for (const [index, s] of [...sums]) {
    if (s.line?.unit !== "ROOM") continue;
    for (const l of lines) {
      if (l.unit === "ROOM" && l.index !== index && !l.has && !sums.has(l.index) && !hits.some((h) => h.index === l.index)) hits.push({ index: l.index, qty: Math.round(s.qty * 100) / 100 });
    }
  }
  return { kind: "ok", hits };
}

// ---- the numbers onto the job's lines ----
export interface Change { name: string; qty: number; was: number; unit: LineUnit }
// the prep a new Plaster line brings with it (the owner's rule: plaster is
// never billed without its primer and paint, by the room) — the prices as
// Settings saved them and the rooms the job's words name
export interface PrepPrices { primer: number; paint: number; rooms: number }
export function applyMeasures(items: SfLine[], hits: MeasureHit[], plasterPrice = 0, prep?: PrepPrices): { items: SfLine[]; changes: Change[] } {
  const next = items.map((it) => ({ ...it }));
  const changes: Change[] = [];
  const lines = measureLines(items);
  for (const h of hits) {
    const line0 = h.index >= 0 ? lines.find((x) => x.index === h.index) : undefined;
    const qty = line0?.unit === "ROOM" ? Math.max(1, Math.round(h.qty)) : roundSf(h.qty);
    if (h.index === -1) {
      next.push({ description: "Plaster", qty, unit: "SF", unit_price: plasterPrice, key: "plaster" });
      changes.push({ name: "Plaster", qty, was: 0, unit: "SF" });
      // the primer and paint go on the job quietly, by the rooms the job's
      // words name: with no room named they start at the list's blank (1),
      // left for the office to set (the crew is never asked)
      if (prep) {
        const rooms = Math.max(1, Math.round(prep.rooms) || 1);
        const has = (key: string, word: RegExp) => next.some((it) => it.key === key || (!it.key && word.test(it.description || "")));
        if (!has("primer", /\bprim(?:er|e|ing)\b/i)) next.push({ description: "Primer", qty: rooms, unit: "ROOM", unit_price: prep.primer, key: "primer" });
        if (!has("paint_sf", /\bpaint/i)) next.push({ description: "Paint", qty: rooms, unit: "ROOM", unit_price: prep.paint, key: "paint_sf" });
      }
      continue;
    }
    const l = lines.find((x) => x.index === h.index);
    if (!l || !next[h.index]) continue;
    const was = Number(next[h.index].qty) || 0;
    next[h.index] = { ...next[h.index], qty, unit: l.unit === "SF" && normUnit(next[h.index].unit || "") !== "SF" ? "SF" : l.unit === "ROOM" && normUnit(next[h.index].unit || "") !== "ROOM" ? "ROOM" : next[h.index].unit };
    changes.push({ name: l.name, qty, was, unit: l.unit });
  }
  return { items: next, changes };
}

// ---- the words ----
const unitWord = (u: LineUnit, lang: "en" | "es") => (u === "LF" ? (lang === "es" ? "pies lineales" : "linear ft") : u === "ROOM" ? (lang === "es" ? "cuartos" : "rooms") : lang === "es" ? "pies cuadrados" : "sq ft");
// the example reads off the job's own lines: "plaster 120 sf", "baseboard 200 lf", "paint 3 rooms"
const exampleName = (l: MeasureLine) => (KEY_WORDS[l.key] || [])[0] || l.words.find((w) => !STOP.has(w)) || l.name.toLowerCase().split(" ")[0];
const exampleOf = (l: MeasureLine, i: number) => `${exampleName(l)} ${l.unit === "ROOM" ? 3 : l.unit === "LF" ? 200 : i === 0 ? 120 : 40} ${l.unit === "ROOM" ? "rooms" : l.unit === "LF" ? "lf" : "sf"}`;
const example = (lines: MeasureLine[]): string => {
  const pick = (lines.filter((l) => !l.has).length ? lines.filter((l) => !l.has) : lines).slice(0, 2);
  if (!pick.length) return "plaster 120 sf";
  return pick.map(exampleOf).join(", ");
};
const list = (lines: MeasureLine[]) => lines.map((l) => l.name).join(", ");
// "3 BEFORE photos" / "3 fotos de ANTES"
// (and "1 BEFORE video", "2 BEFORE photos and 1 video": `n` can carry how many are videos)
export type Count = number | MediaCount;
const kindN = (n: Count, kind: PhotoKind, lang: "en" | "es") =>
  mediaWords(n, lang, lang === "es" ? (kind === "before" ? "ANTES" : "DESPUES") : kind === "before" ? "BEFORE" : "AFTER");

// the line at the foot of the crew text: the two steps, in one breath. The
// same for every job (the crew is never asked for square feet). The second
// argument is the job's number of work days: more than one, and the steps
// are every day's. (Callers that pass anything else, like the job's lines,
// get the one-day ask.)
export function jobAsk(lang0: string | null | undefined, days?: unknown): string {
  if (typeof days === "number" && days > 1) return daysAsk(lang0);
  if (langOf(lang0) === "es") return `Al llegar, responda con fotos: van a ANTES. ${AFTER_HOW.es}`;
  return `When you get there, reply with photos: they go in BEFORE. ${AFTER_HOW.en}`;
}
export { AFTER_HOW };
export const JOB_ASK_MARK = { en: "with the word AFTER", es: "con la palabra DESPUES" };
// just what landed: "Got 2 AFTER photos at 2205 Linden Blvd, Apt 4B (PO 116843)."
export function gotPhotosText(n: Count, kind: PhotoKind, label: string, lang0?: string | null): string {
  const lang = langOf(lang0);
  return lang === "es" ? `Recibido: ${kindN(n, kind, lang)} ${atJob(label, lang)}.` : `Got ${kindN(n, kind, lang)} ${atJob(label, lang)}.`;
}
// the before pictures are on the job: what comes next
export function gotBeforeText(n: Count, label: string, lang0?: string | null): string {
  const lang = langOf(lang0);
  if (lang === "es") return `Recibido: ${kindN(n, "before", lang)} ${atJob(label, lang)}. ${AFTER_HOW.es}`;
  return `Got ${kindN(n, "before", lang)} ${atJob(label, lang)}. ${AFTER_HOW.en}`;
}
// AFTER texted with no photos: the next ones go in AFTER
export function afterNextText(label: string, lang0?: string | null): string {
  return langOf(lang0) === "es"
    ? `Entendido: las fotos que mande ahora van a DESPUES ${atJob(label, "es")}.`
    : `OK: the photos you send now go in AFTER ${atJob(label, "en")}.`;
}
// AFTER (or DONE) texted right after photos: those photos are the after photos
// `thanks`: off when more follows; `hint`: the photos sat on a job the portal
// only guessed (two jobs that day), so the worker hears how to move them;
// `who`: a co-worker sent them (in the crew's thread)
export const WRONG_JOB = { en: "If that's the wrong job, reply with the right number.", es: "Si es otro trabajo, responda con el número correcto." };
export function flippedText(n0: Count, label: string, lang0?: string | null, marked = false, o: { thanks?: boolean; hint?: boolean; who?: string } = {}): string {
  const lang = langOf(lang0);
  const n = asCount(n0);
  const tail = `${marked ? ` ${MARKED_DONE[lang]}` : ""}${o.hint ? ` ${WRONG_JOB[lang]}` : ""}`;
  const thanks = o.thanks === false ? "" : lang === "es" ? " ¡Gracias!" : " Thanks!";
  if (lang === "es") return `Entendido: lo que ${o.who ? `${o.who} acaba` : "acaba"} de mandar ${atJob(label, lang)} ya está en DESPUES (${mediaWords(n, "es")}).${thanks}${tail}`;
  const what = n.n === 1 ? (n.v ? "the video" : "the photo") : `the ${mediaWords(n, "en")}`;
  return `Got it: ${what} ${o.who || "you"} just sent ${atJob(label, lang)} ${n.n === 1 ? "is" : "are"} in AFTER now.${thanks}${tail}`;
}
// AFTER texted again after photos already in AFTER: nothing to move
export function alreadyAfterText(n0: Count, label: string, lang0?: string | null): string {
  const n = asCount(n0);
  if (langOf(lang0) === "es") return `Entendido: lo que acaba de mandar ${atJob(label, "es")} está en DESPUES (${mediaWords(n, "es")}).`;
  const what = n.n === 1 ? (n.v ? "the video" : "the photo") : `the ${mediaWords(n, "en")}`;
  return `Got it: ${what} you just sent ${atJob(label, "en")} ${n.n === 1 ? "is" : "are"} in AFTER.`;
}
// AFTER right after photos still waiting for their job's number: they're the after photos, wherever they go
export function heldAfterText(n0: Count, options: string[], lang0?: string | null): string {
  const lang = langOf(lang0);
  const n = asCount(n0);
  const one = n.n === 1;
  const list = options.length === 2 ? `${options[0]} ${lang === "es" ? "o" : "or"} ${options[1]}` : options.join(", ");
  if (lang === "es") {
    // (photos and videos together: what was just sent, no article)
    const what = one ? (n.v ? "ese video va" : "esa foto va") : n.v === n.n ? `esos ${mediaWords(n, "es")} van` : n.v ? `lo que acaba de mandar (${mediaWords(n, "es")}) va` : `esas ${mediaWords(n, "es")} van`;
    return `Entendido: ${what} a DESPUES. ¿De qué trabajo ${one ? "es" : "son"}? Responda con el número${list ? `: ${list}` : " de PO o de release"}.`;
  }
  const what = one ? (n.v ? "the video" : "the photo") : `the ${mediaWords(n, "en")}`;
  return `Got it: ${what} you just sent ${one ? "goes" : "go"} in AFTER. Which job ${one ? "is it" : "are they"} for? Reply with the ${list ? `number: ${list}` : "PO or release number"}.`;
}
// photos that came a moment after DONE, before any photo of the day (the
// phone sent DONE ahead of the pictures, "done sending" maybe): they stay
// BEFORE, and the worker says if they're the finished work
export function gotBeforeAskText(n: Count, label: string, lang0?: string | null): string {
  const lang = langOf(lang0);
  const one = asCount(n).n === 1;
  return lang === "es"
    ? `Recibido: ${kindN(n, "before", lang)} ${atJob(label, lang)}. Si ${one ? "es" : "son"} del trabajo terminado, responda DESPUES.`
    : `Got ${kindN(n, "before", lang)} ${atJob(label, lang)}. If ${one ? "it's" : "they're"} the finished work, reply AFTER.`;
}
// pictures of the door, after their "no": "Got the photo of the door.", "Got the 2 photos and 1 video of the door."
export function doorGotText(n0: Count, lang0?: string | null): string {
  const n = asCount(n0);
  if (langOf(lang0) === "es") {
    // (photos and videos together: no article, "1 foto y 1 video")
    const what = n.n === 1 ? (n.v ? "el video" : "la foto") : n.v === n.n ? `los ${mediaWords(n, "es")}` : n.v ? mediaWords(n, "es") : `las ${mediaWords(n, "es")}`;
    return `Recibimos ${what} de la puerta.`;
  }
  return `Got the ${n.n === 1 ? (n.v ? "video" : "photo") : mediaWords(n, "en")} of the door.`;
}
// a number a worker texted on their own is on the job's lines, and so on the proposal and the invoice
export function gotMeasureText(changes: Change[], label: string, lang0?: string | null): string {
  const lang = langOf(lang0);
  const got = changes.map((c) => `${c.name} ${c.qty} ${c.unit === "ROOM" && c.qty === 1 ? (lang === "es" ? "cuarto" : "room") : unitWord(c.unit, lang)}`).join(", ");
  if (lang === "es") return `Anotado: ${got} ${atJob(label, lang)}. Ya está en la propuesta y la factura.`;
  return `Got it: ${got} ${atJob(label, lang)}. It's on the proposal and the invoice.`;
}
export function askMeasureText(p: Extract<Parsed, { kind: "ask" }>, label: string, lines: MeasureLine[], lang0?: string | null): string {
  const lang = langOf(lang0);
  const qty = p.qty ? `${roundSf(p.qty)} ${p.rooms ? (lang === "es" ? "cuartos" : "rooms") : lang === "es" ? "pies cuadrados" : "sq ft"}` : "";
  if (p.why === "kind") {
    const by = p.want === "ROOM" ? (lang === "es" ? "por cuarto" : "by the room") : p.want === "LF" ? (lang === "es" ? "por pie lineal" : "by the linear foot") : lang === "es" ? "por pie cuadrado" : "by the square foot";
    const ex = exampleOf({ index: 0, key: "", name: p.line || "Plaster", unit: p.want || "SF", qty: 1, has: false, words: [] }, 0);
    return lang === "es" ? `${p.line || "Esa línea"} va ${by}. Mande como: ${ex}.` : `${p.line || "That line"} is ${by}. Text it like: ${ex}.`;
  }
  if (p.why === "noline") {
    return lang === "es"
      ? `${theJob(label, lang, true)} no tiene una línea por pies cuadrados. Mande el número con el trabajo, como: plaster ${roundSf(p.qty || 120)} sf.`
      : `${label} has no square-foot line. Text the number with the work, like: plaster ${roundSf(p.qty || 120)} sf.`;
  }
  if (p.why === "unit") {
    const have = `${p.was || 0} ${p.rooms ? (lang === "es" ? "cuartos" : "rooms") : lang === "es" ? "pies cuadrados" : "sq ft"}`;
    const ex = `${(p.line || "plaster").toLowerCase().split(" ")[0]} ${roundSf(p.qty || 130)} ${p.rooms ? "rooms" : "sf"}`;
    return lang === "es"
      ? `${p.line || "Esa línea"} ya tiene ${have} ${atJob(label, lang)}. Para cambiarlo, mándelo con la unidad, como: ${ex}.`
      : `${p.line || "That line"} already has ${have} ${atJob(label, lang)}. To change it, text it with the unit, like: ${ex}.`;
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
      ? `No veo "${p.word}" ${atJob(label, lang)}. Las líneas son: ${list(lines)}. Mande como: ${example(lines)}.`
      : `I don't see "${p.word}" ${atJob(label, lang)}. The lines are: ${list(lines)}. Text it like: ${example(lines)}.`;
  }
  return lang === "es"
    ? `¿De qué línea ${qty ? `son los ${qty}` : "es"}? Mande como: ${example(lines)}.`
    : `Which line ${qty ? `is the ${qty} for` : "is it for"}? Text it like: ${example(lines)}.`;
}
// pictures and a number the worker texted on their own, in one text: both landed
// `lost`: pictures in the text that didn't come through — then nothing is "all set"
export function gotBothText(kind: PhotoKind, n: Count, label: string, changes: Change[], lang0?: string | null, marked = false, lost = 0): string {
  const lang = langOf(lang0);
  const got = changes.map((c) => `${c.name} ${c.qty} ${c.unit === "ROOM" && c.qty === 1 ? (lang === "es" ? "cuarto" : "room") : unitWord(c.unit, lang)}`).join(", ");
  const tail = marked ? ` ${MARKED_DONE[lang]}` : "";
  const thanks = lost ? "" : lang === "es" ? " ¡Gracias, todo listo!" : " Thanks, all set!";
  if (lang === "es") {
    return `Recibido: ${kindN(n, kind, lang)} ${atJob(label, lang)}. Anotado: ${got}. Ya está en la propuesta y la factura.${kind === "before" ? ` ${AFTER_HOW.es}` : thanks}${tail}`;
  }
  return `Got ${kindN(n, kind, lang)} ${atJob(label, lang)}. Got it: ${got}. It's on the proposal and the invoice.${kind === "before" ? ` ${AFTER_HOW.en}` : thanks}${tail}`;
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
    ? `${theJob(label, "es", true)} ya está facturado, así que sus líneas no cambian. La oficina puede cambiarlo desde Billing.`
    : `${label} is already invoiced, so its lines don't change. The office can change it from Billing.`;
}
// square feet for a release: releases are priced by the office, so the words go to them
export function releaseMeasureText(label: string, lang0?: string | null): string {
  return langOf(lang0) === "es"
    ? `Recibido. Los pies cuadrados ${ofJob(label, "es")} los ve la oficina; verán su mensaje.`
    : `Got it. Square feet ${atJob(label, "en")} go to the office, and they'll see your text.`;
}
// the after pictures are on the job: the thread is done — and the job is
// marked work done, which the worker is told, with the way to take it back
export const MARKED_DONE = { en: "Marked work done. If it isn't finished, reply NOT DONE.", es: "Marcado como terminado. Si no está terminado, responda NO TERMINADO." };
export function gotAfterText(n: Count, label: string, lang0?: string | null, marked = false, lost = 0): string {
  const lang = langOf(lang0);
  const tail = marked ? ` ${MARKED_DONE[lang]}` : "";
  const thanks = lost ? "" : lang === "es" ? " ¡Gracias, todo listo!" : " Thanks, all set!";
  if (lang === "es") return `Recibido: ${kindN(n, "after", lang)} ${atJob(label, lang)}.${thanks}${tail}`;
  return `Got ${kindN(n, "after", lang)} ${atJob(label, lang)}.${thanks}${tail}`;
}
// "not done", "no terminado": the job isn't finished (the work-done mark
// comes off, and it runs one more work day)
const NOT_DONE_SRC = String.raw`\b(not yet (?:done|finished|complete|completed)|not done|not finished|not complete|not completed|not quite|not yet|still working|still going|need(?:s)? (?:another|one more) day|(?:come|coming) back tomorrow|back tomorrow|(?:haven'?t|have not|hasn'?t|has not) (?:finished|done|completed|been finished)|(?:isn'?t|is not|wasn'?t|was not|aren'?t|are not|ain'?t) (?:done|finished|complete|completed|ready)|(?:didn'?t|did not|couldn'?t|could not) (?:finish|complete|get (?:it )?done)|no terminado|no terminada|no termine|no termino|no terminamos|no terminaron|no lo (?:termine|terminamos|acabe|acabamos)|no acabamos|no acabe|no (?:he|hemos|ha|han) (?:terminado|acabado)|no esta (?:terminado|terminada|listo|lista|acabado)|todavia no|aun no|volvemos manana|regresamos manana|seguimos manana|manana seguimos)\b`;
const NOT_DONE_G = new RegExp(NOT_DONE_SRC, "g");
const straight = (s: string) => (s || "").replace(/[\u2018\u2019`\u00b4]/g, "'");
export const notDone = (body: string): boolean => new RegExp(NOT_DONE_SRC).test(norm(straight(body)));
// with photos, only the plain ways of saying it: "todavía no", "not yet" and
// "still working" ride on arrival photos ("llegamos, todavía no empezamos"),
// and "not quite done" is a progress word, not one more day
const NOT_DONE_STRONG = new RegExp(NOT_DONE_SRC.replace("not quite|not yet|still working|still going|", "").replace("|todavia no|aun no", ""));
export const notDoneStrong = (body: string): boolean => NOT_DONE_STRONG.test(norm(straight(body)));
// "done", "terminé", "all done" with no pictures: the job (or the day) is
// finished. A short text that says only that; a question ("done?") or a
// sentence about something else ("done with the kitchen, starting the
// bathroom") is not it. "Listo" and "ok" on their own are a yes to a crew
// text, never a finished job: those count only as the answer to "Finished?"
const DONE_SAID = /\b(done|finished|complete|completed|terminado|terminada|terminamos|termine|termino|acabamos|acabe|acabado)\b/;
const ALL_DONE = /\b(all done|all finished|(?:whole|entire) job (?:[a-z']+ ){0,2}(?:done|finished|complete|completed)|(?:done|finished|completed?) (?:with )?(?:the )?(?:whole|entire) job|job (?:is )?(?:done|finished|complete)|todo terminado|todo listo|terminamos todo|ya terminamos todo|trabajo terminado|terminamos el trabajo)\b/;
// …the ones about the job itself: never the day's ("all done for today" is
// the day's, "the whole job is done today" is the job's)
const ALL_DONE_JOB = /\b(whole job|job (?:is )?(?:done|finished|complete)|trabajo terminado|terminamos el trabajo|todo el trabajo)\b/;
const FOR_TODAY = /\b(for today|for the day|today|por hoy|de hoy|hoy)\b/;
const TOMORROW = /\b(tomorrow|manana)\b/;
// the whole job, said outright: never the day's, whatever else is said
const WHOLE_JOB = /\b(whole job|entire job|todo el trabajo)\b/;
// the day's (or the week's) and no more: "job done for today", "all done
// for now", "all done, see you monday", "terminamos el trabajo de hoy",
// "todo listo por ahora", "nos vemos el lunes"
const WEEKDAY = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const DIA = "lunes|martes|miercoles|jueves|viernes|sabado|domingo";
const DAY_LIMIT = new RegExp(String.raw`\b(for today|for the day|for now|for this week|for the week|this week|today'?s|todays|today s|por hoy|de hoy|del dia|por el dia|por ahora|esta semana|por la semana|see you (?:tomorrow|next week|${WEEKDAY})|back (?:on )?(?:${WEEKDAY})|hasta (?:el )?(?:${DIA}|manana)|nos vemos (?:el )?(?:${DIA}|manana)|(?:volvemos|regresamos|seguimos) (?:el )?(?:${DIA}))\b`);
// ALL DONE (`t`, read) about the whole job, not the day's (`whole`, the words as said)
const allNotDay = (t: string, whole: string): boolean => {
  if (WHOLE_JOB.test(t)) return true;
  if (DAY_LIMIT.test(whole) || TOMORROW.test(whole)) return false;
  return ALL_DONE_JOB.test(t) || !FOR_TODAY.test(t);
};
// "listo por hoy", "todo listo para mañana": ready, and that's the day
const READY_DAY = /\b(listo|lista|listos|listas|all set) (por hoy|for today|for the day|for now|por ahora|para manana|pa manana|for tomorrow)\b/;
export type DoneSaid = "all" | "day" | "done" | null;
// "all done", "todo terminado" with the photos: the whole job is finished (on
// a day before its last, it ends early). "Almost all done", "casi todo
// terminado", "all done for today", "all done for now", "all done, see you
// monday", "job done for today", "todo listo para mañana" and "todo listo
// para empezar" are not
export const allDoneSaid = (body: string): boolean => {
  if (notDone(body)) return false;
  const whole = norm(straight(body)).replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ").trim();
  const t = unfinishedOff(norm(straight(body))).replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ").trim();
  if (!ALL_DONE.test(t) || /\b(not|no|never|nunca|isn'?t|aren'?t|wasn'?t)\s+(?:\w+\s+)?(all|whole|todo|job|trabajo)\b/.test(t)) return false;
  return allNotDay(t, whole);
};
export function doneSaid(body: string): DoneSaid {
  // (the place in brackets the portal's own question shows, copied back with
  // the number: "TERMINADO 220011 (370 Blake Avenue, Apto 2C)")
  const raw = (body || "").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const t0 = norm(raw).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!t0 || raw.includes("?") || notDone(raw) || t0.length > 40) return null;
  // any no / not / yet / still in a text this short and it isn't a plain
  // "done": "no, we didn't finish it", "haven't finished", "no lo acabamos",
  // "kitchen done, still need the bathroom". Those go to the office as
  // words, never mark a job done
  if (/\b(no|not|never|nunca|nada|todavia|aun|yet|falta|faltan|still|pending|pendiente|pendientes)\b|n t\b/.test(t0)) return null;
  // "almost done", "done by 3", "will be done soon", "listo para empezar": not a finish
  const t = unfinishedOff(norm(straight(raw))).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const all = ALL_DONE.test(t);
  // ("done for now" is the day's, not a "now" of something next)
  if (/\b(starting|empezando|empezar|comenzando|comenzar|start|now|ahora|next|with the|con el|con la)\b/.test(t.replace(/\b(?:for now|por ahora)\b/g, " ")) && !all) return null;
  // ("all done for today", "todo listo para mañana", "all done, see you monday": the day's)
  if (all) return allNotDay(t, t0) ? "all" : "day";
  // ("listo" alone is a yes, never a finish)
  if (!DONE_SAID.test(t)) return READY_DAY.test(t0) ? "day" : null;
  if (DAY_LIMIT.test(t0)) return "day";
  if (TOMORROW.test(t)) return null;
  return FOR_TODAY.test(t) ? "day" : "done";
}
// the answer to the morning's "Finished?" (only then): yes / no
export const yesWord = (body: string): boolean => /^(yes|yeah|yep|yup|si|sii|listo|ya|ya esta|correct|correcto)$/.test(norm(body).replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim());
export const noWord = (body: string): boolean => /^(no+|nope|nah|not yet|todavia no|aun no)$/.test(norm(body).replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim());
export function backInProgressText(label: string, lang0?: string | null): string {
  return langOf(lang0) === "es"
    ? `OK, ${theJob(label, "es")} sigue en proceso. ${AFTER_HOW.es}`
    : `OK, ${label} is back in progress. ${AFTER_HOW.en}`;
}
export function nothingToUndoText(lang0?: string | null): string {
  return langOf(lang0) === "es" ? "Ningún trabajo suyo está marcado como terminado ahora." : "No job of yours is marked done right now.";
}

// ---- a job that runs more than one day (lib/workDays) ----
// "tomorrow, Saturday, November 21" when it is tomorrow, else "Monday, November 23"
export function whenDay(day: string, today: string, lang0?: string | null): string {
  const lang = langOf(lang0);
  const d = longDay(day, lang);
  if (!d) return "";
  const tomorrow = new Date(`${today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (day === today) return lang === "es" ? `hoy, ${d}` : `today, ${d}`;
  if (day === tomorrow.toISOString().slice(0, 10)) return lang === "es" ? `mañana, ${d}` : `tomorrow, ${d}`;
  return d;
}
const dayOf = (n: number, of: number, lang: "en" | "es") => (lang === "es" ? `día ${n}${of > 1 ? ` de ${of}` : ""}` : `day ${n}${of > 1 ? ` of ${of}` : ""}`);
// the crew's ask on a job of more than one day: the same two steps, every day
export function daysAsk(lang0: string | null | undefined): string {
  return langOf(lang0) === "es"
    ? "Cada día: al llegar, responda con fotos (van a ANTES). Al irse, mande las fotos con la palabra DESPUES."
    : "Every day: when you get there, reply with photos (they go in BEFORE). When you leave, send the photos with the word AFTER.";
}
// the after pictures of a day that isn't the job's last: not finished, it goes on
export function gotAfterDayText(n: Count, label: string, o: { day: number; of: number; next: string; today: string }, lang0?: string | null, lost = 0): string {
  const lang = langOf(lang0);
  const next = whenDay(o.next, o.today, lang);
  if (lang === "es") {
    return `Recibido: ${kindN(n, "after", lang)} ${atJob(label, lang)}${o.day ? `, ${dayOf(o.day, o.of, lang)}` : ""}.${lost ? "" : " ¡Gracias!"} Sigue ${next}: al llegar, responda con fotos (van a ANTES). ¿Ya terminó todo el trabajo? Responda TODO TERMINADO.`;
  }
  return `Got ${kindN(n, "after", lang)} ${atJob(label, lang)}${o.day ? `, ${dayOf(o.day, o.of, lang)}` : ""}.${lost ? "" : " Thanks!"} It continues ${next}: when you get there, reply with photos (they go in BEFORE). Is the whole job finished? Reply ALL DONE.`;
}
// NOT DONE on the job's last day (or after it): one more work day, the same crew
export function continuesText(label: string, o: { next: string; today: string; day: number }, lang0?: string | null): string {
  const lang = langOf(lang0);
  const next = whenDay(o.next, o.today, lang);
  return lang === "es"
    ? `Entendido, ${theJob(label, "es")} no está terminado, así que sigue ${next}${o.day ? ` (${dayOf(o.day, 0, lang)})` : ""}, con el mismo equipo. Al llegar, responda con fotos (van a ANTES). ${AFTER_HOW.es}`
    : `OK, ${label} isn't finished, so it continues ${next}${o.day ? ` (${dayOf(o.day, 0, lang)})` : ""} with the same crew. When you get there, reply with photos (they go in BEFORE). ${AFTER_HOW.en}`;
}
// …and the rest of the crew hears it from the portal
export function crewContinuesText(first: string, label: string, o: { next: string; today: string; day: number; who: string }, lang0?: string | null): string {
  const lang = langOf(lang0);
  const next = whenDay(o.next, o.today, lang);
  return lang === "es"
    ? `Hola${first ? ` ${first}` : ""}, le habla Earth Link. ${o.who ? `${o.who} avisó que ` : ""}${theJob(label, "es")} no está terminado, así que sigue ${next}${o.day ? ` (${dayOf(o.day, 0, lang)})` : ""}, con el mismo equipo. Al llegar, responda con fotos (van a ANTES). ${AFTER_HOW.es}`
    : `Hi${first ? ` ${first}` : ""}, this is Earth Link. ${o.who ? `${o.who} let us know ` : ""}${label} isn't finished, so it continues ${next}${o.day ? ` (${dayOf(o.day, 0, lang)})` : ""} with the same crew. When you get there, reply with photos (they go in BEFORE). ${AFTER_HOW.en}`;
}
// NOT DONE before the job's last day: nothing to add, it was going on anyway
export function stillOnText(label: string, o: { next: string; today: string; day: number; of: number }, lang0?: string | null): string {
  const lang = langOf(lang0);
  const next = whenDay(o.next, o.today, lang);
  return lang === "es"
    ? `Entendido, ${theJob(label, "es")} sigue abierto. Continúa ${next}${o.day ? ` (${dayOf(o.day, o.of, lang)})` : ""}.`
    : `OK, ${label} stays open. It continues ${next}${o.day ? ` (${dayOf(o.day, o.of, lang)})` : ""}.`;
}
// a "not done" the portal can't turn into a new day (no day on the job, or the database without section 23)
export function staysOpenText(label: string, lang0?: string | null): string {
  return langOf(lang0) === "es"
    ? `Entendido, ${theJob(label, "es")} sigue abierto. La oficina le dará el próximo día.`
    : `OK, ${label} stays open. The office will set the next day.`;
}
// "not done" on a job the office already invoiced: the mark stays, the office hears it
export function invoicedNotDoneText(label: string, lang0?: string | null): string {
  return langOf(lang0) === "es"
    ? `Entendido. ${theJob(label, "es", true)} ya está facturado, así que la oficina lo revisará.`
    : `OK. ${label} is already invoiced, so the office will look at it.`;
}
// the morning step: day 2 (and on) of a job, to each worker on it
export function dayReminderText(first: string, label: string, o: { day: number; of: number }, lang0?: string | null): string {
  const lang = langOf(lang0);
  return lang === "es"
    ? `Hola${first ? ` ${first}` : ""}, le habla Earth Link. ${o.day ? `Hoy es el ${dayOf(o.day, o.of, lang)} ${atJob(label, lang)}.` : `Hoy sigue el trabajo ${atJob(label, lang)}.`} Al llegar, responda con fotos (van a ANTES). Al irse, mande las fotos con la palabra DESPUES.`
    : `Hi${first ? ` ${first}` : ""}, this is Earth Link. ${o.day ? `Today is ${dayOf(o.day, o.of, lang)} ${atJob(label, lang)}.` : `The job ${atJob(label, lang)} goes on today.`} When you get there, reply with photos (they go in BEFORE). When you leave, send the photos with the word AFTER.`;
}
// the morning after a job's last day with no AFTER photos: was it finished?
export function finishedQuestionText(first: string, label: string, day: string, today: string, lang0?: string | null): string {
  const lang = langOf(lang0);
  const y = new Date(`${today}T12:00:00Z`);
  y.setUTCDate(y.getUTCDate() - 1);
  const yesterday = day === y.toISOString().slice(0, 10);
  const when = yesterday ? (lang === "es" ? "ayer" : "yesterday") : lang === "es" ? `el ${longDay(day, lang)}` : `on ${longDay(day, lang)}`;
  return lang === "es"
    ? `Hola${first ? ` ${first}` : ""}, le habla Earth Link. ¿Terminó ${theJob(label, "es")} ${when}? Responda TERMINADO si está terminado, o NO TERMINADO si no.`
    : `Hi${first ? ` ${first}` : ""}, this is Earth Link. Did you finish ${label} ${when}? Reply DONE if it's finished, or NOT DONE if it isn't.`;
}
// DONE (no pictures) answered
export function doneMarkedText(label: string, needPhotos: boolean, lang0?: string | null): string {
  const lang = langOf(lang0);
  return lang === "es"
    ? `¡Gracias! ${theJob(label, "es", true)} quedó marcado como terminado.${needPhotos ? " Mande ahora las fotos del trabajo terminado: van a DESPUES." : ""}`
    : `Thanks! ${label} is marked work done.${needPhotos ? " Send the photos of the finished work now: they go in AFTER." : ""}`;
}
export function alreadyDoneText(label: string, lang0?: string | null): string {
  return langOf(lang0) === "es" ? `${theJob(label, "es", true)} ya está marcado como terminado. ¡Gracias!` : `${label} is already marked work done. Thanks!`;
}
// DONE with no after pictures yet, nobody asked: the pictures finish it
export function sendAfterText(label: string, lang0?: string | null): string {
  return langOf(lang0) === "es"
    ? `Mande ahora las fotos del trabajo terminado ${ofJob(label, "es")}: van a DESPUES y queda marcado como terminado.`
    : `Send the photos of the finished work ${atJob(label, "en")} now: they go in AFTER, and it gets marked work done.`;
}
// "done" on a day that isn't the job's last: for today, or the whole job?
// `needPhotos`: no AFTER photos of the day yet: the next ones go in AFTER
export function dayDoneText(label: string, o: { next: string; today: string; day: number; of: number }, lang0?: string | null, needPhotos = false): string {
  const lang = langOf(lang0);
  const next = whenDay(o.next, o.today, lang);
  return lang === "es"
    ? `Entendido por hoy.${needPhotos ? " Mande ahora las fotos del trabajo de hoy: van a DESPUES." : ""} ${theJob(label, "es", true)} sigue ${next}${o.day ? ` (${dayOf(o.day, o.of, lang)})` : ""}. Si todo el trabajo está terminado, responda TODO TERMINADO.`
    : `Got it for today.${needPhotos ? " Send the photos of today's work now: they go in AFTER." : ""} ${label} continues ${next}${o.day ? ` (${dayOf(o.day, o.of, lang)})` : ""}. If the whole job is finished, reply ALL DONE.`;
}
// ALL DONE before the job's last day: finished early, the days left come off
export function endedEarlyText(label: string, dropped: string[], lang0?: string | null, needPhotos = false): string {
  const lang = langOf(lang0);
  const days = dropped.map((d) => longDay(d, lang).split(",")[0]).join(lang === "es" ? " y " : " and ");
  return lang === "es"
    ? `¡Gracias! ${theJob(label, "es", true)} quedó marcado como terminado${days ? `, así que no hay trabajo ahí el ${days}` : ""}.${needPhotos ? " Mande ahora las fotos del trabajo terminado: van a DESPUES." : ""}`
    : `Thanks! ${label} is marked work done${days ? `, so there's no work there on ${days}` : ""}.${needPhotos ? " Send the photos of the finished work now: they go in AFTER." : ""}`;
}
export function crewEndedText(first: string, label: string, dropped: string[], lang0?: string | null): string {
  const lang = langOf(lang0);
  const days = dropped.map((d) => longDay(d, lang).split(",")[0]).join(lang === "es" ? " y " : " and ");
  return lang === "es"
    ? `Hola${first ? ` ${first}` : ""}, le habla Earth Link. ${theJob(label, "es", true)} está terminado, así que no hay trabajo ahí el ${days}.`
    : `Hi${first ? ` ${first}` : ""}, this is Earth Link. ${label} is finished, so there's no work there on ${days}.`;
}
// DONE / NOT DONE with two jobs it could be about: which one, by its number
// (`all`: ALL DONE with two jobs it could be; the same question, with its word)
export function whichJobText(verb: "done" | "notdone" | "all", options: { label: string; street?: string; apt?: string }[], lang0?: string | null): string {
  const lang = langOf(lang0);
  const word = verb === "all" ? (lang === "es" ? "TODO TERMINADO" : "ALL DONE") : verb === "done" ? (lang === "es" ? "TERMINADO" : "DONE") : lang === "es" ? "NO TERMINADO" : "NOT DONE";
  const each = options.slice(0, 3).map((j) => {
    const place = jobName({ ...j, label: "" }, lang);
    // (a release keeps its word, "release 12": the answer copied back is read by it)
    const num = /^release\b/i.test(j.label) ? j.label : (j.label.match(/[A-Za-z]?\d[\w-]*$/) || [j.label])[0];
    return `${word} ${num}${place ? ` (${place})` : ""}`;
  });
  const list = each.length === 2 ? `${each[0]} ${lang === "es" ? "o" : "or"} ${each[1]}` : each.length ? each.join(", ") : `${word} 116843`;
  if (!each.length) return lang === "es" ? `¿De qué trabajo? Responda ${word} con el número de PO, así: ${list}.` : `Which job? Reply ${word} with its PO number, like: ${list}.`;
  if (verb !== "notdone") return lang === "es" ? `¿Qué trabajo está terminado? Responda así: ${list}.` : `Which job is finished? Reply like: ${list}.`;
  return lang === "es" ? `¿Qué trabajo no está terminado? Responda así: ${list}.` : `Which job isn't finished? Reply like: ${list}.`;
}
// a plain "no" right after the work-done mark: not finished, or a door?
export function noAfterDoneText(label: string, door: { name: string; num: string } | null, lang0?: string | null): string {
  const lang = langOf(lang0);
  if (lang === "es") return `Si ${theJob(label, "es")} no está terminado, responda NO TERMINADO.${door ? ` Si no hay nadie en ${door.name}, responda NO ${door.num}.` : ""}`;
  return `If ${label} isn't finished, reply NOT DONE.${door ? ` If nobody's home at ${door.name}, reply NO ${door.num}.` : ""}`;
}

// the lines on the job's notes
export const doneNoteLine = (who: string, when: string, byText = false): string =>
  byText ? `✅ ${when} · work done, ${who || "the crew"} texted DONE · ready to invoice` : `✅ ${when} · work done, after photos texted by ${who || "the crew"} · ready to invoice`;
export const undoneNoteLine = (who: string, when: string, next = ""): string => `↩ ${when} · not finished, ${who || "the crew"} texted NOT DONE${next ? ` · continues ${next}` : ""}`;
// a job finished on a day before its last (ALL DONE), or whose AFTER photos moved to another job
export const endedNoteLine = (who: string, when: string, dropped: string): string => `✂ ${when} · ${who || "the crew"} texted ALL DONE · the days after (${dropped}) are off`;
export const unmarkedNoteLine = (when: string, to: string): string => `↩ ${when} · the AFTER photos were moved to ${to}, so the work-done mark came off`;
// the line on the job's notes and on the office's card
export const measureNoteLine = (changes: Change[], who: string, when: string): string =>
  `📏 ${when} · ${changes.map((c) => `${c.name} ${c.qty} ${c.unit === "LF" ? "lin ft" : c.unit === "ROOM" ? (c.qty === 1 ? "room" : "rooms") : "sq ft"}${c.was > 1 ? ` (was ${c.was})` : ""}`).join(", ")} · texted by ${who || "the crew"}`;
