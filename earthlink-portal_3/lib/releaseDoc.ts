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

// NYCHA "Standard Invoice" as a styled xlsx.
export function buildInvoiceXlsx(a: {
  org: Org; cNumber: string; relNum: string; workOrder: string; dev: string;
  number: string; date: string; rows: DocRow[];
}) {
  const total = a.rows.reduce((s, it) => s + it.qty * it.unit_price, 0);
  const asNum = (s: string) => (/^\d+$/.test(s) ? Number(s) : s);
  const aoa: (string | number)[][] = [];
  aoa.push(["Standard Invoice"]);
  aoa.push(["Date:", prettyDate(a.date), "", "", "", "Invoice #", a.number]);
  aoa.push([]);
  aoa.push(["Original To:", "", "", "", "From:"]);
  aoa.push(["NEW YORK CITY HOUSING AUTHORITY", "", "", "", (a.org.company || "").toUpperCase()]);
  aoa.push(["ACCOUNTS PAYABLE", "", "", "", [a.org.address1, a.org.address2].filter(Boolean).join(", ")]);
  aoa.push(["P.O. BOX 3636, CHURCH STREET STATION", "", "", "", [a.org.phone && `Phone ${a.org.phone}`, a.org.email].filter(Boolean).join(" · ")]);
  aoa.push(["NEW YORK, NY 10008-3636", "", "", "", a.org.license ? `License ${a.org.license}` : ""]);
  aoa.push([]);
  aoa.push(["Copy To:"]);
  aoa.push(["NEW YORK CITY HOUSING AUTHORITY, 90 CHURCH STREET, 6TH FLOOR, NEW YORK, NY 10008"]);
  aoa.push(["ATTENTION: BOROUGH PAYMENT UNIT"]);
  aoa.push([]);
  aoa.push(["Contract:", asNum(a.cNumber), "", "Release:", asNum(a.relNum), "", "Development:", a.dev]);
  if (a.workOrder) aoa.push(["Work order:", a.workOrder]);
  aoa.push([]);
  const headerRow = aoa.length;
  aoa.push(["Line", "Item", "Category", "Description", "UOM", "Quantity", "Price", "Total Cost"]);
  a.rows.forEach((it) => aoa.push([it.line, asNum(it.code), it.category, it.description, it.uom, it.qty, it.unit_price, it.qty * it.unit_price]));
  const totalRow = aoa.length;
  aoa.push(["", "", "", "", "", "Total", "", total]);
  aoa.push([]);
  aoa.push(["Mail to: NYCHA Disbursements, P.O. Box 3636, New York, NY 10008-3636 · Questions: Disbursements 212-306-6500"]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 10 }, { wch: 15 }, { wch: 38 }, { wch: 90 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 18 }];
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 7 } }, { s: { r: 10, c: 0 }, e: { r: 10, c: 7 } }, { s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: 7 } }];
  const thin = { style: "thin", color: { rgb: "000000" } };
  const box = { top: thin, bottom: thin, left: thin, right: thin };
  const shade = { patternType: "solid", fgColor: { rgb: "E8E4DA" } };
  const cellAt = (r: number, c: number) => ws[XLSX.utils.encode_cell({ r, c })] || (ws[XLSX.utils.encode_cell({ r, c })] = { t: "s", v: "" });
  cellAt(0, 0).s = { font: { bold: true, sz: 14 }, alignment: { horizontal: "center" }, fill: shade, border: { top: { style: "medium", color: { rgb: "000000" } }, bottom: thin, left: thin, right: thin } };
  cellAt(1, 0).s = { font: { bold: true } }; cellAt(1, 5).s = { font: { bold: true } };
  cellAt(3, 0).s = { font: { bold: true } }; cellAt(3, 4).s = { font: { bold: true } };
  cellAt(9, 0).s = { font: { bold: true } };
  cellAt(11, 0).s = { font: { bold: true } };
  cellAt(13, 0).s = { font: { bold: true } }; cellAt(13, 3).s = { font: { bold: true } }; cellAt(13, 6).s = { font: { bold: true } };
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
