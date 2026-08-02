// Shared document data for a release: the SOS and the invoice both pull line
// items the same way — the walk sheet tied to the release number first, the
// items imported from the release PDF as fallback.
// heavy export engine — loaded only when an invoice xlsx is actually built
let XLSX!: typeof import("xlsx-js-style");
const ensureXLSX = async () => {
  if (XLSX) return;
  const m = await import("xlsx-js-style");
  XLSX = ((m as { default?: typeof import("xlsx-js-style") }).default ?? m) as typeof import("xlsx-js-style");
};
import { sb } from "./supabase";
import { prettyDate, type Org } from "./docs";

export type DocRow = { line: number; code: string; category: string; description: string; uom: string; qty: number; unit_price: number };
export interface ReleaseDocData { rows: DocRow[]; dev: string; addr: string; stair: string; apt: string; }

// "007" and "7" are the same release — compare with leading zeros stripped
const relNorm = (v: unknown) => String(v ?? "").trim().replace(/^0+(?=\d)/, "");

export async function gatherReleaseDoc(
  contractId: string,
  rel: { id: string; rel_number: string; location?: string; address?: string; buildings?: string }
): Promise<ReleaseDocData> {
  // headers only — the fat qty_map comes in a second, tiny read below
  const { data: props } = await sb().from("proposals").select("id,release_number,development,address,apt,stairhall")
    .eq("contract_id", contractId).not("release_number", "is", null)
    .order("created_at", { ascending: false });
  const matches = ((props || []) as { id: string; release_number?: string; development?: string; address?: string; apt?: string; stairhall?: string }[])
    .filter((p) => relNorm(p.release_number) === relNorm(rel.rel_number));
  // quantities come from the newest matching sheet that actually HAS them —
  // an empty duplicate draft on top must not hide a filled one underneath
  let map: Record<string, number> | null = null;
  let prop: (typeof matches)[number] | undefined;
  if (matches.length > 0) {
    const { data: qs } = await sb().from("proposals").select("id,qty_map").in("id", matches.map((m) => m.id));
    const qmap = new Map(((qs || []) as { id: string; qty_map?: Record<string, number> | null }[]).map((q) => [q.id, q.qty_map]));
    prop = matches.find((m) => { const q = qmap.get(m.id); return q && Object.keys(q).length > 0; }) ?? matches[0];
    map = qmap.get(prop.id) || null;
  }
  const head = matches[0] ?? prop;
  let rows: DocRow[] = [];
  if (map && Object.keys(map).length > 0) {
    // fetch only the catalog lines the sheet actually uses, not the whole book
    const codes = Object.keys(map).filter((k) => Number(map![k]) > 0);
    const { data: cat } = codes.length > 0
      ? await sb().from("contract_items").select("line,code,category,description,uom,unit_price").eq("contract_id", contractId).in("code", codes).order("line")
      : { data: [] };
    const m2 = map;
    rows = ((cat || []) as { line: number; code: string; category: string; description: string; uom: string; unit_price: number }[])
      .filter((ci) => Number(m2[ci.code]) > 0)
      .map((ci) => ({ line: ci.line, code: ci.code, category: ci.category, description: ci.description, uom: ci.uom, qty: Number(m2[ci.code]), unit_price: Number(ci.unit_price) }));
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
    dev: rel.location || head?.development || prop?.development || "",
    addr: rel.address || rel.buildings || head?.address || prop?.address || "",
    stair: head?.stairhall || prop?.stairhall || "",
    apt: head?.apt || prop?.apt || "",
  };
}

// NYCHA "Standard Invoice" — replays the owner's own Excel template cell by
// cell (captured in lib/invoiceTemplateSpec.ts) and fills in the release's
// numbers, so every invoice looks exactly like the one they've always sent.
import { INVOICE_TPL, type TplCell } from "./invoiceTemplateSpec";
import { COMPANY } from "./company";

export async function buildInvoiceXlsx(a: {
  org: Org; cNumber: string; relNum: string; workOrder: string; dev: string;
  number: string; date: string; rows: DocRow[]; filename?: string;
}) {
  await ensureXLSX();
  void a.workOrder; // the template has no work-order slot
  const total = a.rows.reduce((s, it) => s + it.qty * it.unit_price, 0);
  const shortDate = (iso: string) => { const m = (iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${Number(m[2])}/${Number(m[3])}/${m[1].slice(2)}` : iso; };

  // items live in the description area (rows 27-48 = 22 lines in the template);
  // a longer list stretches the box instead of spilling out of it
  const extra = Math.max(0, a.rows.length - 22);
  const totalRow = 49 + extra;

  const ws: Record<string, unknown> = {};
  type Style = Record<string, unknown>;
  const put = (coord: string, v: string | number | undefined, s: Style) => {
    const cell: Record<string, unknown> = { t: typeof v === "number" ? "n" : "s", v: v ?? "", s };
    ws[coord] = cell;
    return cell as { v?: unknown; t?: string; z?: string; s?: Style };
  };
  const styleOf = (t: TplCell): Style => {
    const s: Style = {};
    s.font = t.f ? { name: t.f.n || "Calibri", sz: t.f.sz, bold: !!t.f.b } : { name: "Calibri", sz: 16 };
    if (t.brd) {
      const b: Record<string, unknown> = {};
      for (const [k, st] of Object.entries(t.brd)) {
        const side = k === "t" ? "top" : k === "b" ? "bottom" : k === "l" ? "left" : "right";
        b[side] = { style: st, color: { rgb: "000000" } };
      }
      s.border = b;
    }
    if (t.al) s.alignment = { ...(t.al.h ? { horizontal: t.al.h } : {}), ...(t.al.v ? { vertical: t.al.v } : {}) };
    return s;
  };

  // 1) replay the template - rows at/past the box bottom shift down by `extra`
  for (const [coord, tpl] of Object.entries(INVOICE_TPL.cells)) {
    const m = coord.match(/^([A-I])(\d+)$/);
    if (!m) continue;
    let r = Number(m[2]);
    if (extra > 0 && r >= 48) r += extra;
    put(`${m[1]}${r}`, tpl.v ?? "", styleOf(tpl));
  }
  // extra description rows keep the box's side walls
  for (let r = 48; r < 48 + extra; r++) {
    put(`B${r}`, "", { font: { name: "Calibri", sz: 16 }, border: { left: { style: "medium", color: { rgb: "000000" } } } });
    put(`I${r}`, "", { font: { name: "Calibri", sz: 16 }, border: { right: { style: "medium", color: { rgb: "000000" } } } });
  }

  // 2) fill in this release's numbers (template fonts/borders stay)
  const withV = (coord: string, v: string | number) => {
    const cell = ws[coord] as { v?: unknown; t?: string } | undefined;
    if (cell) { cell.v = v; cell.t = typeof v === "number" ? "n" : "s"; }
    else put(coord, v, { font: { name: "Calibri", sz: 16 } });
  };
  const asNum = (s: string) => (/^[1-9]\d*$/.test(s) ? Number(s) : s);
  withV("B5", `DATE: ${shortDate(a.date)}`);
  withV("E5", `INVOICE #: ${a.number}`);
  withV("E8", `VENDOR NAME:  ${(a.org.company || COMPANY.legalName).toUpperCase()}`);
  withV("E10", `ADDRESS: ${[a.org.address1, a.org.address2].filter(Boolean).join(" ").toUpperCase()}`);
  withV("E13", `PHONE # ${a.org.phone || COMPANY.phone}`);
  withV("H13", `FAX # ${COMPANY.fax}`);
  withV("E15", asNum(a.cNumber));
  withV("G15", asNum(a.relNum));
  withV("I15", (a.org.terms || "").toUpperCase());
  withV("E18", (a.dev || "").toUpperCase());

  // 3) the line items, one per row from 27 down
  a.rows.forEach((it, i) => {
    const r = 27 + i;
    // template borders on these cells (the box walls and the band's top edge) stay
    const keep = (coord: string): Style => ((ws[coord] as { s?: Style } | undefined)?.s || {});
    const font14 = { name: "Calibri", sz: 14 };
    put(`B${r}`, `${it.code}  ${it.description}`.trim().slice(0, 60), { ...keep(`B${r}`), font: font14 });
    put(`F${r}`, it.qty, { ...keep(`F${r}`), font: font14, alignment: { horizontal: "right" } });
    put(`G${r}`, it.uom, { ...keep(`G${r}`), font: font14, alignment: { horizontal: "center" } });
    put(`H${r}`, it.unit_price, { ...keep(`H${r}`), font: font14, alignment: { horizontal: "right" } }).z = "#,##0.00";
    put(`I${r}`, Math.round(it.qty * it.unit_price * 100) / 100, { ...keep(`I${r}`), font: font14, alignment: { horizontal: "right" } }).z = "#,##0.00";
  });

  // 4) the total
  const totalCell = ws[`I${totalRow}`] as { v?: unknown; t?: string; z?: string } | undefined;
  if (totalCell) { totalCell.v = Math.round(total * 100) / 100; totalCell.t = "n"; totalCell.z = '"$"#,##0.00'; }

  ws["!ref"] = `A1:I${totalRow + 1}`;
  // the writer pads character widths by ~0.83 — compensate so the sheet
  // reopens with the template's exact column widths
  ws["!cols"] = INVOICE_TPL.cols.map((w) => ({ wch: Math.max(1, w - 0.83) }));
  const rowsArr: ({ hpt: number } | undefined)[] = [];
  for (const [r, h] of Object.entries(INVOICE_TPL.rows)) {
    let rr = Number(r);
    if (extra > 0 && rr >= 48) rr += extra;
    rowsArr[rr - 1] = { hpt: h };
  }
  for (let r = 48; r < 48 + extra; r++) rowsArr[r - 1] = { hpt: 21 };
  ws["!rows"] = rowsArr;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws as never, "Sheet1");
  XLSX.writeFile(wb, a.filename || `invoice_${a.cNumber}_rel${a.relNum}.xlsx`);
}
