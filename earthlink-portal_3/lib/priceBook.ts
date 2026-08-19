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
  { key: "hinge_lobby", description: "Lobby door hinges", unit: "EACH", price: 350, group: "Doors & hardware", words: "hinges?" },
  { key: "hinge_apt", description: "Apartment entrance door hinges", unit: "EACH", price: 150, group: "Doors & hardware", words: "hinges?" },
  // ---- plaster & walls (measured) ----
  { key: "plaster", description: "Plaster", unit: "SF", price: 5, group: "Plaster & walls", words: "plaster|skim\\s*coat|patch(?:ing)?\\b" },
  { key: "popcorn", description: "Popcorn ceiling removal", unit: "SF", price: 5, group: "Plaster & walls", words: "popcorn" },
  { key: "wall_repair", description: "Wall repair", unit: "SF", price: 6, group: "Plaster & walls", words: "wall\\s*repair|repair[^.\\n]{0,12}walls?" },
  { key: "sheetrock", description: "Sheet rock", unit: "SF", price: 12, group: "Plaster & walls", words: "sheet\\s*rock|sheetrock|dry\\s*wall|drywall" },
  { key: "hourly", description: "Additional services", unit: "HOUR", price: 12, group: "Plaster & walls", words: "additional\\s*service|per\\s*hour|hourly" },
  // ---- painting (per apartment: 1 coat / 2 coat) ----
  { key: "paint_1br", description: "Paint 1 bedroom 1 bath apartment", unit: "EACH", price: 1190, price2: 1490, group: "Painting", words: "1\\s*(?:bed\\s*rooms?|br|bdrm)\\b" },
  { key: "paint_2br", description: "Paint 2 bedroom 1 bath apartment", unit: "EACH", price: 1350, price2: 1650, group: "Painting", words: "2\\s*(?:bed\\s*rooms?|br|bdrm)\\b" },
  { key: "paint_3br", description: "Paint 3 bedroom 1 bath apartment", unit: "EACH", price: 1550, price2: 1900, group: "Painting", words: "3\\s*(?:bed\\s*rooms?|br|bdrm)\\b" },
  { key: "paint_4br", description: "Paint 4 bedroom 1.5 bath apartment", unit: "EACH", price: 1900, price2: 2250, group: "Painting", words: "4\\s*(?:bed\\s*rooms?|br|bdrm)\\b" },
  // primer isn't on their list — it rides along at whatever they set in Settings
  { key: "primer", description: "Primer — 1 coat", unit: "SF", price: 0, group: "Painting", words: "primer|prime\\b" },
  { key: "paint_sf", description: "Paint — 2 coats", unit: "SF", price: 0, group: "Painting", words: "paint(?:ing)?\\b" },
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
const STORE = "pricebook/list.json";
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
export interface PriceStore { overrides: PriceOverrides; custom: CustomItem[] }
export const EMPTY_STORE: PriceStore = { overrides: {}, custom: [] };
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
    const { data: listed, error } = await sb().storage.from("docs").list(FOLDER);
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
      ? { overrides: raw.overrides || {}, custom: Array.isArray(raw.custom) ? raw.custom : [] }
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

export async function savePrices(store: PriceStore, now = Date.now()): Promise<string | null> {
  // check again at the moment of writing: if the saved list can't be read
  // right now, nothing is written at all
  const { ok, older, from } = await readStore();
  if (!ok) return "Couldn't read the saved line items just now — nothing was changed. Try again in a moment.";
  const { error } = await sb().storage.from("docs")
    .upload(`${FOLDER}/list-${now}.json`, new Blob([JSON.stringify(store)], { type: "application/json" }), { contentType: "application/json" });
  if (error) return error.message;
  // the new one is safely written, so the ones it replaced can go
  const stale = [...older, ...(from && from !== `${FOLDER}/list-${now}.json` ? [from] : [])];
  if (stale.length > 0) await sb().storage.from("docs").remove([...new Set(stale)]).catch?.(() => null);
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
const BEATS: [string, string][] = [["wall_repair", "plaster"]];
// hardware that names a door as the place it goes, not a door being ordered
const ON_A_DOOR = /lock|closer|hinge|chime|bell|strike|panic|push\s*bar|knob|peep|viewer|sweep|jamb/i;

interface Hit { key: string; qty: number; said: boolean; at: number }

export function priceLinesFor(text: string, opts: PriceMatchOpts = {}): PriceLineOut[] {
  const book = opts.book || PRICE_BOOK;
  const bundle = opts.bundle ?? true;
  const raw = flatten(text || "").trim();
  if (!raw) return [];
  // "one coat" on the PO means the one-coat price
  const coats: 1 | 2 = opts.coats ?? (/\b(?:1|one|single)\s*coat\b/i.test(raw) ? 1 : 2);
  const byKey = new Map(book.map((p) => [p.key, p]));
  const hits: Hit[] = [];

  for (const sent of splitAt(raw, SENTENCE)) {
    // every measurement in the sentence, each spendable by one line only
    const measures = [...sent.s.matchAll(MEASURE)].map((m) => ({ v: n(m[1]), at: m.index as number, used: false }));
    const hours = [...sent.s.matchAll(HOURS)].map((m) => ({ v: n(m[1]), at: m.index as number, used: false }));
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

    const pend: { key: string; at: number; hit: string; unit: string; qty: number; cl: number }[] = [];
    for (let ci = 0; ci < ranges.length; ci++) {
      const cl = ranges[ci];
      const inClause = found.filter((f, i) => f.cl === ci && !shadowed.has(i));
      const has = (k: string) => inClause.some((x) => x.key === k);
      const drop = new Set<string>();
      // a door named next to its hardware is where the hardware goes
      if (has("door") && ON_A_DOOR.test(cl.s)) drop.add("door");
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
      const paintSized = /paint|coat/i.test(cl.s) && /\b(?:apartments?|apt\b|units?|bath)/i.test(cl.s);

      for (const x of inClause) {
        if (drop.has(x.key)) continue;
        if (/^paint_\d/.test(x.key) && !paintSized) continue;
        const p = byKey.get(x.key)!;
        let qty = 0;
        if (p.unit !== "SF" && p.unit !== "HOUR") {
          const before = sent.s.slice(cl.a, x.at);
          const b = before.match(COUNT_BEFORE);
          if (b && !NOT_A_COUNT.test(before.slice(0, (b.index ?? 0) + (/^\D/.test(b[0]) ? 1 : 0)))) qty = n(b[1]);
          if (!qty) {
            const after = sent.s.slice(x.at + x.hit.length, x.at + x.hit.length + 24);
            const a = after.match(/^\s*(?:[x×]|qty\.?|=|\()\s*(\d{1,2})\b/i) || after.match(/^\s*(\d{1,2})\s*(?:ea\b|each|pcs?\b|pieces?|units?)/i);
            if (a) qty = n(a[1]);
          }
        }
        pend.push({ key: x.key, at: x.at, hit: x.hit, unit: p.unit, qty, cl: ci });
      }
    }
    // each measurement in the sentence belongs to the work nearest it, and is
    // spent once — so one "150 sq ft" can't be billed on two different lines
    for (const [unit, pool] of [["SF", measures], ["HOUR", hours]] as const) {
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
    }
    hits.push(...pend.map((x) => ({ key: x.key, qty: x.qty || 1, said: x.qty > 0, at: sent.at + x.at })));
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
  }
  // an apartment price covers the painting; the per-square-foot line would double it
  const sized = [...merged.keys()].some((k) => /^paint_\d/.test(k));
  if (sized) merged.delete("paint_sf");

  // the prep that goes with wet trades, right behind the work that needs it
  if (bundle) {
    for (const b of BUNDLES) {
      const trig = merged.get(b.key);
      if (!trig) continue;
      b.adds.forEach((add, i) => {
        if (add === "paint_sf" && sized) return;
        const had = merged.get(add);
        if (!had) merged.set(add, { key: add, qty: trig.qty, said: false, at: trig.at + (i + 1) / 100 });
        else if (!had.said) had.qty = Math.max(had.qty, trig.qty);
      });
    }
  }

  return [...merged.values()]
    .sort((a, b) => a.at - b.at)
    .map((h) => {
      const p = byKey.get(h.key)!;
      const price = p.price2 !== undefined && coats === 2 ? p.price2 : p.price;
      const desc = p.price2 !== undefined ? `${p.description} — ${coats} coat${coats > 1 ? "s" : ""}` : p.description;
      return { key: h.key, description: desc, qty: h.qty, unit: p.unit, unit_price: price };
    });
}

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
