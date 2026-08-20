// The proposal letter, written by the portal in the exact shape the invoice
// maker reads back. Upload one of these to the PACT tab and every line — PO
// number, service address, each priced work line, tax and total — lands in the
// job without retyping. Same file is the blank template they fill in by hand.
import { zipSync, strToU8 } from "fflate";
import { COMPANY } from "./company";

export interface ProposalLine { description: string; qty: number; unit: string; unit_price: number }
export interface ProposalFields {
  poNumber?: string;
  date?: string;            // MM/DD/YYYY
  attn?: string;            // the person at the partner
  attnTitle?: string;       // what they do there
  billTo?: string[];        // their office lines under the ATTN
  serviceAddress?: string;  // the job site, apartment and all
  lines: ProposalLine[];
  taxPct?: number;
  signer?: string;
}

const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const money = (n: number) => `$${(Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---- the letter's palette and type scale ----
// Sizes are half-points, widths are twips (1/1440 in), letter-spacing is
// twentieths of a point — Word's own units, so nothing is guessed at.
const INK = "1F2328";        // body text: a touch softer than pure black in print
const MUTED = "6E6E66";      // labels and the second line of anything
const BRAND = "C24A0A";      // the rule under the letterhead, the totals bar
const BAND = "F4F1EB";       // the warm tint behind a heading row
const HAIR = "DCD7CB";       // the line between two work lines

// Word checks the ORDER of these, not just their presence: rFonts, b, i, caps,
// color, spacing, sz, szCs. Out of order and it opens the letter read-only and
// says part of it is unreadable.
interface RunOpts { b?: boolean; sz?: number; color?: string; caps?: boolean; track?: number; font?: string }
const run = (text: string, o: RunOpts = {}) =>
  `<w:r><w:rPr>` +
  `<w:rFonts w:ascii="${o.font ?? "Calibri"}" w:hAnsi="${o.font ?? "Calibri"}" w:cs="${o.font ?? "Calibri"}"/>` +
  `${o.b ? "<w:b/><w:bCs/>" : ""}${o.caps ? "<w:caps/>" : ""}` +
  `<w:color w:val="${o.color ?? INK}"/>` +
  `${o.track ? `<w:spacing w:val="${o.track}"/>` : ""}` +
  `<w:sz w:val="${o.sz ?? 21}"/><w:szCs w:val="${o.sz ?? 21}"/>` +
  `</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;

// Same again for the paragraph: pBdr, shd, spacing, ind, jc, in that order.
interface ParaOpts extends RunOpts { align?: string; space?: number; before?: number; rule?: string; ruleTop?: string; ruleW?: number; shade?: string; indent?: number; line?: number }
const paraOf = (inner: string, o: ParaOpts = {}) =>
  `<w:p><w:pPr>` +
  (o.rule || o.ruleTop
    ? `<w:pBdr>${o.ruleTop ? `<w:top w:val="single" w:sz="${o.ruleW ?? 6}" w:space="8" w:color="${o.ruleTop}"/>` : ""}`
      + `${o.rule ? `<w:bottom w:val="single" w:sz="${o.ruleW ?? 6}" w:space="6" w:color="${o.rule}"/>` : ""}</w:pBdr>`
    : "") +
  (o.shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.shade}"/>` : "") +
  `<w:spacing w:before="${o.before ?? 0}" w:after="${o.space ?? 60}" w:line="${o.line ?? 264}" w:lineRule="auto"/>` +
  (o.indent ? `<w:ind w:left="${o.indent}" w:right="${o.indent}"/>` : "") +
  (o.align ? `<w:jc w:val="${o.align}"/>` : "") +
  `</w:pPr>${inner}</w:p>`;
const para = (text: string, o: ParaOpts = {}) => paraOf(text ? run(text, o) : "", o);
// a blank line of a chosen height, for spacing that a margin can't give
const gap = (h: number) => `<w:p><w:pPr><w:spacing w:after="0" w:line="${h}" w:lineRule="exact"/></w:pPr></w:p>`;

interface CellOpts { shade?: string; pad?: [number, number, number, number]; top?: string; bottom?: string; bw?: number; valign?: string }
const cell = (inner: string, w: number, o: CellOpts = {}) => {
  const [pt, pr, pb, pl] = o.pad ?? [90, 110, 90, 110];
  const side = (n: string, c?: string) => `<w:${n} w:val="${c ? "single" : "nil"}" w:sz="${o.bw ?? 6}" w:space="0" w:color="${c ?? "auto"}"/>`;
  return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>` +
    `<w:tcBorders>${side("top", o.top)}${side("left")}${side("bottom", o.bottom)}${side("right")}</w:tcBorders>` +
    (o.shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.shade}"/>` : "") +
    `<w:tcMar><w:top w:w="${pt}" w:type="dxa"/><w:left w:w="${pl}" w:type="dxa"/><w:bottom w:w="${pb}" w:type="dxa"/><w:right w:w="${pr}" w:type="dxa"/></w:tcMar>` +
    // a cell has to hold at least one paragraph — an empty one is what makes
    // Word say part of the document is unreadable
    `<w:vAlign w:val="${o.valign ?? "center"}"/></w:tcPr>${inner || para("", { space: 0 })}</w:tc>`;
};

// every table here draws its own lines cell by cell, so a row can carry a rule
// where it needs one and nothing where it doesn't
const table = (rows: string[], cols: number[]) =>
  `<w:tbl><w:tblPr><w:tblW w:w="${cols.reduce((a, b) => a + b, 0)}" w:type="dxa"/>` +
  `<w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders>` +
  `<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
  `<w:tblGrid>${cols.map((c) => `<w:gridCol w:w="${c}"/>`).join("")}</w:tblGrid>` +
  rows.map((r) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${r}</w:tr>`).join("") + "</w:tbl>";

// the logo, sized to about 0.85" tall, sitting inline in its own cell
const logoPara = (relId: string, px: { w: number; h: number }, center = false) => {
  const cy = 777240; // 0.85 inch in EMU
  const cx = Math.round((px.w / px.h) * cy);
  return `<w:p><w:pPr><w:spacing w:after="0"/>${center ? '<w:jc w:val="center"/>' : ""}</w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="1" name="Logo"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="logo.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
};

const pngSize = (b: Uint8Array): { w: number; h: number } => {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try { return { w: dv.getUint32(16), h: dv.getUint32(20) }; } catch { return { w: 381, h: 350 }; }
};

const cents = (v: number) => Math.round((Number(v) || 0) * 100) / 100;
// the printed unit price is what the total must be built from, or the reader
// (and the customer with a calculator) sees a line that doesn't add up
export const lineTotal = (l: ProposalLine) => cents(cents(l.unit_price) * (Number(l.qty) || 0));

// Build the .docx. `logo` is the bytes of public/logo.png when the page could
// fetch it — without it the letterhead is the same block in text.
export function buildProposalDocx(f: ProposalFields, logo?: Uint8Array): Uint8Array {
  const L = COMPANY.letterhead;
  const taxPct = f.taxPct ?? 8.875;
  const sub = f.lines.reduce((s, l) => s + lineTotal(l), 0);
  const tax = Math.round(sub * taxPct) / 100;
  const grand = Math.round((sub + tax) * 100) / 100;

  const W = 10080;                       // the width of the page inside its margins
  const site = (f.serviceAddress || "").split(",")[0].trim();
  const dearName = (f.attn || "").split(/[\s,]+/)[0] || "";
  const billLines = (f.billTo || []).filter(Boolean);

  // ---- letterhead: everything centered, the way the company's paper reads —
  // the logo above the name, the contact lines under it, a brand rule below
  const nameBlock =
    para(L.name, { b: true, sz: 32, space: 40, track: 4, align: "center" }) +
    para(L.address, { sz: 17, color: MUTED, space: 14, align: "center" }) +
    para(L.phones.replace(/^Phone:\s*/, "").replace(/\s*\|\s*/g, "  ·  "), { sz: 17, color: MUTED, space: 14, align: "center" }) +
    para(L.emails.replace(/^Email:\s*/, "").replace(/\s*\|\s*Office Email:\s*/, "  ·  "), { sz: 17, color: MUTED, space: 0, align: "center" });
  const head = (logo ? logoPara("rId9", pngSize(logo), true) : "") + nameBlock;

  // ---- the title, with what identifies this letter set against it
  const metaLine = (label: string, value: string) =>
    paraOf(run(label, { sz: 15, color: MUTED, caps: true, track: 30 }) + run("   ", { sz: 15 })
      + run(value, { sz: 21, b: true }), { align: "right", space: 30 });
  const titleRow = table([
    cell(para("PROPOSAL", { b: true, sz: 40, color: BRAND, track: 40, space: 0 }), 5000, { pad: [0, 0, 0, 0], valign: "bottom" })
    + cell((f.poNumber ? metaLine("PO #", f.poNumber) : "") + metaLine("Date", f.date || ""),
      W - 5000, { pad: [0, 0, 0, 0], valign: "bottom" }),
  ], [5000, W - 5000]);

  // ---- who it is going to. Plain stacked lines: the invoice maker reads a
  // signed copy back off exactly these, so they never move into a table.
  const attnBlock = [
    f.attn ? para(`ATTN: ${f.attn}`, { sz: 21, b: true, space: 20 }) : "",
    f.attnTitle ? para(f.attnTitle, { sz: 20, color: MUTED, space: 20 }) : "",
    ...billLines.map((b2) => para(b2, { sz: 20, color: MUTED, space: 20 })),
  ].join("");

  // ---- the work. No box around it: a rule under the heading and a hairline
  // between the lines is enough, and it reads as a document rather than a form.
  const COLS = [5180, 1300, 1700, 1900];
  const headCell = (t: string, i: number) =>
    cell(para(t, { b: true, sz: 16, color: MUTED, caps: true, track: 24, space: 0, align: i === 1 ? "center" : i ? "right" : "left" }),
      COLS[i], { shade: BAND, bottom: BRAND, bw: 12, pad: [80, 110, 80, 110] });
  const headRow = ["Description", "Qty", "Unit price", "Amount"].map(headCell).join("");
  const bodyRows = f.lines.map((l) => {
    const qty = `${l.qty}${l.unit && l.unit.toUpperCase() !== "EACH" ? ` ${l.unit.toUpperCase()}` : ""}`;
    const c = (inner: string, i: number) => cell(inner, COLS[i], { bottom: HAIR, pad: [130, 110, 130, 110] });
    return c(para(l.description, { sz: 20, space: 0 }), 0)
      + c(para(qty, { sz: 20, space: 0, align: "center", color: MUTED }), 1)
      + c(para(money(cents(l.unit_price)), { sz: 20, space: 0, align: "right", color: MUTED }), 2)
      + c(para(money(lineTotal(l)), { sz: 20, space: 0, align: "right" }), 3);
  });

  // ---- the totals, lined up under the amount column, the grand total in a bar
  const TL = W - 1900, TR = 1900;
  const totalRow = (label: string, amount: string) =>
    cell(para(label, { sz: 20, space: 0, align: "right", color: MUTED }), TL, { pad: [70, 110, 70, 0] })
    + cell(para(amount, { sz: 20, space: 0, align: "right" }), TR, { pad: [70, 110, 70, 0] });
  const grandRow =
    cell(para("Grand Total", { b: true, sz: 24, space: 0, align: "right", color: "FFFFFF", caps: true, track: 20 }), TL,
      { shade: BRAND, pad: [130, 110, 130, 0] })
    + cell(para(money(grand), { b: true, sz: 26, space: 0, align: "right", color: "FFFFFF" }), TR,
      { shade: BRAND, pad: [130, 110, 130, 0] });

  // ---- somewhere to actually sign, since the letter asks them to
  const SIGW = Math.floor((W - 400) / 2);
  const signLine = (label: string) =>
    cell(para("", { space: 0, rule: HAIR, ruleW: 6, line: 400 })
      + para(label, { sz: 15, color: MUTED, caps: true, track: 30, space: 0, before: 40 }),
      SIGW, { pad: [0, 0, 0, 0], valign: "bottom" });

  const body = [
    head,
    para("", { rule: BRAND, ruleW: 18, space: 260 }),
    titleRow,
    gap(260),
    attnBlock,
    gap(260),
    para(`Dear ${dearName || "Sir or Madam"},`, { sz: 21, space: 180 }),
    para(`${L.name} is pleased to submit this proposal for the following work${site ? ` at ${site}` : ""}.`,
      { sz: 21, space: 220 }),
    // the one fact everything else hangs off, set apart so it cannot be missed
    table([cell(paraOf(run("Service Address:  ", { sz: 16, b: true, color: MUTED, caps: true, track: 24 })
      + run(f.serviceAddress || "—", { sz: 21, b: true }), { space: 0 }),
      W, { shade: BAND, pad: [130, 160, 130, 160] })], [W]),
    gap(300),
    para("Scope of Work", { b: true, sz: 18, color: BRAND, caps: true, track: 34, space: 90 }),
    table([headRow, ...bodyRows], COLS),
    gap(180),
    table([totalRow("Total Cost — labor and materials", money(sub)),
      totalRow(`Sales Tax (${taxPct}%)`, money(tax)), grandRow], [TL, TR]),
    gap(400),
    para("Please sign and return a copy of this proposal to authorize the work.", { sz: 20, space: 60 }),
    gap(560),
    table([signLine("Accepted by") + cell("", 400, { pad: [0, 0, 0, 0] }) + signLine("Date")], [SIGW, 400, SIGW]),
    gap(520),
    para("Best regards,", { sz: 20, space: 300 }),
    para(f.signer || L.signer, { b: true, sz: 22, space: 20 }),
    para(`${L.signerTitle}  ·  ${L.name}`, { sz: 19, color: MUTED, space: 0 }),
    gap(420),
    paraOf(run(L.footer, { sz: 15, color: MUTED, track: 8 }),
      { align: "center", space: 0, before: 160, ruleTop: HAIR, ruleW: 4 }),
  ].join("");

  const doc =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"` +
    ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"` +
    ` xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>` +
    `<w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="png" ContentType="image/png"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
      `</Types>`),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
      `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>` +
      `</Relationships>`),
    "word/document.xml": strToU8(doc),
    "word/_rels/document.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      (logo ? `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.png"/>` : "") +
      `</Relationships>`),
    // the default face and size, so Word doesn't reach for its own
    "word/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:docDefaults><w:rPrDefault><w:rPr>` +
      `<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:color w:val="${INK}"/><w:sz w:val="21"/><w:szCs w:val="21"/>` +
      `</w:rPr></w:rPrDefault>` +
      `<w:pPrDefault><w:pPr><w:spacing w:after="60" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault>` +
      `</w:docDefaults>` +
      `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
      `</w:styles>`),
    "docProps/core.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"` +
      ` xmlns:dc="http://purl.org/dc/elements/1.1/">` +
      `<dc:title>${esc(`Proposal${f.poNumber ? ` ${f.poNumber}` : ""}`)}</dc:title>` +
      `<dc:creator>${esc(L.name)}</dc:creator>` +
      `<cp:lastModifiedBy>${esc(L.name)}</cp:lastModifiedBy>` +
      `</cp:coreProperties>`),
    "docProps/app.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">` +
      `<Application>Earth Link Field Office</Application><Company>${esc(L.name)}</Company>` +
      `</Properties>`),
  };
  if (logo) files["word/media/logo.png"] = logo;
  return zipSync(files, { level: 6 });
}

// "proposal 8300 2156 Linden Boulevard Apt 8A.docx"
export const proposalFileName = (f: ProposalFields): string =>
  `proposal ${[f.poNumber, (f.serviceAddress || "").split(",")[0]].filter(Boolean).join(" ")}`
    .replace(/\s{2,}/g, " ").replace(/[\\/:*?"<>|]/g, "-").trim() + ".docx";

// the blank one to fill in by hand — every kind of line shown once so the
// shape is obvious, and it reads straight back into the invoice maker
export const BLANK_PROPOSAL: ProposalFields = {
  poNumber: "0000",
  date: "",
  attn: "",
  billTo: ["10 Bank Street, Suite 550, White Plains, NY 10606"],
  serviceAddress: "123 EXAMPLE STREET, Brooklyn, NY 11207, Apartment 4B",
  lines: [
    { description: "Scrape and plaster", qty: 100, unit: "SF", unit_price: 6 },
    { description: "Primer", qty: 1, unit: "ROOM", unit_price: 125 },
    { description: "Paint", qty: 1, unit: "ROOM", unit_price: 220 },
  ],
};
