// The move-out survey, the way it gets written on site:
//
//   390 sutter 11A MO
//   2 bedroom
//   Window balance 28
//   Outlet: 1 single 7 double 1 two outlet cover
//   7 passage lock
//   Reglaze tub and sink
//
// A survey template turns those lines into the contract's own line items.
// Each template item is one thing a person writes down ("Window balance"),
// the ways it gets written (its aliases), and the contract line or lines it
// bills, with a count per unit ("Reglaze tub and sink" is two lines, one
// each). The template is set up once per contract from its price book —
// the app proposes a line for every item by keywords, the owner confirms —
// and it learns: a line the owner had to match by hand becomes an alias.
//
// Nothing here touches the database: pure functions over text, the
// template and the price book. The page reads and writes the template.

export interface CatalogLine { code: string; line: number; category: string; description: string; uom: string; unit_price: number }
export interface TemplateLine { code: string; per: number }
// how a seed item finds its line in a price book: every `req` word must be in
// the description ("a|b" = either), `opt` words add to the score, a `not`
// word rules the line out (a toilet is not a toilet paper holder)
export interface FindSpec { req: string[]; opt?: string[]; not?: string[]; per?: number }
export interface TemplateItem {
  key: string;            // stable id
  label: string;          // what the survey says
  aliases: string[];      // other ways it gets written (normalized on use)
  lines: TemplateLine[];  // the contract lines it bills — empty = not matched to the book yet
  group: string;          // Windows, Electrical, … (the blank survey is grouped)
  find: FindSpec[];       // how to propose its lines from a price book
  skip?: boolean;         // the owner never bills this — left off the blank survey
}
export interface SurveyTemplate { version: 1; contractId: string; name: string; cap: number; items: TemplateItem[] }

export const DEFAULT_CAP = 10_000;

// ---- the move-out list ----
// Everything that tends to be on a NYCHA vacant-apartment (move-out) scope.
// Aliases carry the shorthand the crew actually writes.
type Seed = Omit<TemplateItem, "lines">;
const S = (key: string, group: string, label: string, aliases: string[], find: FindSpec[]): Seed => ({ key, group, label, aliases, find });
const NOT_FIXTURE = ["switch", "plate", "cover", "receptacle", "outlet", "bulb", "lamp"];
export const SEED_ITEMS: Seed[] = [
  // apartment size — the whole-apartment lines (paint, clean) that go by bedrooms
  S("apt_studio", "Apartment", "Studio apartment", ["studio", "0 bedroom", "efficiency"], [{ req: ["paint"], opt: ["studio", "apartment", "apt", "efficiency"], not: ["1", "2", "3", "4", "bedroom", "room", "door"] }]),
  S("apt_1br", "Apartment", "1 bedroom apartment", ["1 bedroom", "1 br", "1br", "one bedroom"], [{ req: ["paint"], opt: ["1", "one", "bedroom", "apartment", "apt"], not: ["2", "3", "4", "studio", "door"] }]),
  S("apt_2br", "Apartment", "2 bedroom apartment", ["2 bedroom", "2 br", "2br", "two bedroom"], [{ req: ["paint"], opt: ["2", "two", "bedroom", "apartment", "apt"], not: ["1", "3", "4", "studio", "door"] }]),
  S("apt_3br", "Apartment", "3 bedroom apartment", ["3 bedroom", "3 br", "3br", "three bedroom"], [{ req: ["paint"], opt: ["3", "three", "bedroom", "apartment", "apt"], not: ["1", "2", "4", "studio", "door"] }]),
  S("apt_4br", "Apartment", "4 bedroom apartment", ["4 bedroom", "4 br", "4br", "four bedroom"], [{ req: ["paint"], opt: ["4", "four", "bedroom", "apartment", "apt"], not: ["1", "2", "3", "studio", "door"] }]),
  S("clean", "Apartment", "Apartment cleaning", ["cleaning", "clean", "broom clean", "final clean"], [{ req: ["clean"], opt: ["apartment", "apt", "final", "broom"] }]),
  S("debris", "Apartment", "Debris removal", ["debris", "rubbish", "haul", "garbage", "removal of debris"], [{ req: ["debris|rubbish|refuse"], opt: ["removal", "haul", "remove", "dispose"] }]),
  // windows
  S("win_balance", "Windows", "Window balance", ["window balance", "balance", "balances", "window balances", "sash balance"], [{ req: ["balance"], opt: ["window", "sash", "replace"] }]),
  S("win_guard", "Windows", "Window guard", ["window guard", "guard", "guards", "window guards", "child guard"], [{ req: ["guard"], opt: ["window", "child", "install"] }]),
  S("win_lock", "Windows", "Window lock", ["window lock", "sash lock", "window latch"], [{ req: ["lock|latch"], opt: ["window", "sash"] }]),
  S("win_shade", "Windows", "Window shade", ["shade", "shades", "window shade", "window shades", "blind"], [{ req: ["shade|blind"], opt: ["window", "roller"] }]),
  S("win_screen", "Windows", "Window screen", ["screen", "screens", "window screen"], [{ req: ["screen"], opt: ["window", "insect"] }]),
  // doors and hardware
  S("lock_passage", "Doors", "Passage lock", ["passage lock", "passage", "passage lockset", "passage set", "passage knob"], [{ req: ["passage"], opt: ["lock", "lockset", "set", "knob"], not: ["privacy"] }]),
  S("lock_privacy", "Doors", "Privacy lock", ["privacy lock", "privacy", "privacy lockset", "bathroom lock", "bedroom lock"], [{ req: ["privacy"], opt: ["lock", "lockset", "set"], not: ["passage"] }]),
  S("lock_entrance", "Doors", "Entrance lock / deadbolt", ["entrance lock", "entry lock", "deadbolt", "dead bolt", "front door lock", "apartment lock"], [{ req: ["deadbolt|lock|lockset"], opt: ["entrance", "entry", "dead", "bolt", "apartment", "door"], not: ["passage", "privacy", "window", "mailbox", "cylinder", "sash"] }]),
  S("cylinder", "Doors", "Lock cylinder / re-key", ["cylinder", "rekey", "re key", "change cylinder", "keys"], [{ req: ["cylinder|rekey|key"], opt: ["change", "replace", "lock"] }]),
  S("door_interior", "Doors", "Interior door", ["interior door", "room door", "bedroom door", "door", "doors"], [{ req: ["door"], opt: ["interior", "hollow", "core", "replace", "install", "room"] }]),
  S("door_closet", "Doors", "Closet door", ["closet door", "closet doors", "bifold"], [{ req: ["door"], opt: ["closet", "bifold", "bi-fold"] }]),
  S("door_entrance", "Doors", "Entrance door", ["entrance door", "entry door", "front door", "apartment door", "metal door"], [{ req: ["door"], opt: ["entrance", "entry", "apartment", "metal", "steel", "fire"] }]),
  S("door_stop", "Doors", "Door stop", ["door stop", "doorstop", "stops", "door stops"], [{ req: ["stop"], opt: ["door", "wall", "floor"] }]),
  S("door_hinge", "Doors", "Door hinge", ["hinge", "hinges", "door hinge"], [{ req: ["hinge"], opt: ["door", "butt"] }]),
  S("saddle", "Doors", "Saddle / threshold", ["saddle", "saddles", "threshold", "door saddle"], [{ req: ["saddle|threshold"], opt: ["door", "marble", "metal"] }]),
  S("peephole", "Doors", "Peephole", ["peephole", "peep hole", "viewer", "door viewer"], [{ req: ["peephole|viewer|peep"], opt: ["door"] }]),
  S("door_chain", "Doors", "Door chain / guard", ["door chain", "chain", "chain guard", "door guard"], [{ req: ["chain"], opt: ["door", "guard"] }]),
  S("closet_shelf", "Doors", "Closet shelf and pole", ["closet shelf", "shelf and pole", "shelf", "closet pole", "pole"], [{ req: ["shelf|pole"], opt: ["closet", "clothes", "rod"] }]),
  // electrical
  S("gfi", "Electrical", "GFI outlet", ["gfi", "gfci", "gfi outlet", "gfci outlet", "gfi receptacle", "ground fault"], [{ req: ["gfci|gfi|ground fault"], opt: ["receptacle", "outlet"] }]),
  S("outlet_single", "Electrical", "Outlet — single", ["single outlet", "outlet single", "single", "single receptacle", "simplex"], [{ req: ["receptacle|outlet"], opt: ["single", "simplex"], not: ["gfci", "gfi", "duplex", "plate", "cover", "220", "range", "dryer"] }]),
  S("outlet_double", "Electrical", "Outlet — double (duplex)", ["double outlet", "outlet double", "double", "duplex", "duplex receptacle", "duplex outlet"], [{ req: ["receptacle|outlet"], opt: ["duplex", "double"], not: ["gfci", "gfi", "single", "plate", "cover", "220", "range", "dryer"] }]),
  S("cover_1", "Electrical", "Outlet / switch cover — 1 gang", ["outlet cover", "cover", "cover plate", "plate", "one outlet cover", "single cover", "1 gang cover", "switch cover"], [{ req: ["plate|cover"], opt: ["1", "one", "single", "gang", "receptacle", "outlet", "switch", "wall"], not: ["2", "two", "double", "radiator", "window", "manhole", "floor"] }]),
  S("cover_2", "Electrical", "Outlet / switch cover — 2 gang", ["two outlet cover", "outlet two outlet cover", "double cover", "2 gang cover", "two gang cover", "double outlet cover", "2 gang plate"], [{ req: ["plate|cover"], opt: ["2", "two", "double", "gang", "duplex"], not: ["1", "one", "single", "radiator", "window", "manhole", "floor"] }]),
  S("switch", "Electrical", "Switch", ["switch", "switches", "light switch", "toggle switch", "wall switch"], [{ req: ["switch"], opt: ["toggle", "single", "pole", "wall", "light"], not: ["plate", "cover", "dimmer", "3 way", "three way"] }]),
  S("light_pancake", "Electrical", "Ceiling light (pancake)", ["pancake", "pancake light", "pancake fixture", "ceiling light", "ceiling fixture", "flush mount"], [{ req: ["fixture|light"], opt: ["ceiling", "pancake", "surface", "flush", "mount", "round"], not: [...NOT_FIXTURE, "kitchen", "bathroom", "wall", "exit", "emergency"] }]),
  S("light_wall", "Electrical", "Wall light", ["wall light", "wall lights", "wall fixture", "sconce", "wall sconce"], [{ req: ["fixture|light|sconce"], opt: ["wall", "sconce", "bracket"], not: [...NOT_FIXTURE, "kitchen", "bathroom", "ceiling"] }]),
  S("light_kitchen", "Electrical", "Kitchen light", ["kitchen light", "kitchen fixture", "kitchen ceiling light"], [{ req: ["fixture|light"], opt: ["kitchen"], not: NOT_FIXTURE }]),
  S("light_bath", "Electrical", "Bathroom light", ["bathroom light", "bath light", "bathroom fixture", "vanity light", "bathroom ceiling light"], [{ req: ["fixture|light"], opt: ["bathroom", "bath", "vanity"], not: [...NOT_FIXTURE, "kitchen"] }]),
  S("smoke_wired", "Electrical", "Smoke detector — hardwired", ["wire smoke", "wired smoke", "hardwired smoke", "hard wired smoke", "hardwire smoke", "smoke wired", "smoke detector wired", "wire"], [{ req: ["smoke"], opt: ["hardwired", "hard", "wired", "wire", "120", "ac", "interconnect"], not: ["battery operated", "carbon", "monoxide"] }]),
  S("smoke_battery", "Electrical", "Smoke detector — battery", ["battery", "battery smoke", "smoke battery", "battery detector", "battery smoke detector", "smoke detector battery"], [{ req: ["smoke|detector"], opt: ["battery", "9v", "operated"], not: ["hardwired", "hard wired", "120", "carbon", "monoxide"] }]),
  S("co", "Electrical", "CO detector", ["co", "co detector", "carbon monoxide", "carbon monoxide detector"], [{ req: ["carbon|monoxide"], opt: ["detector", "alarm"], not: ["smoke", "combination"] }]),
  S("smoke_co", "Electrical", "Smoke / CO combo detector", ["combo", "combo detector", "smoke co", "smoke and co", "smoke/co"], [{ req: ["smoke"], opt: ["carbon", "monoxide", "co", "combination", "combo"] }]),
  S("intercom", "Electrical", "Intercom", ["intercom", "buzzer", "intercom station"], [{ req: ["intercom"], opt: ["station", "apartment", "buzzer"] }]),
  S("doorbell", "Electrical", "Doorbell", ["doorbell", "door bell", "bell", "chime"], [{ req: ["bell|chime"], opt: ["door", "button"] }]),
  S("exhaust_fan", "Electrical", "Exhaust fan", ["exhaust fan", "fan", "bathroom fan", "vent fan"], [{ req: ["fan"], opt: ["exhaust", "bathroom", "vent"] }]),
  // kitchen
  S("kitchen_plumbing", "Kitchen", "Kitchen plumbing (faucet)", ["kitchen plumbing", "kitchen faucet", "kitchen sink plumbing", "kitchen sink faucet", "faucet kitchen"], [{ req: ["faucet"], opt: ["kitchen", "sink", "replace"], not: ["lavatory", "lav", "bathroom", "bath", "tub", "shower"] }]),
  S("kitchen_sink", "Kitchen", "Kitchen sink", ["kitchen sink", "sink kitchen"], [{ req: ["sink"], opt: ["kitchen", "stainless", "replace"] }]),
  S("kitchen_trap", "Kitchen", "Kitchen trap / supplies", ["trap", "p trap", "supply lines", "supplies", "kitchen trap"], [{ req: ["trap|supply"], opt: ["kitchen", "sink", "p-trap", "line"] }]),
  S("cabinet_base", "Kitchen", "Base cabinet", ["base cabinet", "base cabinets", "lower cabinet", "sink cabinet"], [{ req: ["cabinet"], opt: ["base", "lower", "sink"] }]),
  S("cabinet_wall", "Kitchen", "Wall cabinet", ["wall cabinet", "wall cabinets", "upper cabinet", "upper cabinets"], [{ req: ["cabinet"], opt: ["wall", "upper"] }]),
  S("countertop", "Kitchen", "Countertop", ["countertop", "counter top", "counter", "laminate top"], [{ req: ["countertop|counter"], opt: ["top", "laminate", "kitchen"] }]),
  S("stove", "Kitchen", "Stove / range", ["stove", "range", "gas stove", "gas range"], [{ req: ["stove|range"], opt: ["gas", "kitchen", "install", "connect"] }]),
  S("range_hood", "Kitchen", "Range hood", ["range hood", "hood", "stove hood"], [{ req: ["hood"], opt: ["range", "stove", "kitchen"] }]),
  S("refrigerator", "Kitchen", "Refrigerator", ["refrigerator", "fridge"], [{ req: ["refrigerator"], opt: ["install", "deliver"] }]),
  // bathroom
  S("medicine_cabinet", "Bathroom", "Medicine cabinet", ["medicine cabinet", "medicine", "med cabinet", "mirror cabinet"], [{ req: ["medicine"], opt: ["cabinet", "mirror"], not: ["door", "shelf", "glass"] }]),
  S("toilet", "Bathroom", "Toilet", ["toilet", "water closet", "wc", "toilet bowl", "toilet and tank"], [{ req: ["toilet|water closet|closet"], opt: ["bowl", "tank", "complete", "replace", "install"], not: ["paper", "seat", "holder", "tissue", "flange", "supply"] }]),
  S("toilet_seat", "Bathroom", "Toilet seat", ["toilet seat", "seat"], [{ req: ["seat"], opt: ["toilet", "closet"], not: ["paper", "holder"] }]),
  S("shower_head", "Bathroom", "Shower head", ["shower head", "showerhead", "shower"], [{ req: ["shower"], opt: ["head", "replace"], not: ["rod", "valve", "body", "curtain", "door", "diverter", "arm"] }]),
  S("shower_rod", "Bathroom", "Shower rod", ["shower rod", "curtain rod", "rod"], [{ req: ["rod"], opt: ["shower", "curtain"], not: ["closet", "clothes"] }]),
  S("bath_accessories", "Bathroom", "Bathroom accessories (towel bar, paper holder, soap dish)", ["bathroom accessories", "accessories", "bath accessories", "bathroom accessory", "towel bar paper holder soap dish"],
    [{ req: ["towel"], opt: ["bar", "holder"], not: ["ring"] }, { req: ["paper|tissue"], opt: ["holder", "toilet"] }, { req: ["soap"], opt: ["dish", "holder"] }]),
  S("towel_bar", "Bathroom", "Towel bar", ["towel bar", "towel rack"], [{ req: ["towel"], opt: ["bar", "holder"] }]),
  S("paper_holder", "Bathroom", "Toilet paper holder", ["paper holder", "toilet paper holder", "tissue holder"], [{ req: ["paper|tissue"], opt: ["holder", "toilet"] }]),
  S("soap_dish", "Bathroom", "Soap dish", ["soap dish", "soap holder"], [{ req: ["soap"], opt: ["dish", "holder"] }]),
  S("grab_bar", "Bathroom", "Grab bar", ["grab bar", "grab bars", "safety bar"], [{ req: ["grab"], opt: ["bar", "safety"] }]),
  S("bath_faucet", "Bathroom", "Bathroom sink faucet", ["bathroom faucet", "bathroom plumbing", "lav faucet", "lavatory faucet", "sink faucet", "basin faucet"], [{ req: ["faucet"], opt: ["lavatory", "lav", "bathroom", "bath", "basin"], not: ["kitchen", "tub", "shower"] }]),
  S("tub_faucet", "Bathroom", "Tub / shower valve", ["tub faucet", "shower valve", "tub valve", "tub spout", "shower body", "diverter"], [{ req: ["tub|shower|bath"], opt: ["valve", "spout", "faucet", "diverter", "body", "mixing"] }]),
  S("reglaze_both", "Bathroom", "Reglaze tub and sink", ["reglaze tub and sink", "reglaze", "reglazing", "tub and sink reglaze", "reglaze tub sink", "glaze tub and sink"],
    [{ req: ["reglaz|glaz|refinish"], opt: ["tub", "bathtub", "bath"], not: ["sink", "lavatory", "basin", "tile", "wall"] }, { req: ["reglaz|glaz|refinish"], opt: ["sink", "lavatory", "basin", "lav"], not: ["tub", "bathtub", "tile", "wall"] }]),
  S("reglaze_tub", "Bathroom", "Reglaze tub", ["reglaze tub", "tub reglaze", "glaze tub", "reglaze bathtub", "tub"], [{ req: ["reglaz|glaz|refinish"], opt: ["tub", "bathtub", "bath"], not: ["sink", "lavatory", "basin", "tile", "wall"] }]),
  S("reglaze_sink", "Bathroom", "Reglaze sink", ["reglaze sink", "sink reglaze", "glaze sink", "reglaze lavatory"], [{ req: ["reglaz|glaz|refinish"], opt: ["sink", "lavatory", "basin", "lav"], not: ["tub", "bathtub", "tile", "wall"] }]),
  S("lav_sink", "Bathroom", "Bathroom sink (lavatory)", ["bathroom sink", "lavatory", "lav", "lav sink", "basin"], [{ req: ["lavatory|sink|basin"], opt: ["bathroom", "bath", "wall", "hung", "replace"] }]),
  S("bath_tile_wall", "Bathroom", "Bathroom wall tile", ["wall tile", "bathroom tile", "bath tile", "ceramic tile"], [{ req: ["tile"], opt: ["wall", "ceramic", "bathroom", "bath"] }]),
  S("bath_tile_floor", "Bathroom", "Bathroom floor tile", ["bathroom floor tile", "bath floor", "floor tile bathroom"], [{ req: ["tile"], opt: ["floor", "ceramic", "bathroom", "bath"] }]),
  // walls, ceilings, floors
  S("plaster", "Walls & floors", "Plaster patch", ["plaster", "plaster patch", "patch", "skim", "skim coat", "plastering"], [{ req: ["plaster"], opt: ["patch", "repair", "skim", "wall", "ceiling"] }]),
  S("sheetrock", "Walls & floors", "Sheetrock patch", ["sheetrock", "drywall", "sheetrock patch", "gypsum"], [{ req: ["sheetrock|drywall|gypsum"], opt: ["patch", "repair", "replace"] }]),
  S("paint_room", "Walls & floors", "Paint room", ["paint room", "paint", "painting", "room paint"], [{ req: ["paint"], opt: ["room", "walls", "ceiling", "per"], not: ["apartment", "apt", "bedroom", "studio", "door", "radiator", "cabinet"] }]),
  S("floor_tile", "Walls & floors", "Floor tile (VCT)", ["floor tile", "vct", "tile floor", "vinyl tile", "floor tiles"], [{ req: ["tile|vct"], opt: ["floor", "vct", "vinyl", "composition"] }]),
  S("cove_base", "Walls & floors", "Cove base / baseboard", ["cove base", "base", "baseboard", "base molding", "vinyl base"], [{ req: ["base|baseboard"], opt: ["cove", "vinyl", "molding", "rubber"] }]),
  S("window_sill", "Walls & floors", "Window sill", ["sill", "window sill", "sills"], [{ req: ["sill"], opt: ["window", "marble", "replace"] }]),
  S("radiator_cover", "Walls & floors", "Radiator cover", ["radiator cover", "radiator covers", "rad cover"], [{ req: ["radiator"], opt: ["cover", "enclosure"] }]),
  S("radiator_valve", "Walls & floors", "Radiator valve", ["radiator valve", "steam valve", "valve"], [{ req: ["valve"], opt: ["radiator", "steam", "air"] }]),
  S("mailbox", "Doors", "Mailbox lock", ["mailbox", "mailbox lock", "mail box"], [{ req: ["mailbox|mail"], opt: ["lock", "box"] }]),
];

// ---- words ----
const STOP = new Set(["and", "the", "a", "an", "of", "x", "ea", "each", "pcs", "pc", "qty", "for", "to", "in", "with", "new", "replace", "install", "furnish", "per", "&"]);
const singular = (w: string) => {
  if (w.length <= 3) return w;
  if (/ies$/.test(w)) return w.replace(/ies$/, "y");
  if (/(ches|shes|sses|xes)$/.test(w)) return w.replace(/es$/, "");
  if (/s$/.test(w) && !/ss$/.test(w)) return w.replace(/s$/, "");
  return w;
};
// "Window balances" → ["window", "balance"]; digits stay (a "2 gang" cover)
export const words = (s: string): string[] =>
  (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter((w) => w && !STOP.has(w)).map(singular);
export const normLabel = (s: string) => words(s).join(" ");
// two words are the same thing when one is the other, or one sits inside the other ("wire" in "hardwired")
const sameWord = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a)));
const overlap = (a: string[], b: string[]) => a.filter((w) => b.some((v) => sameWord(w, v))).length;

// the survey line's words against every alias: 1 for a word-for-word match,
// else the share of the alias the line covers (with a penalty for extra words)
export function matchItem(label: string, items: TemplateItem[]): { item?: TemplateItem; score: number } {
  const lw = words(label);
  if (lw.length === 0) return { score: 0 };
  let best: { item?: TemplateItem; score: number } = { score: 0 };
  for (const it of items) {
    if (it.skip) continue;
    for (const alias of [it.label, ...it.aliases]) {
      const aw = words(alias);
      if (aw.length === 0) continue;
      const exact = aw.length === lw.length && aw.every((w) => lw.includes(w));
      const hit = overlap(aw, lw);
      const score = exact ? 1 : hit === 0 ? 0 : (hit / aw.length) * (hit / Math.max(hit, lw.length)) * 0.95;
      if (score > best.score) best = { item: it, score };
    }
  }
  return best;
}

// ---- proposing lines from a price book (the one-time set-up) ----
// a keyword is one word, or a phrase whose words all appear; "a|b" is either
const hasWord = (desc: string[], kw: string) => kw.split("|").some((k) => words(k).every((kk) => desc.some((w) => sameWord(w, kk))));
export function proposeLine(spec: FindSpec, catalog: CatalogLine[]): { line: CatalogLine; score: number }[] {
  const out: { line: CatalogLine; score: number }[] = [];
  for (const c of catalog) {
    const desc = words(`${c.description} ${c.category}`);
    if (!spec.req.every((k) => hasWord(desc, k))) continue;
    if ((spec.not || []).some((k) => hasWord(desc, k))) continue;
    const opt = (spec.opt || []).filter((k) => hasWord(desc, k)).length;
    // shorter descriptions that carry the words are the plainer match
    out.push({ line: c, score: 2 * spec.req.length + opt - Math.min(desc.length, 20) / 40 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}
// a fresh template for a contract: every seed item, each with its best-scoring
// line where the book has one (the owner checks the list once)
export function proposeTemplate(contractId: string, catalog: CatalogLine[]): SurveyTemplate {
  const items: TemplateItem[] = SEED_ITEMS.map((s) => ({
    ...s,
    lines: s.find.map((f) => { const p = proposeLine(f, catalog)[0]; return p ? { code: p.line.code, per: f.per ?? 1 } : null; }).filter((x): x is TemplateLine => !!x),
  }));
  return { version: 1, contractId, name: "Move-out", cap: DEFAULT_CAP, items };
}

// ---- the survey text ----
export interface ParsedLine { raw: string; label: string; qty: number; itemKey?: string; score: number; note?: string }
export interface ParsedSurvey { address: string; apt: string; kind: string; bedrooms?: number; lines: ParsedLine[] }

const NUM = "(\\d+(?:\\.\\d+)?)";
const APT = /^(?:apt\.?\s*)?(\d{1,3}[a-z]{0,2}|[a-z]\d{1,3}[a-z]?|ph\d*)$/i;
const KIND = /^(mo|mi|m\.o\.|m\.i\.|move ?-?out|move ?-?in|vacant|vacancy)$/i;
const kindName = (k: string) => (/^(mi|m\.i\.|move ?-?in)$/i.test(k) ? "Move-in" : /^(mo|m\.o\.|move ?-?out|vacant|vacancy)$/i.test(k) ? "Move-out" : k);

// "390 sutter 11A MO" → address, apt, kind. Anything that isn't that shape is not a header.
export function parseHeader(line: string): { address: string; apt: string; kind: string } | null {
  const toks = line.trim().split(/\s+/);
  if (toks.length < 2 || !/^\d+(?:-\d+)?[a-z]?$/i.test(toks[0])) return null; // "390", "21-10"
  let kind = "";
  const two = toks.slice(-2).join(" ");
  if (toks.length >= 3 && KIND.test(two)) { kind = kindName(two); toks.splice(-2, 2); }
  else if (KIND.test(toks[toks.length - 1])) kind = kindName(toks.pop()!);
  let apt = "";
  if (toks.length >= 3 && APT.test(toks[toks.length - 1].replace(/^#/, ""))) {
    apt = toks.pop()!.replace(/^#/, "").replace(/^apt\.?\s*/i, "").toUpperCase();
    if (toks.length >= 3 && /^(apt\.?|apartment|unit|#)$/i.test(toks[toks.length - 1])) toks.pop();
  }
  if (toks.length < 2 || !/[a-z]/i.test(toks.slice(1).join(" "))) return null; // a street needs a name
  const address = toks.map((t, i) => (i === 0 ? t : t.charAt(0).toUpperCase() + t.slice(1))).join(" ");
  return { address, apt, kind };
}

// one line of counts: "Outlet: 1 single 7 double 1 two outlet cover" → [1 single, 7 double, 1 two outlet cover]
function pairsOf(text: string): { qty: number; label: string }[] | null {
  const re = new RegExp(`${NUM}\\s+([^\\d]+?)(?=\\s+\\d|$)`, "g");
  const out: { qty: number; label: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ qty: parseFloat(m[1]), label: m[2].trim() });
  return out.length >= 2 ? out : null;
}

export function parseSurvey(text: string, items: TemplateItem[]): ParsedSurvey {
  const out: ParsedSurvey = { address: "", apt: "", kind: "", lines: [] };
  const raw = (text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const push = (rawLine: string, label: string, qty: number, prefix = "") => {
    // with a prefix ("Outlet:") try the prefixed wording first, then the bare one
    const tries = prefix ? [`${prefix} ${label}`, label] : [label];
    let best: { item?: TemplateItem; score: number } = { score: 0 };
    for (const t of tries) { const m = matchItem(t, items); if (m.score > best.score) best = m; }
    out.lines.push({ raw: rawLine, label: prefix ? `${prefix} ${label}` : label, qty, itemKey: best.score >= 0.6 ? best.item?.key : undefined, score: best.score });
  };
  raw.forEach((line, i) => {
    if (/^#/.test(line) || /<[^>]*>/.test(line)) return; // a group heading or an unfilled placeholder from the blank survey
    if (i === 0) { const h = parseHeader(line); if (h) { Object.assign(out, h); return; } }
    // "2 bedroom" — the size, and an item when the book prices whole apartments
    const br = /^(\d)\s*(?:bed ?rooms?|br|bd)\b/i.exec(line) || /^(studio)$/i.exec(line);
    if (br) { out.bedrooms = br[1].toLowerCase() === "studio" ? 0 : parseInt(br[1], 10); push(line, line, 1); return; }
    // "Label: 28" / "Label: 1 single 7 double …"
    const colon = /^([^:]+):\s*(.*)$/.exec(line);
    if (colon) {
      const prefix = colon[1].trim(), rest = colon[2].trim();
      if (!rest) return; // a blank line on the filled-in survey — not on this job
      if (new RegExp(`^${NUM}$`).test(rest)) { push(line, prefix, parseFloat(rest)); return; }
      const pairs = pairsOf(rest);
      if (pairs) { pairs.forEach((p) => push(line, p.label, p.qty, prefix)); return; }
      push(line, `${prefix} ${rest}`, 1); return;
    }
    const pairs = pairsOf(line);
    if (pairs) { pairs.forEach((p) => push(line, p.label, p.qty)); return; }
    let m = new RegExp(`^${NUM}\\s+(.+)$`).exec(line);
    if (m) { push(line, m[2], parseFloat(m[1])); return; }
    m = new RegExp(`^(.+?)\\s+${NUM}$`).exec(line);
    if (m) { push(line, m[1], parseFloat(m[2])); return; }
    push(line, line, 1);
  });
  return out;
}

// ---- from counts to contract lines ----
export interface SheetLine { code: string; qty: number; unit_price: number; description: string; itemKey: string; label: string; uom: string; line: number }
export function buildLines(parsed: ParsedSurvey, items: TemplateItem[], catalog: CatalogLine[]): { lines: SheetLine[]; unmatched: ParsedLine[]; unmapped: TemplateItem[]; twice: string[] } {
  const byCode = new Map(catalog.map((c) => [c.code, c]));
  const count = new Map<string, number>();
  const seen = new Map<string, number>();
  const unmatched: ParsedLine[] = [];
  for (const l of parsed.lines) {
    if (!l.itemKey) { if (l.qty > 0) unmatched.push(l); continue; }
    if (l.qty <= 0) continue;
    count.set(l.itemKey, (count.get(l.itemKey) || 0) + l.qty);
    seen.set(l.itemKey, (seen.get(l.itemKey) || 0) + 1);
  }
  const lines: SheetLine[] = [];
  const unmapped: TemplateItem[] = [];
  const twice: string[] = [];
  for (const it of items) {
    const n = count.get(it.key);
    if (!n) continue;
    if ((seen.get(it.key) || 0) > 1) twice.push(it.label);
    const real = it.lines.filter((tl) => byCode.has(tl.code));
    if (real.length === 0) { unmapped.push(it); continue; }
    for (const tl of real) {
      const c = byCode.get(tl.code)!;
      const at = lines.find((x) => x.code === c.code);
      const add = n * (tl.per || 1);
      if (at) at.qty += add;
      else lines.push({ code: c.code, qty: add, unit_price: Number(c.unit_price) || 0, description: c.description, itemKey: it.key, label: it.label, uom: c.uom, line: c.line });
    }
  }
  return { lines, unmatched, unmapped, twice };
}
export const sheetTotal = (lines: { qty: number; unit_price: number }[]) =>
  Math.round(lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_price) || 0), 0) * 100) / 100;

// Keep the first sheet under the cap: whole items come off the bottom of the
// template's order (the last things on the list are the first to wait) until
// what's left fits. Nothing is trimmed to a fraction — a count is a count.
export function splitToCap(lines: SheetLine[], cap: number, order: string[]): { first: SheetLine[]; rest: SheetLine[] } {
  if (!(cap > 0) || sheetTotal(lines) <= cap) return { first: lines, rest: [] };
  const rank = (k: string) => { const i = order.indexOf(k); return i < 0 ? order.length : i; };
  const keys = [...new Set(lines.map((l) => l.itemKey))].sort((a, b) => rank(b) - rank(a)); // last first
  const moved = new Set<string>();
  for (const k of keys) {
    if (sheetTotal(lines.filter((l) => !moved.has(l.itemKey))) <= cap) break;
    moved.add(k);
  }
  return { first: lines.filter((l) => !moved.has(l.itemKey)), rest: lines.filter((l) => moved.has(l.itemKey)) };
}

// the blank survey the crew fills in on site, one line per item with a colon
// to type the count after — grouped, only the items the template bills
export function blankSurvey(items: TemplateItem[]): string {
  const out: string[] = ["<address> <apt> MO", "<n> bedroom", ""];
  let group = "";
  for (const it of items) {
    if (it.skip || it.lines.length === 0) continue;
    if (it.key.startsWith("apt_")) continue; // the size line above covers these
    if (it.group !== group) { group = it.group; out.push(`# ${group}`); }
    out.push(`${it.label.replace(/\s*\(.*\)$/, "")}: `);
  }
  return out.join("\n");
}
