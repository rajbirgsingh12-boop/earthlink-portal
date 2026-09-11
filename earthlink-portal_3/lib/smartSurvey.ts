// The survey PDF, read into the contract's lines. Claude reads the page
// (typed or scanned) with the contract's price book beside it and says which
// line each written item bills; the rules read (pdf text → shorthand lines →
// keyword-matched lines) stands in when the smart reader is off or fails.
// Never throws — a failed smart read is a rules read with a note.
import { z } from "zod";
import { buildLines, parseSurvey, proposeTemplate, type CatalogLine } from "./surveyTemplate";
import { smartConfigured, SMART_TIMEOUT_MS } from "./smartPo";

export const SurveySchema = z.object({
  address: z.string().describe("the street address as written on the first line, e.g. '390 Sutter'; empty if none"),
  apt: z.string().describe("the apartment, e.g. '11A'; empty if none"),
  kind: z.string().describe("'Move-out' when the survey says MO, 'Move-in' for MI, otherwise what it says; empty if none"),
  bedrooms: z.number().nullable().describe("the bedroom count when written ('2 bedroom'); null when not"),
  items: z.array(z.object({
    written: z.string().describe("the survey line, as written"),
    qty: z.number().describe("the count written on that line; 1 when there is none"),
    lines: z.array(z.object({
      code: z.string().describe("a code from the price book — never one that isn't there"),
      qty: z.number().describe("how many of that line this item bills"),
    })).describe("the price-book line or lines this item bills; empty when the book has no line for it"),
    note: z.string().nullable().describe("anything a person should know: no line in the book, written twice, a guess"),
  })),
});
export type SmartSurvey = z.infer<typeof SurveySchema>;
export type SurveyRead = { survey: SmartSurvey; readBy: "claude" | "rules"; note?: string };

export const SMART_SURVEY_SYSTEM = `You read a contractor's apartment survey — the shorthand a foreman writes walking a vacant NYCHA apartment (a "move-out", MO) — and turn it into the housing authority contract's own price-book lines.
How a survey reads:
- the first line is the address, the apartment and MO or MI ("390 sutter 11A MO");
- "2 bedroom" is the apartment size;
- then one item per line with its count: "Window balance 28", "7 passage lock", "GFI 4"; a line with no count means 1;
- "Outlet: 1 single 7 double 1 two outlet cover" is three items — 1 single receptacle, 7 duplex receptacles, 1 two-gang cover plate;
- "Reglaze tub and sink" (or "sink and tub", "tub glaze") bills two lines (the tub, the sink); "Bathroom accessories" bills the towel bar, the toilet-paper holder and the soap dish; "1 wire smoke", "1 wire" and "1 electric smoke" are one hardwired smoke detector and "2 battery" / "2 battery smoke" two battery smoke detectors; "pancake" is a surface-mount ceiling light fixture and "pull chain" / "pull" a pull-chain fixture; "privacy" and "passage" are locksets; "Kitchen plumbing" is the kitchen faucet unless the book says otherwise;
- two counts on one line are two items: "4 gfi 1 double cover" is 4 GFCI receptacles and 1 two-gang cover plate; "3 switch 1 double" is 3 single switches and 1 double (two-gang) switch; "2 pancake 1 pull chain" is 2 ceiling fixtures and 1 pull-chain fixture; "Switch 3 single" is 3 single switches; "7 outlets" are duplex receptacles;
- "Door knocker and interviewer bondo door" is three things: a door knocker, a door viewer (peephole — "interviewer" is the foreman's word for it) and repairing the door with Bondo; "Wax" or "Strip and wax floor" is floor stripping and waxing; "Natural gas detector" is a gas detector; "Connect kitchen appliances" is hooking up the stove and refrigerator; "New sink" in the bathroom list is the lavatory sink; "7 door paint" is painting 7 interior doors and "Apartment door paint" the entrance door;
- "Paint done" (or anything "done") is a note that the work is already finished — not an item; spelling slips happen ("Showet head", "atural gas") — read them as the item meant.
Rules:
- every code you give must be in the price book you are shown — never invent one, never guess a code;
- pick the plainest line that IS the item: a toilet is not a toilet-paper holder or a seat, a single receptacle is not a single-pole switch, a wall light is not a wall plate;
- when the book prices painting the whole apartment by bedroom count, the "N bedroom" line bills that paint line once; otherwise it bills nothing;
- when the book has no line for an item, leave its lines empty and say so in the note — do not force a near miss;
- when the same item is written twice, keep both lines and note it;
- keep the survey's order; quantities are the counts written, times what the book's unit needs (a line priced per pair for a pair).`;

const bookText = (catalog: CatalogLine[]) =>
  catalog.map((c) => `${c.code} | ${c.description} | ${c.uom} | ${Number(c.unit_price).toFixed(2)}`).join("\n");

// what Claude is shown: the page itself (typed or scanned), or — for our own
// form, read off its boxes — the survey as text, so nothing rides on how a
// PDF app drew the boxes
export type SurveySource = { pdf: Uint8Array } | { text: string };
export async function askClaudeSurvey(source: SurveySource, catalog: CatalogLine[], timeoutMs: number = SMART_TIMEOUT_MS): Promise<SmartSurvey | null> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const client = new Anthropic({ timeout: timeoutMs, maxRetries: 0 });
  const res = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 12000,
    output_config: { effort: "high", format: zodOutputFormat(SurveySchema) },
    system: SMART_SURVEY_SYSTEM,
    messages: [{
      role: "user",
      content: [
        ...("pdf" in source ? [{ type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: Buffer.from(source.pdf).toString("base64") } }] : []),
        { type: "text", text: `Read this survey into the price book's lines.${"text" in source ? `\n\nSURVEY:\n${source.text}` : ""}\n\nPRICE BOOK (code | description | unit | price):\n${bookText(catalog)}` },
      ],
    }],
  });
  if (res.stop_reason === "refusal") return null;
  return res.parsed_output ?? null;
}

// the rules read: the page's text as shorthand lines, matched by keywords to
// lines the book's own wording suggests
export function rulesSurvey(text: string, catalog: CatalogLine[]): SmartSurvey {
  const items = proposeTemplate("", catalog).items;
  const p = parseSurvey(text, items);
  const built = buildLines(p, items, catalog);
  const twice = new Set(built.twice);
  return {
    address: p.address, apt: p.apt, kind: p.kind, bedrooms: p.bedrooms ?? null,
    items: p.lines.map((l) => {
      const it = l.itemKey ? items.find((x) => x.key === l.itemKey) : undefined;
      const lines = it ? it.lines.filter((tl) => catalog.some((c) => c.code === tl.code)).map((tl) => ({ code: tl.code, qty: l.qty * (tl.per || 1) })) : [];
      const note = !it ? "no line in the price book matched this" : lines.length === 0 ? `${it.label}: the book has no line for it` : twice.has(it.label) ? "written more than once — the counts are added up" : null;
      return { written: l.raw, qty: l.qty, lines, note };
    }),
  };
}

// Claude's answer, checked: only codes the book has, only counts above zero
export function cleanSmart(s: SmartSurvey, catalog: CatalogLine[]): { survey: SmartSurvey; dropped: number } {
  const codes = new Set(catalog.map((c) => c.code));
  let dropped = 0;
  const items = s.items.map((it) => {
    const lines = (it.lines || []).filter((l) => { const ok = codes.has(String(l.code)) && Number(l.qty) > 0; if (!ok) dropped += 1; return ok; })
      .map((l) => ({ code: String(l.code), qty: Number(l.qty) }));
    return { written: it.written || "", qty: Number(it.qty) || 0, lines, note: it.note ?? null };
  });
  return { survey: { address: s.address || "", apt: s.apt || "", kind: s.kind || "", bedrooms: s.bedrooms ?? null, items }, dropped };
}

// `formText` is set when the PDF is our own form, read off its boxes: that
// text is the survey, for the rules and for Claude alike
export async function readSurveySmart(
  pdf: Uint8Array, text: string, catalog: CatalogLine[],
  ask: (source: SurveySource, catalog: CatalogLine[], timeoutMs: number) => Promise<SmartSurvey | null> = askClaudeSurvey,
  timeoutMs: number = SMART_TIMEOUT_MS,
  formText?: string,
): Promise<SurveyRead> {
  const rules = () => rulesSurvey(formText ?? text, catalog);
  if (formText !== undefined && formText.trim() === "") return { survey: rules(), readBy: "rules", note: "the form's boxes are all empty" };
  if (!smartConfigured()) return { survey: rules(), readBy: "rules", note: formText === undefined && text.trim().length < 20 ? "no text on the page and the smart reader isn't switched on (ANTHROPIC_API_KEY)" : undefined };
  try {
    const answer = await Promise.race([
      ask(formText !== undefined ? { text: formText } : { pdf }, catalog, timeoutMs),
      new Promise<null>((_, rej) => setTimeout(() => rej(new Error("the smart reader took too long")), timeoutMs + 2_000)),
    ]);
    if (!answer) return { survey: rules(), readBy: "rules", note: "the smart reader declined this page" };
    const { survey, dropped } = cleanSmart(answer, catalog);
    if (survey.items.length === 0) return { survey: rules(), readBy: "rules", note: "the smart reader found no lines on the page" };
    return { survey, readBy: "claude", ...(dropped ? { note: `${dropped} line${dropped === 1 ? "" : "s"} the reader named weren't in the price book and were left off` } : {}) };
  } catch (e) {
    return { survey: rules(), readBy: "rules", note: e instanceof Error ? e.message.slice(0, 120) : "the smart reader failed" };
  }
}
