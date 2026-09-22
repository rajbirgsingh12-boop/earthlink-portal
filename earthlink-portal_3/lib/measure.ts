// Square feet from photos. The owner takes pictures of the wall or ceiling
// that needs plaster; Claude looks at them on the server (/api/measure) and
// works out the area from something of known size in the shot — a door, an
// outlet cover, a tile, the ceiling height — and the number lands on the
// job's square-foot line. A photo can never be measured exactly: every
// number here is a starting point the tape measure overrules, and the
// screen says so. Nothing in this file touches the database or the screen;
// the measuring itself lives in lib/smartMeasure.ts (server only).
import { normUnit } from "./priceBook";

export type Surface = "wall" | "ceiling" | "floor" | "other";
export type Confidence = "low" | "medium" | "high";
// marks the owner puts on a photo, in that photo's own pixels (0,0 top-left):
// a ruler — two ends of something whose length is known — and an outline of
// the spot to measure. The ruler is what makes a photo with nothing of a
// known size in it measurable: floor to ceiling works in any room.
export interface RulerMark { x1: number; y1: number; x2: number; y2: number; inches: number }
export interface BoxMark { x1: number; y1: number; x2: number; y2: number }
export interface PhotoMarks { ruler?: RulerMark | null; box?: BoxMark | null }
export interface ImageMeta { width: number; height: number; ruler: RulerMark | null; box: BoxMark | null }
export interface MeasuredArea {
  photo: number;          // which photo, 1-based, in the order sent
  where: string;          // "bedroom wall left of the window"
  surface: Surface;
  width_ft: number;
  height_ft: number;
  sq_ft: number;          // whole square feet, rounded up
  ruler: string;          // what gave the scale: "door (80 in tall)"
  confidence: Confidence;
  same_as: number;        // 0, or the photo number this area was already counted under
  note: string;
  box: BoxMark | null;    // where it is in the photo, in pixels — drawn back for the owner to check
  same_plane: boolean;    // on the same flat surface as the photo's marked ruler (or no ruler marked)
  scale_ratio: number;    // how much bigger a foot looks here than at the ruler (1 = the same distance)
}
export interface MeasureResult { areas: MeasuredArea[]; total_sq_ft: number; warnings: string[] }
export interface MeasureHints {
  scope: "spots" | "whole";   // just the damaged spots, or the whole wall/ceiling shown
  ceilingFt: number;          // the room's ceiling height — 8 ft in most NYC apartments
  note: string;               // anything else the owner knows ("the door is 32 in wide")
}
export const DEFAULT_HINTS: MeasureHints = { scope: "spots", ceilingFt: 8, note: "" };
export const MAX_PHOTOS = 6;          // per measuring — keeps the request under the server's body cap
export const MAX_SQFT = 5000;         // no apartment wall is bigger; anything above is a misread

// ---- the square-foot lines on a job ----
export const SF_KEYS = ["plaster", "wall_repair", "popcorn", "sheetrock"];
export interface SfLine { description: string; qty: number; unit: string; unit_price: number; key?: string; base?: string }
// Painting and priming are priced by the room or by the apartment, never by
// the square foot — and a PO that printed no unit can still land here as
// "SF". Putting square feet on one of those would multiply an apartment
// price by the area, so they are never a target, whatever unit they carry.
const isPainting = (it: SfLine): boolean =>
  /^(paint_|primer$)/.test(it.key || "") || (!it.key && /(^|[^a-z])(paint|painting|painted|primer|prime|priming)([^a-z]|$)/i.test(it.description || ""));
// a line measured in square feet: by its price-book key, or by its unit
export const isSfLine = (it: SfLine): boolean =>
  !isPainting(it) && ((!!it.key && SF_KEYS.includes(it.key)) || normUnit(it.unit || "") === "SF");
export const sfLines = (items: SfLine[]): number[] => items.map((it, i) => (isSfLine(it) ? i : -1)).filter((i) => i >= 0);
// the line the panel starts on: one the price book itself calls square feet.
// A line read off a PO is offered, but never chosen for the owner.
export const firstSfLine = (items: SfLine[]): number | null => {
  const keyed = items.findIndex((it) => isSfLine(it) && !!it.key && SF_KEYS.includes(it.key));
  return keyed >= 0 ? keyed : null;
};
export const roundSf = (n: number): number => Math.max(0, Math.ceil(Number(n) || 0));

// the answer, made safe: bad rows dropped, sizes clamped, a duplicate of an
// earlier photo counted once, the total recomputed here (never trusted)
export function cleanMeasure(raw: unknown): MeasureResult {
  const r = (raw || {}) as { areas?: unknown; warnings?: unknown };
  const list = Array.isArray(r.areas) ? (r.areas as Record<string, unknown>[]) : [];
  const surfaces: Surface[] = ["wall", "ceiling", "floor", "other"];
  const confs: Confidence[] = ["low", "medium", "high"];
  const areas: MeasuredArea[] = [];
  for (const a of list) {
    if (!a || typeof a !== "object") continue;
    const w = Math.max(0, Number(a.width_ft) || 0), h = Math.max(0, Number(a.height_ft) || 0);
    let sq = roundSf(Number(a.sq_ft) || 0);
    if (!sq && w && h) sq = roundSf(w * h);
    // a duplicate must point at an EARLIER photo; anything else (itself, a
    // photo further down, one that was never sent) is a real area, not a copy
    const photo = Math.max(1, Math.floor(Number(a.photo) || 1));
    const claimed = Math.max(0, Math.floor(Number(a.same_as) || 0));
    const same = claimed > 0 && claimed < photo ? claimed : 0;
    if (!sq && !same) continue;
    const bx = (a.box || null) as Record<string, unknown> | null;
    const box = bx && [bx.x1, bx.y1, bx.x2, bx.y2].every((v) => Number.isFinite(Number(v)))
      ? { x1: Math.min(Number(bx.x1), Number(bx.x2)), y1: Math.min(Number(bx.y1), Number(bx.y2)), x2: Math.max(Number(bx.x1), Number(bx.x2)), y2: Math.max(Number(bx.y1), Number(bx.y2)) } : null;
    areas.push({
      photo,
      where: String(a.where || "").replace(/\s+/g, " ").trim() || "the area in the photo",
      surface: surfaces.includes(a.surface as Surface) ? (a.surface as Surface) : "other",
      width_ft: Math.round(w * 2) / 2, height_ft: Math.round(h * 2) / 2,
      sq_ft: same ? 0 : Math.min(MAX_SQFT, sq),
      ruler: String(a.ruler || "").replace(/\s+/g, " ").trim(),
      confidence: confs.includes(a.confidence as Confidence) ? (a.confidence as Confidence) : "low",
      same_as: same,
      note: String(a.note || "").replace(/\s+/g, " ").trim(),
      box: box && box.x2 - box.x1 >= 1 && box.y2 - box.y1 >= 1 ? box : null,
      same_plane: a.same_plane !== false,
      scale_ratio: Number(a.scale_ratio) > 0 ? Math.min(4, Math.max(0.25, Number(a.scale_ratio))) : 1,
    });
  }
  const warnings = (Array.isArray(r.warnings) ? (r.warnings as unknown[]) : []).map((w) => String(w || "").trim()).filter(Boolean);
  return { areas, total_sq_ft: totalOf(areas), warnings };
}
export const totalOf = (areas: { sq_ft: number; same_as?: number }[]): number => areas.reduce((s, a) => s + (a.same_as ? 0 : roundSf(a.sq_ft)), 0);

// ---- the ruler's arithmetic: done here, not guessed ----
export const rulerPx = (r: RulerMark): number => Math.hypot(r.x2 - r.x1, r.y2 - r.y1);
// pixels per inch along the marked ruler — 0 when the mark is too short to trust
export const pxPerInch = (r: RulerMark): number => (r.inches > 0 && rulerPx(r) >= 20 ? rulerPx(r) / r.inches : 0);
export const halfFt = (inches: number): number => Math.round((inches / 12) * 2) / 2;
export const rulerLabel = (r: RulerMark): string => `your mark (${r.inches % 12 === 0 ? `${r.inches / 12} ft` : `${r.inches} in`})`;
// How far the ruler's arithmetic may land from what Claude read off the
// picture before the mark is the thing to doubt, not the eye. A wall
// photographed from the side runs away from the camera: a foot at the far
// end covers fewer pixels than a foot at the ruler, so one scale across the
// whole photo is wrong — Claude reports how much bigger a foot looks at the
// spot (scale_ratio), and that correction is applied. When the two still
// disagree badly, the picture is telling us the mark can't be trusted there.
const AGREE = 1.5;
// A photo with a ruler on it: an area on the same surface is sized from its
// box and the ruler's scale at that spot — the owner's mark, not Claude's
// eye. An outline the owner drew is the box for that photo's one area.
export function refineWithRulers(result: MeasureResult, metas: (ImageMeta | null | undefined)[]): MeasureResult {
  const areas = result.areas.map((a) => {
    if (a.same_as) return a;
    const m = metas[a.photo - 1];
    if (!m || !m.ruler) return a;
    const base = pxPerInch(m.ruler);
    if (!base) return a;
    const only = result.areas.filter((x) => x.photo === a.photo && !x.same_as).length === 1;
    // the owner drew the outline themselves and marked the ruler: that is the
    // measurement, and no second-guessing it
    const ownOutline = !!(m.box && only);
    const box = ownOutline ? m.box! : a.box;
    if (!box || !a.same_plane) return a;
    // a foot at the spot covers scale_ratio times the pixels it covers at the mark
    const ratio = a.scale_ratio > 0 ? a.scale_ratio : 1;
    const scale = base * ratio;
    const wIn = Math.abs(box.x2 - box.x1) / scale, hIn = Math.abs(box.y2 - box.y1) / scale;
    if (wIn <= 0 || hIn <= 0) return a;
    const sq = Math.min(MAX_SQFT, Math.max(1, roundSf((wIn * hIn) / 144)));
    // the mark and the eye must land near each other; when they don't, the
    // eye is kept and the owner is told to put the mark beside the spot
    const eye = Math.max(1, roundSf(a.sq_ft));
    const off = Math.max(sq / eye, eye / sq);
    if (!ownOutline && a.sq_ft > 0 && off > AGREE) {
      return { ...a, box, confidence: (a.confidence === "high" ? "medium" : a.confidence) as Confidence,
        note: [a.note, "your ruler is far from this spot — mark one beside it for a solid number"].filter(Boolean).join(" · ") };
    }
    return {
      ...a, box,
      width_ft: halfFt(wIn), height_ft: halfFt(hIn), sq_ft: sq,
      ruler: rulerLabel(m.ruler),
      // square to the mark, or the owner's own outline, is solid; measured a
      // long way from the mark is not
      confidence: (ownOutline || (ratio >= 0.8 && ratio <= 1.25) ? "high" : "medium") as Confidence,
    };
  });
  return { ...result, areas, total_sq_ft: totalOf(areas) };
}

// the measured square feet onto the job's lines: the chosen square-foot line
// takes the number (its key and wording kept), or a Plaster line is added
// when the job has none. The price is the book's when the caller may price;
// otherwise 0, and the admin's auto-price fills it on their next open.
export function applyMeasure(items: SfLine[], lineIndex: number | null, sqft: number, plasterPrice = 0): SfLine[] {
  const n = roundSf(sqft);
  const next = items.map((it) => ({ ...it }));
  if (lineIndex !== null && lineIndex >= 0 && lineIndex < next.length) {
    next[lineIndex] = { ...next[lineIndex], qty: n, unit: normUnit(next[lineIndex].unit || "") === "SF" ? next[lineIndex].unit : "SF" };
    return next;
  }
  next.push({ description: "Plaster", qty: n, unit: "SF", unit_price: plasterPrice, key: "plaster" });
  return next;
}
// the line on the job's notes — what was measured, from what, and by what;
// when the owner changed Claude's numbers, what the estimate was
export const measureNote = (r: MeasureResult, photos: number, day: string, estimateTotal?: number): string => {
  const parts = r.areas.filter((a) => !a.same_as && a.sq_ft > 0).map((a) => `${a.where} ${a.sq_ft} sq ft`);
  const rulers = [...new Set(r.areas.map((a) => a.ruler).filter(Boolean))];
  const changed = estimateTotal !== undefined && roundSf(estimateTotal) !== roundSf(r.total_sq_ft);
  return `📷 ${day} · ${r.total_sq_ft} sq ft ${changed ? `from ${photos} photo${photos === 1 ? "" : "s"}, Claude's estimate of ${roundSf(estimateTotal!)} sq ft changed by hand` : `measured from ${photos} photo${photos === 1 ? "" : "s"}`}${parts.length ? ` (${parts.join(", ")})` : ""}${rulers.length ? ` · ruler: ${rulers.join(", ")}` : ""}${changed ? "" : " · check it with the tape"}`;
};
// the note when the owner typed the number in themselves — with Claude's estimate on record when there was one
export const typedNote = (sqft: number, day: string, estimateTotal?: number): string =>
  `📷 ${day} · ${roundSf(sqft)} sq ft typed in by hand${estimateTotal !== undefined ? ` (Claude's estimate was ${roundSf(estimateTotal)} sq ft)` : ""}`;
// a line that already carries a number — typed on the card, or read off the
// PO — is never overwritten by an estimate; only a typed number replaces it.
// The price list's own lines start at 1, which is the blank.
export const lineHasNumber = (items: SfLine[], lineIndex: number | null): boolean =>
  lineIndex !== null && lineIndex >= 0 && lineIndex < items.length && Number(items[lineIndex].qty) > 1;
export const CONF_LABEL: Record<Confidence, string> = { high: "solid", medium: "rough", low: "a guess" };

// ---- asking the server ----
export type MeasureOutcome = { ok: true; result: MeasureResult } | { ok: false; note: string };
export interface MeasurePhoto { name: string; blob: Blob; width?: number; height?: number; marks?: PhotoMarks }
const b64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const mediaOf = (p: MeasurePhoto): string => {
  const t = (p.blob.type || "").toLowerCase();
  if (/^image\/(jpeg|png|webp|gif)$/.test(t)) return t;
  return /\.png$/i.test(p.name) ? "image/png" : /\.webp$/i.test(p.name) ? "image/webp" : "image/jpeg";
};
// the photos (already shrunk) and the hints, to Claude, through the server
export async function measurePhotos(photos: MeasurePhoto[], hints: MeasureHints): Promise<MeasureOutcome> {
  if (photos.length === 0) return { ok: false, note: "Pick at least one photo" };
  if (photos.length > MAX_PHOTOS) return { ok: false, note: `Up to ${MAX_PHOTOS} photos at a time` };
  try {
    const images = await Promise.all(photos.map(async (p) => ({
      name: p.name, media_type: mediaOf(p), data: await b64(p.blob),
      width: p.width || 0, height: p.height || 0,
      ruler: p.marks?.ruler || null, box: p.marks?.box || null,
    })));
    // loaded here, not at the top: the server reads this file too (for the form's cleanup) and has no browser client
    const { sb } = await import("./supabase");
    const { data: { session } } = await sb().auth.getSession();
    const res = await fetch("/api/measure", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
      body: JSON.stringify({ images, hints }),
    });
    const out = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; note?: string; error?: string };
    if (res.status === 413) return { ok: false, note: "Those photos are too big to send together — try fewer at a time" };
    if (!res.ok) return { ok: false, note: out.error || out.note || `The server said ${res.status}` };
    if (!out.ok) return { ok: false, note: out.note || "Claude couldn't measure these" };
    const result = cleanMeasure(out.result);
    if (result.areas.length === 0) return { ok: false, note: result.warnings[0] || "Claude couldn't make out an area to measure in these photos — try one with a door or an outlet in the shot" };
    return { ok: true, result };
  } catch {
    return { ok: false, note: "No signal — try again in a moment" };
  }
}
