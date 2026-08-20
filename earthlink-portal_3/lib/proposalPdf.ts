// The same proposal letter as a PDF — what actually gets emailed. The .docx
// stays the editable copy and the one a signed return reads back from; this is
// the one that looks identical on every machine that opens it.
//
// The layout deliberately mirrors lib/proposalDoc.ts line for line. A test
// holds the two together on what matters: the same addressee, the same work,
// the same money.
import { COMPANY } from "./company";
import { money, lineTotal, proposalFileName, type ProposalFields } from "./proposalDoc";

// the letter's palette, as in the .docx
type Rgb = readonly [number, number, number];
const INK: Rgb = [0.122, 0.137, 0.157];
const MUTED: Rgb = [0.431, 0.431, 0.400];
const BRAND: Rgb = [0.761, 0.290, 0.039];
const BAND: Rgb = [0.957, 0.945, 0.922];
const HAIR: Rgb = [0.863, 0.843, 0.796];
const WHITE: Rgb = [1, 1, 1];

const cents = (v: number) => Math.round((Number(v) || 0) * 100) / 100;

// Every vertical gap in the letter, so the whole thing can be drawn a little
// tighter when a long work list would otherwise push the signature block onto
// a second page. Three profiles, and the loosest one that still fits on one
// page wins — a short proposal keeps the airy spacing, a ten-line one closes
// up rather than breaking in half.
type Space = {
  headRule: number; afterRule: number; metaRow: number; afterMeta: number;
  attn: number; line: number; afterBill: number; afterDear: number;
  introLine: number; afterIntro: number; afterBand: number; afterScope: number;
  afterHead: number; rowLine: number; rowGap: number;
  preTot: number; totRow: number; preGrand: number; postGrand: number;
  preSign: number; signLab: number; postSign: number; regards: number; signerLine: number;
};
const NORMAL: Space = {
  headRule: 54, afterRule: 26, metaRow: 15, afterMeta: 32,
  attn: 14, line: 13, afterBill: 14, afterDear: 22,
  introLine: 14, afterIntro: 12, afterBand: 32, afterScope: 16,
  afterHead: 22, rowLine: 13, rowGap: 5,
  preTot: 12, totRow: 16, preGrand: 30, postGrand: 34,
  preSign: 48, signLab: 12, postSign: 38, regards: 26, signerLine: 14,
};
const MID: Space = {
  ...NORMAL,
  headRule: 52, afterRule: 23, afterMeta: 28, afterBill: 12, afterDear: 20,
  afterIntro: 10, afterBand: 30, afterScope: 14, afterHead: 21, rowGap: 4,
  preTot: 11, preGrand: 28, postGrand: 32, preSign: 44, postSign: 34, regards: 24,
};
const TIGHT: Space = {
  ...NORMAL,
  headRule: 50, afterRule: 20, afterMeta: 24, attn: 13, line: 12,
  afterBill: 10, afterDear: 18, introLine: 13, afterIntro: 8, afterBand: 28,
  afterScope: 13, afterHead: 20, rowGap: 4,
  preTot: 10, totRow: 15, preGrand: 26, postGrand: 30,
  preSign: 40, signLab: 11, postSign: 30, regards: 22, signerLine: 13,
};
// how much room the closing needs below the last work row: every gap from the
// totals down to the signer, plus the clear space above the footer rule at 72
const tailHeight = (s: Space) =>
  s.preTot + s.totRow + s.preGrand + s.postGrand + s.preSign + s.signLab +
  s.postSign + s.regards + s.signerLine + 92;

export async function buildProposalPdf(f: ProposalFields, logo?: Uint8Array): Promise<Uint8Array> {
  const first = await render(f, NORMAL, logo);
  if (first.pages === 1) return first.bytes;
  for (const s of [MID, TIGHT]) {
    const tryIt = await render(f, s, logo);
    if (tryIt.pages === 1) return tryIt.bytes;
  }
  return first.bytes;   // genuinely a multi-page letter — keep it readable
}

async function render(f: ProposalFields, S: Space, logo?: Uint8Array): Promise<{ bytes: Uint8Array; pages: number }> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const C = (c: Rgb) => rgb(c[0], c[1], c[2]);
  const L = COMPANY.letterhead;

  const M = 54, RIGHT = 558, W = RIGHT - M;
  let page = doc.addPage([612, 792]);
  let y = 738;

  const put = (t: string, x: number, size = 10, font = helv, color: Rgb = INK) =>
    page.drawText(t, { x, y, size, font, color: C(color) });
  const putAt = (t: string, x: number, yy: number, size = 10, font = helv, color: Rgb = INK) =>
    page.drawText(t, { x, y: yy, size, font, color: C(color) });
  const putR = (t: string, xr: number, size = 10, font = helv, color: Rgb = INK) =>
    put(t, xr - font.widthOfTextAtSize(t, size), size, font, color);
  // The .docx letter-spaces its small-cap labels. A PDF must not: any character
  // spacing at all and the text comes back out of the file as "S E R V I C E
  // A D D R E S S", which is how a signed copy stops reading back into the
  // invoice maker. The labels carry on weight, size and colour instead.
  // (`sp` is kept in the signature so this file reads against the .docx.)
  const track = (t: string, x: number, size: number, font: typeof helv, color: Rgb, _sp: number, yy = y) => {
    page.drawText(t, { x, y: yy, size, font, color: C(color) });
    return x + font.widthOfTextAtSize(t, size);
  };
  const trackW = (t: string, size: number, font: typeof helv, _sp: number) => font.widthOfTextAtSize(t, size);
  const rule = (yy: number, w = 0.6, color = HAIR, x0 = M, x1 = RIGHT) =>
    page.drawLine({ start: { x: x0, y: yy }, end: { x: x1, y: yy }, thickness: w, color: C(color) });
  // break a description to fit its column
  const wrap = (t: string, width: number, size: number, font = helv) => {
    // a single run of characters wider than the column breaks mid-word —
    // otherwise it would print straight through the money columns beside it
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
    for (const word of t.split(/\s+/).flatMap(fit)) {
      const next = cur ? `${cur} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && cur) { out.push(cur); cur = word; } else cur = next;
    }
    if (cur) out.push(cur);
    return out.length ? out : [""];
  };

  // ---- letterhead ----
  let lx = M;
  if (logo) {
    try {
      const img = await doc.embedPng(logo);
      const h = 60, w = (img.width / img.height) * h;
      page.drawImage(img, { x: M, y: y - h + 14, width: w, height: h });
      lx = M + w + 14;
    } catch { /* unreadable logo — text letterhead */ }
  }
  putAt(L.name, lx, y, 14.5, bold);
  putAt(L.address, lx, y - 15, 8.5, helv, MUTED);
  putAt(L.phones.replace(/^Phone:\s*/, "").replace(/\s*\|\s*/g, "  ·  "), lx, y - 27, 8.5, helv, MUTED);
  putAt(L.emails.replace(/^Email:\s*/, "").replace(/\s*\|\s*Office Email:\s*/, "  ·  "), lx, y - 39, 8.5, helv, MUTED);
  y -= S.headRule;
  rule(y, 2, BRAND);
  y -= S.afterRule;

  // ---- title, with what identifies this letter set against it ----
  track("PROPOSAL", M, 19, bold, BRAND, 2.2);
  const meta = (label: string, value: string) => {
    const vw = bold.widthOfTextAtSize(value, 10.5);
    putAt(value, RIGHT - vw, y, 10.5, bold);
    const lw = trackW(label, 7.5, bold, 1.4);
    track(label, RIGHT - vw - 9 - lw, 7.5, bold, MUTED, 1.4, y + 1);
  };
  if (f.poNumber) { meta("PO #", f.poNumber); y -= S.metaRow; }
  meta("DATE", f.date || "");
  y -= S.afterMeta;

  // ---- the service address leads, in its own band (wrapping — a long
  // development name must not run off the page edge) ----
  const labW = trackW("SERVICE ADDRESS:", 8, bold, 1.2);
  const addrX = M + 10 + labW + 8;
  const addrLines = wrap(f.serviceAddress || "—", RIGHT - 10 - addrX, 10.5, bold);
  page.drawRectangle({ x: M, y: y - 8 - (addrLines.length - 1) * 14, width: W, height: 26 + (addrLines.length - 1) * 14, color: C(BAND) });
  track("SERVICE ADDRESS:", M + 10, 8, bold, MUTED, 1.2, y);
  addrLines.forEach((ln, i) => putAt(ln, addrX, y - i * 14, 10.5, bold));
  y -= S.afterBand + (addrLines.length - 1) * 14;

  // ---- who it is going to ----
  if (f.attn) { put(`ATTN: ${f.attn}`, M, 10.5, bold); y -= S.attn; }
  if (f.attnTitle) { put(f.attnTitle, M, 10, helv, MUTED); y -= S.line; }
  for (const b of (f.billTo || []).filter(Boolean)) { put(b, M, 10, helv, MUTED); y -= S.line; }
  y -= S.afterBill;

  const dearName = (f.attn || "").split(/[\s,]+/)[0] || "";
  put(`Dear ${dearName || "Sir or Madam"},`, M, 10.5);
  y -= S.afterDear;
  const site = (f.serviceAddress || "").split(",")[0].trim();
  for (const ln of wrap(`${L.name} is pleased to submit this proposal for the following work${site ? ` at ${site}` : ""}.`, W, 10.5)) {
    put(ln, M, 10.5); y -= S.introLine;
  }
  y -= S.afterIntro;

  // ---- the work ----
  track("SCOPE OF WORK", M, 9, bold, BRAND, 1.7);
  y -= S.afterScope;
  const QX = 392, UX = 470, AX = RIGHT;      // right edges of qty / unit price / amount
  const DW = 300;                             // the description column
  const tableHead = (label: string) => {
    page.drawRectangle({ x: M, y: y - 7, width: W, height: 20, color: C(BAND) });
    page.drawLine({ start: { x: M, y: y - 7 }, end: { x: RIGHT, y: y - 7 }, thickness: 1.4, color: C(BRAND) });
    track(label, M + 8, 8, bold, MUTED, 1.2);
    track("QTY", QX - trackW("QTY", 8, bold, 1.2), 8, bold, MUTED, 1.2);
    track("UNIT PRICE", UX - trackW("UNIT PRICE", 8, bold, 1.2), 8, bold, MUTED, 1.2);
    track("AMOUNT", AX - trackW("AMOUNT", 8, bold, 1.2), 8, bold, MUTED, 1.2);
    y -= S.afterHead;
  };
  tableHead("DESCRIPTION");

  let sub = 0;
  for (const l of f.lines) {
    const rows = wrap(l.description, DW, 10);
    if (y - rows.length * S.rowLine < 150) { page = doc.addPage([612, 792]); y = 738; tableHead("DESCRIPTION (continued)"); }
    const qty = `${l.qty}${l.unit && l.unit.toUpperCase() !== "EACH" ? ` ${l.unit.toUpperCase()}` : ""}`;
    sub += lineTotal(l);
    rows.forEach((rt, i) => {
      // one description long enough to outrun the page breaks mid-block —
      // nothing may print below the footer rule
      if (y < 96) { page = doc.addPage([612, 792]); y = 738; tableHead("DESCRIPTION (continued)"); }
      put(rt, M + 8, 10);
      if (i === 0) {
        putR(qty, QX, 10, helv, MUTED);
        putR(money(cents(l.unit_price)), UX, 10, helv, MUTED);
        putR(money(lineTotal(l)), AX, 10);
      }
      y -= S.rowLine;
    });
    y -= S.rowGap;
    rule(y + 8, 0.6);
  }

  // ---- the totals ----
  const taxPct = f.taxPct ?? 8.875;
  const tax = Math.round(sub * taxPct) / 100;
  const grand = Math.round((sub + tax) * 100) / 100;
  if (y < tailHeight(S)) { page = doc.addPage([612, 792]); y = 738; }
  y -= S.preTot;
  putR("Total Cost — labor and materials", RIGHT - 92, 10, helv, MUTED);
  putR(money(sub), AX, 10);
  y -= S.totRow;
  putR(`Sales Tax (${taxPct}%)`, RIGHT - 92, 10, helv, MUTED);
  putR(money(tax), AX, 10);
  y -= S.preGrand;
  page.drawRectangle({ x: M, y: y - 8, width: W, height: 27, color: C(BRAND) });
  const gtW = trackW("GRAND TOTAL", 11, bold, 1.6);
  track("GRAND TOTAL", RIGHT - 92 - gtW, 11, bold, WHITE, 1.6);
  putR(money(grand), AX, 12.5, bold, WHITE);
  y -= S.postGrand;

  // ---- sign and return ----
  put("Please sign and return a copy of this proposal to authorize the work.", M, 10);
  y -= S.preSign;
  const half = (W - 26) / 2;
  rule(y, 0.6, HAIR, M, M + half);
  rule(y, 0.6, HAIR, M + half + 26, RIGHT);
  y -= S.signLab;
  track("ACCEPTED BY", M, 7.5, bold, MUTED, 1.4);
  track("DATE", M + half + 26, 7.5, bold, MUTED, 1.4);
  y -= S.postSign;

  put("Best regards,", M, 10);
  y -= S.regards;
  put(f.signer || L.signer, M, 11, bold);
  y -= S.signerLine;
  put(`${L.signerTitle}  ·  ${L.name}`, M, 9.5, helv, MUTED);

  // ---- the line along the foot, on the last page ----
  rule(72, 0.6);
  const foot = L.footer;
  putAt(foot, (612 - helv.widthOfTextAtSize(foot, 8)) / 2, 58, 8, helv, MUTED);
  return { bytes: await doc.save(), pages: doc.getPageCount() };
}

export const proposalPdfName = (f: ProposalFields): string => proposalFileName(f).replace(/\.docx$/i, ".pdf");
