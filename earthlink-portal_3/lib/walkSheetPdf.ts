// The NYCHA walk sheet as a real PDF file — what "⬇ PDF" on the proposals
// list hands over without opening the sheet. Same letterhead and band-and-rule
// look as the printed sheet and the PACT proposal letter; the table wraps long
// descriptions and carries on to a second page with its header repeated.
import { COMPANY } from "./company";

export interface WalkSheetLine { line?: number; code: string; category?: string; description: string; unit: string; qty: number; unit_price: number }
export interface WalkSheetFields {
  number: string;            // the sheet number
  contractNumber?: string;
  development?: string; address?: string; apt?: string; stairhall?: string;
  job?: string;              // "For"
  releaseNumber?: string; walkDate?: string; nychaStaff?: string; vendorStaff?: string;
  lines: WalkSheetLine[];
}

type Rgb = readonly [number, number, number];
const INK: Rgb = [0.122, 0.137, 0.157];
const MUTED: Rgb = [0.431, 0.431, 0.400];
const BRAND: Rgb = [0.761, 0.290, 0.039];
const BAND: Rgb = [0.957, 0.945, 0.922];
const HAIR: Rgb = [0.863, 0.843, 0.796];
const WHITE: Rgb = [1, 1, 1];

const cents = (v: number) => Math.round((Number(v) || 0) * 100) / 100;
export const walkSheetMoney = (n: number) => `$${cents(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const walkSheetTotal = (lines: WalkSheetLine[]) => lines.reduce((s, l) => s + cents(cents(l.unit_price) * (Number(l.qty) || 0)), 0);
export const walkSheetFileName = (f: WalkSheetFields) =>
  `NYCHA walk sheet ${[f.development || f.address, f.job].filter(Boolean).join(" - ") || f.number}`.replace(/[\\/:*?"<>|]/g, "-").slice(0, 120) + ".pdf";

export async function buildWalkSheetPdf(f: WalkSheetFields, logo?: Uint8Array): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const C = (c: Rgb) => rgb(c[0], c[1], c[2]);
  const L = COMPANY.letterhead;
  const M = 40, RIGHT = 572, W = RIGHT - M;
  let page = doc.addPage([612, 792]);
  let y = 750;
  let pageNo = 1;

  const put = (t: string, x: number, yy: number, size = 9, font = helv, color: Rgb = INK) => page.drawText(t, { x, y: yy, size, font, color: C(color) });
  const putR = (t: string, xr: number, yy: number, size = 9, font = helv, color: Rgb = INK) => put(t, xr - font.widthOfTextAtSize(t, size), yy, size, font, color);
  const rule = (yy: number, w = 0.6, color: Rgb = HAIR) => page.drawLine({ start: { x: M, y: yy }, end: { x: RIGHT, y: yy }, thickness: w, color: C(color) });
  const wrap = (t: string, width: number, size: number, font = helv) => {
    const fit = (word: string): string[] => {
      if (font.widthOfTextAtSize(word, size) <= width) return [word];
      const parts: string[] = []; let piece = "";
      for (const ch of word) { if (font.widthOfTextAtSize(piece + ch, size) > width && piece) { parts.push(piece); piece = ch; } else piece += ch; }
      if (piece) parts.push(piece);
      return parts;
    };
    const out: string[] = []; let cur = "";
    for (const word of String(t || "").split(/\s+/).flatMap(fit)) {
      const next = cur ? `${cur} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && cur) { out.push(cur); cur = word; } else cur = next;
    }
    if (cur) out.push(cur);
    return out.length ? out : [""];
  };
  const footer = () => {
    rule(50, 0.6);
    put(L.name, M, 38, 7.5, helv, MUTED);
    putR(`Sheet ${f.number} · page ${pageNo}`, RIGHT, 38, 7.5, helv, MUTED);
  };

  // ---- letterhead, centered like the company's paper ----
  const ctr = (t: string, size: number, font = helv, color: Rgb = INK) => put(t, (612 - font.widthOfTextAtSize(t, size)) / 2, y, size, font, color);
  if (logo) {
    try {
      const img = await doc.embedPng(logo);
      const h = 36, w = (img.width / img.height) * h;
      page.drawImage(img, { x: (612 - w) / 2, y: y - h + 8, width: w, height: h });
      y -= h + 7;
    } catch { /* unreadable logo — text letterhead */ }
  }
  ctr(L.name, 13, bold); y -= 14;
  ctr(L.address, 8.5, helv, MUTED); y -= 11;
  ctr(L.phones.replace(/^Phone:\s*/, "").replace(/\s*\|\s*/g, "   ·   "), 8.5, helv, MUTED); y -= 11;
  ctr(L.emails.replace(/^Email:\s*/, "").replace(/\s*\|\s*Office Email:\s*/, "   ·   "), 8.5, helv, MUTED); y -= 8;
  rule(y, 1.6, BRAND); y -= 26;

  // ---- title band ----
  put("PROPOSAL — NYCHA WALK SHEET", M, y, 16, bold, BRAND);
  putR(`SHEET # ${f.number}`, RIGHT, y + 2, 9, bold, INK);
  y -= 8; rule(y, 2.2, BRAND); y -= 18;

  // ---- the header fields, in a band ----
  const fields: [string, string][] = [
    ["Contract #", f.contractNumber || ""], ["Development", f.development || ""],
    ["Address", [f.address, f.apt && `Apt ${f.apt}`, f.stairhall && `Stairhall ${f.stairhall}`].filter(Boolean).join(" · ")],
    ["For", f.job || ""], ["Release #", f.releaseNumber || ""], ["Walk date", f.walkDate || ""],
    ["NYCHA staff", f.nychaStaff || ""], ["Vendor staff", f.vendorStaff || ""],
  ];
  const shown = fields.filter(([k, v]) => v || ["Contract #", "Development", "Address", "For"].includes(k));
  const bandH = shown.length * 13 + 12;
  page.drawRectangle({ x: M, y: y - bandH + 10, width: W, height: bandH, color: C(BAND) });
  let fy = y - 2;
  for (const [k, v] of shown) {
    put(k.toUpperCase(), M + 8, fy, 7.5, helv, MUTED);
    put(v || "—", M + 96, fy, 9.5, bold, INK);
    fy -= 13;
  }
  y = y - bandH + 10 - 18;

  // ---- the table ----
  // Line | Item | Category | Description | UOM | Qty | Price | Total
  // right edges for the number columns leave room for a five-figure total
  const X = { line: M, code: M + 34, cat: M + 92, desc: M + 164, uom: M + 338, qty: M + 372, price: M + 418, total: RIGHT };
  const DESC_W = X.uom - X.desc - 8, CAT_W = X.desc - X.cat - 8;
  const head = (continued = false) => {
    page.drawRectangle({ x: M, y: y - 5, width: W, height: 17, color: C(BAND) });
    put("LINE", X.line + 2, y, 7.5, bold, MUTED); put("ITEM", X.code, y, 7.5, bold, MUTED); put("CATEGORY", X.cat, y, 7.5, bold, MUTED);
    put(continued ? "DESCRIPTION (CONTINUED)" : "DESCRIPTION", X.desc, y, 7.5, bold, MUTED); put("UOM", X.uom, y, 7.5, bold, MUTED);
    putR("QTY", X.qty + 30, y, 7.5, bold, MUTED); putR("PRICE", X.price + 52, y, 7.5, bold, MUTED); putR("TOTAL", X.total, y, 7.5, bold, MUTED);
    y -= 5; rule(y, 1.4, BRAND); y -= 14;
  };
  const newPage = () => {
    footer();
    page = doc.addPage([612, 792]); pageNo += 1; y = 740;
    head(true);
  };
  head();
  for (const l of f.lines) {
    const dl = wrap(l.description, DESC_W, 8.5);
    const cl = wrap(l.category || "", CAT_W, 7.5);
    const n = Math.max(dl.length, cl.length);
    const rowH = n * 10.5 + 6;
    if (y - rowH < 70) newPage();
    put(l.line ? String(l.line) : "", X.line + 2, y, 8, helv, MUTED);
    put(l.code || "", X.code, y, 8, helv, MUTED);
    cl.forEach((t, i) => put(t, X.cat, y - i * 10.5, 7.5, helv, MUTED));
    dl.forEach((t, i) => put(t, X.desc, y - i * 10.5, 8.5, helv, INK));
    put(l.unit || "", X.uom, y, 8, helv, MUTED);
    putR(String(l.qty), X.qty + 30, y, 8.5, helv, INK);
    putR(walkSheetMoney(l.unit_price), X.price + 52, y, 8.5, helv, MUTED);
    putR(walkSheetMoney(cents(l.unit_price) * (Number(l.qty) || 0)), X.total, y, 8.5, bold, INK);
    y -= rowH;
    rule(y + 4, 0.5);
    y -= 4;
  }
  if (f.lines.length === 0) { put("No quantities entered on this walk sheet yet.", X.desc, y, 9, helv, MUTED); y -= 16; }

  // ---- total band ----
  if (y - 30 < 70) newPage();
  y -= 6;
  page.drawRectangle({ x: M, y: y - 8, width: W, height: 24, color: C(BRAND) });
  put("TOTAL", X.uom, y, 9.5, bold, WHITE);
  putR(walkSheetMoney(walkSheetTotal(f.lines)), RIGHT - 8, y, 11, bold, WHITE);
  footer();
  return doc.save();
}
