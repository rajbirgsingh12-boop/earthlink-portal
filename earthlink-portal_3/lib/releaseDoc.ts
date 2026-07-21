// Shared document data for a release: the SOS and the invoice both pull line
// items the same way — the walk sheet tied to the release number first, the
// items imported from the release PDF as fallback.
import * as XLSX from "xlsx-js-style";
import { sb } from "./supabase";
import { prettyDate, type Org } from "./docs";

export type DocRow = { line: number; code: string; category: string; description: string; uom: string; qty: number; unit_price: number };
export interface ReleaseDocData { rows: DocRow[]; dev: string; addr: string; stair: string; apt: string; }

export async function gatherReleaseDoc(
  contractId: string,
  rel: { id: string; rel_number: string; location?: string; address?: string; buildings?: string }
): Promise<ReleaseDocData> {
  const { data: props } = await sb().from("proposals").select("*")
    .eq("contract_id", contractId).eq("release_number", rel.rel_number)
    .order("created_at", { ascending: false }).limit(1);
  const prop = (props || [])[0] as { qty_map?: Record<string, number> | null; development?: string; address?: string; apt?: string; stairhall?: string } | undefined;
  let rows: DocRow[] = [];
  if (prop?.qty_map && Object.keys(prop.qty_map).length > 0) {
    const { data: cat } = await sb().from("contract_items").select("*").eq("contract_id", contractId).order("line");
    const map = prop.qty_map;
    rows = ((cat || []) as { line: number; code: string; category: string; description: string; uom: string; unit_price: number }[])
      .filter((ci) => Number(map[ci.code]) > 0)
      .map((ci) => ({ line: ci.line, code: ci.code, category: ci.category, description: ci.description, uom: ci.uom, qty: Number(map[ci.code]), unit_price: Number(ci.unit_price) }));
  }
  if (rows.length === 0) {
    const { data: cd } = await sb().from("contract_items").select("code,category").eq("contract_id", contractId);
    let catMap = new Map(((cd || []) as { code: string; category: string }[]).map((c) => [c.code, c.category]));
    if (catMap.size === 0) {
      const { data: pb } = await sb().from("price_items").select("code,category");
      catMap = new Map(((pb || []) as { code: string; category: string }[]).map((c) => [c.code, c.category]));
    }
    const { data: its } = await sb().from("release_items").select("*").eq("release_id", rel.id).order("line");
    rows = ((its || []) as { line: number; code: string; description: string; qty: number; uom: string; unit_price: number; amount: number }[])
      .filter((it) => Number(it.qty) > 0)
      .map((it) => ({
        line: it.line || 0, code: it.code, category: catMap.get(it.code) || "", description: it.description,
        uom: it.uom || "EA", qty: Number(it.qty),
        unit_price: Number(it.unit_price) || (Number(it.qty) ? (Number(it.amount) || 0) / Number(it.qty) : 0),
      }));
  }
  return {
    rows,
    dev: rel.location || prop?.development || "",
    addr: rel.address || rel.buildings || prop?.address || "",
    stair: prop?.stairhall || "",
    apt: prop?.apt || "",
  };
}

// NYCHA "Standard Invoice" — same layout as Earth Link's paper template
// (Original To / copy to on the left, FROM on the right, contract-release-
// development-period block, item table), styled like the SOS export.
export function buildInvoiceXlsx(a: {
  org: Org; cNumber: string; relNum: string; workOrder: string; dev: string;
  number: string; date: string; rows: DocRow[];
}) {
  const total = a.rows.reduce((s, it) => s + it.qty * it.unit_price, 0);
  const asNum = (s: string) => (/^\d+$/.test(s) ? Number(s) : s);
  const aoa: (string | number)[][] = [];
  aoa.push(["Standard Invoice"]);                                                               // r0
  aoa.push(["Date:", prettyDate(a.date), "", "", "Invoice #", a.number]);                       // r1
  aoa.push([]);                                                                                 // r2
  aoa.push(["Original To:", "", "", "", "From:"]);                                              // r3
  aoa.push(["NEW YORK CITY HOUSING AUTHORITY", "", "", "", `VENDOR NAME: ${(a.org.company || "").toUpperCase()}`]);
  aoa.push(["ACCOUNTS PAYABLE", "", "", "", `ADDRESS: ${[a.org.address1, a.org.address2].filter(Boolean).join(", ")}`]);
  aoa.push(["P.O. BOX 3636", "", "", "", `PHONE: ${a.org.phone || ""}${a.org.email ? ` · ${a.org.email}` : ""}`]);
  aoa.push(["CHURCH STREET STATION", "", "", "", a.org.license ? `LICENSE: ${a.org.license}` : ""]);
  aoa.push(["NEW YORK, NY 10008"]);                                                             // r8
  aoa.push([]);                                                                                 // r9
  aoa.push(["Copy To:", "", "", "", "Contract:", asNum(a.cNumber), "Release:", asNum(a.relNum)]);       // r10
  aoa.push(["New York City Housing Authority", "", "", "", "Development:", a.dev]);             // r11
  aoa.push(["90 CHURCH STREET", "", "", "", "Work order:", a.workOrder || ""]);                 // r12
  aoa.push(["6TH FLOOR, NEW YORK, NY 10008", "", "", "", "Period from:", "", "Period to:", ""]); // r13
  aoa.push(["ATTENTION: BOROUGH PAYMENT UNIT"]);                                                // r14
  aoa.push([]);                                                                                 // r15
  const headerRow = aoa.length;
  aoa.push(["Line", "Item", "Category", "Description", "UOM", "Quantity Authorized", "Price", "Total Cost"]);
  a.rows.forEach((it) => aoa.push([it.line, asNum(it.code), it.category, it.description, it.uom, it.qty, it.unit_price, it.qty * it.unit_price]));
  const totalRow = aoa.length;
  aoa.push(["", "", "", "", "", "Total", "", total]);
  aoa.push([]);
  aoa.push(["Mail to: NYCHA Disbursements, P.O. Box 3636, New York, NY 10008-3636 · Questions: Disbursements 212-306-6500"]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 12 }, { wch: 15 }, { wch: 38 }, { wch: 90 }, { wch: 18 }, { wch: 16 }, { wch: 14 }, { wch: 18 }];
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 7 } },
    ...[4, 5, 6, 7].map((r) => ({ s: { r, c: 4 }, e: { r, c: 7 } })),   // FROM block values span E:H
    { s: { r: 11, c: 5 }, e: { r: 11, c: 7 } },                          // development value
    { s: { r: 12, c: 5 }, e: { r: 12, c: 7 } },                          // work order value
    { s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: 7 } },
  ];
  const thin = { style: "thin", color: { rgb: "000000" } };
  const box = { top: thin, bottom: thin, left: thin, right: thin };
  const shade = { patternType: "solid", fgColor: { rgb: "E8E4DA" } };
  const cellAt = (r: number, c: number) => ws[XLSX.utils.encode_cell({ r, c })] || (ws[XLSX.utils.encode_cell({ r, c })] = { t: "s", v: "" });
  cellAt(0, 0).s = { font: { bold: true, sz: 14 }, alignment: { horizontal: "center", vertical: "center" }, fill: shade, border: { top: { style: "medium", color: { rgb: "000000" } }, bottom: thin, left: thin, right: thin } };
  // Date / Invoice # line
  cellAt(1, 0).s = { font: { bold: true } }; cellAt(1, 4).s = { font: { bold: true } };
  cellAt(1, 5).s = { font: { bold: true }, border: { bottom: thin } };
  // section labels
  for (const [r, c] of [[3, 0], [3, 4], [10, 0], [14, 0]] as [number, number][]) cellAt(r, c).s = { font: { bold: true }, fill: shade, border: box };
  // contract / release / development / work order / period labels + boxed values
  for (const [r, c] of [[10, 4], [10, 6], [11, 4], [12, 4], [13, 4], [13, 6]] as [number, number][]) cellAt(r, c).s = { font: { bold: true }, fill: shade, border: box };
  for (const [r, c] of [[10, 5], [10, 7], [11, 5], [12, 5], [13, 5], [13, 7]] as [number, number][]) cellAt(r, c).s = { border: box, alignment: { horizontal: "left" } };
  for (let r = headerRow; r <= totalRow; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = cellAt(r, c);
      const s: Record<string, unknown> = { border: box, alignment: { vertical: "top", wrapText: c === 3 } };
      if (r === headerRow || r === totalRow) s.font = { bold: true };
      if (r === headerRow) s.fill = shade;
      cell.s = s;
      if (r > headerRow && (c === 6 || c === 7) && typeof cell.v === "number") cell.z = "#,##0.00";
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Invoice");
  XLSX.writeFile(wb, `invoice_${a.cNumber}_rel${a.relNum}.xlsx`);
}
