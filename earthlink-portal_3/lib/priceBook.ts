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
  not?: string;          // wording near the hit that means it ISN'T this line
  price2?: number;       // painting: the second-coat price
}

export const PRICE_GROUPS = ["Doors & hardware", "Plaster & walls", "Painting"] as const;

// their list, as written, with the wording a PO tends to use for each line
export const PRICE_BOOK: PriceItem[] = [
  // ---- doors & hardware (counted) ----
  // their list prices apartment and basement doors — a "lobby door" in a PO is
  // naming where the hardware goes, not ordering a door
  { key: "door", description: "Apartment / basement door — supply & install", unit: "EACH", price: 1395, group: "Doors & hardware", words: "(?:apartment|basement|entrance)\\s+doors?\\b|\\bdoors?\\b(?!\\s*(?:closer|chime|hinge|bell|bar|strike|frame))", not: "lobby|panic|closer|chime|hinge|bell|strike" },
  { key: "mortise", description: "Apartment mortise lock", unit: "EACH", price: 990, group: "Doors & hardware", words: "mortise" },
  { key: "lever", description: "Lever handle lock", unit: "EACH", price: 490, group: "Doors & hardware", words: "lever\\s*handle(?:\\s*lock)?", not: "panic" },
  { key: "strike_bsmt", description: "Electrical strike — basement", unit: "EACH", price: 890, group: "Doors & hardware", words: "electric(?:al)?\\s*strikes?[^.\\n]{0,20}basement|basement[^.\\n]{0,20}electric(?:al)?\\s*strikes?" },
  // no location named = the lobby price (the dearer one) — they can switch it
  { key: "strike_lobby", description: "Electrical strike — lobby", unit: "EACH", price: 1090, group: "Doors & hardware", words: "electric(?:al)?\\s*strikes?", not: "basement" },
  { key: "panic_lever", description: "Stainless steel panic exit push bar with lever handle", unit: "EACH", price: 1550, group: "Doors & hardware", words: "panic[^.\\n]{0,30}lever" },
  { key: "panic", description: "Stainless steel panic exit push bar", unit: "EACH", price: 1250, group: "Doors & hardware", words: "panic(?:\\s*(?:exit|bar|push))?" },
  { key: "chime", description: "Mechanical door chime", unit: "EACH", price: 190, group: "Doors & hardware", words: "chime|door\\s*bell" },
  { key: "closer", description: "Door closer", unit: "EACH", price: 1050, group: "Doors & hardware", words: "door\\s*closer|closers?\\b" },
  { key: "hinge_lobby", description: "Lobby door hinges", unit: "EACH", price: 350, group: "Doors & hardware", words: "hinges?", not: "apartment|apt\\b" },
  { key: "hinge_apt", description: "Apartment entrance door hinges", unit: "EACH", price: 150, group: "Doors & hardware", words: "hinges?", not: "lobby" },
  // ---- plaster & walls (measured) ----
  { key: "plaster", description: "Plaster", unit: "SF", price: 5, group: "Plaster & walls", words: "plaster|skim\\s*coat|patch(?:ing)?\\b" },
  { key: "popcorn", description: "Popcorn ceiling removal", unit: "SF", price: 5, group: "Plaster & walls", words: "popcorn" },
  { key: "wall_repair", description: "Wall repair", unit: "SF", price: 6, group: "Plaster & walls", words: "wall\\s*repair|repair[^.\\n]{0,12}walls?" },
  { key: "sheetrock", description: "Sheet rock", unit: "SF", price: 12, group: "Plaster & walls", words: "sheet\\s*rock|sheetrock|dry\\s*wall|drywall" },
  { key: "hourly", description: "Additional services", unit: "HOUR", price: 12, group: "Plaster & walls", words: "additional\\s*service|per\\s*hour|hourly" },
  // ---- painting (per apartment: 1 coat / 2 coat) ----
  { key: "paint_1br", description: "Paint 1 bedroom 1 bath apartment", unit: "EACH", price: 1190, price2: 1490, group: "Painting", words: "1\\s*(?:bed\\s*room|bedroom|br|bdrm)" },
  { key: "paint_2br", description: "Paint 2 bedroom 1 bath apartment", unit: "EACH", price: 1350, price2: 1650, group: "Painting", words: "2\\s*(?:bed\\s*room|bedroom|br|bdrm)" },
  { key: "paint_3br", description: "Paint 3 bedroom 1 bath apartment", unit: "EACH", price: 1550, price2: 1900, group: "Painting", words: "3\\s*(?:bed\\s*room|bedroom|br|bdrm)" },
  { key: "paint_4br", description: "Paint 4 bedroom 1.5 bath apartment", unit: "EACH", price: 1900, price2: 2250, group: "Painting", words: "4\\s*(?:bed\\s*room|bedroom|br|bdrm)" },
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

// ---- prices they've edited in Settings ----
const STORE = "pricebook/list.json";
export interface PriceOverride { price?: number; price2?: number; description?: string }
export type PriceOverrides = Record<string, PriceOverride>;

export async function loadPrices(): Promise<PriceItem[]> {
  try {
    const { data } = await sb().storage.from("docs").download(STORE);
    if (!data) return PRICE_BOOK;
    const ov = JSON.parse(await data.text()) as PriceOverrides;
    return PRICE_BOOK.map((p) => (ov[p.key] ? { ...p, ...ov[p.key] } : p));
  } catch { return PRICE_BOOK; }
}

export async function savePrices(ov: PriceOverrides): Promise<string | null> {
  await sb().storage.from("docs").remove([STORE]);
  const { error } = await sb().storage.from("docs")
    .upload(STORE, new Blob([JSON.stringify(ov)], { type: "application/json" }), { contentType: "application/json" });
  return error ? error.message : null;
}

// ---- reading a purchase order ----
const n = (s: string): number => { const v = parseFloat(String(s).replace(/,/g, "")); return Number.isFinite(v) && v > 0 ? v : 0; };

// How many? POs write it every which way: "250 sq ft", "install 3 apartment
// doors", "door closer x 2", "6 hours". Counted things are capped at a sane
// number so a PO number can never be mistaken for a quantity.
function qtyFor(text: string, at: number, hit: string, unit: string): number {
  const before = text.slice(Math.max(0, at - 48), at);
  const after = text.slice(at + hit.length, at + hit.length + 48);
  const measure = unit === "SF" ? /(\d[\d,]*(?:\.\d+)?)\s*(?:sq\.?\s*(?:ft|feet)|sf\b|square\s*feet)/i
    : unit === "HOUR" ? /(\d[\d,]*(?:\.\d+)?)\s*(?:hours?|hrs?)\b/i : null;
  if (measure) {
    // the measurement next to this line wins over one further off in the PO
    const near = before.match(measure) || after.match(measure) || text.match(measure);
    if (near) return n(near[1]);
    return 0;
  }
  // "x 2", "(3)", "4 ea"
  const a = after.match(/^\s*(?:[x×]|qty\.?|=|\()\s*(\d{1,3})\b/i) || after.match(/^\s*(\d{1,3})\s*(?:ea\b|each|pcs?\b|pieces?|units?)/i);
  if (a) return n(a[1]);
  // "3 doors" — and up to three words in between ("3 apartment entrance doors")
  const b = before.match(/\b(\d{1,3})\s+((?:[A-Za-z.'-]+\s+){0,3})$/);
  if (b && (b[2].trim() === "" || n(b[1]) <= 99)) return n(b[1]);
  return 0;
}

export interface PriceMatchOpts {
  book?: PriceItem[];
  coats?: 1 | 2;      // painting: which column of their list (default 2 coats)
  bundle?: boolean;   // add the prep lines that go with wet trades (default yes)
}

// a narrower line wins over the general one it would otherwise double up with
const BEATS: [string, string][] = [
  ["panic_lever", "panic"], ["panic_lever", "lever"], ["wall_repair", "plaster"],
];

// Everything on the price list this PO is asking for, in the order the PO says
// it, with the count the PO gave (1 when it didn't say) and the list price.
export function priceLinesFor(text: string, opts: PriceMatchOpts = {}): PriceLine[] {
  const book = opts.book || PRICE_BOOK;
  const coats = opts.coats ?? 2;
  const bundle = opts.bundle ?? true;
  const t = (text || "").replace(/\s+/g, " ");
  if (!t.trim()) return [];
  const byKey = new Map(book.map((p) => [p.key, p]));
  const hit = new Map<string, { qty: number; at: number; said: boolean }>();
  const put = (key: string, qty: number, at: number, said: boolean) => {
    const had = hit.get(key);
    if (!had) { hit.set(key, { qty, at, said }); return; }
    hit.set(key, { qty: Math.max(had.qty, qty), at: Math.min(had.at, at), said: had.said || said });
  };
  let sized = false; // the PO named an apartment size, so painting is priced per apartment
  for (const p of book) {
    const re = new RegExp(p.words, "gi");
    const no = p.not ? new RegExp(p.not, "i") : null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      const at = m.index;
      if (m.index === re.lastIndex) re.lastIndex++;
      // wording right around the hit that means this isn't that line
      if (no && no.test(t.slice(Math.max(0, at - 30), at + m[0].length + 30))) continue;
      // an apartment size only means painting when the PO is about painting
      if (/^paint_\d/.test(p.key)) {
        if (!/paint|coat/i.test(t)) break;
        sized = true;
      }
      put(p.key, qtyFor(t, at, m[0], p.unit) || 1, at, true);
    }
  }
  if (sized) hit.delete("paint_sf");
  for (const [win, lose] of BEATS) if (hit.has(win)) hit.delete(lose);
  // the prep that goes with wet trades, right behind the work that needs it
  if (bundle) {
    for (const b of BUNDLES) {
      const trig = hit.get(b.key);
      if (!trig) continue;
      b.adds.forEach((add, i) => {
        if (add === "paint_sf" && sized) return; // an apartment price already covers the painting
        const had = hit.get(add);
        // prep covers the same area as the work that needs it
        if (!had) hit.set(add, { qty: trig.qty, at: trig.at + (i + 1) / 100, said: false });
        else if (!had.said || had.qty === 1) hit.set(add, { ...had, qty: Math.max(had.qty, trig.qty) });
      });
    }
  }
  return [...hit.entries()]
    .sort((a, b) => a[1].at - b[1].at)
    .map(([k, v]) => {
      const p = byKey.get(k)!;
      const price = coats === 1 ? p.price : (p.price2 ?? p.price);
      const desc = p.price2 !== undefined ? `${p.description} — ${coats} coat${coats > 1 ? "s" : ""}` : p.description;
      return { description: desc, qty: v.qty, unit: p.unit, unit_price: price };
    });
}
