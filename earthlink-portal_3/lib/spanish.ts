// The work line in Spanish. The PO's wording is the partner's English; a
// worker who reads Spanish gets the whole text in Spanish, the work
// included. Claude translates it on the server (the same key the PO reader
// uses); when Claude can't — no key, no signal, a slow answer — a built-in
// construction glossary stands in, so the text never goes out half in English.
import { sb } from "./supabase";

// ---- the glossary: the words on partner POs, the way a foreman in Brooklyn says them ----
// longer phrases first, so "scrape plaster paint" is read as one thing
const PHRASES: [string, string][] = [
  ["scrape plaster and paint", "raspar, resanar y pintar"],
  ["scrape plaster paint", "raspar, resanar y pintar"],
  ["scrape and plaster", "raspar y resanar"],
  ["scrape plaster", "raspar y resanar"],
  ["plaster and paint", "resanar y pintar"],
  ["plaster & paint", "resanar y pintar"],
  ["plaster paint", "resanar y pintar"],
  ["patch and paint", "parchar y pintar"],
  ["patch paint", "parchar y pintar"],
  ["prime and paint", "imprimar y pintar"],
  ["prime paint", "imprimar y pintar"],
  ["sand and paint", "lijar y pintar"],
  ["compound and paint", "aplicar compuesto y pintar"],
  ["skim coat", "capa fina de compuesto"],
  ["skim", "capa fina"],
  ["wall cracking", "grietas en la pared"],
  ["ceiling cracking", "grietas en el techo"],
  ["cracking", "grietas"],
  ["water damage", "daño por agua"],
  ["water stain", "mancha de agua"],
  ["water stains", "manchas de agua"],
  ["touch up", "retoque"],
  ["touch-up", "retoque"],
  ["touchup", "retoque"],
  ["touch ups", "retoques"],
  ["move-out", "move-out"],
  ["move out", "move-out"],
  ["moveout", "move-out"],
  ["as needed", "según haga falta"],
  ["where needed", "donde haga falta"],
  ["as per", "según"],
  ["to match existing", "igual al existente"],
  ["match existing", "igual al existente"],
  ["the entire apartment", "todo el apartamento"],
  ["the whole apartment", "todo el apartamento"],
  ["entire apartment", "todo el apartamento"],
  ["whole apartment", "todo el apartamento"],
  ["the entire", "todo el"],
  ["the whole", "todo el"],
  ["master bedroom", "recámara principal"],
  ["living room", "sala"],
  ["dining room", "comedor"],
  ["laundry room", "cuarto de lavado"],
  ["utility room", "cuarto de servicio"],
  ["door frame", "marco de la puerta"],
  ["door frames", "marcos de las puertas"],
  ["window sill", "repisa de la ventana"],
  ["window sills", "repisas de las ventanas"],
  ["window frame", "marco de la ventana"],
  ["closet door", "puerta del clóset"],
  ["closet doors", "puertas del clóset"],
  ["cove base", "zoclo de vinil"],
  ["base board", "zoclo"],
  ["kitchen sink", "fregadero"],
  ["bathroom sink", "lavabo"],
  ["kitchen cabinet", "gabinete de cocina"],
  ["kitchen cabinets", "gabinetes de cocina"],
  ["medicine cabinet", "botiquín"],
  ["shower head", "regadera"],
  ["shower rod", "barra de la cortina"],
  ["shower curtain", "cortina de baño"],
  ["toilet seat", "asiento del inodoro"],
  ["light fixture", "lámpara"],
  ["light fixtures", "lámparas"],
  ["smoke detector", "detector de humo"],
  ["smoke detectors", "detectores de humo"],
  ["carbon monoxide detector", "detector de monóxido"],
  ["drop cloth", "lona"],
  ["drop cloths", "lonas"],
  ["sheet rock", "tablaroca"],
  ["joint compound", "compuesto"],
  ["prep work", "preparación"],
  ["two coats", "dos manos"],
  ["three coats", "tres manos"],
  ["one coat", "una mano"],
  ["2 coats", "2 manos"],
  ["3 coats", "3 manos"],
  ["1 coat", "1 mano"],
  ["sq ft", "pies cuadrados"],
  ["sq. ft.", "pies cuadrados"],
  ["sqft", "pies cuadrados"],
  ["square feet", "pies cuadrados"],
  ["lin ft", "pies lineales"],
  ["linear feet", "pies lineales"],
  ["next to", "junto a"],
  ["the kitchen", "la cocina"],
  ["the bathroom", "el baño"],
  ["the bedroom", "la recámara"],
  ["the bedrooms", "las recámaras"],
  ["the hallway", "el pasillo"],
  ["the closet", "el clóset"],
  ["the ceiling", "el techo"],
  ["the ceilings", "los techos"],
  ["the wall", "la pared"],
  ["the walls", "las paredes"],
  ["the floor", "el piso"],
  ["the floors", "los pisos"],
  ["the door", "la puerta"],
  ["the doors", "las puertas"],
  ["the window", "la ventana"],
  ["the windows", "las ventanas"],
  ["the apartment", "el apartamento"],
  ["the unit", "la unidad"],
  ["the tub", "la tina"],
  ["the toilet", "el inodoro"],
  ["the sink", "el lavabo"],
  ["the tenant", "el inquilino"],
  ["the super", "el súper"],
];
const WORDS: Record<string, string> = {
  // rooms and places
  bedroom: "recámara", bedrooms: "recámaras", bdrm: "recámara", bathroom: "baño", bathrooms: "baños", bath: "baño",
  kitchen: "cocina", hallway: "pasillo", hall: "pasillo", foyer: "entrada", entry: "entrada", entrance: "entrada",
  closet: "clóset", closets: "clósets", basement: "sótano", stairs: "escaleras", staircase: "escaleras", stairwell: "escaleras",
  lobby: "lobby", apartment: "apartamento", apt: "apto", unit: "unidad", room: "cuarto", rooms: "cuartos", roof: "azotea",
  building: "edificio", exterior: "exterior", interior: "interior", inside: "adentro", outside: "afuera",
  // parts
  wall: "pared", walls: "paredes", ceiling: "techo", ceilings: "techos", floor: "piso", floors: "pisos",
  door: "puerta", doors: "puertas", window: "ventana", windows: "ventanas", trim: "moldura", molding: "moldura", moulding: "moldura",
  baseboard: "zoclo", baseboards: "zoclos", tile: "azulejo", tiles: "azulejos", sheetrock: "tablaroca", drywall: "tablaroca",
  cabinet: "gabinete", cabinets: "gabinetes", countertop: "cubierta", countertops: "cubiertas", counter: "cubierta",
  sink: "lavabo", tub: "tina", bathtub: "tina", shower: "regadera", toilet: "inodoro", faucet: "llave", faucets: "llaves",
  mirror: "espejo", vanity: "mueble de baño", light: "luz", lights: "luces", fixture: "lámpara", fixtures: "lámparas",
  outlet: "tomacorriente", outlets: "tomacorrientes", switch: "interruptor", switches: "interruptores",
  radiator: "radiador", radiators: "radiadores", pipe: "tubo", pipes: "tubos", lock: "cerradura", locks: "cerraduras",
  hinge: "bisagra", hinges: "bisagras", handle: "manija", handles: "manijas", knob: "perilla", knobs: "perillas",
  screen: "mosquitero", screens: "mosquiteros", shelf: "repisa", shelves: "repisas", stove: "estufa", refrigerator: "refrigerador", fridge: "refrigerador",
  peephole: "mirilla", threshold: "umbral", carpet: "alfombra", vinyl: "vinil", wood: "madera", glass: "vidrio", metal: "metal",
  frame: "marco", frames: "marcos", corner: "esquina", corners: "esquinas", edge: "borde", edges: "bordes", surface: "superficie",
  area: "área", areas: "áreas", spot: "punto", spots: "puntos", section: "sección", sections: "secciones", side: "lado", sides: "lados",
  hole: "hoyo", holes: "hoyos", crack: "grieta", cracks: "grietas", leak: "fuga", leaks: "fugas", mold: "moho", stain: "mancha", stains: "manchas",
  damage: "daño", damaged: "dañado", broken: "roto", loose: "suelto", missing: "faltante", peeling: "descarapelado", rotted: "podrido",
  wet: "mojado", dry: "seco", old: "viejo", new: "nuevo", small: "pequeño", large: "grande", big: "grande",
  // the work
  plaster: "resanar", plastering: "resanado", plastered: "resanado", paint: "pintar", painting: "pintura", painted: "pintado",
  scrape: "raspar", scraping: "raspado", scraped: "raspado", sand: "lijar", sanding: "lijado", prime: "imprimar", primer: "imprimador",
  patch: "parchar", patching: "parchado", compound: "compuesto", spackle: "masilla", spackling: "masilla",
  repair: "reparar", repairs: "reparaciones", fix: "arreglar", replace: "cambiar", replacement: "cambio", install: "instalar", installation: "instalación",
  remove: "quitar", removal: "retiro", demo: "demoler", demolish: "demoler", clean: "limpiar", cleaning: "limpieza", caulk: "sellar con silicón",
  caulking: "sellado con silicón", seal: "sellar", grout: "lechada", hang: "colgar", adjust: "ajustar", level: "nivelar", tape: "encintar",
  cut: "cortar", prep: "preparar", prepare: "preparar", finish: "acabado", finishing: "acabado", coat: "mano", coats: "manos",
  check: "revisar", inspect: "revisar", test: "probar", measure: "medir", verify: "verificar", cover: "cubrir", protect: "proteger",
  deliver: "entregar", bring: "traer", supply: "suministrar", materials: "materiales", material: "material", tools: "herramientas",
  ladder: "escalera", furniture: "muebles", tenant: "inquilino", super: "súper", key: "llave", keys: "llaves", access: "acceso",
  work: "trabajo", job: "trabajo", labor: "mano de obra", laborer: "obrero", hours: "horas", hour: "hora", hrs: "horas", hr: "hora",
  days: "días", day: "día", each: "cada uno", ea: "cada uno", per: "por",
  // small words
  and: "y", with: "con", in: "en", on: "en", at: "en", of: "de", for: "para", to: "a", from: "de", the: "", a: "", an: "",
  all: "todo", full: "completo", complete: "completo", entire: "todo", whole: "todo", only: "solo", also: "también", then: "luego",
  after: "después de", before: "antes de", same: "mismo", other: "otro", both: "ambos", around: "alrededor de", above: "arriba de", below: "debajo de",
  behind: "detrás de", near: "cerca de", left: "izquierda", right: "derecha", front: "frente", back: "atrás", top: "arriba", bottom: "abajo",
  upper: "de arriba", lower: "de abajo", throughout: "en todo", including: "incluyendo", please: "por favor", must: "debe", needs: "necesita", needed: "necesario",
  white: "blanco", color: "color", match: "igualar", existing: "existente", one: "uno", two: "dos", three: "tres", four: "cuatro",
};
const ROOMS = "master bedroom|bedrooms?|bdrm|bathrooms?|bath|kitchen|living room|dining room|hallway|hall|foyer|closets?|laundry room|basement|lobby|stairwell|stairs|apartment|apt|unit|rooms?";
const PARTS = "walls?|ceilings?|floors?|doors?|windows?|cabinets?|sinks?|tiles?|trim|baseboards?|lights?|outlets?|switch(?:es)?|faucets?|counter(?:tops?)?|door frames?|window sills?|molding|radiators?|pipes?|shelves|shelf|mirror|vanity|tub|toilet|shower|fixtures?|closets?";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// no lookbehind here — Safari before 16.4 has none: the character before
// the word is matched and put back
const GLOSSARY = new RegExp(`(^|[^\\w])(${[...PHRASES.map(([k]) => k), ...Object.keys(WORDS)].sort((a, b) => b.length - a.length).map(esc).join("|")})(?![\\w])`, "gi");
const lookup = new Map<string, string>([...PHRASES, ...Object.entries(WORDS)].map(([k, v]) => [k.toLowerCase(), v]));

// the work line, word by word: what a Spanish-reading worker gets when
// Claude can't be asked. Rooms move behind their parts ("bedroom wall" →
// "pared de recámara"), phrases go first, numbers and unit labels stay.
export function roughSpanish(text: string): string {
  let t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  // a PO typed in capitals reads as words here, not shouting
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 6 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.6) t = t.toLowerCase();
  t = t.replace(/\s*&\s*/g, " and ");
  // "sheetrock repair", "tile replacement" → "repair sheetrock": the verb leads in Spanish
  const VERB: Record<string, string> = { replacement: "replace", installation: "install", removal: "remove", cleaning: "clean", painting: "paint", plastering: "plaster" };
  t = t.replace(/\b([a-z]+(?:\s[a-z]+)?)\s+(repair|replacement|installation|removal|cleaning|painting|plastering)\b/gi, (_m, what: string, verb: string) => `${VERB[verb.toLowerCase()] ?? verb} ${what}`);
  // "bedroom wall", "bedroom 2 ceiling" → "wall of bedroom", "ceiling of bedroom 2"
  t = t.replace(new RegExp(`\\b(${ROOMS})(\\s+#?\\d+[a-z]?)?\\s+(${PARTS})\\b`, "gi"), (_m, room: string, no: string | undefined, part: string) => `${part} of ${room}${no ? no : ""}`);
  t = t.replace(GLOSSARY, (_m, pre: string, word: string) => `${pre}${lookup.get(word.toLowerCase()) ?? word}`);
  t = t.replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
  // a sentence starts with a capital, and so does each one after a period
  t = t.replace(/(^|[.!?]\s+)([a-záéíóúñ])/g, (_m, p: string, c: string) => `${p}${c.toUpperCase()}`);
  return t;
}

// ---- Claude's translation, remembered by the English it came from ----
const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
const keyOf = (t: string) => (t || "").replace(/\s+/g, " ").trim().toLowerCase();
// what the preview can show right now: Claude's Spanish if it has answered, else the glossary's
export const spanishNow = (text: string): string => cache.get(keyOf(text)) ?? roughSpanish(text);
export const spanishKnown = (text: string): boolean => cache.has(keyOf(text));
// the Spanish for this work line — Claude's when it answers, the glossary's when it can't
export async function spanishWork(text: string): Promise<string> {
  const k = keyOf(text);
  if (!k) return "";
  const hit = cache.get(k);
  if (hit) return hit;
  if (!pending.has(k)) {
    pending.set(k, (async () => {
      try {
        const { data: { session } } = await sb().auth.getSession();
        const res = await fetch("/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
          body: JSON.stringify({ text: (text || "").trim() }),
        });
        const out = res.ok ? ((await res.json()) as { ok?: boolean; text?: string }) : null;
        if (out?.ok && typeof out.text === "string" && out.text.trim()) { cache.set(k, out.text.trim()); return out.text.trim(); }
      } catch { /* no signal, or Claude isn't set up — the glossary stands in */ }
      return roughSpanish(text);
    })().finally(() => pending.delete(k)));
  }
  return pending.get(k)!;
}
