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
  billTo?: string[];        // their office lines under the ATTN
  serviceAddress?: string;  // the job site, apartment and all
  lines: ProposalLine[];
  taxPct?: number;
  signer?: string;
}

const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const money = (n: number) => `$${(Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---- little OOXML helpers (half-points for size, twips for width) ----
const run = (text: string, o: { b?: boolean; sz?: number; color?: string } = {}) =>
  `<w:r><w:rPr>${o.b ? "<w:b/>" : ""}<w:sz w:val="${o.sz ?? 22}"/><w:szCs w:val="${o.sz ?? 22}"/>` +
  `${o.color ? `<w:color w:val="${o.color}"/>` : ""}<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr>` +
  `<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;

const para = (text: string, o: { b?: boolean; sz?: number; align?: string; space?: number; rule?: boolean; color?: string } = {}) =>
  `<w:p><w:pPr>${o.align ? `<w:jc w:val="${o.align}"/>` : ""}` +
  `<w:spacing w:after="${o.space ?? 60}" w:line="240" w:lineRule="auto"/>` +
  `${o.rule ? '<w:pBdr><w:bottom w:val="single" w:sz="12" w:space="4" w:color="1A1A1A"/></w:pBdr>' : ""}` +
  `</w:pPr>${text ? run(text, o) : ""}</w:p>`;

const cell = (inner: string, w: number, o: { border?: boolean; shade?: string; align?: string } = {}) =>
  `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>` +
  (o.border === false ? "<w:tcBorders><w:top w:val=\"nil\"/><w:left w:val=\"nil\"/><w:bottom w:val=\"nil\"/><w:right w:val=\"nil\"/></w:tcBorders>" : "") +
  (o.shade ? `<w:shd w:val="clear" w:fill="${o.shade}"/>` : "") +
  `<w:vAlign w:val="center"/></w:tcPr>${inner}</w:tc>`;

const table = (rows: string[], borders: boolean, cols: number[]) =>
  `<w:tbl><w:tblPr><w:tblW w:w="${cols.reduce((a, b) => a + b, 0)}" w:type="dxa"/>` +
  (borders
    ? '<w:tblBorders><w:top w:val="single" w:sz="6" w:color="9A9A9A"/><w:left w:val="single" w:sz="6" w:color="9A9A9A"/><w:bottom w:val="single" w:sz="6" w:color="9A9A9A"/><w:right w:val="single" w:sz="6" w:color="9A9A9A"/><w:insideH w:val="single" w:sz="6" w:color="C8C8C8"/><w:insideV w:val="single" w:sz="6" w:color="C8C8C8"/></w:tblBorders>'
    : '<w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders>') +
  `<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
  `<w:tblGrid>${cols.map((c) => `<w:gridCol w:w="${c}"/>`).join("")}</w:tblGrid>` +
  rows.map((r) => `<w:tr>${r}</w:tr>`).join("") + "</w:tbl>";

// the logo, sized to about 0.85" tall, sitting inline in its own cell
const logoPara = (relId: string, px: { w: number; h: number }) => {
  const cy = 777240; // 0.85 inch in EMU
  const cx = Math.round((px.w / px.h) * cy);
  return `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
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

  // letterhead: logo on the left, the company block beside it
  const nameBlock =
    para(L.name, { b: true, sz: 30, space: 20 }) + para(L.address, { sz: 18, space: 10 }) +
    para(L.phones, { sz: 18, space: 10 }) + para(L.emails, { sz: 18, space: 0 });
  const head = logo
    ? table([cell(logoPara("rId9", pngSize(logo)), 1900, { border: false }) + cell(nameBlock, 7460, { border: false })], false, [1900, 7460])
    : nameBlock;

  // the work table — the Qty column reads "250 x" so the price and the line
  // total sit next to each other exactly the way the reader expects them
  const billLines = (f.billTo || []).filter(Boolean);
  const hdr = ["Description", "Qty", "Unit price", "Amount"];
  const widths = [5100, 1100, 1500, 1660];
  const headRow = hdr.map((h, i) => cell(para(h, { b: true, sz: 20, space: 0, align: i ? "right" : "left" }), widths[i], { shade: "EFEFEF" })).join("");
  const bodyRows = f.lines.map((l) =>
    cell(para(l.description, { sz: 20, space: 0 }), widths[0]) +
    cell(para(`${l.qty} x`, { sz: 20, space: 0, align: "right" }), widths[1]) +
    cell(para(money(cents(l.unit_price)), { sz: 20, space: 0, align: "right" }), widths[2]) +
    cell(para(money(lineTotal(l)), { sz: 20, space: 0, align: "right" }), widths[3]));

  const body = [
    head,
    para("", { rule: true, space: 160 }),
    para(`Date: ${f.date || ""}`, { sz: 20 }),
    f.poNumber ? para(`PO #: ${f.poNumber}`, { sz: 20 }) : "",
    f.attn || billLines.length > 0 ? para(`ATTN: ${f.attn || ""}`, { sz: 20 }) : "",
    ...billLines.map((b) => para(b, { sz: 20 })),
    para("", { space: 120 }),
    para(`Dear ${f.attn || "Sir or Madam"},`, { sz: 20 }),
    para("We are pleased to submit our proposal for the property below.", { sz: 20, space: 120 }),
    para(`Service Address: ${f.serviceAddress || "—"}`, { sz: 20, space: 160 }),
    para("Scope of Work", { b: true, sz: 24, space: 80 }),
    table([headRow, ...bodyRows], true, widths),
    para("", { space: 120 }),
    para(`Total Cost: ${money(sub)}`, { sz: 20 }),
    para(`Sales Tax (${taxPct}%): ${money(tax)}`, { sz: 20 }),
    para(`Grand Total: ${money(grand)}`, { b: true, sz: 22, space: 200 }),
    para("Thank you for the opportunity. Please sign and return a copy to authorize the work.", { sz: 20, space: 200 }),
    para("Best regards,", { sz: 20, space: 40 }),
    para(f.signer || L.name, { b: true, sz: 20, space: 0 }),
    para(L.phones.replace(/^Phone:\s*/, ""), { sz: 18 }),
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
      `</Types>`),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`),
    "word/document.xml": strToU8(doc),
    "word/_rels/document.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      (logo ? `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.png"/>` : "") +
      `</Relationships>`),
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
  billTo: ["Fairstead", "10 Bank Street", "White Plains, NY 10606"],
  serviceAddress: "Building 123 EXAMPLE STREET, Apartment 4B Brooklyn, NY 11207",
  lines: [
    { description: "Plaster", qty: 100, unit: "SF", unit_price: 5 },
    { description: "Primer — 1 coat", qty: 100, unit: "SF", unit_price: 0 },
    { description: "Paint — 2 coats", qty: 100, unit: "SF", unit_price: 0 },
  ],
};
