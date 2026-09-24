// The NYCHA walk sheet as a real PDF file — what "⬇ PDF" on the proposals
// list hands over without opening the sheet. In the logo's colors: the
// letterhead with a teal-and-green rule (the globe's two halves), the job's
// details across one cream band, the line items with each category under its
// description, a brown total bar, and what the work is for (the sheet's "For")
// under it as the scope of work. The table carries on to a next page with its
// header repeated; every page is footed "page N of M".
import { COMPANY } from "./company";
import { LOGO_RGB, type Rgb } from "./logoColors";

export interface WalkSheetLine { line?: number; code: string; category?: string; description: string; unit: string; qty: number; unit_price: number }
export interface WalkSheetScopeGroup { title: string; items: string[] }
export interface WalkSheetFields {
  number: string;            // the sheet number
  contractNumber?: string;
  development?: string; address?: string; apt?: string; stairhall?: string;
  job?: string;              // "For" — printed as the scope of work
  releaseNumber?: string; walkDate?: string; nychaStaff?: string; vendorStaff?: string;
  date?: string;             // the date on the proposal (MM/DD/YYYY); today when left out
  scope?: { intro?: string; groups: WalkSheetScopeGroup[] }; // the work, grouped and numbered, in place of "For"
  lines: WalkSheetLine[];
}

const { brown: BROWN, teal: TEAL, green: GREEN, tan: TAN, ink: INK, muted: MUTED, cream: CREAM, hair: HAIR } = LOGO_RGB;
const WHITE: Rgb = [1, 1, 1];

const cents = (v: number) => Math.round((Number(v) || 0) * 100) / 100;
export const walkSheetMoney = (n: number) => `$${cents(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const walkSheetTotal = (lines: WalkSheetLine[]) => lines.reduce((s, l) => s + cents(cents(l.unit_price) * (Number(l.qty) || 0)), 0);
export const walkSheetFileName = (f: WalkSheetFields) =>
  `${[f.development || f.address, f.job].filter(Boolean).join(" - ") || f.number} Walk Sheet`.replace(/[\\/:*?"<>|]/g, "-").slice(0, 120) + ".pdf";
const today = () => {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
};

export async function buildWalkSheetPdf(f: WalkSheetFields, logo?: Uint8Array): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  type Font = typeof helv;
  const C = (c: Rgb) => rgb(c[0], c[1], c[2]);
  const L = COMPANY.letterhead;
  const M = 50, RIGHT = 562, W = RIGHT - M;
  const TOP = 752, FLOOR = 72; // nothing prints below FLOOR but the footer
  let page = doc.addPage([612, 792]);
  let y = TOP;

  // widths as drawn — drawText does not kern, so neither may the measuring
  const tw = (t: string, size: number, font: Font = helv) => [...String(t)].reduce((a, ch) => a + font.widthOfTextAtSize(ch, size), 0);
  const put = (t: string, x: number, yy: number, size = 10, font: Font = helv, color: Rgb = INK) => page.drawText(t, { x, y: yy, size, font, color: C(color) });
  const putR = (t: string, xr: number, yy: number, size = 10, font: Font = helv, color: Rgb = INK) => put(t, xr - tw(t, size, font), yy, size, font, color);
  const putC = (t: string, yy: number, size = 10, font: Font = helv, color: Rgb = INK) => put(t, (612 - tw(t, size, font)) / 2, yy, size, font, color);
  const rule = (yy: number, w = 0.6, color: Rgb = HAIR, x0 = M, x1 = RIGHT) => page.drawLine({ start: { x: x0, y: yy }, end: { x: x1, y: yy }, thickness: w, color: C(color) });
  const wrap = (t: string, width: number, size: number, font: Font = helv) => {
    // a single run wider than the column breaks mid-word rather than print through the next one
    const fit = (word: string): string[] => {
      if (tw(word, size, font) <= width) return [word];
      const parts: string[] = []; let piece = "";
      for (const ch of word) { if (tw(piece + ch, size, font) > width && piece) { parts.push(piece); piece = ch; } else piece += ch; }
      if (piece) parts.push(piece);
      return parts;
    };
    const out: string[] = []; let cur = "";
    for (const word of String(t || "").split(/\s+/).filter(Boolean).flatMap(fit)) {
      const next = cur ? `${cur} ${word}` : word;
      if (tw(next, size, font) > width && cur) { out.push(cur); cur = word; } else cur = next;
    }
    if (cur) out.push(cur);
    return out.length ? out : [""];
  };
  const newPage = () => { page = doc.addPage([612, 792]); y = TOP - 12; };

  // ---- letterhead, centered like the company's paper ----
  if (logo) {
    try {
      const img = await doc.embedPng(logo);
      const h = 46, w = (img.width / img.height) * h;
      page.drawImage(img, { x: (612 - w) / 2, y: y - h + 8, width: w, height: h });
      y -= h + 8;
    } catch { /* unreadable logo — text letterhead */ }
  }
  putC(L.name, y, 14.5, bold, BROWN); y -= 15;
  putC(L.address, y, 8.5, helv, MUTED); y -= 11.5;
  putC(L.phones.replace(/^Phone:\s*/, "").replace(/\s*\|\s*/g, "  ·  "), y, 8.5, helv, MUTED); y -= 11.5;
  putC(L.emails.replace(/^Email:\s*/, "").replace(/\s*\|\s*Office Email:\s*/, "  ·  "), y, 8.5, helv, MUTED); y -= 12;
  // the globe's two halves, ocean then land
  page.drawRectangle({ x: M, y: y - 1.25, width: W / 2, height: 2.5, color: C(TEAL) });
  page.drawRectangle({ x: M + W / 2, y: y - 1.25, width: W / 2, height: 2.5, color: C(GREEN) });
  y -= 34;

  // ---- title, with the sheet number and date against it ----
  put("PROPOSAL", M, y, 20, bold, BROWN);
  const date = f.date || today();
  const metaW = Math.max(tw(f.number, 10.5, bold), tw(date, 10.5, bold));
  const meta = (label: string, value: string, yy: number) => {
    putR(value, RIGHT, yy, 10.5, bold, BROWN);
    putR(label, RIGHT - metaW - 10, yy + 1, 7.5, bold, TAN);
  };
  meta("SHEET #", f.number, y + 9);
  meta("DATE", date, y - 6);
  y -= 16;
  put("NYCHA Walk Sheet", M, y, 10.5, helv, TEAL);
  y -= 26;

  // ---- the job's details, flowed across one cream band ----
  const fields: [string, string][] = ([
    ["CONTRACT #", f.contractNumber || ""], ["DEVELOPMENT", f.development || ""],
    ["ADDRESS", [f.address, f.apt && `Apt ${f.apt}`, f.stairhall && `Stairhall ${f.stairhall}`].filter(Boolean).join(", ")],
    ["RELEASE #", f.releaseNumber || ""], ["WALK DATE", f.walkDate || ""],
    ["NYCHA STAFF", f.nychaStaff || ""], ["VENDOR STAFF", f.vendorStaff || ""],
  ] as [string, string][]).filter(([k, v]) => v || k === "CONTRACT #" || k === "DEVELOPMENT");
  const inner = W - 24, FGAP = 40;
  type Cell = { k: string; lines: string[]; w: number };
  const rows: Cell[][] = [[]];
  let used = 0;
  for (const [k, v] of fields) {
    const lines = wrap(v || "—", inner, 10.5, bold);
    const w = Math.min(inner, Math.max(tw(k, 7.5, bold), ...lines.map((ln) => tw(ln, 10.5, bold))));
    const row = rows[rows.length - 1];
    if (row.length && used + FGAP + w > inner) { rows.push([]); used = 0; }
    rows[rows.length - 1].push({ k, lines, w });
    used += (rows[rows.length - 1].length > 1 ? FGAP : 0) + w;
  }
  const rowH = (r: Cell[]) => 16 + 13 * Math.max(...r.map((c) => c.lines.length));
  const bandH = rows.reduce((s, r) => s + rowH(r), 0) + 8 * (rows.length - 1) + 11;
  page.drawRectangle({ x: M, y: y + 13 - bandH, width: W, height: bandH, color: C(CREAM) });
  for (const r of rows) {
    // the spare room in a full row goes between its fields, not all at the end
    const spare = rows.length > 1 && r.length > 1 ? (inner - r.reduce((s, c) => s + c.w, 0)) / (r.length - 1) : FGAP;
    let x = M + 12;
    for (const c of r) {
      put(c.k, x, y, 7.5, bold, TAN);
      c.lines.forEach((ln, i) => put(ln, x, y - 16 - i * 13, 10.5, bold, BROWN));
      x += c.w + Math.min(spare, 80);
    }
    y -= rowH(r) + 8;
  }
  y -= 21;

  // ---- line items ----
  // Line | Item | Description (its category under it) | UOM | Qty | Price | Total
  const X = { line: M + 12, code: M + 40, desc: M + 104, uom: M + 310, qtyR: M + 388, priceR: M + 438, totalR: RIGHT - 12 };
  const DESC_W = X.uom - X.desc - 8;
  const head = (continued = false) => {
    const hd = (t: string, x: number, right = false) => (right ? putR : put)(t, x, y, 7.5, bold, TAN);
    hd("LINE", X.line); hd("ITEM", X.code); hd(continued ? "DESCRIPTION (CONTINUED)" : "DESCRIPTION", X.desc); hd("UOM", X.uom);
    hd("QTY", X.qtyR, true); hd("PRICE", X.priceR, true); hd("TOTAL", X.totalR, true);
    y -= 8; rule(y, 1.2, BROWN); y -= 18;
  };
  head();
  f.lines.forEach((l, idx) => {
    const dl = wrap(l.description, DESC_W, 9.5);
    const cl = l.category ? wrap(`Category: ${l.category}`, DESC_W, 7.5) : [];
    const h = dl.length * 12 + cl.length * 10;
    if (y - h < FLOOR + 10) { newPage(); head(true); }
    // an item code or unit too wide for its column is cut to fit rather than run into the next
    const clip = (t: string, width: number, size: number) => { let s = String(t || ""); while (s && tw(s, size) > width) s = s.slice(0, -1); return s; };
    put(l.line ? String(l.line) : "", X.line, y, 9, helv, MUTED);
    put(clip(l.code, X.desc - X.code - 8, 9), X.code, y, 9, helv, MUTED);
    dl.forEach((t, i) => put(t, X.desc, y - i * 12, 9.5, helv, INK));
    let cy = y - dl.length * 12 - 1;
    cl.forEach((t) => { put(t, X.desc, cy, 7.5, helv, MUTED); cy -= 10; });
    if (!cl.length) cy += 1;
    put(clip(l.unit, 44, 9), X.uom, y, 9, helv, MUTED);
    putR((Number(l.qty) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 }), X.qtyR, y, 9.5);
    putR(walkSheetMoney(l.unit_price), X.priceR, y, 9.5, helv, MUTED);
    putR(walkSheetMoney(cents(l.unit_price) * (Number(l.qty) || 0)), X.totalR, y, 9.5, bold, BROWN);
    y = cy - 4;
    if (idx < f.lines.length - 1) { rule(y, 0.6); y -= 18; }
  });
  if (f.lines.length === 0) { put("No quantities entered on this walk sheet yet.", X.desc, y, 9.5, helv, MUTED); y -= 8; }

  // ---- total ----
  if (y - 36 < FLOOR) newPage();
  const bandTop = y - 6;
  page.drawRectangle({ x: M, y: bandTop - 30, width: W, height: 30, color: C(BROWN) });
  putR("TOTAL", X.qtyR, bandTop - 19, 10, bold, WHITE);
  putR(walkSheetMoney(walkSheetTotal(f.lines)), X.totalR, bandTop - 19.5, 13, bold, WHITE);
  y = bandTop - 30 - 32;

  // ---- scope of work: the groups when given, else the sheet's "For" ----
  const groups = f.scope?.groups?.filter((g) => g.items.length) || [];
  const intro = f.scope ? f.scope.intro || "" : (f.job || "").trim();
  if (groups.length || intro) {
    if (y - 50 < FLOOR) newPage();
    put("SCOPE OF WORK", M, y, 8, bold, TEAL); y -= 8;
    rule(y, 0.8, TEAL, M, M + 24); y -= 16;
    for (const ln of intro ? wrap(intro, W, 10) : []) {
      if (y < FLOOR) newPage();
      put(ln, M, y, 10, helv, INK); y -= 13;
    }
    if (intro && groups.length) y -= 9;
    let n = 0;
    for (const g of groups) {
      if (y - 32 < FLOOR) newPage();
      page.drawRectangle({ x: M, y: y - 3, width: 2.5, height: 12, color: C(GREEN) });
      put(g.title.toUpperCase(), M + 9, y, 7.5, bold, TAN);
      y -= 17;
      for (const item of g.items) {
        n += 1;
        const ls = wrap(item, W - 33, 10);
        if (y - 13.5 * (ls.length - 1) < FLOOR) newPage();
        putR(`${n}.`, M + 25, y, 9.5, bold, GREEN);
        ls.forEach((ln, j) => put(ln, M + 33, y - j * 13, 10, helv, INK));
        y -= 13.5 * ls.length;
      }
      y -= 10;
    }
  }

  // ---- footers, once the page count is known ----
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    page = p;
    rule(48, 0.6);
    put(L.name, M, 36, 7.5, helv, MUTED);
    putR(`Sheet ${f.number}  ·  page ${i + 1} of ${pages.length}`, RIGHT, 36, 7.5, helv, MUTED);
  });
  return doc.save();
}
