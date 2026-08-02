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

export interface InvoiceArgs {
  org: Org; cNumber: string; relNum: string; workOrder: string; dev: string;
  number: string; date: string; rows: DocRow[]; filename?: string;
}

async function buildInvoiceWb(a: InvoiceArgs) {
  await ensureXLSX();
  void a.workOrder; // the template has no work-order slot
  const total = a.rows.reduce((s, it) => s + it.qty * it.unit_price, 0);
  const shortDate = (iso: string) => { const m = (iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${Number(m[2])}/${Number(m[3])}/${m[1].slice(2)}` : iso; };

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

  // 1) replay the template header block (rows 1-24) — the line-item area below
  //    is built fresh as the boxed LINE table the owner's real invoices use
  for (const [coord, tpl] of Object.entries(INVOICE_TPL.cells)) {
    const m = coord.match(/^([A-I])(\d+)$/);
    if (!m || Number(m[2]) > 24) continue;
    put(coord, tpl.v ?? "", styleOf(tpl));
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

  // 3) the boxed item table, exactly like the owner's sent invoices:
  //    LINE | Description | Quanity | uom | unit price | Amount
  const K = { rgb: "000000" };
  const bd = (t?: string, b?: string, l?: string, r2?: string) => ({
    ...(t ? { top: { style: t, color: K } } : {}), ...(b ? { bottom: { style: b, color: K } } : {}),
    ...(l ? { left: { style: l, color: K } } : {}), ...(r2 ? { right: { style: r2, color: K } } : {}),
  });
  const f11 = { name: "Calibri", sz: 11 };
  const f11b = { ...f11, bold: true };
  const f11bu = { ...f11, bold: true, underline: true };
  const mid = { horizontal: "center", vertical: "center" };
  const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];
  const rowsArr: ({ hpt: number } | undefined)[] = [];
  for (const [r, h] of Object.entries(INVOICE_TPL.rows)) {
    if (Number(r) <= 24) rowsArr[Number(r) - 1] = { hpt: h };
  }
  rowsArr[24] = { hpt: 10 }; // breathing room under the header block

  const hdr = 26, first = 27;
  const emptyRow = first + a.rows.length; // the originals keep one blank ruled row
  const totalRow = emptyRow + 2;
  // header row (their exact spellings)
  put(`B${hdr}`, "LINE", { font: f11bu, alignment: mid, border: bd("medium", "thin", "medium", "thin") });
  put(`C${hdr}`, "Description", { font: f11bu, alignment: mid, border: bd("medium", "thin", "thin") });
  put(`D${hdr}`, "", { font: f11, border: bd("medium", "thin") });
  put(`E${hdr}`, "", { font: f11, border: bd("medium", "thin", undefined, "thin") });
  put(`F${hdr}`, "Quanity ", { font: f11bu, alignment: { vertical: "center" }, border: bd("medium", "thin", "thin", "thin") });
  put(`G${hdr}`, "uom ", { font: f11bu, alignment: { vertical: "center" }, border: bd("medium", "thin", "thin", "thin") });
  put(`H${hdr}`, "unit price ", { font: f11bu, alignment: { vertical: "center" }, border: bd("medium", "thin", "thin", "thin") });
  put(`I${hdr}`, "Amount", { font: f11bu, alignment: { vertical: "center" }, border: bd("medium", "thin", "thin", "medium") });
  merges.push({ s: { r: hdr - 1, c: 2 }, e: { r: hdr - 1, c: 4 } });
  rowsArr[hdr - 1] = { hpt: 16 };

  const itemRow = (r: number, it: DocRow | null, last: boolean) => {
    const bB = last ? "medium" : "thin";
    put(`B${r}`, it ? it.code : "", { font: f11, alignment: mid, border: bd("thin", bB, "medium", "thin") });
    put(`C${r}`, it ? it.description : "", { font: f11, alignment: { ...mid, wrapText: true }, border: bd("thin", bB, "thin") });
    put(`D${r}`, "", { font: f11, border: bd("thin", bB) });
    put(`E${r}`, "", { font: f11, border: bd("thin", bB, undefined, "thin") });
    put(`F${r}`, it ? it.qty : "", { font: f11, alignment: mid, border: bd("thin", bB, "thin", "thin") });
    put(`G${r}`, it ? it.uom : "", { font: f11, alignment: mid, border: bd("thin", bB, "thin", "thin") });
    const pc = put(`H${r}`, it ? it.unit_price : "", { font: f11, alignment: mid, border: bd("thin", bB, "thin", "thin") });
    if (it) pc.z = "#,##0.00";
    const ac = put(`I${r}`, it ? Math.round(it.qty * it.unit_price * 100) / 100 : "", { font: f11b, alignment: mid, border: bd("thin", bB, "thin", "medium") });
    if (it) ac.z = '"$"#,##0.00';
    merges.push({ s: { r: r - 1, c: 2 }, e: { r: r - 1, c: 4 } });
    // rows grow with the wrapped description (~34 characters per line)
    const lines = it ? Math.max(1, Math.ceil(it.description.length / 34)) : 1;
    rowsArr[r - 1] = { hpt: Math.max(30, lines * 13 + 12) };
  };
  a.rows.forEach((it, i) => itemRow(first + i, it, false));
  itemRow(emptyRow, null, true);

  // 4) the Total price box, set off to the right like theirs
  put(`G${totalRow}`, "Total price", { font: f11b, alignment: mid, border: bd("thin", "thin", "thin") });
  put(`H${totalRow}`, "", { font: f11b, border: bd("thin", "thin", undefined, "thin") });
  const tc = put(`I${totalRow}`, Math.round(total * 100) / 100, { font: f11b, alignment: mid, border: bd("thin", "thin", "thin", "thin") });
  tc.z = '"$"#,##0.00';
  merges.push({ s: { r: totalRow - 1, c: 6 }, e: { r: totalRow - 1, c: 7 } });
  rowsArr[totalRow - 1] = { hpt: 16 };
  rowsArr[emptyRow] = { hpt: 8 };

  ws["!ref"] = `A1:I${totalRow + 1}`;
  // the writer pads character widths by ~0.83 — compensate so the sheet
  // reopens with the template's exact column widths
  ws["!cols"] = INVOICE_TPL.cols.map((w) => ({ wch: Math.max(1, w - 0.83) }));
  ws["!rows"] = rowsArr;
  ws["!merges"] = merges;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws as never, "Sheet1");
  return wb;
}

export async function buildInvoiceXlsx(a: InvoiceArgs) {
  const wb = await buildInvoiceWb(a);
  XLSX.writeFile(wb, a.filename || `invoice_${a.cNumber}_rel${a.relNum}.xlsx`);
}

// same workbook as raw bytes — for zipping many invoices into one download
export async function buildInvoiceBytes(a: InvoiceArgs): Promise<Uint8Array> {
  const wb = await buildInvoiceWb(a);
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

// the same invoice as a one-page PDF — drawn straight from the filled
// workbook cells, so the PDF always says exactly what the Excel says
export async function buildInvoicePdfBytes(a: InvoiceArgs): Promise<Uint8Array> {
  const wb = await buildInvoiceWb(a);
  const ws = wb.Sheets.Sheet1 as unknown as Record<string, { v?: unknown; t?: string; z?: string; s?: Record<string, unknown> } | unknown>;
  const pdf = await import("pdf-lib");
  const doc = await pdf.PDFDocument.create();
  const [helv, helvB] = await Promise.all([
    doc.embedFont(pdf.StandardFonts.Helvetica), doc.embedFont(pdf.StandardFonts.HelveticaBold),
  ]);
  const endRow = Number((String(ws["!ref"] || "A1:I51").match(/(\d+)$/) || [0, 51])[1]);
  // excel column chars -> points; row heights are points already
  const colPts = INVOICE_TPL.cols.map((w) => (w * 7 + 5) * 0.75);
  const rowsArr = (ws["!rows"] as ({ hpt: number } | undefined)[]) || [];
  const rowPts: number[] = [];
  for (let r = 1; r <= endRow; r++) rowPts[r] = rowsArr[r - 1]?.hpt ?? 15;
  const W = colPts.reduce((s, w) => s + w, 0);
  const H = rowPts.reduce((s, h) => s + (h || 0), 0);
  const page = doc.addPage([612, 792]); // letter portrait, like the printed sheet
  const k = Math.min((612 - 36) / W, (792 - 36) / H);
  const x0 = (612 - W * k) / 2;
  const y0 = 792 - (792 - H * k) / 2; // top edge
  const colX: number[] = [0];
  for (let c = 0; c < colPts.length; c++) colX[c + 1] = colX[c] + colPts[c];
  const rowY: number[] = [0, 0]; // rowY[r] = distance from top to row r's top
  for (let r = 1; r <= endRow; r++) rowY[r + 1] = rowY[r] + (rowPts[r] || 0);
  const px = (c: number) => x0 + colX[c] * k;
  const py = (rTop: number) => y0 - rTop * k; // sheet-top distance -> page y
  const lineW: Record<string, number> = { hair: 0.4, thin: 0.75, medium: 1.5, thick: 2.25, dotted: 0.5, dashed: 0.5 };
  const black = pdf.rgb(0, 0, 0);
  const fmtNum = (v: number, z?: string) => {
    const s = Math.abs(v % 1) < 1e-9 && !z ? String(v) : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return z && z.includes('"$"') ? `$${s}` : s;
  };
  // merged ranges: text draws once across the span, covered cells keep borders
  const mergeSpan = new Map<string, number>(); // anchor coord -> end col
  const mergeCovered = new Set<string>();
  for (const m of (ws["!merges"] as { s: { r: number; c: number }; e: { r: number; c: number } }[] | undefined) || []) {
    mergeSpan.set(`${"ABCDEFGHI"[m.s.c]}${m.s.r + 1}`, m.e.c);
    for (let cc = m.s.c; cc <= m.e.c; cc++) if (cc !== m.s.c) mergeCovered.add(`${"ABCDEFGHI"[cc]}${m.s.r + 1}`);
  }
  for (let r = 1; r <= endRow; r++) {
    for (let c = 0; c < 9; c++) {
      const coord = `${"ABCDEFGHI"[c]}${r}`;
      const cell = ws[coord] as { v?: unknown; t?: string; z?: string; s?: { font?: { sz?: number; bold?: boolean; underline?: boolean }; border?: Record<string, { style?: string }>; alignment?: { horizontal?: string; wrapText?: boolean } } } | undefined;
      if (!cell) continue;
      let xL = px(c), xR = px(c + 1);
      const yT = py(rowY[r]), yB = py(rowY[r + 1]);
      const b = cell.s?.border || {};
      for (const [side, spec] of Object.entries(b)) {
        if (!spec?.style) continue;
        const t = (lineW[spec.style] ?? 0.75) * k;
        if (side === "top") page.drawLine({ start: { x: xL, y: yT }, end: { x: xR, y: yT }, thickness: t, color: black });
        if (side === "bottom") page.drawLine({ start: { x: xL, y: yB }, end: { x: xR, y: yB }, thickness: t, color: black });
        if (side === "left") page.drawLine({ start: { x: xL, y: yB }, end: { x: xL, y: yT }, thickness: t, color: black });
        if (side === "right") page.drawLine({ start: { x: xR, y: yB }, end: { x: xR, y: yT }, thickness: t, color: black });
      }
      const raw = cell.v;
      if (raw === undefined || raw === null || raw === "" || mergeCovered.has(coord)) continue;
      if (mergeSpan.has(coord)) xR = px(mergeSpan.get(coord)! + 1);
      const text = typeof raw === "number" ? fmtNum(raw, cell.z) : String(raw);
      const font = cell.s?.font?.bold ? helvB : helv;
      // calibri runs a touch narrower than helvetica — keep the fit
      let size = (cell.s?.font?.sz ?? 16) * k * 0.92;
      const al = cell.s?.alignment?.horizontal || (typeof raw === "number" ? "right" : "left");
      // wrapped cells (the item descriptions) draw as stacked centered lines
      if (cell.s?.alignment?.wrapText) {
        const words = text.split(/\s+/).filter(Boolean);
        const roomW = xR - xL - 6 * k;
        const lines: string[] = [];
        let cur = "";
        for (const w of words) {
          const nx = cur ? `${cur} ${w}` : w;
          if (font.widthOfTextAtSize(nx, size) > roomW && cur) { lines.push(cur); cur = w; }
          else cur = nx;
        }
        if (cur) lines.push(cur);
        const lh = size * 1.18;
        let ly = (yT + yB) / 2 + (lines.length * lh) / 2 - size * 0.85;
        for (const ln of lines) {
          const lw = font.widthOfTextAtSize(ln, size);
          const lx = al === "left" ? xL + 3 * k : al === "right" ? xR - 3 * k - lw : (xL + xR) / 2 - lw / 2;
          page.drawText(ln, { x: lx, y: ly, size, font, color: black });
          ly -= lh;
        }
        continue;
      }
      // like Excel, text may spill over EMPTY neighbors but never into a
      // filled cell or past the sheet edge — shrink until it fits its room
      const occupied = (cc: number) => {
        const cel = ws[`${"ABCDEFGHI"[cc]}${r}`] as { v?: unknown } | undefined;
        return !!cel && cel.v !== undefined && cel.v !== null && cel.v !== "";
      };
      let room = px(9) - (xL + 3 * k);
      if (al === "right") {
        let lo = 0;
        for (let cc = c - 1; cc >= 0; cc--) if (occupied(cc)) { lo = px(cc + 1); break; }
        room = xR - 3 * k - lo;
      } else if (al === "center") {
        let lo = 0, hi = px(9);
        for (let cc = c - 1; cc >= 0; cc--) if (occupied(cc)) { lo = px(cc + 1); break; }
        for (let cc = c + 1; cc < 9; cc++) if (occupied(cc)) { hi = px(cc); break; }
        room = Math.min((xL + xR) / 2 - lo, hi - (xL + xR) / 2) * 2 - 4 * k;
      } else {
        for (let cc = c + 1; cc < 9; cc++) if (occupied(cc)) { room = px(cc) - (xL + 3 * k) - 2 * k; break; }
      }
      let tw = font.widthOfTextAtSize(text, size);
      if (tw > room && room > 0) { size = Math.max(5, (size * room) / tw); tw = font.widthOfTextAtSize(text, size); }
      const tx = al === "right" ? xR - 3 * k - tw : al === "center" ? (xL + xR) / 2 - tw / 2 : xL + 3 * k;
      const ty = yB + ((yT - yB) - size * 0.7) / 2;
      page.drawText(text, { x: tx, y: ty, size, font, color: black });
      if (cell.s?.font?.underline) page.drawLine({ start: { x: tx, y: ty - 1.6 * k }, end: { x: tx + tw, y: ty - 1.6 * k }, thickness: 0.7 * k, color: black });
    }
  }
  return doc.save();
}
