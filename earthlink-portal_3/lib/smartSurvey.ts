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
- "Reglaze tub and sink" bills two lines (the tub, the sink); "Bathroom accessories" bills the towel bar, the toilet-paper holder and the soap dish; "1 wire smoke" is one hardwired smoke detector and "2 battery" two battery smoke detectors; "pancake" is a surface-mount ceiling light fixture; "privacy" and "passage" are locksets; "Kitchen plumbing" is the kitchen faucet unless the book says otherwise.
Rules:
- every code you give must be in the price book you are shown — never invent one, never guess a code;
- pick the plainest line that IS the item: a toilet is not a toilet-paper holder or a seat, a single receptacle is not a single-pole switch, a wall light is not a wall plate;
- when the book prices painting the whole apartment by bedroom count, the "N bedroom" line bills that paint line once; otherwise it bills nothing;
- when the book has no line for an item, leave its lines empty and say so in the note — do not force a near miss;
- when the same item is written twice, keep both lines and note it;
- keep the survey's order; quantities are the counts written, times what the book's unit needs (a line priced per pair for a pair).`;

const bookText = (catalog: CatalogLine[]) =>
  catalog.map((c) => `${c.code} | ${c.description} | ${c.uom} | ${Number(c.unit_price).toFixed(2)}`).join("\n");

export async function askClaudeSurvey(pdf: Uint8Array, catalog: CatalogLine[], timeoutMs: number = SMART_TIMEOUT_MS): Promise<SmartSurvey | null> {
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
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(pdf).toString("base64") } },
        { type: "text", text: `Read this survey into the price book's lines.\n\nPRICE BOOK (code | description | unit | price):\n${bookText(catalog)}` },
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

export async function readSurveySmart(
  pdf: Uint8Array, text: string, catalog: CatalogLine[],
  ask: (pdf: Uint8Array, catalog: CatalogLine[], timeoutMs: number) => Promise<SmartSurvey | null> = askClaudeSurvey,
  timeoutMs: number = SMART_TIMEOUT_MS,
): Promise<SurveyRead> {
  const rules = () => rulesSurvey(text, catalog);
  if (!smartConfigured()) return { survey: rules(), readBy: "rules", note: text.trim().length < 20 ? "no text on the page and the smart reader isn't switched on (ANTHROPIC_API_KEY)" : undefined };
  try {
    const answer = await Promise.race([
      ask(pdf, catalog, timeoutMs),
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
