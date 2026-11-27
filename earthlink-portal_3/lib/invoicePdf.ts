// The PACT invoice page, in the same look as the proposal letter (lib/proposalPdf.ts):
// the centered letterhead in the logo's colors, the cream bands, the brown total.
// A proposal and the invoice that follows it now read as one company's papers.
//
// This draws only the invoice page (or pages, for a long work list) into a PDF
// the PACT page is building; the PO and the before and after photos are added
// after it there, as before. lib/proposalPdf.ts itself is left as it is.
//
// The money is worked the way the invoice has always worked it: each line is
// its quantity times its unit price, the tax is taken on the sum of the lines,
// and nothing is rounded until it is printed. So the same job bills the same
// total it billed before the new look.
import type { PDFDocument, PDFFont, PDFPage } from "pdf-lib";
import { COMPANY } from "./company";
import { money } from "./proposalDoc";
import { LOGO_RGB, type Rgb } from "./logoColors";

const { ink: INK, muted: MUTED, brown: BROWN, teal: TEAL, green: GREEN, tan: TAN, cream: BAND, hair: HAIR } = LOGO_RGB;
const WHITE: Rgb = [1, 1, 1];

export interface InvoiceLine { description: string; qty: number | string; unit: string; unit_price: number | string }
export interface InvoicePageFields {
  invoiceNumber: string;
  poNumber: string;
  date: string;          // as it is printed, e.g. "Nov 27, 2026"
  billTo: string[];      // the partner first, then its address lines
  jobSite: string[];     // the job's address, then its unit or apartment
  lines: InvoiceLine[];  // the work lines only: a tax line is never a work line
  taxPct: number;
  payTo: string;         // the company the checks are made out to
}

export async function drawInvoicePages(doc: PDFDocument, f: InvoicePageFields, logo?: Uint8Array): Promise<void> {
  const { StandardFonts, rgb } = await import("pdf-lib");
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const C = (c: Rgb) => rgb(c[0], c[1], c[2]);
  const L = COMPANY.letterhead;
  const M = 54, RIGHT = 558, W = RIGHT - M;
  let page: PDFPage = doc.addPage([612, 792]);
  let y = 738;
  const putAt = (t: string, x: number, yy: number, size = 10, font: PDFFont = helv, color: Rgb = INK) =>
    page.drawText(t, { x, y: yy, size, font, color: C(color) });
  const put = (t: string, x: number, size = 10, font: PDFFont = helv, color: Rgb = INK) => putAt(t, x, y, size, font, color);
  const putR = (t: string, xr: number, size = 10, font: PDFFont = helv, color: Rgb = INK) =>
    put(t, xr - font.widthOfTextAtSize(t, size), size, font, color);
  const rule = (yy: number, w = 0.6, color: Rgb = HAIR) =>
    page.drawLine({ start: { x: M, y: yy }, end: { x: RIGHT, y: yy }, thickness: w, color: C(color) });
  // break a text to fit its column, a word wider than the column broken inside
  // the word, so nothing prints through the money columns beside it
  const wrap = (t: string, width: number, size: number, font: PDFFont = helv): string[] => {
    const fit = (word: string): string[] => {
      if (font.widthOfTextAtSize(word, size) <= width) return [word];
      const parts: string[] = [];
      let piece = "";
      for (const ch of word) {
        if (font.widthOfTextAtSize(piece + ch, size) > width && piece) { parts.push(piece); piece = ch; } else piece += ch;
      }
      if (piece) parts.push(piece);
      return parts;
    };
    const out: string[] = [];
    let cur = "";
    for (const word of t.split(/\s+/).filter(Boolean).flatMap(fit)) {
      const next = cur ? `${cur} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && cur) { out.push(cur); cur = word; } else cur = next;
    }
    if (cur) out.push(cur);
    return out.length ? out : [""];
  };

  // ---- letterhead: centered, exactly as the proposal letter prints it ----
  y += 12;
  const ctr = (t: string, size: number, font: PDFFont = helv, color: Rgb = INK) =>
    putAt(t, (612 - font.widthOfTextAtSize(t, size)) / 2, y, size, font, color);
  if (logo) {
    try {
      const img = await doc.embedPng(logo);
      const h = 36, w = (img.width / img.height) * h;
      page.drawImage(img, { x: (612 - w) / 2, y: y - h + 8, width: w, height: h });
      y -= h + 7;
    } catch { /* an unreadable logo: the letterhead in text only */ }
  }
  ctr(L.name, 14.5, bold, BROWN);
  y -= 15;
  ctr(L.address, 8.5, helv, MUTED);
  y -= 11.5;
  ctr(L.phones.replace(/^Phone:\s*/, "").replace(/\s*\|\s*/g, "  ·  "), 8.5, helv, MUTED);
  y -= 11.5;
  ctr(L.emails.replace(/^Email:\s*/, "").replace(/\s*\|\s*Office Email:\s*/, "  ·  "), 8.5, helv, MUTED);
  y -= 10;
  // the globe's two halves, ocean then land
  page.drawRectangle({ x: M, y: y - 1.25, width: W / 2, height: 2.5, color: C(TEAL) });
  page.drawRectangle({ x: M + W / 2, y: y - 1.25, width: W / 2, height: 2.5, color: C(GREEN) });
  y -= 26;

  // ---- the title, with the numbers that identify this invoice beside it ----
  putAt("INVOICE", M, y, 19, bold, BROWN);
  const meta = (label: string, value: string) => {
    const vw = bold.widthOfTextAtSize(value, 10.5);
    putAt(value, RIGHT - vw, y, 10.5, bold);
    putAt(label, RIGHT - vw - 9 - bold.widthOfTextAtSize(label, 7.5), y + 1, 7.5, bold, TAN);
  };
  if (f.invoiceNumber) { meta("INVOICE #", f.invoiceNumber); y -= 15; }
  if (f.poNumber) { meta("PO #", f.poNumber); y -= 15; }
  meta("DATE", f.date || "");
  y -= 32;

  // ---- who is billed ----
  putAt("BILL TO", M, y, 7.5, bold, TAN);
  y -= 14;
  f.billTo.filter(Boolean).forEach((ln, i) => {
    const size = i === 0 ? 10.5 : 10, font = i === 0 ? bold : helv;
    for (const part of wrap(ln, W, size, font)) { put(part, M, size, font, i === 0 ? INK : MUTED); y -= 13; }
  });
  y -= 18;

  // ---- where the work was done, in its own band ----
  const site = f.jobSite.filter(Boolean);
  if (site.length > 0) {
    const addrX = M + 10 + bold.widthOfTextAtSize("JOB SITE:", 8) + 8;
    const addrLines = site.flatMap((s) => wrap(s, RIGHT - 10 - addrX, 10.5, bold));
    page.drawRectangle({ x: M, y: y - 8 - (addrLines.length - 1) * 14, width: W, height: 26 + (addrLines.length - 1) * 14, color: C(BAND) });
    putAt("JOB SITE:", M + 10, y, 8, bold, TAN);
    addrLines.forEach((ln, i) => putAt(ln, addrX, y - i * 14, 10.5, bold));
    y -= 32 + (addrLines.length - 1) * 14;
  }

  // ---- the work ----
  putAt("DESCRIPTION OF WORK", M, y, 9, bold, TEAL);
  y -= 16;   // clear of the table's band below it, so the heading is never cut
  const CQ = 374, UX = 470, AX = RIGHT; // the qty column's center; the right edges of unit price and amount
  const DW = 290;                       // the description column
  const tableHead = (label: string) => {
    page.drawRectangle({ x: M, y: y - 7, width: W, height: 20, color: C(BAND) });
    page.drawLine({ start: { x: M, y: y - 7 }, end: { x: RIGHT, y: y - 7 }, thickness: 1.4, color: C(BROWN) });
    put(label, M + 8, 8, bold, TAN);
    put("QTY", CQ - bold.widthOfTextAtSize("QTY", 8) / 2, 8, bold, TAN);
    putR("UNIT PRICE", UX, 8, bold, TAN);
    putR("AMOUNT", AX, 8, bold, TAN);
    y -= 22;
  };
  const nextPage = () => { page = doc.addPage([612, 792]); y = 738; tableHead("DESCRIPTION (continued)"); };
  tableHead("DESCRIPTION");
  let subtotal = 0;
  for (const l of f.lines) {
    const amount = (Number(l.qty) || 0) * (Number(l.unit_price) || 0);
    subtotal += amount;
    const rows = wrap(l.description, DW, 10);
    if (y - rows.length * 13 < 150) nextPage();
    const unit = (l.unit || "").trim().toUpperCase();
    const qty = `${l.qty}${unit && unit !== "EACH" ? ` ${unit}` : ""}`;
    rows.forEach((rt, i) => {
      // a description long enough to outrun the page breaks inside itself:
      // nothing may print below the footer rule
      if (y < 96) nextPage();
      put(rt, M + 8, 10);
      if (i === 0) {
        put(qty, CQ - helv.widthOfTextAtSize(qty, 10) / 2, 10, helv, MUTED);
        putR(money(Number(l.unit_price) || 0), UX, 10, helv, MUTED);
        putR(money(amount), AX, 10);
      }
      y -= 13;
    });
    y -= 7;
    rule(y + (13 + 7 + 4.7) / 2, 0.6);
  }

  // ---- the totals: the tax once, under the work ----
  if (y < 170) { page = doc.addPage([612, 792]); y = 738; }
  const tax = subtotal * f.taxPct / 100;
  y -= 12;
  putR("Subtotal", RIGHT - 92, 10, helv, MUTED);
  putR(money(subtotal), AX, 10);
  if (f.taxPct) {
    y -= 16;
    putR(`Sales Tax (${f.taxPct}%)`, RIGHT - 92, 10, helv, MUTED);
    putR(money(tax), AX, 10);
  }
  y -= 30;
  page.drawRectangle({ x: M, y: y - 8, width: W, height: 27, color: C(BROWN) });
  put("TOTAL DUE", RIGHT - 92 - bold.widthOfTextAtSize("TOTAL DUE", 11), 11, bold, WHITE);
  putR(money(subtotal + tax), AX, 12.5, bold, WHITE);

  // ---- the line along the foot of the last invoice page ----
  rule(72, 0.6);
  const foot = `Make all checks payable to ${(f.payTo || L.name).toUpperCase()}  ·  Thank you for your business`;
  putAt(foot, (612 - helv.widthOfTextAtSize(foot, 8)) / 2, 58, 8, helv, MUTED);
}
