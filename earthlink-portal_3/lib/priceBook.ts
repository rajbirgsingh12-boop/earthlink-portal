// The partner price list (Fairstead / Boulevard) turned into something the
// invoice maker can use: every line they quoted, what it's measured in, and
// the words on a purchase order that mean that line. When a PO comes in
// saying "plaster the bedroom wall", this is what turns it into priced work
// lines — plaster, primer and paint — instead of one blank row to type out.
//
// Prices are editable in Settings; what's here is the list as they gave it.
import { sb } from "./supabase";

export interface PriceItem {
  key: string;
  description: string;   // how the line reads on a proposal / invoice
  unit: string;          // EACH · SF · HOUR
  price: number;
  group: string;
  words: string;         // the PO wording that means this line (regex source)
  price2?: number;       // painting: the second-coat price
}

export const PRICE_GROUPS = ["Doors & hardware", "Plaster & walls", "Painting"] as const;

// their list, as written, with the wording a PO tends to use for each line
export const PRICE_BOOK: PriceItem[] = [
  // ---- doors & hardware (counted) ----
  { key: "door", description: "Apartment / basement door — supply & install", unit: "EACH", price: 1395, group: "Doors & hardware", words: "\\bdoors?\\b(?!\\s*(?:closer|chime|hinge|bell|bar|strike|frame|knob|sweep))" },
  { key: "mortise", description: "Apartment mortise lock", unit: "EACH", price: 990, group: "Doors & hardware", words: "mortise" },
  { key: "lever", description: "Lever handle lock", unit: "EACH", price: 490, group: "Doors & hardware", words: "lever\\s*handle(?:\\s*lock)?" },
  { key: "strike_bsmt", description: "Electrical strike — basement", unit: "EACH", price: 890, group: "Doors & hardware", words: "electric(?:al)?\\s*strikes?" },
  { key: "strike_lobby", description: "Electrical strike — lobby", unit: "EACH", price: 1090, group: "Doors & hardware", words: "electric(?:al)?\\s*strikes?" },
  { key: "panic_lever", description: "Stainless steel panic exit push bar with lever handle", unit: "EACH", price: 1550, group: "Doors & hardware", words: "panic" },
  { key: "panic", description: "Stainless steel panic exit push bar", unit: "EACH", price: 1250, group: "Doors & hardware", words: "panic" },
  { key: "chime", description: "Mechanical door chime", unit: "EACH", price: 190, group: "Doors & hardware", words: "chime|door\\s*bell" },
  { key: "closer", description: "Door closer", unit: "EACH", price: 1050, group: "Doors & hardware", words: "closers?\\b" },
  { key: "hinge_lobby", description: "Lobby door hinges", unit: "EACH", price: 350, group: "Doors & hardware", words: "\\bhinges?\\b" },
  { key: "hinge_apt", description: "Apartment entrance door hinges", unit: "EACH", price: 150, group: "Doors & hardware", words: "\\bhinges?\\b" },
  // ---- plaster & walls (measured) ----
  // scraping a wall is the front half of plastering it — a PO that says scrape
  // is asking for the whole job. It has to say WHAT is being scraped, though:
  // a fire escape, a floor, a sticker and an apartment being repainted are all
  // somebody else's line, and pricing them as plaster invents money nobody
  // agreed to.
  { key: "plaster", description: "Plaster", unit: "SF", price: 6, group: "Plaster & walls", words: "\\bscrap(?:e|es|ed|ing)\\b(?=[^.]{0,30}\\b(?:walls?|ceilings?|plaster|skim|sheet\\s*rock|sheetrock|dry\\s*wall|drywall)\\b)|\\b(?:walls?|c(?:ei|ie|e|i)l+ings?)\\b|\\bplaster(?:ing)?\\b|\\bskim(?:\\s*coat)?\\b|\\bspackl(?:e|ing)\\b|\\bpatch(?:ing|es)?\\b|\\btape\\s*(?:and|&)\\s*spackle\\b|\\bscratch\\s*coat\\b" },
  { key: "popcorn", description: "Popcorn ceiling removal", unit: "SF", price: 5, group: "Plaster & walls", words: "popcorn|textured?\\s*ceilings?|stipple" },
  { key: "wall_repair", description: "Scrape and plaster", unit: "SF", price: 6, group: "Plaster & walls", words: "wall\\s*repair|repair[^.\\n]{0,12}walls?|hole[s]?\\s*in\\s*the\\s*walls?" },
  { key: "sheetrock", description: "Sheet rock", unit: "SF", price: 12, group: "Plaster & walls", words: "sheet\\s*rock|sheetrock|dry\\s*wall|drywall|gypsum|blue\\s*board|rock\\s*the\\s*walls?" },
  { key: "hourly", description: "Additional services", unit: "HOUR", price: 12, group: "Plaster & walls", words: "additional\\s*services?|time\\s*(?:and|&)\\s*materials?\\b|\\bt\\s*&\\s*m\\b|labou?r\\s*only|\\bhourly\\s*(?:work|labou?r|rate\\s*work)\\b" },
  // ---- painting (per apartment: 1 coat / 2 coat) ----
  { key: "paint_1br", description: "Paint 1 bedroom 1 bath apartment", unit: "EACH", price: 1190, price2: 1490, group: "Painting", words: "1\\s*(?:bed\\s*rooms?|br|bdrm)\\b" },
  { key: "paint_2br", description: "Paint 2 bedroom 1 bath apartment", unit: "EACH", price: 1350, price2: 1650, group: "Painting", words: "2\\s*(?:bed\\s*rooms?|br|bdrm)\\b" },
  { key: "paint_3br", description: "Paint 3 bedroom 1 bath apartment", unit: "EACH", price: 1550, price2: 1900, group: "Painting", words: "3\\s*(?:bed\\s*rooms?|br|bdrm)\\b" },
  { key: "paint_4br", description: "Paint 4 bedroom 1.5 bath apartment", unit: "EACH", price: 1900, price2: 2250, group: "Painting", words: "4\\s*(?:bed\\s*rooms?|br|bdrm)\\b" },
  // priming and painting are priced by the room, not by the square foot
  // the coat count is how WE price, not something the customer is told —
  // the line just says "Primer" (the old wording still reads back in)
  { key: "primer", description: "Primer", unit: "ROOM", price: 125, group: "Painting", words: "primer|prime\\b|priming|seal(?:er|ing)?\\s*coat" },
  // just "Paint" — they don't do two coats. The two-coat wording stays in the
  // trigger words so a letter already sent out still reads back as this line.
  { key: "paint_sf", description: "Paint", unit: "ROOM", price: 220, group: "Painting", words: "paint(?:ing|ed)?\\b|re\\s*paint|finish\\s*coat|two\\s*coats?|2\\s*coats?" },
];

// Wet trades carry their prep with them: nobody plasters a wall and leaves it
// bare. Hardware is never bundled — a lock only gets billed when the PO asks
// for one.
export const BUNDLES: { key: string; adds: string[] }[] = [
  { key: "plaster", adds: ["primer", "paint_sf"] },
  { key: "wall_repair", adds: ["primer", "paint_sf"] },
  { key: "popcorn", adds: ["primer", "paint_sf"] },
  { key: "sheetrock", adds: ["plaster", "primer", "paint_sf"] },
];

export interface PriceLine { description: string; qty: number; unit: string; unit_price: number }
export interface PriceLineOut extends PriceLine { key: string }

// ---- the line items they keep in Settings ----
// The list above is what the partners quoted. Everything about it is editable
// on the Settings page — the wording, the unit, the price — and they can add
// line items of their own for work the sheet never covered. That's all this
// store holds; the built-in list stays the fallback.
export interface PriceOverride {
  price?: number;
  price2?: number;
  description?: string;
  unit?: string;
  extra?: string;   // more PO wording that means this line (plain words, comma separated)
  off?: boolean;    // stop using this line
}
export type PriceOverrides = Record<string, PriceOverride>;
// a line item they wrote themselves
export interface CustomItem { key: string; description: string; unit: string; price: number; group: string; words: string }
// who a PACT proposal is addressed to when the purchase order doesn't name
// anybody — the partner's POs print the office, not the person at it
export interface ProposalContact { name?: string; title?: string }
export interface PriceStore { overrides: PriceOverrides; custom: CustomItem[]; attn?: ProposalContact }
export const EMPTY_STORE: PriceStore = { overrides: {}, custom: [] };
// who these letters go to unless Settings says otherwise — the partner's POs
// print the office, never the person at it
export const DEFAULT_ATTN: Required<ProposalContact> = { name: "Marsha Rhule-Allen", title: "Purchasing Manager" };
export const attnFrom = (store: PriceStore | null | undefined): Required<ProposalContact> =>
  // once they have set it, what they set is what it is — including blank, which
  // means "leave the letter unaddressed"
  (store?.attn ? { name: store.attn.name || "", title: store.attn.title || "" } : DEFAULT_ATTN);
export const CUSTOM_GROUP = "Our own line items";

// Word turns "-" into a dash and "\'" into a curly quote, and people write
// "move-out" where a PO says "move out". Both sides get flattened the same way
// so wording matches the way a person means it to.
export const flatten = (t: string): string =>
  (t || "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");

// What they type as trigger wording is plain words — "popcorn, textured
// ceiling" — never a regular expression, so a stray bracket can't break the
// reader or match something wild. A word must carry letters or digits to
// count, so a stray "-" can't attach a price to every PO.
export const keywordsRe = (words: string): string =>
  flatten(words).split(/[,\n]/).map((w) => w.trim().replace(/\.+$/, "")).filter((w) => /[a-z0-9]/i.test(w) && w.length > 1)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+").replace(/\\\./g, "\\.?"))
    .map((w) => `${/^[a-z0-9]/i.test(w) ? "\\b" : ""}${w}${/[a-z0-9]$/i.test(w) ? "\\b" : ""}`)
    .join("|");

// a unit is only meaningful to the reader as EACH, SF or HOUR — however it
// gets typed
export const normUnit = (u: string): string => {
  const t = flatten(u).trim().toUpperCase().replace(/\./g, "");
  if (/^(SF|SQ ?FT|SQFT|S F|SQUARE (FT|FEET)|FT2|SQ)$/.test(t)) return "SF";
  if (/^(HOUR|HOURS|HR|HRS|PER HOUR|HOURLY)$/.test(t)) return "HOUR";
  if (/^(ROOM|ROOMS|RM|RMS|PER ROOM)$/.test(t)) return "ROOM";
  if (/^(EACH|EA|UNIT|UNITS|PC|PCS|PIECE|PIECES)$/.test(t) || !t) return "EACH";
  return t;
};

const newKey = (existing: string[]): string => {
  for (let i = 1; ; i++) { const k = `own${i}`; if (!existing.includes(k)) return k; }
};
export const blankCustom = (existing: CustomItem[]): CustomItem =>
  ({ key: newKey(existing.map((c) => c.key)), description: "", unit: "EACH", price: 0, group: CUSTOM_GROUP, words: "" });

// the list the reader actually works from: the sheet as edited, minus what
// they switched off, plus their own line items
export function bookFrom(store: PriceStore): PriceItem[] {
  const built = PRICE_BOOK
    .filter((p) => !store.overrides[p.key]?.off)
    .map((p) => {
      const o = store.overrides[p.key];
      if (!o) return p;
      const extra = keywordsRe(o.extra || "");
      return {
        ...p,
        price: o.price ?? p.price,
        price2: o.price2 ?? p.price2,
        description: o.description?.trim() || p.description,
        unit: normUnit(o.unit || p.unit),
        words: extra ? `${p.words}|${extra}` : p.words,
      };
    });
  const own = (store.custom || [])
    .filter((c) => c.description.trim() && keywordsRe(c.words))
    .map((c) => ({ key: `own:${c.key}`, description: c.description.trim(), unit: normUnit(c.unit), price: Number(c.price) || 0, group: c.group || CUSTOM_GROUP, words: keywordsRe(c.words) }));
  return [...built, ...own];
}

// The saved list is written as a new file each time and the newest one wins.
// The docs bucket allows insert and delete but not update, so overwriting one
// fixed name would fail from the second save on — and a delete-then-write
// would leave a moment with no list at all.
const FOLDER = "pricebook";
const LEGACY = "pricebook/list.json";
const stamped = (name: string) => Number(name.match(/^list-(\d+)\.json$/)?.[1] || 0);

// Reading has to tell "nothing saved yet" from "couldn't read it" — a save
// that guessed wrong would write over work it never loaded. Listing the folder
// answers that without reading error text.
async function readStore(): Promise<{ store: PriceStore; ok: boolean; from: string | null; older: string[] }> {
  try {
    // newest first, or a backlog of old versions would hide the current one
    const { data: listed, error } = await sb().storage.from("docs").list(FOLDER, { limit: 100, sortBy: { column: "name", order: "desc" } });
    if (error || !Array.isArray(listed)) return { store: EMPTY_STORE, ok: false, from: null, older: [] };
    const versions = listed.filter((f) => stamped(f.name) > 0).sort((a, b) => stamped(b.name) - stamped(a.name));
    const newest = versions[0]?.name || (listed.some((f) => f.name === "list.json") ? "list.json" : null);
    const older = versions.slice(1).map((f) => `${FOLDER}/${f.name}`);
    if (!newest) return { store: EMPTY_STORE, ok: true, from: null, older: [] }; // never saved any
    const path = newest === "list.json" ? LEGACY : `${FOLDER}/${newest}`;
    const { data, error: de } = await sb().storage.from("docs").download(path);
    if (de || !data) return { store: EMPTY_STORE, ok: false, from: null, older: [] };
    const raw = JSON.parse(await data.text()) as Partial<PriceStore> & PriceOverrides;
    // the first version of this file was just {key: {price}} — still readable
    const store: PriceStore = raw && (raw.overrides || raw.custom)
      ? { overrides: raw.overrides || {}, custom: Array.isArray(raw.custom) ? raw.custom : [], ...(raw.attn ? { attn: raw.attn } : {}) }
      : { overrides: (raw || {}) as PriceOverrides, custom: [] };
    return { store, ok: true, from: path, older: newest === "list.json" ? older : [...older, ...(listed.some((f) => f.name === "list.json") ? [LEGACY] : [])] };
  } catch { return { store: EMPTY_STORE, ok: false, from: null, older: [] }; }
}

// `ok` false means the saved list couldn't be read — the page must not then
// save, or it would write over edits it never loaded
export async function loadPrices(): Promise<{ items: PriceItem[]; store: PriceStore; ok: boolean }> {
  const { store, ok } = await readStore();
  return { items: bookFrom(store), store, ok };
}

export async function savePrices(store: PriceStore): Promise<string | null> {
  // check again at the moment of writing: if the saved list can't be read
  // right now, nothing is written at all
  const { ok, older, from } = await readStore();
  if (!ok) return "Couldn't read the saved line items just now — nothing was changed. Try again in a moment.";
  // the name is stamped AFTER that read, so it always sorts above anything the
  // read saw; two saves in the same millisecond just take the next stamp
  const body = () => new Blob([JSON.stringify(store)], { type: "application/json" });
  const known = [...older, ...(from ? [from] : [])];
  let stamp = Date.now();
  const seen = Math.max(0, ...known.map((f) => stamped(f.split("/").pop() || "")));
  if (stamp <= seen) stamp = seen + 1;
  let written = "";
  for (let tries = 0; tries < 3; tries++) {
    const path = `${FOLDER}/list-${stamp + tries}.json`;
    const { error } = await sb().storage.from("docs").upload(path, body(), { contentType: "application/json" });
    if (!error) { written = path; break; }
    if (!/exists|409|duplicate/i.test(error.message)) return error.message;
  }
  if (!written) return "Couldn't write the line items — try again in a moment.";
  // the new one is safely written, so anything OLDER than it can go — never a
  // file someone else wrote in the meantime
  const mine = stamped(written.split("/").pop() || "");
  const stale = [...new Set(known)]
    .filter((f) => f !== written && (f.endsWith("list.json") || stamped(f.split("/").pop() || "") < mine));
  if (stale.length > 0) { try { await sb().storage.from("docs").remove(stale); } catch { /* leftovers are harmless */ } }
  return null;
}

// ---- reading a purchase order ----
// Reading a PO is guesswork, so the rules lean the safe way: a quantity is
// only believed when the PO puts it right next to the work, a price only goes
// on work the PO actually names, and anything unclear comes through as 1 for
// them to correct. Over-billing a partner is the outcome worth contorting the
// code to avoid.
const n = (v: string): number => { const x = parseFloat(String(v).replace(/,/g, "")); return Number.isFinite(x) && x > 0 ? x : 0; };

// sentences hold the measurements ("…320 sq ft"); clauses hold the meaning
// ("panic bar on the lobby door" is one thing, not three)
const splitAt = (text: string, re: RegExp): { s: string; at: number }[] => {
  const out: { s: string; at: number }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    out.push({ s: text.slice(last, m.index), at: last });
    last = (m.index as number) + m[0].length;
  }
  out.push({ s: text.slice(last), at: last });
  return out.filter((c) => c.s.trim());
};
const SENTENCE = /[.;\n]+\s*/g;
const CLAUSE = /\s*(?:,|\band\b|\balso\b|\bplus\b)\s+/gi;

const MEASURE = /(\d[\d,]*(?:\.\d+)?)\s*(?:sq\.?\s*(?:ft|feet)|sf\b|square\s*feet)/gi;
const HOURS = /(\d[\d,]*(?:\.\d+)?)\s*(?:hours?|hrs?)\b/gi;
// "3 rooms" — only a plain room count, never "2 bedroom apartment" (that's a
// size, not a number of rooms to paint)
const ROOMS = /(\d[\d,]*(?:\.\d+)?)\s*rooms?\b/gi;
// the rooms a PO names — "prime and paint the kitchen, bathroom and hallway"
// is three rooms even though it never says a number
const ROOM_WORDS = /\b(kitchens?|bath\s*rooms?|bed\s*rooms?|living\s*rooms?|dining\s*rooms?|hall\s*ways?|foyers?|vestibules?|dens?|laundry\s*rooms?|utility\s*rooms?|pantr(?:y|ies)|nurser(?:y|ies)|entry\s*ways?)\b/gi;
const STREETY = /\b(?:ave|avenue|st|street|blvd|boulevard|rd|road|dr|drive|ln|lane|pl|place|ct|court|ter|terrace|pkwy|parkway|houses?|towers?)\b/i;
const NOT_A_ROOM_COUNT = /(?:apt\.?|apartment|unit|#|no\.?|bldg|building|floor|fl\.?|suite|ste\.?|p\.?o\.?)\s*$/i;
const roomsNamed = (t: string): number => {
  const kinds = new Map<string, number>();
  for (const m of t.matchAll(ROOM_WORDS)) {
    const at = m.index as number;
    // "1465 Bedford Avenue" and "Kitchen Lane" name a place, not a room
    if (STREETY.test(t.slice(at, at + m[1].length + 14))) continue;
    const lead = t.slice(Math.max(0, at - 14), at);
    const kind = m[1].toLowerCase().replace(/\s+/g, "").replace(/(?:es|s)$/, "");
    // "hall bath" and "master bedroom" are one room, not two
    if (/\b(?:hall|master|half|full|en\s*suite)\s*$/i.test(lead) && /bath/.test(kind)) continue;
    // an apartment SIZE ("1 bedroom 1 bath apartment") is not a room count
    if (/\d\s*(?:bed\s*rooms?|br)\b[^.]{0,14}$/i.test(lead) && /bath/.test(kind)) continue;
    // "2 bedrooms and the living room" is three rooms, not two kinds of room
    const said = lead.match(/(\d{1,2})\s+$/);
    const count = said && !NOT_A_ROOM_COUNT.test(lead.slice(0, lead.length - said[0].length))
      ? Math.min(20, parseInt(said[1], 10)) : 1;
    kinds.set(kind, Math.max(kinds.get(kind) || 0, count));
  }
  return [...kinds.values()].reduce((a, b) => a + b, 0);
};
// a count right before the work, with room for one adjective
const COUNT_BEFORE = /(?:^|[^\d])(\d{1,2})\s+(?:[A-Za-z.'-]+\s+){0,3}$/;
// …unless that number is a PO number, an apartment, a building or a date
const NOT_A_COUNT = /(?:p\.?\s*o\.?|no\.?|#|apt\.?|apartment|unit|bldg|building|floor|fl\.?|suite|ste\.?|room|work\s*order|\d[/-]?)\s*$/i;

export interface PriceMatchOpts {
  book?: PriceItem[];
  coats?: 1 | 2;      // painting: which column of their list (2 unless the PO says one)
  bundle?: boolean;   // add the prep lines that go with wet trades (default yes)
}

// a narrower line wins over the general one it would double up with — but only
// inside the same clause, so other work in the PO is never quietly deleted
// a popcorn ceiling has its own price — scraping one is that job, not plastering
const BEATS: [string, string][] = [["wall_repair", "plaster"], ["popcorn", "plaster"]];
// hardware that names a door as the place it goes, not a door being ordered
const ON_A_DOOR = /lock|closer|hinge|chime|door\s*bell|strike|panic|push\s*bar/i;
// the wording that means the wall gets scraped before it gets plastered —
// and repair talk means the same thing: damaged, cracked, peeling or
// water-hit plaster comes off before new plaster goes on
const SCRAPED = /\bscrap(?:e|es|ed|ing)\b|\brepair\w*\b|\bdamag\w*\b|\bcrack\w*\b|\bholes?\b|\bpeel\w*\b|\bchip\w*\b|\bflak\w*\b|\bwater\b|\brestor\w*\b|\bresurfac\w*\b/i;
// A wall or a ceiling on its own says nothing — what is being DONE to it is
// what makes it the plaster job. These three decide it:
//   the trade, said outright
const PLASTER_SAID = /\b(?:plaster\w*|skim\w*|spackl\w*|patch\w*|scratch\s*coat|scrap(?:e|es|ed|ing))\b/i;
//   something being done to the surface itself
const SURFACE_WORK = /\b(?:damage\w*|water|crack\w*|holes?|peel\w*|chip\w*|flak\w*|prep\w*|repair\w*|fix\w*|re-?d(?:o|one|oing)|resurfac\w*|smooth\w*|done|finish\w*|restor\w*|seal\w*)\b/i;
//   …and the things that merely HANG on a wall or a ceiling, which are somebody
//   else's trade however broken they are
const ON_A_SURFACE = /\b(?:fans?|lights?|lighting|fixtures?|outlets?|sockets?|switch\w*|a\/?c|air\s*condition\w*|radiators?|pipes?|sprinklers?|smoke|detectors?|cameras?|intercoms?|cabinets?|doors?|windows?|tiles?|floors?|mount\w*|shelf|shelves|tvs?|televisions?)\b/i;

interface Hit { key: string; qty: number; said: boolean; at: number; scrape?: boolean }

export function priceLinesFor(text: string, opts: PriceMatchOpts = {}): PriceLineOut[] {
  const book = opts.book || PRICE_BOOK;
  const bundle = opts.bundle ?? true;
  const raw = flatten(text || "").trim();
  if (!raw) return [];
  // they don't do two coats — one is what an apartment is quoted at, unless the
  // PO itself asks for two and is paying for two
  const twoCoat = /\b(?:2|two)\s*coats?\b/i.test(raw);
  const coats: 1 | 2 = opts.coats ?? (twoCoat ? 2 : 1);
  const byKey = new Map(book.map((p) => [p.key, p]));
  const hits: Hit[] = [];

  for (const sent of splitAt(raw, SENTENCE)) {
    // every measurement in the sentence, each spendable by one line only
    const measures = [...sent.s.matchAll(MEASURE)].map((m) => ({ v: n(m[1]), at: m.index as number, used: false }));
    const hours = [...sent.s.matchAll(HOURS)].map((m) => ({ v: n(m[1]), at: m.index as number, used: false }));
    const rooms = [...sent.s.matchAll(ROOMS)].map((m) => ({ v: n(m[1]), at: m.index as number, used: false }));
    // clause boundaries: the guards below read the clause a hit lands in, but
    // matching runs across the whole sentence so wording like "strip and wax"
    // still finds itself
    const ranges: { a: number; b: number; s: string }[] = splitAt(sent.s, CLAUSE).map((c) => ({ a: c.at, b: c.at + c.s.length, s: c.s }));
    const clOf = (pos: number) => { const i = ranges.findIndex((r) => pos >= r.a && pos <= r.b); return i < 0 ? Math.max(0, ranges.length - 1) : i; };

    // where each line item shows up in this sentence — once per clause
    const found: { key: string; at: number; end: number; hit: string; cl: number; own: boolean }[] = [];
    for (const p of book) {
      let re: RegExp;
      try { re = new RegExp(p.words, "gi"); } catch { continue; } // unusable wording is simply skipped
      const seenCl = new Set<number>();
      let m: RegExpExecArray | null;
      while ((m = re.exec(sent.s))) {
        if (m.index === re.lastIndex) re.lastIndex++;
        const cl = clOf(m.index);
        if (seenCl.has(cl)) continue; // a clause names a thing once
        seenCl.add(cl);
        found.push({ key: p.key, at: m.index, end: m.index + m[0].length, hit: m[0], cl, own: p.key.startsWith("own:") });
      }
    }
    // two lines claiming the same words is one piece of work: the longer
    // wording wins, and their own line item wins a tie against the sheet
    const shadowed = new Set<number>();
    found.forEach((a, i) => found.forEach((b, j) => {
      if (i === j || shadowed.has(i) || shadowed.has(j)) return;
      if (a.at >= b.end || b.at >= a.end) return; // no overlap
      const alen = a.end - a.at, blen = b.end - b.at;
      // the sheet's own pairs (hinges, strikes, panic bar) share wording on
      // purpose and are settled by the clause rules below — leave them be
      const bothSheet = !a.own && !b.own;
      if (alen > blen) shadowed.add(j);
      else if (alen === blen && !bothSheet && (a.own !== b.own ? a.own : i < j)) shadowed.add(j);
    }));

    const pend: { key: string; at: number; hit: string; unit: string; qty: number; cl: number; scrape: boolean }[] = [];
    for (let ci = 0; ci < ranges.length; ci++) {
      const cl = ranges[ci];
      const inClause = found.filter((f, i) => f.cl === ci && !shadowed.has(i));
      const has = (k: string) => inClause.some((x) => x.key === k);
      const drop = new Set<string>();
      // a door named next to its hardware is where the hardware goes
      if (has("door") && ON_A_DOOR.test(cl.s)) drop.add("door");
      // a clause that only ever said "wall" or "ceiling" bills the plaster job
      // when something is being done to the surface — and never when what is
      // wrong is the fan hanging off it
      if (has("plaster") && !PLASTER_SAID.test(cl.s) && (!SURFACE_WORK.test(cl.s) || ON_A_SURFACE.test(cl.s))) drop.add("plaster");
      // one location wins — but only when both variants matched: if one is
      // switched off in Settings, the other stands on its own
      if (has("hinge_lobby") && has("hinge_apt")) drop.add(/lobby/i.test(cl.s) ? "hinge_apt" : "hinge_lobby");
      if (has("strike_lobby") && has("strike_bsmt")) drop.add(/lobby/i.test(cl.s) ? "strike_bsmt" : "strike_lobby");
      // the panic bar is one line — with the lever handle when the PO says so
      if (has("panic") || has("panic_lever")) {
        if (/lever/i.test(cl.s)) { drop.add("panic"); drop.add("lever"); } else drop.add("panic_lever");
      }
      for (const [win, lose] of BEATS) if (has(win) && !drop.has(win)) drop.add(lose);
      // an apartment size only prices a whole apartment when the clause is
      // about painting one — "paint 2 bedrooms and the living room" isn't
      const paintSized = /paint|coat/i.test(cl.s) && /\b(?:apartments?|apt\b|units?)\b|\d\s*(?:\.\d)?\s*bath\b/i.test(cl.s);

      for (const x of inClause) {
        if (drop.has(x.key)) continue;
        if (/^paint_\d/.test(x.key) && !paintSized) continue;
        const p = byKey.get(x.key)!;
        let qty = 0;
        if (p.unit !== "SF" && p.unit !== "HOUR" && p.unit !== "ROOM") {
          const before = sent.s.slice(cl.a, x.at);
          const b = before.match(COUNT_BEFORE);
          if (b && !NOT_A_COUNT.test(before.slice(0, (b.index ?? 0) + (/^\D/.test(b[0]) ? 1 : 0)))) qty = n(b[1]);
          if (!qty) {
            const after = sent.s.slice(x.at + x.hit.length, x.at + x.hit.length + 24);
            const a = after.match(/^\s*(?:[x×]|qty\.?|=|\()\s*(\d{1,2})\b/i) || after.match(/^\s*(\d{1,2})\s*(?:ea\b|each|pcs?\b|pieces?|units?)/i);
            if (a) qty = n(a[1]);
          }
        }
        // whether the PO said scrape is read off the clause, not off the word
        // that happened to match first — "kitchen ceiling scrape plaster" is a
        // scrape job even though "ceiling" is what the reader saw first
        pend.push({ key: x.key, at: x.at, hit: x.hit, unit: p.unit, qty, cl: ci, scrape: SCRAPED.test(cl.s) });
      }
    }
    // each measurement in the sentence belongs to the work nearest it, and is
    // spent once — so one "150 sq ft" can't be billed on two different lines
    for (const [unit, pool] of [["SF", measures], ["HOUR", hours], ["ROOM", rooms]] as const) {
      const want = pend.filter((x) => x.unit === unit);
      // work in the same clause as the measurement gets first claim on it
      const pairs = pool.flatMap((mm, mi) => want.map((w, wi) => ({ mi, wi, d: Math.abs(mm.at - w.at), far: clOf(mm.at) === w.cl ? 0 : 1 })));
      pairs.sort((a, b) => a.far - b.far || a.d - b.d);
      const takenW = new Set<number>();
      for (const pr of pairs) {
        if (pool[pr.mi].used || takenW.has(pr.wi)) continue;
        pool[pr.mi].used = true; takenW.add(pr.wi);
        want[pr.wi].qty = pool[pr.mi].v;
      }
      // "plaster 200 sq ft and 150 sq ft" is 350 — a measurement nobody claimed
      // belongs to the work in its own clause
      for (const mm of pool) {
        if (mm.used) continue;
        const mine = want.filter((w) => w.cl === clOf(mm.at));
        // its own clause if there is one piece of work there, otherwise the
        // nearest work in the same sentence
        const owner = mine.length === 1 ? mine[0]
          : want.length > 0 ? want.reduce((a, b) => (Math.abs(b.at - mm.at) < Math.abs(a.at - mm.at) ? b : a)) : null;
        if (owner) { owner.qty += mm.v; mm.used = true; }
      }
    }
    // it only says "scrape and plaster" when the PO said scrape — a plaster
    // line that came along behind sheetrock never claims it
    hits.push(...pend.map((x) => ({ key: x.key, qty: x.qty || 1, said: x.qty > 0, at: sent.at + x.at, scrape: x.scrape })));
  }

  // the same work named more than once: counts the PO gave add up; when it
  // never gave one, it stays a single line of 1
  const merged = new Map<string, Hit>();
  for (const h of hits) {
    const had = merged.get(h.key);
    if (!had) { merged.set(h.key, { ...h }); continue; }
    if (h.said && had.said) had.qty = Math.round((had.qty + h.qty) * 100) / 100;
    else if (h.said) { had.qty = h.qty; had.said = true; }
    had.at = Math.min(had.at, h.at);
    had.scrape = had.scrape || h.scrape;
  }
  // plaster work brings its own primer and paint by the room — a whole-
  // apartment repaint price on top of that is just noise
  if (["plaster", "wall_repair", "popcorn", "sheetrock"].some((k) => merged.has(k)))
    for (const k of [...merged.keys()]) if (/^paint_\d/.test(k)) merged.delete(k);
  // an apartment price covers the painting; the by-the-room line would double it
  const sized = [...merged.keys()].some((k) => /^paint_\d/.test(k));
  if (sized) merged.delete("paint_sf");

  // "3 rooms" anywhere in the PO says how many rooms the work covers; failing
  // that, the rooms it names by hand do; failing that, one
  const roomsSaid = n([...raw.matchAll(ROOMS)][0]?.[1] || "") || Math.max(1, roomsNamed(raw));
  // the prep that goes with wet trades, right behind the work that needs it
  if (bundle) {
    for (const b of BUNDLES) {
      const trig = merged.get(b.key);
      if (!trig) continue;
      b.adds.forEach((add, i) => {
        if (add === "paint_sf" && sized) return;
        const addUnit = byKey.get(add)?.unit;
        // prep measured the same way as the work covers the same amount of it;
        // measured differently (rooms behind square feet), the PO's own room
        // count decides, and one room is the safe default
        const qty = addUnit === byKey.get(b.key)?.unit ? trig.qty
          : addUnit === "ROOM" ? roomsSaid : 1;
        const had = merged.get(add);
        if (!had) merged.set(add, { key: add, qty, said: false, at: trig.at + (i + 1) / 100 });
        else if (!had.said) had.qty = Math.max(had.qty, qty);
      });
    }
  }

  // any room-priced line the PO didn't count for itself covers the rooms the
  // PO named — "prime and paint the kitchen, bathroom and hallway" is three
  for (const h of merged.values()) if (!h.said && byKey.get(h.key)?.unit === "ROOM") h.qty = roomsSaid;

  return [...merged.values()]
    .sort((a, b) => a.at - b.at)
    .map((h) => {
      const p = byKey.get(h.key)!;
      const price = p.price2 !== undefined && coats === 2 ? p.price2 : p.price;
      // a PO that says scrape is asking for the scraping too, so the line says so
      const lead = h.scrape && h.key === "plaster"
        ? `Scrape and ${/^[A-Z][a-z]/.test(p.description) ? p.description[0].toLowerCase() + p.description.slice(1) : p.description}`
        : p.description;
      return { key: h.key, description: lead, qty: h.qty, unit: p.unit, unit_price: price };
    });
}

// The wording cleanup RUN_ME.sql applies to the database, for rows the SQL
// has not reached yet: "Wall repair" reads "Scrape and plaster" and the
// "— N coat(s)" tails come off. Papers built from an old job read the new
// way immediately, and a job heals in place the first time it is opened.
export const cleanLineWording = <T extends { description: string }>(items: T[]): { items: T[]; changed: boolean } => {
  let changed = false;
  const out = items.map((it) => {
    let d = it.description === "Wall repair" ? "Scrape and plaster" : it.description;
    d = d.replace(/\s*—\s*[12]\s*coats?\s*$/i, "");
    if (d === it.description) return it;
    changed = true;
    return { ...it, description: d };
  });
  return { items: changed ? out : items, changed };
};

// which price-list lines a description already stands for — so work a PO
// priced in its own words never gets a second, list-priced copy beside it
export const keysIn = (description: string, book?: PriceItem[]): string[] =>
  priceLinesFor(description, { book, bundle: false }).map((l) => l.key);

// Which single line item a description already stands for — used to tell
// whether work is already on a job. Only an unambiguous answer counts: a
// description that reads as two different lines ("move out clean and paint
// touch-up") claims neither, so nothing gets silently swallowed.
export const soleKey = (description: string, book?: PriceItem[]): string | null => {
  const ks = keysIn(description, book);
  return ks.length === 1 ? ks[0] : null;
};
