// A job's pictures as one PDF to send out: the job on top, then the before
// pictures and the after pictures, two to a page, each with when it was
// taken and who took it (read off the file's own name, the way the inbox
// names them: before_2026-10-06_151012_jose_x7k2_1.jpg). Pure: bytes in,
// bytes out — the page fetches the pictures and hands them here.
import type { PDFPageDrawTextOptions } from "pdf-lib";
import { COMPANY } from "./company";
import { LOGO_RGB, type Rgb } from "./logoColors";

export interface PhotoIn { name: string; bytes: Uint8Array; type?: string }
export interface PhotoJob { po: string; partner?: string; address?: string; apt?: string; description?: string; date: string }
export type PhotoKind = "before" | "after" | "other";
export const photoKindOf = (name: string): PhotoKind => (/^before/i.test(name) ? "before" : /^after/i.test(name) ? "after" : "other");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "before_2026-10-06_151012_jose_x7k2_1.jpg" → "Oct 6, 2026 3:10 PM · Jose"
export function photoCaption(name: string): string {
  const m = name.match(/^(?:before|after|noaccess)_(\d{4})-(\d{2})-(\d{2})(?:_(\d{2})(\d{2})\d{2})?(?:_([a-z]+))?/i);
  if (!m) return "";
  const [, y, mo, d, hh, mm, who] = m;
  const day = `${MONTHS[Number(mo) - 1] || mo} ${Number(d)}, ${y}`;
  let time = "";
  if (hh !== undefined) {
    // the inbox stamps the time in UTC; shown as New York's
    const at = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm)));
    time = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(at);
    const nyDay = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(at);
    return `${nyDay} ${time}${who && who !== "crew" && who !== "sms" ? ` · ${who[0].toUpperCase()}${who.slice(1)}` : ""}`;
  }
  return `${day}${who && who !== "crew" ? ` · ${who[0].toUpperCase()}${who.slice(1)}` : ""}`;
}
// the PO number by itself: the reader sometimes leaves "PO#" on the front
const poOf = (po: string) => (po || "").replace(/^PO#?\s*/i, "").trim();
// "PO 116843 photos.pdf". What a file name can't carry comes out: "#?%&" (a
// web address ends at them, so the copy kept on the job drops them too) and
// the same slashes, colons and quotes the invoice's file name trades for "-".
export const photoPdfName = (j: PhotoJob) => {
  const po = poOf(j.po).replace(/[#?%&]+/g, "").replace(/[\\/:*"<>|]/g, "-").replace(/\s{2,}/g, " ").trim().slice(0, 60);
  return `PO ${po || "job"} photos.pdf`;
};

// Helvetica holds Latin letters, the usual marks and the common typographic
// quotes and dashes, and nothing else: one Cyrillic file name or one arrow or
// check mark in the description would stop the whole PDF. A letter with an
// accent Helvetica lacks falls back to its plain twin; what has none is left
// out; any run of whitespace is a space.
const SAFE = /^[\x20-\x7E\xA0-\xFF‘’‚“”„–—•€]$/;
export function pdfSafeText(s: string): string {
  let out = "";
  for (const ch of s || "") {
    if (/\s/.test(ch)) { out += " "; continue; }
    if (SAFE.test(ch)) { out += ch; continue; }
    for (const d of ch.normalize("NFKD")) if (SAFE.test(d)) out += d;
  }
  return out;
}

export async function buildPhotoPdf(j: PhotoJob, photos: PhotoIn[], logo?: Uint8Array): Promise<{ bytes: Uint8Array; pages: number; skipped: string[] }> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const C = (c: Rgb) => rgb(c[0], c[1], c[2]);
  const { ink: INK, muted: MUTED, teal: TEAL, hair: HAIR, cream: BAND } = LOGO_RGB;
  const M = 48, PW = 612, PH = 792, RIGHT = PW - M, W = RIGHT - M;
  const order = (k: PhotoKind) => (k === "before" ? 0 : k === "after" ? 1 : 2);
  const sorted = [...photos].sort((a, b) => order(photoKindOf(a.name)) - order(photoKindOf(b.name)) || a.name.localeCompare(b.name));
  // a picture's name as the PDF can print it; one that has nothing printable
  // left (a name typed in another alphabet) goes by its place in the order
  const nameOf = (i: number, name: string) => {
    const base = pdfSafeText(name.replace(/\.\w+$/, "")).trim();
    return /[A-Za-z0-9]/.test(base) ? pdfSafeText(name).trim() : `Picture ${i + 1}`;
  };
  const skipped: string[] = [];
  const skippedNames: string[] = [];
  // the pictures first, so a page is only started for ones the PDF can hold
  const embedded: { name: string; label: string; kind: PhotoKind; img: Awaited<ReturnType<typeof doc.embedJpg>> }[] = [];
  for (const [i, p] of sorted.entries()) {
    try {
      const isPng = /^image\/png$/i.test(p.type || "") || /\.png$/i.test(p.name) || (p.bytes[0] === 0x89 && p.bytes[1] === 0x50);
      const img = isPng ? await doc.embedPng(p.bytes) : await doc.embedJpg(p.bytes);
      embedded.push({ name: p.name, label: nameOf(i, p.name), kind: photoKindOf(p.name), img });
    } catch { skipped.push(p.name); skippedNames.push(nameOf(i, p.name)); }
  }
  let page = doc.addPage([PW, PH]);
  let pages = 1;
  // every string goes through the font's safe set on its way onto the page
  const draw = (s: string, o: PDFPageDrawTextOptions) => page.drawText(pdfSafeText(s), o);
  // words onto lines no wider than `width`; a single word wider than that is cut into pieces
  const wrap = (text: string, size: number, width: number, font = helv): string[] => {
    const fits = (s: string) => font.widthOfTextAtSize(s, size) <= width;
    const words = pdfSafeText(text).trim().split(/\s+/).filter(Boolean).flatMap((w) => {
      const parts: string[] = []; let rest = w;
      while (rest && !fits(rest)) { let k = rest.length - 1; while (k > 1 && !fits(rest.slice(0, k))) k -= 1; parts.push(rest.slice(0, k)); rest = rest.slice(k); }
      if (rest) parts.push(rest);
      return parts;
    });
    const lines: string[] = []; let cur = "";
    for (const w of words) { const next = cur ? `${cur} ${w}` : w; if (!fits(next) && cur) { lines.push(cur); cur = w; } else cur = next; }
    if (cur) lines.push(cur);
    return lines;
  };
  // ---- the job, on top of the first page ----
  let y = PH - 54;
  if (logo) {
    try { const lg = await doc.embedPng(logo); const h = 34, w = (lg.width / lg.height) * h; page.drawImage(lg, { x: M, y: y - h + 8, width: w, height: h }); } catch { /* no logo: the name stands */ }
  }
  draw(COMPANY.shortName, { x: logo ? M + 110 : M, y: y - 4, size: 13, font: bold, color: C(INK) });
  draw("Job photos", { x: RIGHT - bold.widthOfTextAtSize("Job photos", 13), y: y - 4, size: 13, font: bold, color: C(TEAL) });
  y -= 34;
  page.drawLine({ start: { x: M, y }, end: { x: RIGHT, y }, thickness: 0.8, color: C(HAIR) });
  y -= 22;
  const lineOf = (label: string, value: string) => {
    const lines = wrap(value, 10.5, W - 92);
    if (!lines.length) return;
    draw(label.toUpperCase(), { x: M, y, size: 8, font: bold, color: C(MUTED) });
    for (const l of lines) { draw(l, { x: M + 92, y, size: 10.5, font: helv, color: C(INK) }); y -= 16; }
  };
  lineOf("PO", poOf(j.po));
  lineOf("Partner", j.partner || "");
  lineOf("Address", [j.address, j.apt ? `Apt ${j.apt}` : ""].filter(Boolean).join(", "));
  lineOf("Date", j.date);
  if (j.description) {
    const lines = wrap(j.description, 10, W - 92);
    // as many lines as the page has room for above the picture count; a cut is marked
    const room = Math.max(1, Math.floor((y - M - 40) / 14));
    if (lines.length > room) {
      lines.length = room;
      let last = lines[room - 1].replace(/[\s,;:.]+$/, "");
      while (last && helv.widthOfTextAtSize(`${last}...`, 10) > W - 92) last = last.slice(0, -1);
      lines[room - 1] = `${last}...`;
    }
    if (lines.length) {
      draw("WORK", { x: M, y, size: 8, font: bold, color: C(MUTED) });
      for (const l of lines) { draw(l, { x: M + 92, y, size: 10, font: helv, color: C(INK) }); y -= 14; }
    }
  }
  const n = (k: PhotoKind) => embedded.filter((e) => e.kind === k).length;
  y -= 6;
  draw(`${n("before")} before · ${n("after")} after${n("other") ? ` · ${n("other")} more` : ""}`, { x: M, y, size: 9.5, font: helv, color: C(MUTED) });
  y -= 18;
  if (skippedNames.length) {
    // pictures the browser couldn't turn into a JPEG (a HEIC on a computer, a file that isn't a picture)
    const note = `${skippedNames.length} picture${skippedNames.length === 1 ? "" : "s"} the PDF can't hold: ${skippedNames.join(", ")}`;
    for (const l of wrap(note, 9, W)) { draw(l, { x: M, y, size: 9, font: helv, color: C(MUTED) }); y -= 13; }
    y -= 5;
  }
  // ---- the pictures, two to a page ----
  const SLOT_H = 300, CAP_H = 16, GAP = 14;
  let lastKind: PhotoKind | null = null;
  for (const e of embedded) {
    const need = SLOT_H + CAP_H + GAP + (lastKind !== e.kind ? 22 : 0);
    if (y - need < M) { page = doc.addPage([PW, PH]); pages += 1; y = PH - M; }
    if (lastKind !== e.kind) {
      page.drawRectangle({ x: M, y: y - 16, width: W, height: 18, color: C(BAND) });
      draw(e.kind === "before" ? "BEFORE" : e.kind === "after" ? "AFTER" : "MORE", { x: M + 8, y: y - 11, size: 9, font: bold, color: C(TEAL) });
      y -= 22;
      lastKind = e.kind;
    }
    const scale = Math.min(W / e.img.width, SLOT_H / e.img.height);
    const w = e.img.width * scale, h = e.img.height * scale;
    page.drawImage(e.img, { x: M + (W - w) / 2, y: y - h, width: w, height: h });
    y -= h + 12;
    const cap = photoCaption(e.name) || e.label;
    draw(cap, { x: M, y, size: 9, font: helv, color: C(MUTED) });
    y -= CAP_H + GAP - 12;
  }
  if (embedded.length === 0) draw("No pictures the PDF could hold.", { x: M, y, size: 10, font: helv, color: C(MUTED) });
  const bytes = await doc.save();
  return { bytes, pages, skipped };
}
