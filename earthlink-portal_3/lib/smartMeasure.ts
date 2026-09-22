// Claude looks at the photos and works out the square feet. Server-only:
// needs ANTHROPIC_API_KEY (the same key the PO reader uses). The answer is a
// fixed form — one row per area, where it sits in the photo, what gave the
// scale and how sure it is — and lib/measure.ts makes it safe, then redoes
// the arithmetic from any ruler the owner marked, before anyone sees it.
import { z } from "zod";
import { smartClient, smartErrorNote } from "./smartPo";
import { cleanMeasure, refineWithRulers, type ImageMeta, type MeasureHints, type MeasureResult } from "./measure";

export const AreaSchema = z.object({
  areas: z.array(z.object({
    photo: z.number().describe("Which photo this area is in, counting from 1 in the order given."),
    where: z.string().describe("Where it is, in plain words a worker would use: 'bedroom wall left of the window', 'kitchen ceiling over the stove'."),
    surface: z.enum(["wall", "ceiling", "floor", "other"]),
    box: z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() }).describe("The smallest box around the area, in that photo's own pixels (0,0 is the top-left corner; the photo's size is given). All zeros when same_as is set."),
    width_ft: z.number().describe("Real width of the area in feet, to the nearest half foot."),
    height_ft: z.number().describe("Real height (or depth, for a ceiling) in feet, to the nearest half foot."),
    sq_ft: z.number().describe("width_ft × height_ft, rounded UP to a whole number of square feet. 0 when same_as is set."),
    ruler: z.string().describe("What gave the scale, with its size: 'the marked ruler (96 in)', 'interior door (80 in tall)', 'outlet cover (4.5 in tall)', 'ceiling height (8 ft, as told)'. Empty if nothing did."),
    same_plane: z.boolean().describe("true when the area lies on the same flat surface (the same wall, or the same ceiling) as the ruler marked in its photo — or when no ruler is marked. false when the marked ruler is on a different wall or at a different distance from the camera."),
    confidence: z.enum(["low", "medium", "high"]),
    same_as: z.number().describe("0 normally. When this is the SAME area already reported for an earlier photo, that photo's number — so it is not counted twice."),
    note: z.string().describe("One short remark when something should be checked: a steep angle, a spot partly out of frame, a ruler far from the area. Empty when clean."),
  })),
  warnings: z.array(z.string()).describe("Anything that makes the numbers rough, in plain words: nothing of a known size in view, a blurry photo, the damage continuing out of frame. Empty when clean."),
});
export type SmartMeasure = z.infer<typeof AreaSchema>;

export const MEASURE_SYSTEM = `You measure plaster and paint repair areas from photos for Earth Link General Construction, a New York City contractor working in apartments (NYCHA and partner buildings). The owner photographs a wall or ceiling; you estimate the area that needs work in square feet, as exactly as the picture allows. Work like a surveyor, not a guesser:

THE RULER. Scale comes from something whose real size is known.
- Best: a ruler the owner marked on the photo — a red line with its length written on it, whose pixel ends are also given in the text. Its pixel length ÷ its real length is the scale (pixels per inch) on that surface at that distance. Use it.
- Next: things of standard size in these buildings — apartment entry door 36 × 80 in; interior door 30 or 32 × 80 in; closet door 24–30 × 80 in; door knob 36 in off the floor; light switch 48 in off the floor; outlet 12–16 in off the floor; a single cover plate 4.5 × 2.75 in (a double one 4.5 × 4.5); baseboard or vinyl cove base 4 in; window sill about 30 in off the floor; kitchen counter 36 in high, upper cabinets 30 in tall starting 54 in up, stove 30 in wide; bathroom wall tile 4¼ × 4¼ in; floor tile 12 × 12 in (older 9 × 9 in vinyl); subway tile 3 × 6 in; cinder block 8 × 16 in; brick 8 × 2¼ in; radiator about 25 in tall; bathtub 60 × 30 in; toilet tank top about 30 in; refrigerator 66–70 in tall; a phone 6 in; a hand 7½ in; a person about 5 ft 8 in.
- Always: the ceiling height the owner gives (8 ft in most of these apartments). When both the floor line and the ceiling line of a wall are in the photo, that span IS a ruler for that wall — use it, and say so. Only when no floor, no ceiling, no marked ruler and no standard object are in view is the confidence low.

THE MEASUREMENT.
- Give each area's box in the photo's own pixels, and its real width and height. Size = pixel extent ÷ scale. A wall seen at an angle recedes: a foot near the camera spans more pixels than a foot far away — take the scale at the area's own position (compare the wall's floor-to-ceiling height in pixels at the ruler and at the area, and correct by that ratio), and say in the note when you corrected for it.
- An outline the owner marked (a red dashed box) is exactly what to measure: report that box, and nothing else in that photo unless it is plainly a second, separate spot.
- Scope "spots": the damaged, cracked, peeling, patched or water-stained region — the smallest rectangle that covers it, width and height to the nearest half foot. Each separate spot is its own row. Scope "whole": the whole wall shown (width × ceiling height) or the whole ceiling shown (length × width), one row per wall or ceiling.
- sq_ft is width × height rounded UP to a whole number; a small patch is at least 1 sq ft.
- Two photos of the same spot (a wide shot and a close-up): report it once, under the first photo. The later row gets same_as = the earlier photo's number and sq_ft 0.
- Confidence: high when the scale comes from a marked ruler or a floor-to-ceiling span on the same surface and the camera is roughly square to it; medium when the ruler is on another wall, far from the area, or the angle is steep; low when nothing of a known size is in view — then say in warnings what to put in the next shot (step back so the floor and the ceiling are both in the picture, or mark a ruler).
- Never invent an area you cannot see, never measure furniture, floors or fixtures unless asked, and never pad a number to be safe — the owner checks it with a tape. Answer through the form only.`;

export interface MeasureImage extends ImageMeta { media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; data: string }
export const MEASURE_TIMEOUT_MS = 48_000;
const px = (n: number) => Math.round(n);
// what the text beside the photos says about each one: its size, the marks
export const photoLines = (images: ImageMeta[], hints: MeasureHints): string => images.map((im, i) => {
  const parts = [`Photo ${i + 1}: ${im.width && im.height ? `${im.width} × ${im.height} px` : "size unknown"}.`];
  if (im.ruler) parts.push(`Ruler marked in red from (${px(im.ruler.x1)}, ${px(im.ruler.y1)}) to (${px(im.ruler.x2)}, ${px(im.ruler.y2)}) — its real length is ${im.ruler.inches} in${im.ruler.inches === Math.round(hints.ceilingFt * 12) ? " (floor to ceiling)" : ""}.`);
  if (im.box) parts.push(`Outline marked in red, dashed, from (${px(im.box.x1)}, ${px(im.box.y1)}) to (${px(im.box.x2)}, ${px(im.box.y2)}) — measure exactly this.`);
  if (!im.ruler && !im.box) parts.push("No marks — find the scale yourself.");
  return parts.join(" ");
}).join("\n");

export async function askClaudeMeasure(images: MeasureImage[], hints: MeasureHints, timeoutMs = MEASURE_TIMEOUT_MS): Promise<SmartMeasure | null> {
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const client = await smartClient(timeoutMs);
  const ceiling = Number(hints.ceilingFt) > 0 ? Number(hints.ceilingFt) : 8;
  const ask = [
    `${images.length} photo${images.length === 1 ? "" : "s"}, in order.`,
    `Scope: ${hints.scope === "whole" ? "the WHOLE wall or ceiling shown in each photo" : "just the damaged spots that need plaster"}.`,
    `Ceiling height: ${ceiling} ft.`,
    hints.note.trim() ? `From the owner: ${hints.note.trim()}` : "",
    photoLines(images, hints),
    "Measure the area in square feet and fill the form.",
  ].filter(Boolean).join("\n");
  const res = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 6000,
    output_config: { effort: "high", format: zodOutputFormat(AreaSchema) },
    system: MEASURE_SYSTEM,
    messages: [{
      role: "user",
      content: [
        ...images.map((im) => ({ type: "image" as const, source: { type: "base64" as const, media_type: im.media_type, data: im.data } })),
        { type: "text", text: ask },
      ],
    }],
  });
  if (res.stop_reason === "refusal") return null;
  return res.parsed_output ?? null;
}

// the whole thing, never throwing: the form, cleaned, the ruler's arithmetic
// redone here — or a plain note why not
export async function measureSmart(images: MeasureImage[], hints: MeasureHints, ask = askClaudeMeasure, timeoutMs = MEASURE_TIMEOUT_MS): Promise<{ result: MeasureResult } | { note: string }> {
  try {
    const s = await Promise.race<SmartMeasure | null>([
      ask(images, hints, timeoutMs),
      new Promise<null>((_, rej) => setTimeout(() => rej(new Error("the measuring took too long")), timeoutMs + 2_000)),
    ]);
    if (!s) return { note: "Claude declined to measure these photos" };
    return { result: refineWithRulers(cleanMeasure(s), images) };
  } catch (e) {
    const why = smartErrorNote(e);
    return { note: /took too long/.test(why) ? "Claude took too long — try fewer photos" : why.replace(/^Claude couldn't read it/, "Claude couldn't measure it") };
  }
}
