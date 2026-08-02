"use client";
// The official NYCHA Statement of Services (form 042.726 Rev. 04/03/23 v2).
// The genuine fillable PDF ships with the app (public/sos-template.pdf, fields
// blanked); this fills its named form fields with the release's numbers, so
// what downloads IS the real form — barcode, internal-use section and all.
export interface SosLine { describe: string; qty: string; uom: string; rate: string; total: string }
export interface SosData {
  vendorName: string; street: string; cityStateZip: string; phone: string; email: string;
  supplierNo: string; fedTaxId: string;
  poRelease: string; workOrder: string; dateOfServices: string;
  description: string;
  labor: SosLine[];      // the form fits 7 labor lines
  materials: SosLine[];  // and 5 material lines
  overhead: string; profit: string; totalCost: string;
  vendorNameTitle: string; dateSigned: string;
}

export const blankSosLine = (): SosLine => ({ describe: "", qty: "", uom: "", rate: "", total: "" });

export async function buildSosPdf(d: SosData): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const res = await fetch("/sos-template.pdf");
  if (!res.ok) throw new Error("Couldn't load the SOS form template");
  const doc = await PDFDocument.load(await res.arrayBuffer());
  const form = doc.getForm();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const set = (name: string, v: string) => { try { form.getTextField(name).setText(v || ""); } catch { /* field missing in template */ } };

  set("VENDOR_NAME", d.vendorName);
  set("STREET_ADDRESS", d.street);
  set("CITY_STATE_ZIP", d.cityStateZip);
  set("CONTACT_NUMBER", d.phone);
  set("EMAIL_ADDRESS", d.email);
  set("SUPPLY_NUMBER", d.supplierNo);
  set("FEDERAL_TAX_ID_NUMBER", d.fedTaxId);
  set("PO_NUMBER_RELEASE_NUMBER", d.poRelease);
  set("DATE_SERVICES_PERFORMED", d.dateOfServices);
  try {
    const dsc = form.getTextField("DESCRIBE_WORK_PERFORMED");
    dsc.setText(d.description || "");
    // the template's description box auto-sizes (short text would print huge)
    dsc.acroField.setDefaultAppearance("/Helv 10 Tf 0 g");
  } catch { /* field missing */ }
  d.labor.slice(0, 7).forEach((l, i) => {
    const n = i + 1;
    set(`LABOR_DESCRIBE_${n}`, l.describe);
    set(`LABOR_QTY_${n}`, l.qty);
    set(`LABOR_UOM_${n}`, l.uom);
    set(`LABOR_UNIT_PRICE_RATE_${n}`, l.rate);
    set(`LABOR_TOTAL_LINE_COST_${n}`, l.total);
  });
  d.materials.slice(0, 5).forEach((l, i) => {
    const n = i + 1;
    set(`MATERIALS_DESCRIBE_${n}`, l.describe);
    set(`MATERIALS_QTY_${n}`, l.qty);
    set(`MATERIALS_UOM_${n}`, l.uom);
    set(`MATERIALS_UNIT_PRICE_RATE_${n}`, l.rate);
    set(`MATERIALS_TOTAL_LINE_COST_${n}`, l.total);
  });
  set("OVERHEAD_AMOUNT", d.overhead);
  set("PROFIT_AMOUNT", d.profit);
  set("TOTAL_COST_AMOUNT", d.totalCost);
  set("VENDOR_NAME_AND_TITLE", d.vendorNameTitle);
  try { form.getCheckBox("VENDOR_AKNOWLEDGE_CRIME_CHECKBOX").check(); } catch { /* missing */ }
  form.updateFieldAppearances(helv);

  // two fields share their name with a NYCHA internal-use twin at the bottom of
  // the form — filling the field would show in both places, so the value is
  // drawn as plain text at the top box only, and NYCHA's copies stay blank
  const page = doc.getPage(0);
  const drawAt = (name: string, v: string) => {
    if (!v) return;
    try {
      const w = (form.getTextField(name) as unknown as { acroField: { getWidgets(): { getRectangle(): { x: number; y: number } }[] } }).acroField.getWidgets()[0];
      const r = w.getRectangle();
      page.drawText(v, { x: r.x + 2, y: r.y + 3, size: 9, font: helv });
    } catch { /* missing */ }
  };
  drawAt("WORK_ORDER_NUMBER", d.workOrder);
  drawAt("DATE_SIGNED", d.dateSigned);

  return doc.save();
}

export async function downloadSosPdf(d: SosData, filename: string): Promise<void> {
  const bytes = await buildSosPdf(d);
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const blob = new Blob([ab], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  // revoking right away can abort the download on iPhone — give it a minute
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
