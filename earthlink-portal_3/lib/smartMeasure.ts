// Claude looks at the photos and works out the square feet. Server-only:
// needs ANTHROPIC_API_KEY (the same key the PO reader uses). The answer is a
// fixed form — one row per area, with what gave the scale and how sure it
// is — and lib/measure.ts makes it safe before anyone sees it.
import { z } from "zod";
import { smartClient, smartErrorNote } from "./smartPo";
import { cleanMeasure, type MeasureHints, type MeasureResult } from "./measure";

export const AreaSchema = z.object({
  areas: z.array(z.object({
    photo: z.number().describe("Which photo this area is in, counting from 1 in the order given."),
    where: z.string().describe("Where it is, in plain words a worker would use: 'bedroom wall left of the window', 'kitchen ceiling over the stove'."),
    surface: z.enum(["wall", "ceiling", "floor", "other"]),
    width_ft: z.number().describe("Width of the area in feet, to the nearest half foot."),
    height_ft: z.number().describe("Height (or depth, for a ceiling) in feet, to the nearest half foot."),
    sq_ft: z.number().describe("width_ft × height_ft, rounded UP to a whole number of square feet. 0 when same_as is set."),
    ruler: z.string().describe("What gave the scale, with its size: 'interior door (80 in tall)', 'outlet cover (4.5 in tall)', 'ceiling height (8 ft, as told)'. Empty if nothing did."),
    confidence: z.enum(["low", "medium", "high"]),
    same_as: z.number().describe("0 normally. When this is the SAME area already reported for an earlier photo, that photo's number — so it is not counted twice."),
    note: z.string().describe("One short remark when something should be checked: a steep angle, a spot partly out of frame, a ruler far from the area. Empty when clean."),
  })),
  warnings: z.array(z.string()).describe("Anything that makes the numbers rough, in plain words: no known-size object in view, a blurry photo, the damage continuing out of frame. Empty when clean."),
});
export type SmartMeasure = z.infer<typeof AreaSchema>;

export const MEASURE_SYSTEM = `You measure plaster and paint repair areas from photos for Earth Link General Construction, a New York City contractor working in apartments (NYCHA and partner buildings). The owner takes a photo of a wall or ceiling; you estimate the area that needs work in square feet. Method:
1. Find the ruler in each photo — something whose size is known: an interior apartment door (80 in tall, usually 30 to 32 in wide in these buildings), a door knob (36 in off the floor), an outlet or light-switch cover plate (4.5 in tall × 2.75 in wide), a 4 × 4 in ceramic wall tile, a 12 × 12 in floor tile, a kitchen counter (36 in high), a baseboard (3 to 4 in), a radiator, a tape measure or ruler, a person (about 5 ft 8 in). The ceiling height the owner gives you is a ruler too (most of these apartments are 8 ft). Name the ruler you used and its size.
2. Scope "spots": measure the damaged, cracked, peeling, patched or water-stained region — the smallest rectangle that covers it, width and height in feet to the nearest half foot. Each separate spot is its own row. Scope "whole": the whole wall shown (its width × the ceiling height) or the whole ceiling shown (length × width) — one row per wall or ceiling.
3. sq_ft is width × height rounded UP to a whole number. Round small patches up to at least 1 sq ft.
4. Allow for the camera: a wall photographed at a steep angle is wider than it looks; a close-up makes a spot look bigger than it is. Say so in the note and lower the confidence.
5. Two photos of the same spot (a wider shot and a close-up): report it once, under the first photo. The later row gets same_as = the earlier photo's number and sq_ft 0.
6. Confidence: high when the ruler is right beside the area and the camera is square to the surface; medium when the ruler is elsewhere in the room or the angle is steep; low when there is no ruler at all — then work from the ceiling height and say in warnings that a door, an outlet cover or a tape measure in the shot would make it solid.
7. Never invent an area you cannot see, and never measure furniture, floors or fixtures unless asked. Answer through the form only.`;

export interface MeasureImage { media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; data: string }
export const MEASURE_TIMEOUT_MS = 50_000;
export async function askClaudeMeasure(images: MeasureImage[], hints: MeasureHints, timeoutMs = MEASURE_TIMEOUT_MS): Promise<SmartMeasure | null> {
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const client = await smartClient(timeoutMs);
  const ceiling = Number(hints.ceilingFt) > 0 ? Number(hints.ceilingFt) : 8;
  const ask = [
    `${images.length} photo${images.length === 1 ? "" : "s"}, in order.`,
    `Scope: ${hints.scope === "whole" ? "the WHOLE wall or ceiling shown in each photo" : "just the damaged spots that need plaster"}.`,
    `Ceiling height: ${ceiling} ft.`,
    hints.note.trim() ? `From the owner: ${hints.note.trim()}` : "",
    "Measure the area in square feet and fill the form.",
  ].filter(Boolean).join("\n");
  const res = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 4000,
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

// the whole thing, never throwing: the form, cleaned — or a plain note why not
export async function measureSmart(images: MeasureImage[], hints: MeasureHints, ask = askClaudeMeasure, timeoutMs = MEASURE_TIMEOUT_MS): Promise<{ result: MeasureResult } | { note: string }> {
  try {
    const s = await Promise.race<SmartMeasure | null>([
      ask(images, hints, timeoutMs),
      new Promise<null>((_, rej) => setTimeout(() => rej(new Error("the measuring took too long")), timeoutMs + 2_000)),
    ]);
    if (!s) return { note: "Claude declined to measure these photos" };
    return { result: cleanMeasure(s) };
  } catch (e) {
    const why = smartErrorNote(e);
    return { note: /took too long/.test(why) ? "Claude took too long — try fewer photos" : why.replace(/^Claude couldn't read it/, "Claude couldn't measure it") };
  }
}
