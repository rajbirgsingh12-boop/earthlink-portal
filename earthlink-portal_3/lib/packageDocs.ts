"use client";
// The NYCHA invoice-package paperwork: affidavit, REP hiring summary,
// Section 3 hiring summary and the monthly Equal Opportunity report.
// The owner's own signed copies ship with the app (public/pkg/*) — for other
// contracts only the contract number changes, swapped the same way their PDF
// editor did it (the typed values live in annotations on top of the scans).
// Any contract can also carry its own uploaded copy of a document (the
// affidavit lists different materials per contract) — that copy wins.
import { sb } from "./supabase";

export const PKG_SLOTS = [
  { key: "affidavit", label: "Affidavit (AU-2)", file: "affidavit.pdf", note: "different materials per contract — upload this contract's own copy when you have it" },
  { key: "rep", label: "REP Hiring Summary", file: "rep.pdf", note: "" },
  { key: "hiring", label: "Section 3 Hiring Summary", file: "hiring.pdf", note: "" },
  { key: "eo", label: "Equal Opportunity Report", file: "eo.pdf", note: "" },
] as const;
export type PkgSlot = (typeof PKG_SLOTS)[number];

// the contract number baked into the shipped template PDFs
const TPL_NUM = "2536683";

const storePath = (contractId: string, file: string) => `package/${contractId}/${file}`;

// which documents this contract has its own uploaded copy of
export async function listPkgOverrides(contractId: string): Promise<Set<string>> {
  const { data } = await sb().storage.from("docs").list(`package/${contractId}`);
  return new Set(((data || []) as { name: string }[]).map((f) => f.name));
}

export async function uploadPkgOverride(contractId: string, slot: PkgSlot, f: File): Promise<string | null> {
  // no update policy on storage — replace is delete + fresh upload
  await sb().storage.from("docs").remove([storePath(contractId, slot.file)]);
  const { error } = await sb().storage.from("docs").upload(storePath(contractId, slot.file), f, { contentType: "application/pdf" });
  return error ? error.message : null;
}

export async function removePkgOverride(contractId: string, slot: PkgSlot): Promise<string | null> {
  const { error } = await sb().storage.from("docs").remove([storePath(contractId, slot.file)]);
  return error ? error.message : null;
}

async function fetchOverride(contractId: string, file: string): Promise<ArrayBuffer | null> {
  const { data } = await sb().storage.from("docs").download(storePath(contractId, file));
  return data ? data.arrayBuffer() : null;
}

async function fetchTemplate(file: string): Promise<ArrayBuffer> {
  const res = await fetch(`/pkg/${file}`);
  if (!res.ok) throw new Error(`Couldn't load the ${file} template`);
  return res.arrayBuffer();
}

type PdfLib = typeof import("pdf-lib");

// find FreeText annotations whose typed contents mention the template's
// contract number — that's where the visible values live on these scans
function numberAnnots(pdf: PdfLib, doc: import("pdf-lib").PDFDocument) {
  const { PDFName, PDFArray, PDFDict, PDFString, PDFHexString } = pdf;
  const out: { dict: import("pdf-lib").PDFDict; text: string }[] = [];
  const page = doc.getPage(0);
  const annots = page.node.lookup(PDFName.of("Annots"), PDFArray);
  if (!annots) return out;
  for (let i = 0; i < annots.size(); i++) {
    const a = annots.lookup(i);
    if (!(a instanceof PDFDict)) continue;
    if (String(a.lookup(PDFName.of("Subtype"))) !== "/FreeText") continue;
    const cts = a.lookup(PDFName.of("Contents"));
    const text = cts instanceof PDFString || cts instanceof PDFHexString ? cts.decodeText() : "";
    if (text.includes(TPL_NUM)) out.push({ dict: a, text });
  }
  return out;
}

// swap an annotation's appearance for freshly drawn text lines (bbox coords)
function redrawAnnot(
  pdf: PdfLib, doc: import("pdf-lib").PDFDocument, a: import("pdf-lib").PDFDict,
  font: import("pdf-lib").PDFFont, newContents: string,
  lines: { x: number; y: number; size: number; text: string; center?: boolean }[]
) {
  const { PDFName, PDFArray, PDFDict, PDFString } = pdf;
  const ap = a.lookup(PDFName.of("AP"), PDFDict);
  if (!ap) return;
  const old = doc.context.lookup(ap.get(PDFName.of("N")));
  const bbox = (old as { dict?: import("pdf-lib").PDFDict })?.dict?.lookup(PDFName.of("BBox"), PDFArray);
  if (!bbox) return;
  const bw = (bbox.lookup(2) as unknown as { asNumber(): number }).asNumber();
  const bh = (bbox.lookup(3) as unknown as { asNumber(): number }).asNumber();
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => "\\" + c);
  const ops = [
    "q BT 0 g",
    ...lines.map((l) => {
      const x = l.center ? l.x - font.widthOfTextAtSize(l.text, l.size) / 2 : l.x;
      return `/HF ${l.size} Tf 1 0 0 1 ${x.toFixed(2)} ${l.y.toFixed(2)} Tm (${esc(l.text)}) Tj`;
    }),
    "ET Q",
  ].join("\n");
  const stream = doc.context.stream(ops, {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, bw, bh],
    Resources: { Font: { HF: font.ref } },
  });
  ap.set(PDFName.of("N"), doc.context.register(stream));
  a.set(PDFName.of("Contents"), PDFString.of(newContents));
}

// REP Hiring Summary — one wide annotation holds development, contract number
// and contract amount; redrawn with the new number in the number's spot
async function buildRep(bytes: ArrayBuffer, cNumber: string): Promise<Uint8Array> {
  if (!cNumber || cNumber === TPL_NUM) return new Uint8Array(bytes);
  const pdf = await import("pdf-lib");
  const doc = await pdf.PDFDocument.load(bytes, { ignoreEncryption: true });
  const helvB = await doc.embedFont(pdf.StandardFonts.HelveticaBold);
  for (const { dict, text } of numberAnnots(pdf, doc)) {
    redrawAnnot(pdf, doc, dict, helvB, text.replace(TPL_NUM, cNumber), [
      { x: 2.32, y: 16.32, size: 9.6, text: "citywide Manhattan plaster" },
      { x: 2.32, y: 5.01, size: 9.6, text: "Restoration" },
      { x: 215.1, y: 5.01, size: 12, text: cNumber, center: true },
      { x: 400, y: 5.01, size: 9.6, text: "$5,000,000.00" },
    ]);
  }
  return doc.save();
}

// Equal Opportunity report — the contract number is its own small annotation
async function buildEo(bytes: ArrayBuffer, cNumber: string): Promise<Uint8Array> {
  if (!cNumber || cNumber === TPL_NUM) return new Uint8Array(bytes);
  const pdf = await import("pdf-lib");
  const doc = await pdf.PDFDocument.load(bytes, { ignoreEncryption: true });
  const helv = await doc.embedFont(pdf.StandardFonts.Helvetica);
  for (const { dict } of numberAnnots(pdf, doc)) {
    redrawAnnot(pdf, doc, dict, helv, cNumber, [
      { x: 2, y: 4.2, size: 11, text: cNumber },
    ]);
  }
  return doc.save();
}

// Section 3 Hiring Summary — the genuine fillable form; the contract and
// release numbers are real fields (works on uploaded copies too)
async function buildHiring(bytes: ArrayBuffer, cNumber: string, relNumber: string): Promise<Uint8Array> {
  const pdf = await import("pdf-lib");
  const doc = await pdf.PDFDocument.load(bytes, { ignoreEncryption: true });
  try {
    const form = doc.getForm();
    const helv = await doc.embedFont(pdf.StandardFonts.Helvetica);
    try { form.getTextField("PRIME ORIGINAL CONTRACT NO").setText(cNumber || ""); } catch { /* field missing */ }
    try { form.getTextField("release no").setText(relNumber || ""); } catch { /* field missing */ }
    form.updateFieldAppearances(helv);
  } catch { /* not a fillable copy — ship as-is */ }
  return doc.save();
}

export interface PkgDoc { name: string; bytes: Uint8Array }

// the four supporting documents for one release's invoice package
export async function buildPackageDocs(contractId: string, cNumber: string, relNumber: string): Promise<PkgDoc[]> {
  const custom = await listPkgOverrides(contractId);
  const get = async (file: string) =>
    custom.has(file) ? ((await fetchOverride(contractId, file)) ?? fetchTemplate(file)) : fetchTemplate(file);
  const [affB, repB, hirB, eoB] = await Promise.all([
    get("affidavit.pdf"), get("rep.pdf"), get("hiring.pdf"), get("eo.pdf"),
  ]);
  const rel = String(relNumber || "").trim();
  const [rep, hir, eo] = await Promise.all([
    custom.has("rep.pdf") ? Promise.resolve(new Uint8Array(repB)) : buildRep(repB, cNumber),
    buildHiring(hirB, cNumber, rel),
    custom.has("eo.pdf") ? Promise.resolve(new Uint8Array(eoB)) : buildEo(eoB, cNumber),
  ]);
  return [
    { name: `AFFIDAVIT_${cNumber}.pdf`, bytes: new Uint8Array(affB) },
    { name: `REP_${cNumber}.pdf`, bytes: rep },
    { name: `HIRING_PLAN_${cNumber}_REL${rel || "X"}.pdf`, bytes: hir },
    { name: `EQUAL_OPPORTUNITY_${cNumber}.pdf`, bytes: eo },
  ];
}
