// The survey PDF, read into the move-out list. Claude reads the page (typed
// or scanned) with the list of things a survey can say beside it and names
// which thing each written line is; the rules read (pdf text → shorthand
// lines → keyword-matched items) stands in when the smart reader is off or
// fails. What each item bills is not the reader's call — lib/surveyTemplate.ts
// bills the way the release does. Never throws — a failed smart read is a
// rules read with a note.
import { z } from "zod";
import { parseSurvey, SEED_ITEMS, itemByKey, type ReadItem } from "./surveyTemplate";
import { smartConfigured, smartClient, smartErrorNote, SMART_TIMEOUT_MS } from "./smartPo";

export const SurveySchema = z.object({
  address: z.string().describe("the street address as written on the first line, e.g. '390 Sutter'; empty if none"),
  apt: z.string().describe("the apartment, e.g. '11A'; empty if none"),
  kind: z.string().describe("'Move-out' when the survey says MO, 'Move-in' for MI, otherwise what it says; empty if none"),
  bedrooms: z.number().nullable().describe("the bedroom count when written ('2 bedroom'); null when not"),
  items: z.array(z.object({
    written: z.string().describe("the survey line, as written"),
    qty: z.number().describe("the count written on that line; 1 when there is none"),
    key: z.string().describe("the key of the thing on the list this line is — only a key from the list, never one that isn't there; empty when nothing on the list is it"),
    note: z.string().nullable().describe("anything a person should know: not on the list, written twice, a guess"),
  })),
});
export type SmartSurvey = { address: string; apt: string; kind: string; bedrooms: number | null; items: ReadItem[] };
export type SurveyRead = { survey: SmartSurvey; readBy: "claude" | "rules"; note?: string };

export const SMART_SURVEY_SYSTEM = `You read a contractor's apartment survey — the shorthand a foreman writes walking a vacant NYCHA apartment (a "move-out", MO) — and name what each line is from a fixed list of things a survey can say.
How a survey reads:
- the first line is the address, the apartment and MO or MI ("390 sutter 11A MO");
- "2 bedroom" is the apartment size — give it as the size item ("apt_2br");
- then one item per line with its count: "Window balance 28", "7 passage lock", "GFI 4"; a line with no count means 1;
- "Outlet: 1 single 7 double 1 two outlet cover" is three items — 1 single outlet, 7 double outlets, 1 two-gang cover plate;
- "Reglaze tub and sink" (or "sink and tub", "tub glaze" for the tub alone) is the reglaze-both item; "Bathroom accessories" is one item (the towel bar, paper holder and soap dish together); "1 wire smoke", "1 wire" and "1 electric smoke" are one hardwired smoke detector and "2 battery" / "2 battery smoke" two battery smoke detectors; "pancake" is the ceiling light and "pull chain" / "pull" the pull-chain light; "privacy" and "passage" are locks; "Kitchen plumbing" is the kitchen faucet;
- two counts on one line are two items: "4 gfi 1 double cover" is 4 GFI outlets and 1 two-gang cover plate; "3 switch 1 double" is 3 switches and 1 double switch; "2 pancake 1 pull chain" is 2 ceiling lights and 1 pull-chain light; "Switch 3 single" is 3 switches; "7 outlets" are double outlets;
- "Door knocker and interviewer bondo door" is three things: a door knocker, a peephole ("interviewer" is the foreman's word for the door viewer) and a door repair with Bondo; "Wax" or "Strip and wax floor" is the floor wax; "Natural gas detector" is the gas detector; "Connect kitchen appliances" is hooking up the stove and refrigerator; "New sink" in the bathroom list is the bathroom sink; "7 door paint" is painting 7 interior doors and "Apartment door paint" the entrance door;
- "Paint done" (or anything "done") is a note that the work is already finished — not an item; spelling slips happen ("Showet head", "atural gas") — read them as the item meant.
Rules:
- every key you give must be on the list you are shown — never invent one, never guess a near miss;
- pick the thing that IS the item: a toilet is not a toilet seat, a single outlet is not a switch, a wall light is not a cover plate;
- when nothing on the list is the item, leave the key empty and say so in the note;
- when the same item is written twice and one mention has no count ("Bathroom light" in the bathroom list, "1 bathroom light" in the electrical list), it is the same thing once — give it once and note it; with a count both times, give both;
- keep the survey's order; the count is what is written, 1 when there is none.`;

// the list Claude picks from: key — what it is — how it gets written
const itemList = () => SEED_ITEMS.map((s) => `${s.key}: ${s.label}${s.aliases.length ? ` (also written: ${s.aliases.slice(0, 8).join(", ")})` : ""}`).join("\n");

// what Claude is shown: the page itself (typed or scanned), or — for our own
// form, read off its boxes — the survey as text, so nothing rides on how a
// PDF app drew the boxes
export type SurveySource = { pdf: Uint8Array } | { text: string };
export async function askClaudeSurvey(source: SurveySource, timeoutMs: number = SMART_TIMEOUT_MS): Promise<SmartSurvey | null> {
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const client = await smartClient(timeoutMs);
  const res = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 8000,
    output_config: { effort: "high", format: zodOutputFormat(SurveySchema) },
    system: SMART_SURVEY_SYSTEM,
    messages: [{
      role: "user",
      content: [
        ...("pdf" in source ? [{ type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: Buffer.from(source.pdf).toString("base64") } }] : []),
        { type: "text", text: `Read this survey into the list.${"text" in source ? `\n\nSURVEY:\n${source.text}` : ""}\n\nTHE LIST (key: what it is):\n${itemList()}` },
      ],
    }],
  });
  if (res.stop_reason === "refusal") return null;
  const o = res.parsed_output;
  return o ? { address: o.address, apt: o.apt, kind: o.kind, bedrooms: o.bedrooms ?? null, items: o.items.map((it) => ({ written: it.written, qty: it.qty, key: it.key, note: it.note ?? null })) } : null;
}

// the rules read: the page's text as shorthand lines, matched by keywords to the list
export function rulesSurvey(text: string): SmartSurvey {
  const p = parseSurvey(text);
  const pieces = new Map<number, number>();
  for (const l of p.lines) pieces.set(l.at ?? -1, (pieces.get(l.at ?? -1) || 0) + 1);
  return {
    address: p.address, apt: p.apt, kind: p.kind, bedrooms: p.bedrooms ?? null,
    // a line that read as several things ("Outlet: 1 single 7 double") is several items, each in its own words
    items: p.lines.map((l) => ({ written: (pieces.get(l.at ?? -1) || 0) > 1 ? l.label : l.raw, qty: l.qty, key: l.itemKey || "", note: l.itemKey ? null : "nothing on the list reads like this", ...(l.implied ? { implied: true } : {}) })),
  };
}

// Claude's answer, checked: only keys on the list, only counts above zero
export function cleanSmart(s: SmartSurvey): { survey: SmartSurvey; dropped: number } {
  let dropped = 0;
  const items = (s.items || []).map((it) => {
    const key = String(it.key || "");
    const known = !key || !!itemByKey(key);
    if (!known) dropped += 1;
    return { written: String(it.written || ""), qty: Number(it.qty) || 0, key: known ? key : "", note: known ? (it.note ?? null) : `the reader named "${key}", which isn't on the list${it.note ? ` — ${it.note}` : ""}` };
  }).filter((it) => it.qty > 0);
  return { survey: { address: s.address || "", apt: s.apt || "", kind: s.kind || "", bedrooms: s.bedrooms ?? null, items }, dropped };
}

// `formText` is set when the PDF is our own form, read off its boxes: that
// text is the survey, for the rules and for Claude alike
export async function readSurveySmart(
  pdf: Uint8Array, text: string,
  ask: (source: SurveySource, timeoutMs: number) => Promise<SmartSurvey | null> = askClaudeSurvey,
  timeoutMs: number = SMART_TIMEOUT_MS,
  formText?: string,
): Promise<SurveyRead> {
  const rules = () => rulesSurvey(formText ?? text);
  if (formText !== undefined && formText.trim() === "") return { survey: rules(), readBy: "rules", note: "the form's boxes are all empty" };
  if (!smartConfigured()) return { survey: rules(), readBy: "rules", note: formText === undefined && text.trim().length < 20 ? "no text on the page and the smart reader isn't switched on (ANTHROPIC_API_KEY)" : undefined };
  try {
    const answer = await Promise.race([
      ask(formText !== undefined ? { text: formText } : { pdf }, timeoutMs),
      new Promise<null>((_, rej) => setTimeout(() => rej(new Error("the smart reader took too long")), timeoutMs + 2_000)),
    ]);
    if (!answer) return { survey: rules(), readBy: "rules", note: "the smart reader declined this page" };
    const { survey, dropped } = cleanSmart(answer);
    if (survey.items.length === 0) return { survey: rules(), readBy: "rules", note: "the smart reader found no lines on the page" };
    return { survey, readBy: "claude", ...(dropped ? { note: dropped === 1 ? "1 line the reader named wasn't on the list and was left off" : `${dropped} lines the reader named weren't on the list and were left off` } : {}) };
  } catch (e) {
    return { survey: rules(), readBy: "rules", note: smartErrorNote(e) };
  }
}
