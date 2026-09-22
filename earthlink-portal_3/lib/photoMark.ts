// The owner's marks, drawn onto the photo before Claude sees it: a red
// ruler line with its length written on it, and a red outline around the
// spot. Claude reads the marks off the picture, and the server does the
// ruler's arithmetic from the same numbers. Browser only (canvas).
import type { PhotoMarks } from "./measure";

export interface SizedBlob { blob: Blob; width: number; height: number }
// the photo's own size in pixels — 0 × 0 when the browser can't decode it
export async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  try {
    const bmp = await createImageBitmap(blob);
    const out = { width: bmp.width, height: bmp.height };
    bmp.close();
    return out;
  } catch { return { width: 0, height: 0 }; }
}
export const inchesLabel = (inches: number): string => (inches % 12 === 0 ? `${inches / 12} ft` : inches >= 12 ? `${Math.floor(inches / 12)} ft ${Math.round(inches % 12)} in` : `${inches} in`);

// a copy of the photo with the marks on it, as JPEG; the plain photo when
// there are no marks or the browser can't draw
export async function annotate(blob: Blob, marks: PhotoMarks | undefined): Promise<SizedBlob> {
  const size = await imageSize(blob);
  if (!marks || (!marks.ruler && !marks.box) || !size.width) return { blob, ...size };
  try {
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width; canvas.height = bmp.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { blob, ...size };
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const lw = Math.max(3, Math.round(Math.max(canvas.width, canvas.height) / 350));
    ctx.lineWidth = lw; ctx.strokeStyle = "#e11d1d"; ctx.fillStyle = "#e11d1d"; ctx.lineCap = "round";
    if (marks.box) {
      const b = marks.box;
      ctx.setLineDash([lw * 3, lw * 2]);
      ctx.strokeRect(Math.min(b.x1, b.x2), Math.min(b.y1, b.y2), Math.abs(b.x2 - b.x1), Math.abs(b.y2 - b.y1));
      ctx.setLineDash([]);
    }
    if (marks.ruler) {
      const r = marks.ruler;
      ctx.beginPath(); ctx.moveTo(r.x1, r.y1); ctx.lineTo(r.x2, r.y2); ctx.stroke();
      // end ticks, square to the line
      const ang = Math.atan2(r.y2 - r.y1, r.x2 - r.x1), t = lw * 4;
      for (const [x, y] of [[r.x1, r.y1], [r.x2, r.y2]]) {
        ctx.beginPath(); ctx.moveTo(x - Math.sin(ang) * t, y + Math.cos(ang) * t); ctx.lineTo(x + Math.sin(ang) * t, y - Math.cos(ang) * t); ctx.stroke();
      }
      // the length, on a white tag by the middle of the line
      const label = inchesLabel(r.inches);
      const fs = Math.max(18, Math.round(Math.max(canvas.width, canvas.height) / 40));
      ctx.font = `bold ${fs}px sans-serif`;
      const tw = ctx.measureText(label).width, mx = (r.x1 + r.x2) / 2, my = (r.y1 + r.y2) / 2;
      const px = Math.min(Math.max(4, mx + lw * 3), canvas.width - tw - fs), py = Math.min(Math.max(fs + 4, my), canvas.height - 4);
      ctx.fillStyle = "rgba(255,255,255,0.92)"; ctx.fillRect(px - 4, py - fs, tw + 8, fs + 6);
      ctx.fillStyle = "#e11d1d"; ctx.fillText(label, px, py);
    }
    const out = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    return { blob: out || blob, ...size };
  } catch { return { blob, ...size }; }
}
