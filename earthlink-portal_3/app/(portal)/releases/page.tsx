"use client";
import { useEffect, useRef, useState } from "react";
// styled fork of SheetJS — same API, plus cell borders/fonts for the SOS export
import * as XLSX from "xlsx-js-style";
import { sb } from "@/lib/supabase";
import { fmt, parseNum } from "@/lib/format";
import Stamp from "@/components/Stamp";
import type { Contract, Release } from "@/lib/types";
import { parseReleasePdfText, type ReleaseItem } from "@/lib/parseRelease";
import { prettyDate, type Org } from "@/lib/docs";
import { canonTrade, checkLabor, aggregateLogged } from "@/lib/labor";
import ContractPicker from "@/components/ContractPicker";
import NychaInvoicePrint from "@/components/NychaInvoicePrint";
import { gatherReleaseDoc, buildInvoiceXlsx, type DocRow } from "@/lib/releaseDoc";

type Filter = "all" | "chase" | "payroll" | "canceled" | "hours";
type PriceRow = { code: string; category: string; description: string; unit: string; unit_price: number };
type SosRow = { line: number; code: string; category: string; description: string; uom: string; qty: number; unit_price: number };

// ---- read red-filled (canceled) rows straight out of the xlsx zip ----
async function unzipEntries(buf: ArrayBuffer, names: string[]): Promise<Record<string, string>> {
  const dv = new DataView(buf); const u8 = new Uint8Array(buf); const td = new TextDecoder();
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65558); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("no eocd");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true);
    const elen = dv.getUint16(off + 30, true);
    const clen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = td.decode(u8.subarray(off + 46, off + 46 + nlen));
    if (names.includes(name)) {
      const lnlen = dv.getUint16(lho + 26, true);
      const lelen = dv.getUint16(lho + 28, true);
      const start = lho + 30 + lnlen + lelen;
      const comp = u8.slice(start, start + csize);
      if (method === 0) out[name] = td.decode(new Uint8Array(comp));
      else {
        const stream = new Blob([comp]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        out[name] = await new Response(stream).text();
      }
    }
    off += 46 + nlen + elen + clen;
  }
  return out;
}
function isRedHex(rgb: string | null): boolean {
  if (!rgb) return false;
  const h = rgb.slice(-6);
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return r >= 0xc0 && g <= 0x50 && b <= 0x50;
}
async function detectRedRows(buf: ArrayBuffer): Promise<Set<number>> {
  const red = new Set<number>();
  try {
    const files = await unzipEntries(buf, ["xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]);
    const styles = files["xl/styles.xml"]; const sheet = files["xl/worksheets/sheet1.xml"] || files["xl/worksheets/sheet2.xml"];
    if (!styles || !sheet) return red;
    const dp = new DOMParser();
    const sd = dp.parseFromString(styles, "application/xml");
    const redFills = new Set<number>(); const redFonts = new Set<number>();
    Array.from(sd.getElementsByTagName("fills")[0]?.getElementsByTagName("fill") || []).forEach((f, i) => {
      const c = f.getElementsByTagName("fgColor")[0];
      if (c && isRedHex(c.getAttribute("rgb"))) redFills.add(i);
    });
    Array.from(sd.getElementsByTagName("fonts")[0]?.getElementsByTagName("font") || []).forEach((f, i) => {
      const c = f.getElementsByTagName("color")[0];
      if (c && isRedHex(c.getAttribute("rgb"))) redFonts.add(i);
    });
    const redXf = new Set<number>();
    const cellXfs = sd.getElementsByTagName("cellXfs")[0];
    Array.from(cellXfs?.getElementsByTagName("xf") || []).forEach((xf, i) => {
      if (redFills.has(Number(xf.getAttribute("fillId"))) || redFonts.has(Number(xf.getAttribute("fontId")))) redXf.add(i);
    });
    if (redXf.size === 0) return red;
    const wd = dp.parseFromString(sheet, "application/xml");
    Array.from(wd.getElementsByTagName("row")).forEach((row) => {
      const n = Number(row.getAttribute("r"));
      const hit = Array.from(row.getElementsByTagName("c")).some((c) => redXf.has(Number(c.getAttribute("s"))));
      if (hit && n) red.add(n);
    });
  } catch { /* not a zip (csv) or unreadable styles — fall back to text flags */ }
  return red;
}


export default function Releases() {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [active, setActive] = useState<string>("");
  const [rows, setRows] = useState<Release[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(100);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [logged, setLogged] = useState<Record<string, number> | null>(null);
  const [pending, setPending] = useState<{ items: Omit<Release, "id" | "contract_id">[]; guess: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pdfPending, setPdfPending] = useState<{
    contract: string; rel: string; date: string; location: string; address: string;
    ticket: string; amount: number; hours: number; items: ReleaseItem[];
    breakdown: { cls: string; hours: number }[]; propNote: string;
    pdfFile?: File; propFile?: File;
  } | null>(null);
  const pdfRef = useRef<HTMLInputElement>(null);
  const propRef = useRef<HTMLInputElement>(null);

  // ---- SOS / attachments / aging state ----
  const [org, setOrg] = useState<Org | null>(null);
  const [priceBook, setPriceBook] = useState<PriceRow[] | null>(null);
  const [attachRel, setAttachRel] = useState<Release | null>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const isImg = (n: string) => /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(n);
  const [sosView, setSosView] = useState<{ relNum: string; ticket: string; cNumber: string; dev: string; addr: string; stair: string; apt: string; rows: SosRow[]; total: number } | null>(null);
  const [sosReady, setSosReady] = useState<Set<string>>(new Set());
  const [stageData, setStageData] = useState<{ items: Set<string>; walks: Set<string> }>({ items: new Set(), walks: new Set() });
  const [invPreview, setInvPreview] = useState<{ number: string; date: string; cNumber: string; relNum: string; dev: string; workOrder: string; rows: DocRow[] } | null>(null);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 2500); };

  const loadContracts = async () => {
    const { data } = await sb().from("contracts").select("id,number,name").order("number");
    const list = (data || []) as Contract[];
    setContracts(list);
    if (!active && list[0]) setActive(list[0].id);
  };
  useEffect(() => {
    loadContracts();
    sb().from("org").select("*").single().then(({ data }) => data && setOrg(data as Org));
  }, []);

  const loadRows = async (cid: string) => {
    if (!cid) { setRows([]); return; }
    setBusy(true);
    const all: Release[] = [];
    let from = 0;
    for (;;) {
      const { data } = await sb().from("releases").select("*").eq("contract_id", cid).order("id").range(from, from + 999);
      if (!data || data.length === 0) break;
      all.push(...(data as Release[]));
      if (data.length < 1000) break;
      from += 1000;
    }
    // sort numerically by release number when possible
    all.sort((a, b) => (parseFloat(a.rel_number) || 0) - (parseFloat(b.rel_number) || 0));
    setRows(all);
    setBusy(false);
    // which releases can produce an SOS? those with imported line items,
    // or a walk sheet (with quantities) whose Release # matches
    const ready = new Set<string>();
    const ids = all.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 200) {
      const { data: its } = await sb().from("release_items").select("release_id").in("release_id", ids.slice(i, i + 200));
      ((its || []) as { release_id: string }[]).forEach((it) => ready.add(it.release_id));
    }
    const { data: props } = await sb().from("proposals").select("release_number,qty_map").eq("contract_id", cid);
    const walkNums = new Set(
      ((props || []) as { release_number?: string; qty_map?: Record<string, number> | null }[])
        .filter((p) => p.release_number && p.qty_map && Object.keys(p.qty_map).length > 0)
        .map((p) => String(p.release_number).trim())
    );
    const itemsSet = new Set(ready);
    all.forEach((r) => { if (walkNums.has(String(r.rel_number).trim())) ready.add(r.id); });
    setSosReady(ready);
    setStageData({ items: itemsSet, walks: walkNums });
  };

  // the release's life at a glance: each stage lights up from data already entered
  const pipeline = (r: Release): [string, boolean][] => [
    ["WALK", stageData.walks.has(String(r.rel_number).trim())],
    ["REL", stageData.items.has(r.id)],
    ["WORK", !!(r.date_completed && String(r.date_completed).trim())],
    ["PAY", r.payroll_done],
    ["INV", !!r.invoice_sent],
    ["PAID", r.received],
  ];
  useEffect(() => { loadRows(active); }, [active]);

  const loadLogged = async () => {
    const { data } = await sb().from("timesheet_entries").select("release_id,hours");
    const agg: Record<string, number> = {};
    (data || []).forEach((e: { release_id: string | null; hours: number[] }) => {
      if (!e.release_id) return;
      agg[e.release_id] = (agg[e.release_id] || 0) + (e.hours || []).reduce((s2, h) => s2 + (Number(h) || 0), 0);
    });
    setLogged(agg);
  };

  const live = rows.filter((r) => !r.canceled);
  const canceledRows = rows.filter((r) => r.canceled);
  // chase = work done and payroll submitted, waiting on NYCHA's money
  const notR = live.filter((r) => r.payroll_done && !r.received && Number(r.amount) > 0);
  // payroll to submit = still open releases whose payroll isn't in yet
  const prPend = live.filter((r) => !r.payroll_done && !r.received && Number(r.amount) > 0);
  const tot = live.reduce((s, r) => s + Number(r.amount), 0);

  let list = live;
  if (filter === "chase") list = notR;
  if (filter === "payroll") list = prPend;
  if (filter === "canceled") list = canceledRows;
  if (q) list = list.filter((r) => `${r.rel_number} ${r.location} ${r.buildings} ${r.ticket}`.toLowerCase().includes(q.toLowerCase()));
  const shown = list.slice(0, limit);

  const toggle = async (r: Release, patch: Partial<Release>) => {
    setRows(rows.map((x) => (x.id === r.id ? { ...x, ...patch } : x)));
    let { error } = await sb().from("releases").update(patch).eq("id", r.id);
    if (error && /column/i.test(error.message)) {
      // database not upgraded yet — retry without the new aging columns
      const legacy = Object.fromEntries(Object.entries(patch).filter(([k]) => !["paid_date", "invoice_sent", "attachments"].includes(k)));
      if (Object.keys(legacy).length > 0) ({ error } = await sb().from("releases").update(legacy).eq("id", r.id));
      else error = null;
    }
    if (error) { flash(error.message); loadRows(active); }
  };

  // ---------- invoice generator ----------
  const bookFor = useRef<string>("");
  const loadPriceBook = async (): Promise<PriceRow[]> => {
    if (priceBook && bookFor.current === active) return priceBook;
    // prefer the active contract's own price book; fall back to the general book
    const { data: cd } = await sb().from("contract_items").select("code,category,description,uom,unit_price").eq("contract_id", active).order("line");
    let list: PriceRow[] = ((cd || []) as { code: string; category: string; description: string; uom: string; unit_price: number }[])
      .map((r) => ({ code: r.code, category: r.category, description: r.description, unit: r.uom, unit_price: r.unit_price }));
    if (list.length === 0) {
      const { data } = await sb().from("price_items").select("code,category,description,unit,unit_price");
      list = (data || []) as PriceRow[];
    }
    bookFor.current = active;
    setPriceBook(list);
    return list;
  };

  // payroll can be marked DONE only when logged hours meet the release's
  // labor minimum — per classification and in total (more is fine, less never)
  const togglePayroll = async (r: Release) => {
    if (!r.payroll_done) {
      const breakdown = r.labor_breakdown || [];
      const reqTotal = Number(r.labor_hours) || 0;
      if (reqTotal > 0 || breakdown.length > 0) {
        const { data: ents } = await sb().from("timesheet_entries").select("release_id,employee_id,hours").eq("release_id", r.id);
        const { data: allEmps } = await sb().from("employees").select("id,trade");
        const tradeById = new Map(((allEmps || []) as { id: string; trade: string }[]).map((e) => [e.id, canonTrade(e.trade)]));
        const logged = aggregateLogged((ents || []) as { release_id: string | null; employee_id: string; hours: number[] }[], tradeById)[r.id] || {};
        const res = checkLabor(breakdown, reqTotal, logged);
        if (!res.ok) {
          const parts = res.shorts.map((s) => `${s.cls} ${s.logged}/${s.required}h`);
          if (res.totalLogged < res.totalRequired) parts.push(`total ${res.totalLogged}/${res.totalRequired}h`);
          flash(`Short of the release minimum: ${[...new Set(parts)].join(" · ")} — log the hours in Payroll first`);
          return;
        }
      }
    }
    toggle(r, { payroll_done: !r.payroll_done });
  };

  // ---------- NYCHA Standard Invoice ----------
  const genInvoice = async (r: Release) => {
    setBusy(true);
    const c = contracts.find((x) => x.id === active);
    const d = await gatherReleaseDoc(active, r);
    setBusy(false);
    if (d.rows.length === 0) { flash("No line items for this release — make a walk sheet for it, or import the release PDF"); return; }
    const today = new Date().toISOString().slice(0, 10);
    if (!r.invoice_sent) {
      // generating the invoice records the sent date (feeds the statement aging)
      await sb().from("releases").update({ invoice_sent: today }).eq("id", r.id);
      setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, invoice_sent: today } : x)));
    }
    setInvPreview({ number: `${c?.number || ""}-${r.rel_number}`, date: today, cNumber: c?.number || "", relNum: r.rel_number, dev: d.dev, workOrder: r.ticket || "", rows: d.rows });
  };

  // ---------- Statement of Services (NYCHA form 042.726) ----------
  const genSOS = async (r: Release) => {
    setBusy(true);
    const c = contracts.find((x) => x.id === active);
    // prefer the walk sheet (proposal) tied to this release number
    const { data: props } = await sb().from("proposals").select("*")
      .eq("contract_id", active).eq("release_number", r.rel_number)
      .order("created_at", { ascending: false }).limit(1);
    const prop = (props || [])[0] as { qty_map?: Record<string, number> | null; development?: string; address?: string; apt?: string; stairhall?: string } | undefined;
    let rows: SosRow[] = [];
    if (prop && prop.qty_map && Object.keys(prop.qty_map).length > 0) {
      const { data: cat } = await sb().from("contract_items").select("*").eq("contract_id", active).order("line");
      const map = prop.qty_map;
      rows = ((cat || []) as { line: number; code: string; category: string; description: string; uom: string; unit_price: number }[])
        .filter((ci) => Number(map[ci.code]) > 0)
        .map((ci) => ({ line: ci.line, code: ci.code, category: ci.category, description: ci.description, uom: ci.uom, qty: Number(map[ci.code]), unit_price: Number(ci.unit_price) }));
    }
    if (rows.length === 0) {
      // fall back to the line items imported from the release PDF
      const book = await loadPriceBook();
      const cat = new Map(book.map((b) => [b.code, b.category]));
      const { data: its } = await sb().from("release_items").select("*").eq("release_id", r.id).order("line");
      rows = ((its || []) as { line: number; code: string; description: string; qty: number; uom: string; unit_price: number; amount: number }[])
        .filter((it) => Number(it.qty) > 0)
        .map((it) => ({
          line: it.line || 0, code: it.code, category: cat.get(it.code) || "", description: it.description,
          uom: it.uom || "EA", qty: Number(it.qty),
          unit_price: Number(it.unit_price) || (Number(it.qty) ? (Number(it.amount) || 0) / Number(it.qty) : 0),
        }));
    }
    setBusy(false);
    if (rows.length === 0) { flash("No line items for this release — make a walk sheet with quantities for it, or import the release PDF"); return; }
    setSosView({
      relNum: r.rel_number, ticket: r.ticket || "", cNumber: c?.number || "",
      dev: r.location || prop?.development || "", addr: r.address || r.buildings || prop?.address || "",
      stair: prop?.stairhall || "", apt: prop?.apt || "",
      rows, total: rows.reduce((s, it) => s + it.qty * it.unit_price, 0),
    });
  };

  const downloadSOS = () => {
    if (!sosView) return;
    const { relNum, ticket, cNumber, dev, addr, stair, apt, rows, total } = sosView;
    const today = prettyDate(new Date().toISOString().slice(0, 10));

    const aoa: (string | number)[][] = [];
    const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];
    const wide = (row: number, from = 0, to = 8) => merges.push({ s: { r: row, c: from }, e: { r: row, c: to } });
    aoa.push(["NYCHA STATEMENT OF SERVICE"]); wide(0);
    aoa.push(["Vendor:", "", (org?.company || "").toUpperCase()]);
    aoa.push(["Address:", "", [org?.address1, org?.address2].filter(Boolean).join(", "), "", "", "Date:", today]);
    aoa.push(["Telephone:", "", org?.phone || ""]);
    aoa.push(["Email:", "", org?.email || ""]);
    aoa.push([]);
    aoa.push(["PO:", "", /^\d+$/.test(cNumber) ? Number(cNumber) : cNumber]);
    aoa.push(["Work order:", "", ticket]);
    aoa.push(["Release:", "", /^\d+$/.test(relNum) ? Number(relNum) : relNum]);
    aoa.push(["Development:", "", dev]);
    aoa.push(["Stairhall:", "", stair]);
    aoa.push(["Apt:", "", apt]);
    aoa.push(["Address:", "", addr]);
    aoa.push([]);
    const headerRow = aoa.length;
    aoa.push(["Line", "Item", "Category", "Description", "UOM", "Quantity Authorized", "Price", "Total Cost"]);
    rows.forEach((it) => aoa.push([it.line, /^\d+$/.test(it.code) ? Number(it.code) : it.code, it.category, it.description, it.uom, it.qty, it.unit_price, it.qty * it.unit_price]));
    const totalRow = aoa.length;
    aoa.push(["", "", "", "", "", "Total", "", total]);
    aoa.push([]);
    const matHeader = aoa.length;
    aoa.push(["ITEMIZED LIST OF MATERIALS", "", "", "", "QTY", "UOM", "UNIT PRICE", "Cost Plus 10% Markup", "TOTAL COST"]);
    for (let i = 1; i <= 10; i++) aoa.push([i]);
    const matTotal = aoa.length;
    aoa.push(["", "Total"]);
    aoa.push(["", "Overhead", "$", "(not required for blanket agreements)"]);
    aoa.push(["", "Profit", "$", "(not required for blanket agreements)"]);
    aoa.push(["", "Total cost", "$"]);
    aoa.push([]);
    const ack1 = aoa.length;
    aoa.push(["I acknowledge and understand that offering, giving and/or accepting bribes, gratuities and/or gifts is a criminal offense under federal and New York state law."]); wide(ack1);
    const vendorSig = aoa.length;
    aoa.push(["VENDOR SIGNATURE", "", "", "", "", "Date:"]);
    aoa.push([]);
    const internal = aoa.length;
    aoa.push(["For NYCHA Internal Use Only:"]); wide(internal);
    const cert = aoa.length;
    aoa.push(["I hereby certify that the above-described work, labor, material, equipment, and/or services as referenced in accordance with the above referenced Purchase Order has been completed and inspected by me to my satisfaction."]); wide(cert);
    const ack2 = aoa.length;
    aoa.push(["I acknowledge and understand that offering, giving and/or accepting bribes, gratuities and/or gifts is a criminal offense under federal and New York state law."]); wide(ack2);
    const inspSig = aoa.length;
    aoa.push(["Inspected by Name and title", "", "", "", "Signature"]);
    const cmSig = aoa.length;
    aoa.push(["Contract Manager Signature"]);
    aoa.push(["WO #", "", "", "Date:", "receipt"]);
    aoa.push(["", "", "", "", "(for filing reference — fill in after the document is uploaded)"]);
    aoa.push([]);
    aoa.push(["NYCHA 042.726 (Rev. 04/05/24) v2"]);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 9 }, { wch: 15 }, { wch: 38 }, { wch: 90 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 16 }];
    ws["!merges"] = merges;
    const thin = { style: "thin", color: { rgb: "000000" } };
    const box = { top: thin, bottom: thin, left: thin, right: thin };
    const shade = { patternType: "solid", fgColor: { rgb: "E8E4DA" } };
    const cellAt = (row: number, col: number) => ws[XLSX.utils.encode_cell({ r: row, c: col })];
    const ensure = (row: number, col: number) => cellAt(row, col) || (ws[XLSX.utils.encode_cell({ r: row, c: col })] = { t: "s", v: "" });
    const style = (row: number, col: number, s: Record<string, unknown>) => { const cell = cellAt(row, col); if (cell) cell.s = s; };
    style(0, 0, { font: { bold: true, sz: 14 }, alignment: { horizontal: "center", vertical: "center" }, fill: shade, border: { top: { style: "medium", color: { rgb: "000000" } }, bottom: thin, left: thin, right: thin } });
    // bordered vendor + job header blocks (labels shaded bold, values boxed)
    for (const row of [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12]) {
      for (const col of [0, 1]) { ensure(row, col); style(row, col, { font: { bold: true }, fill: shade, border: box }); }
      ensure(row, 2); style(row, 2, { border: box });
      if (row === 2) { style(row, 5, { font: { bold: true }, fill: shade, border: box }); ensure(row, 6); style(row, 6, { border: box, alignment: { horizontal: "center" } }); }
    }
    for (let row = headerRow; row <= totalRow; row++) {
      for (let col = 0; col < 8; col++) {
        const cell = cellAt(row, col);
        if (!cell) continue;
        const s: Record<string, unknown> = { border: box, alignment: { vertical: "top", wrapText: col === 3 } };
        if (row === headerRow || row === totalRow) s.font = { bold: true };
        if (row === headerRow) s.fill = shade;
        cell.s = s;
        if (row > headerRow && (col === 6 || col === 7) && typeof cell.v === "number") cell.z = "#,##0.00";
      }
    }
    for (let row = matHeader; row <= matTotal; row++) {
      for (let col = 0; col < 9; col++) {
        const cell = cellAt(row, col) || (ws[XLSX.utils.encode_cell({ r: row, c: col })] = { t: "s", v: "" });
        cell.s = { border: box, ...(row === matHeader ? { font: { bold: true }, fill: shade } : {}), ...(row === matTotal ? { font: { bold: true } } : {}) };
      }
    }
    for (const [row, from, to] of [[vendorSig, 1, 4], [vendorSig, 6, 7], [inspSig, 1, 3], [inspSig, 5, 7], [cmSig, 2, 5]] as [number, number, number][]) {
      for (let col = from; col <= to; col++) {
        const cell = cellAt(row, col) || (ws[XLSX.utils.encode_cell({ r: row, c: col })] = { t: "s", v: "" });
        cell.s = { border: { bottom: thin } };
      }
    }
    for (const row of [vendorSig, inspSig, cmSig, internal]) style(row, 0, { font: { bold: true } });
    for (const row of [ack1, cert, ack2]) style(row, 0, { font: { italic: true }, alignment: { wrapText: true, vertical: "top" } });
    ws["!rows"] = []; ws["!rows"][ack1] = { hpt: 26 }; ws["!rows"][cert] = { hpt: 26 }; ws["!rows"][ack2] = { hpt: 26 };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    XLSX.writeFile(wb, `SOS_${cNumber}_rel${relNum}.xlsx`);
  };

  // ---------- attachments ----------
  const uploadAttachment = async (r: Release, file: File): Promise<{ name: string; path: string } | null> => {
    const path = `${r.id}/${file.name}`;
    const { error } = await sb().storage.from("docs").upload(path, file, { upsert: true });
    if (error) {
      flash(/bucket/i.test(error.message) ? "Storage not set up — run supabase/upgrade_invoices_aging_docs.sql first" : error.message);
      return null;
    }
    return { name: file.name, path };
  };

  const attachFile = async (r: Release, file: File) => {
    setBusy(true);
    const up = await uploadAttachment(r, file);
    if (up) {
      const list = [...(r.attachments || []).filter((a) => a.path !== up.path), up];
      const { error } = await sb().from("releases").update({ attachments: list }).eq("id", r.id);
      if (error) flash(error.message);
      else {
        setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, attachments: list } : x)));
        setAttachRel((prev) => (prev && prev.id === r.id ? { ...prev, attachments: list } : prev));
        flash(`Attached ${file.name}`);
      }
    }
    setBusy(false);
  };

  const openAttachment = async (path: string) => {
    const { data, error } = await sb().storage.from("docs").createSignedUrl(path, 3600);
    if (error || !data) { flash(error?.message || "Couldn't open the file"); return; }
    window.open(data.signedUrl, "_blank");
  };

  const removeAttachment = async (r: Release, path: string) => {
    await sb().storage.from("docs").remove([path]);
    const list = (r.attachments || []).filter((a) => a.path !== path);
    const { error } = await sb().from("releases").update({ attachments: list }).eq("id", r.id);
    if (error) { flash(error.message); return; }
    setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, attachments: list } : x)));
    setAttachRel((prev) => (prev && prev.id === r.id ? { ...prev, attachments: list } : prev));
  };

  // timestamped job photos straight from the phone camera
  const addPhotos = async (r: Release, files: File[]) => {
    for (const [i, f] of files.entries()) {
      const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "");
      const ext = (f.name.match(/\.\w+$/) || [".jpg"])[0];
      const named = new File([f], `photo_${stamp}${files.length > 1 ? `_${i + 1}` : ""}${ext}`, { type: f.type });
      await attachFile(r, named);
    }
  };

  // thumbnails for the photos in the open panel
  useEffect(() => {
    const imgs = (attachRel?.attachments || []).filter((a) => isImg(a.name));
    if (imgs.length === 0) { setPhotoUrls({}); return; }
    sb().storage.from("docs").createSignedUrls(imgs.map((a) => a.path), 3600).then(({ data }) => {
      const m: Record<string, string> = {};
      (data || []).forEach((d) => { if (d.signedUrl && d.path) m[d.path] = d.signedUrl; });
      setPhotoUrls(m);
    });
  }, [attachRel]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- import ----------
  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fname = file.name || "";
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const buf = ev.target?.result as ArrayBuffer;
        const redRows = await detectRedRows(buf);
        const wb = XLSX.read(buf, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const raw: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false, blankrows: true });
        const hIdx = raw.findIndex((r) => r.some((c) => /release/i.test(c)) && r.some((c) => /amount/i.test(c)));
        if (hIdx < 0) { flash("No header row with Release + Amount found"); return; }
        const headers = raw[hIdx].map((h) => String(h).toLowerCase());
        const col = (re: RegExp) => headers.findIndex((h) => re.test(h));
        const m = { rel: col(/^release/), location: col(/location/), buildings: col(/building/), ticket: col(/ticket/), amount: col(/amount/), pre: col(/pre/), date: col(/date|complet/), payroll: col(/payroll/), received: col(/receiv/), status: col(/status/), hours: col(/hour|labor/) };
        const pre = raw.slice(0, hIdx).flat().join(" ");
        const gm = pre.match(/contract\s*#?\s*([A-Za-z0-9-]+)/i) || fname.match(/(\d{5,})/);
        const items = raw.slice(hIdx + 1)
          .map((r, k) => ({ r, sheetRow: hIdx + 2 + k }))
          .filter(({ r }) => r.some((c) => String(c).trim() !== ""))
          .map(({ r, sheetRow }) => {
            const g = (i: number) => (i >= 0 ? String(r[i] ?? "").trim() : "");
            const rowText = r.join(" ");
            return {
              rel_number: g(m.rel), location: g(m.location), buildings: g(m.buildings), ticket: g(m.ticket),
              amount: m.amount >= 0 ? parseNum(r[m.amount]) : 0, pre_check: g(m.pre), date_completed: g(m.date),
              payroll_done: /^d/i.test(g(m.payroll)), received: /^y/i.test(g(m.received)),
              canceled: redRows.has(sheetRow) || /cancel|void/i.test(g(m.status) || rowText), labor_hours: m.hours >= 0 ? parseNum(r[m.hours]) : 0, assigned_to: null,
            };
          })
          .filter((it) => it.rel_number || it.amount > 0);
        setPending({ items, guess: gm ? gm[1] : "" });
      } catch { flash("Couldn't read that file — save as .xlsx or .csv"); }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  const runImport = async (mode: "replace" | "append") => {
    if (!pending) return;
    setBusy(true);
    const num = (pending.guess || "Contract").trim();
    let contract = contracts.find((c) => c.number === num);
    if (!contract) {
      const { data, error } = await sb().from("contracts").insert({ number: num, name: num }).select().single();
      if (error) { flash(error.message); setBusy(false); return; }
      contract = data as Contract;
    }
    if (mode === "replace") await sb().from("releases").delete().eq("contract_id", contract.id);
    for (let i = 0; i < pending.items.length; i += 500) {
      const chunk = pending.items.slice(i, i + 500).map((it) => ({ ...it, contract_id: contract!.id }));
      const { error } = await sb().from("releases").insert(chunk);
      if (error) { flash(error.message); break; }
    }
    setPending(null); setBusy(false);
    await loadContracts(); setActive(contract.id); await loadRows(contract.id);
    flash(`Loaded into ${num}`);
  };

  // ---------- mass import: several release PDFs at once, saved automatically ----------
  const importPdfBatch = async (files: File[]) => {
    setBusy(true);
    flash(`Reading ${files.length} PDFs…`);
    const done: string[] = []; const failed: string[] = [];
    const cCache = new Map<string, Contract>();
    contracts.forEach((c) => cCache.set(c.number, c));
    const used = new Set<string>();
    try {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      for (const file of files) {
        try {
          const buf = await file.arrayBuffer();
          const docp = await pdfjs.getDocument({ data: buf }).promise;
          let text = "";
          for (let pg = 1; pg <= docp.numPages; pg++) {
            const tc = await (await docp.getPage(pg)).getTextContent();
            text += tc.items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n";
          }
          const parsed = parseReleasePdfText(text);
          if (!parsed) { failed.push(file.name); continue; }
          const num = parsed.contract.trim() || "Contract";
          let contract = cCache.get(num);
          if (!contract) {
            const { data: nc, error } = await sb().from("contracts").insert({ number: num, name: num }).select().single();
            if (error || !nc) { failed.push(file.name); continue; }
            contract = nc as Contract; cCache.set(num, contract);
          }
          used.add(contract.id);
          const breakdown = parsed.items.filter((it) => it.uom === "HOUR")
            .map((it) => ({ cls: it.description.replace(/,?\s*Regular Hours/i, "").trim(), hours: it.qty }));
          const { data: existing } = await sb().from("releases").select("id").eq("contract_id", contract.id).eq("rel_number", parsed.rel).limit(1);
          let relId: string;
          if (existing && existing[0]) {
            relId = (existing[0] as { id: string }).id;
            const { error } = await sb().from("releases").update({
              amount: parsed.total, labor_hours: parsed.laborHours, labor_breakdown: breakdown,
              ticket: parsed.workOrders[0] || "", location: parsed.development,
            }).eq("id", relId);
            if (error) { failed.push(file.name); continue; }
            await sb().from("release_items").delete().eq("release_id", relId);
          } else {
            const { data: rel, error } = await sb().from("releases").insert({
              contract_id: contract.id, rel_number: parsed.rel, location: parsed.development,
              buildings: "", ticket: parsed.workOrders[0] || "", amount: parsed.total,
              labor_hours: parsed.laborHours, labor_breakdown: breakdown,
              date_completed: "", pre_check: "", payroll_done: false, received: false, canceled: false, assigned_to: null,
            }).select().single();
            if (error || !rel) { failed.push(file.name); continue; }
            relId = (rel as Release).id;
          }
          if (parsed.items.length > 0) {
            await sb().from("release_items").insert(parsed.items.map((it) => ({ release_id: relId, ...it })));
          }
          const path = `${relId}/${file.name}`;
          const { error: ue } = await sb().storage.from("docs").upload(path, file, { upsert: true });
          if (!ue) {
            const { data: cur } = await sb().from("releases").select("attachments").eq("id", relId).single();
            const prev = ((cur as { attachments?: { name: string; path: string }[] } | null)?.attachments || []).filter((a) => a.path !== path);
            await sb().from("releases").update({ attachments: [...prev, { name: file.name, path }] }).eq("id", relId);
          }
          done.push(parsed.rel);
        } catch { failed.push(file.name); }
      }
    } catch { /* pdfjs failed to load */ }
    setBusy(false);
    await loadContracts();
    const target = used.size === 1 ? [...used][0] : active;
    if (target) { setActive(target); loadRows(target); }
    flash(`${done.length} release${done.length === 1 ? "" : "s"} added${done.length ? ` (${done.slice(0, 10).join(", ")})` : ""}${failed.length ? ` · ${failed.length} failed` : ""} — SOS is ready on each row`);
  };

  // ---------- release PDF import ----------
  const handlePdf = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 1) { importPdfBatch(files); e.target.value = ""; return; }
    const file = files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        setBusy(true);
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const doc = await pdfjs.getDocument({ data: ev.target?.result as ArrayBuffer }).promise;
        let text = "";
        for (let pg = 1; pg <= doc.numPages; pg++) {
          const tc = await (await doc.getPage(pg)).getTextContent();
          text += tc.items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n";
        }
        const parsed = parseReleasePdfText(text);
        if (!parsed) { flash("Couldn't read this PDF — is it a NYCHA blanket release?"); setBusy(false); return; }
        const breakdown = parsed.items
          .filter((it) => it.uom === "HOUR")
          .map((it) => ({ cls: it.description.replace(/,?\s*Regular Hours/i, "").trim(), hours: it.qty }));
        setPdfPending({
          contract: parsed.contract, rel: parsed.rel, date: parsed.orderDate,
          location: parsed.development, address: "", ticket: parsed.workOrders[0] || "",
          amount: parsed.total, hours: parsed.laborHours, items: parsed.items,
          breakdown, propNote: "", pdfFile: file,
        });
        setBusy(false);
      } catch { flash("Couldn't read that PDF"); setBusy(false); }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  // reads the proposal/walk sheet and pulls Development, Address, Apt, Stairhall, Release #
  const handleProposal = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !pdfPending) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb = XLSX.read(ev.target?.result as ArrayBuffer, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const raw: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false, blankrows: false });
        const findVal = (re: RegExp): string => {
          for (const row of raw.slice(0, 12)) {
            for (let i = 0; i < row.length; i++) {
              if (re.test(String(row[i]).trim())) {
                for (let j = i + 1; j < row.length; j++) {
                  const v = String(row[j]).trim();
                  if (!v) continue;
                  if (v.endsWith(":")) return ""; // ran into the next label — field is blank
                  return v;
                }
                return "";
              }
            }
          }
          return "";
        };
        const dev = findVal(/^development\s*:?$/i);
        const addr = findVal(/^address\s*:?$/i);
        const apt = findVal(/^apt\.?\s*:?$/i);
        const stair = findVal(/^stairhall\s*:?$/i);
        const relNo = findVal(/^release\s*#?\s*:?$/i);
        const po = findVal(/^po\s*:?$/i);
        const parts = [addr, apt && `Apt ${apt}`, stair && `Stairhall ${stair}`].filter(Boolean);
        let note = "";
        if (relNo && pdfPending.rel && relNo !== pdfPending.rel) note = `Proposal says release ${relNo} but PDF is release ${pdfPending.rel} — double-check`;
        else if (po && pdfPending.contract && po !== pdfPending.contract) note = `Proposal is for contract ${po} but PDF is ${pdfPending.contract} — double-check`;
        setPdfPending({
          ...pdfPending,
          address: parts.join(", ") || pdfPending.address,
          location: pdfPending.location || dev,
          propNote: note,
          propFile: file,
        });
        flash(note ? "Proposal loaded — release # mismatch!" : "Address pulled from proposal");
      } catch { flash("Couldn't read that proposal sheet"); }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  const savePdfRelease = async () => {
    if (!pdfPending) return;
    setBusy(true);
    const num = pdfPending.contract.trim() || "Contract";
    let contract = contracts.find((c) => c.number === num);
    if (!contract) {
      const { data, error } = await sb().from("contracts").insert({ number: num, name: num }).select().single();
      if (error) { flash(error.message); setBusy(false); return; }
      contract = data as Contract;
    }
    // if this release number already exists on the contract, UPDATE it instead of duplicating
    const { data: existing } = await sb().from("releases").select("id,buildings,address")
      .eq("contract_id", contract.id).eq("rel_number", pdfPending.rel).limit(1);
    const prior = (existing || [])[0] as (Release & { address?: string }) | undefined;
    let relId: string;
    if (prior) {
      const patch: Record<string, unknown> = {
        amount: pdfPending.amount, labor_hours: pdfPending.hours,
        labor_breakdown: pdfPending.breakdown, ticket: pdfPending.ticket, location: pdfPending.location,
      };
      if (pdfPending.address) { patch.address = pdfPending.address; patch.buildings = pdfPending.address; }
      const { error } = await sb().from("releases").update(patch).eq("id", prior.id);
      if (error) { flash(error.message); setBusy(false); return; }
      relId = prior.id;
      await sb().from("release_items").delete().eq("release_id", relId);
    } else {
      const { data: rel, error } = await sb().from("releases").insert({
        contract_id: contract.id, rel_number: pdfPending.rel, location: pdfPending.location,
        buildings: pdfPending.address, address: pdfPending.address, ticket: pdfPending.ticket,
        amount: pdfPending.amount, labor_hours: pdfPending.hours, labor_breakdown: pdfPending.breakdown,
        date_completed: "", pre_check: "", payroll_done: false, received: false, canceled: false, assigned_to: null,
      }).select().single();
      if (error || !rel) { flash(error?.message || "Save failed"); setBusy(false); return; }
      relId = (rel as Release).id;
    }
    if (pdfPending.items.length > 0) {
      const { error: e2 } = await sb().from("release_items").insert(
        pdfPending.items.map((it) => ({ release_id: relId, ...it }))
      );
      if (e2) flash(`Release saved, but items failed: ${e2.message}`);
    }
    // auto-attach the source documents to the release (best-effort)
    const ups: { name: string; path: string }[] = [];
    for (const f of [pdfPending.pdfFile, pdfPending.propFile]) {
      if (!f) continue;
      const path = `${relId}/${f.name}`;
      const { error: ue } = await sb().storage.from("docs").upload(path, f, { upsert: true });
      if (!ue) ups.push({ name: f.name, path });
    }
    if (ups.length > 0) {
      const { data: cur } = await sb().from("releases").select("attachments").eq("id", relId).single();
      const prev = ((cur as { attachments?: { name: string; path: string }[] } | null)?.attachments || []).filter((a) => !ups.some((u) => u.path === a.path));
      await sb().from("releases").update({ attachments: [...prev, ...ups] }).eq("id", relId);
    }
    const saved = pdfPending; const updated = !!prior;
    setPdfPending(null); setBusy(false);
    await loadContracts(); setActive(contract.id); await loadRows(contract.id);
    flash(`Release ${saved.rel} ${updated ? "updated" : "added"} — ${saved.items.length} line items`);
  };

  const exportSheet = () => {
    const c = contracts.find((x) => x.id === active);
    const out = rows.map((r) => ({
      Release: r.rel_number, Location: r.location, Buildings: r.buildings, "Ticket #": r.ticket,
      Amount: Number(r.amount), "pre check": r.pre_check, "Date Completed": r.date_completed,
      Payroll: r.payroll_done ? "done" : "", "Received ": r.received ? "y" : "", Status: r.canceled ? "CANCELED" : "", "Labor Hrs": Number(r.labor_hours) || 0,
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(out), "Sheet1");
    XLSX.writeFile(wb, `${c?.number || "releases"}-export.xlsx`);
  };

  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <div className="font-display text-2xl font-bold uppercase">Releases</div>
        <div className="flex gap-2">
          <button className="btn btn-ghost" onClick={() => pdfRef.current?.click()}>+ From PDF(s)</button>
          <button className="btn btn-ghost" onClick={() => fileRef.current?.click()}>Upload sheet</button>
          {rows.length > 0 && <button className="btn btn-ghost" onClick={exportSheet}>Download</button>}
        </div>
      </div>
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFile} />
      <input ref={pdfRef} type="file" accept="application/pdf" multiple className="hidden" onChange={handlePdf} />
      <input ref={propRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleProposal} />

      {pending && (
        <div className="card mb-4 border-work p-4">
          <div className="mb-2 font-display text-base font-semibold uppercase">Import {pending.items.length} releases</div>
          <label className="text-[11px] uppercase tracking-widest text-inksoft">Contract number</label>
          <input className="field mb-2 mt-1" value={pending.guess} onChange={(e) => setPending({ ...pending, guess: e.target.value })} />
          <div className="mb-3 font-mono text-xs text-inksoft">
            Total {fmt(pending.items.reduce((s, i) => s + i.amount, 0))} · canceled flagged: {pending.items.filter((i) => i.canceled).length}
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={() => runImport("replace")} disabled={busy}>Load (replace contract)</button>
            <button className="btn" onClick={() => runImport("append")} disabled={busy}>Append</button>
            <button className="btn btn-ghost" onClick={() => setPending(null)}>Cancel</button>
          </div>
        </div>
      )}

      {pdfPending && (
        <div className="card mb-4 border-work p-4">
          <div className="mb-3 font-display text-base font-semibold uppercase">
            New release from PDF{pdfPending.date ? ` · ordered ${pdfPending.date}` : ""}
          </div>
          <div className="mb-3 grid grid-cols-2 gap-2.5 md:grid-cols-3">
            {([
              ["contract", "Contract #"], ["rel", "Release #"], ["location", "Development"],
              ["address", "Address / Apt (from proposal)"], ["ticket", "Ticket / Work Order"],
              ["amount", "Amount"], ["hours", "Labor hrs"],
            ] as ["contract" | "rel" | "location" | "address" | "ticket" | "amount" | "hours", string][]).map(([k, label]) => (
              <div key={k} className={k === "address" ? "col-span-2 md:col-span-1" : ""}>
                <div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">{label}</div>
                <input className="field" inputMode={k === "amount" || k === "hours" ? "decimal" : "text"}
                  placeholder={k === "address" ? "e.g. Stairhall 15, Apt 526" : ""}
                  value={String(pdfPending[k])}
                  onChange={(e) => setPdfPending({ ...pdfPending, [k]: k === "amount" || k === "hours" ? parseNum(e.target.value) : e.target.value })} />
              </div>
            ))}
          </div>
          {pdfPending.breakdown.length > 0 && (
            <div className="mb-3">
              <div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Labor by classification</div>
              <div className="flex flex-wrap gap-1.5">
                {pdfPending.breakdown.map((b, i) => (
                  <span key={i} className="rounded-sm border border-rulesoft px-2 py-1 font-mono text-xs">{b.cls} · {b.hours}h</span>
                ))}
              </div>
            </div>
          )}
          {pdfPending.propNote && <div className="mb-3 text-xs font-semibold text-alert">{pdfPending.propNote}</div>}
          <div className="mb-2 text-[11px] uppercase tracking-widest text-inksoft">Line items ({pdfPending.items.length})</div>
          <div className="mb-3 max-h-64 overflow-y-auto rounded-sm border border-rulesoft">
            <table className="w-full border-collapse text-xs">
              <thead><tr className="border-b border-rulesoft text-left font-display uppercase tracking-widest text-inksoft">
                <th className="p-2">Ln</th><th className="p-2">Item</th><th className="p-2">Description</th>
                <th className="p-2 text-right">Qty</th><th className="p-2">UOM</th>
                <th className="p-2 text-right">Unit</th><th className="p-2 text-right">Amount</th><th></th>
              </tr></thead>
              <tbody>
                {pdfPending.items.map((it, i) => (
                  <tr key={i} className="border-b border-rulesoft">
                    <td className="p-2 font-mono">{it.line}</td>
                    <td className="p-2 font-mono">{it.code}</td>
                    <td className="max-w-[260px] truncate p-2" title={it.description}>{it.description}</td>
                    <td className="p-2 text-right font-mono">{it.qty}</td>
                    <td className="p-2">{it.uom}</td>
                    <td className="p-2 text-right font-mono">{it.unit_price ? fmt(it.unit_price) : ""}</td>
                    <td className="p-2 text-right font-mono">{fmt(it.amount)}</td>
                    <td className="p-2 text-center">
                      <button className="text-alert" title="Remove line" onClick={() => {
                        const items = pdfPending.items.filter((_, j) => j !== i);
                        setPdfPending({ ...pdfPending, items, amount: items.reduce((sm, x) => sm + x.amount, 0) });
                      }}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mb-3 font-mono text-xs text-inksoft">
            Items sum {fmt(pdfPending.items.reduce((sm, x) => sm + x.amount, 0))} · Release total {fmt(pdfPending.amount)}
            {Math.abs(pdfPending.items.reduce((sm, x) => sm + x.amount, 0) - pdfPending.amount) > 0.01 && <span className="text-alert"> · MISMATCH — check lines</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={savePdfRelease} disabled={busy}>Save release</button>
            <button className="btn" onClick={() => propRef.current?.click()}>Attach proposal sheet</button>
            <button className="btn btn-ghost" onClick={() => setPdfPending(null)}>Cancel</button>
          </div>
        </div>
      )}

      {contracts.length > 1 && (
        <div className="mb-3"><ContractPicker contracts={contracts} value={active} onChange={(id) => { setActive(id); setLimit(100); }} /></div>
      )}

      {rows.length > 0 && (() => {
        const rec = live.filter((r) => r.received).reduce((s, r) => s + Number(r.amount), 0);
        const outst = live.filter((r) => !r.received).reduce((s, r) => s + Number(r.amount), 0);
        const pct = tot > 0 ? Math.round((rec / tot) * 100) : 0;
        return (
          <div className="mb-3">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
              {([["Released", fmt(tot), "text-ink"], [`Received · ${pct}%`, fmt(rec), "text-ok"], ["Not received", fmt(outst), "text-work"], ["To chase", fmt(notR.reduce((s, r) => s + Number(r.amount), 0)), "text-work"], ["Payroll pending", fmt(prPend.reduce((s, r) => s + Number(r.amount), 0)), "text-alert"]] as [string, string, string][]).map(([l, v, cls]) => (
                <div key={l} className="card p-3">
                  <div className="text-[10px] uppercase tracking-[.12em] text-inksoft">{l}</div>
                  <div className={`font-mono text-base font-semibold ${cls}`}>{v}</div>
                </div>
              ))}
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-sm bg-rulesoft">
              <div className="h-full bg-ok transition-all duration-300" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })()}

      <div className="mb-3 flex flex-wrap gap-2">
        {([["all", "All"], ["chase", `Chase list (${notR.length})`], ["payroll", `Payroll to submit (${prPend.length})`], ["canceled", `Canceled (${canceledRows.length})`], ["hours", "Payroll check"]] as [Filter, string][]).map(([f, l]) => (
          <button key={f} className={`btn ${filter === f ? "btn-primary" : "btn-ghost"} px-3 py-1.5 text-[13px]`} onClick={() => { setFilter(f); setLimit(100); if (f === "hours" && !logged) loadLogged(); }}>{l}</button>
        ))}
      </div>

      <input className="field mb-3" placeholder="Search release #, development, ticket…" value={q} onChange={(e) => { setQ(e.target.value); setLimit(100); }} />

      {filter === "hours" && (
        <div className="card overflow-x-auto">
          <table className="w-full border-collapse text-sm" style={{ minWidth: 560 }}>
            <thead><tr className="border-b-[1.5px] border-ink text-left font-display text-xs uppercase tracking-widest text-inksoft">
              <th className="p-2.5">Rel</th><th className="p-2.5">Location</th><th className="p-2.5 text-right">Required hrs</th><th className="p-2.5 text-right">Logged hrs</th><th className="p-2.5 text-center">Check</th></tr></thead>
            <tbody>
              {live.filter((r) => (Number(r.labor_hours) > 0 || (logged?.[r.id] || 0) > 0) && (!q || `${r.rel_number} ${r.location} ${r.buildings} ${r.ticket}`.toLowerCase().includes(q.toLowerCase()))).map((r) => {
                const got = logged?.[r.id] || 0;
                const need = Number(r.labor_hours) || 0;
                return (
                  <tr key={r.id} className="border-b border-rulesoft">
                    <td className="p-2.5 font-mono text-xs">{r.rel_number}</td>
                    <td className="p-2.5">{r.location}<div className="max-w-[220px] truncate text-[11px] text-inksoft">{r.buildings}</div>{(r.labor_breakdown || []).length > 0 && <div className="max-w-[220px] truncate text-[11px] text-inksoft">{(r.labor_breakdown || []).map((b) => `${b.cls} ${b.hours}h`).join(" · ")}</div>}</td>
                    <td className="p-2.5 text-right">
                      <input className="w-20 rounded-sm border border-rulesoft p-1.5 text-right font-mono" inputMode="decimal" defaultValue={need || ""} placeholder="0"
                        onBlur={(e) => toggle(r, { labor_hours: parseNum(e.target.value) })} />
                    </td>
                    <td className="p-2.5 text-right font-mono">{got}</td>
                    <td className="p-2.5 text-center">
                      {need === 0 ? <Stamp label="SET HRS" tone="mute" /> : got >= need ? <Stamp label="OK" tone="ok" /> : <Stamp label={`SHORT ${need - got}`} tone="alert" />}
                    </td>
                  </tr>
                );
              })}
              {logged === null && <tr><td colSpan={5} className="p-4 text-inksoft">Loading payroll…</td></tr>}
              {logged !== null && live.filter((r) => Number(r.labor_hours) > 0 || (logged?.[r.id] || 0) > 0).length === 0 && (
                <tr><td colSpan={5} className="p-4 text-inksoft">No releases with hours yet. Set required hours here (or import a sheet with an Hours column), and link payroll entries to releases in the Payroll tab.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {filter !== "hours" && <div className="card overflow-x-auto">
        <table className="w-full border-collapse text-sm" style={{ minWidth: 560 }}>
          <thead>
            <tr className="border-b-[1.5px] border-ink text-left font-display text-xs uppercase tracking-widest text-inksoft">
              <th className="p-2.5">Rel</th><th className="p-2.5">Location</th><th className="p-2.5 text-right">Amount</th>
              <th className="p-2.5 text-center">Payroll</th><th className="p-2.5 text-center">Received</th><th className="p-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className={`border-b border-rulesoft ${r.canceled ? "opacity-50" : ""}`}>
                <td className="p-2.5 font-mono text-xs">{r.rel_number}</td>
                <td className={`p-2.5 ${r.canceled ? "line-through" : ""}`}>
                  {r.location}
                  <div className="max-w-[240px] truncate text-[11px] text-inksoft">{r.buildings}{r.ticket ? ` · ${r.ticket}` : ""}</div>
                  {!r.canceled && (() => {
                    const stages = pipeline(r);
                    const current = stages.findIndex(([, done]) => !done);
                    return (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {stages.map(([l, done], i) => (
                          <span key={l} title={l} className={`rounded-[2px] border px-1 py-px font-mono text-[9px] font-semibold tracking-wide ${
                            done ? "border-ok bg-ok/10 text-ok" : i === current ? "border-work text-work" : "border-rulesoft text-rule"
                          }`}>{l}</span>
                        ))}
                      </div>
                    );
                  })()}
                </td>
                <td className={`p-2.5 text-right font-mono ${r.canceled ? "line-through" : ""}`}>{fmt(Number(r.amount))}</td>
                <td className="p-2.5 text-center">
                  {!r.canceled && <button onClick={() => togglePayroll(r)}><Stamp label={r.payroll_done ? "DONE" : "TO DO"} tone={r.payroll_done ? "ok" : "alert"} /></button>}
                </td>
                <td className="p-2.5 text-center">
                  {!r.canceled ? <button onClick={() => toggle(r, { received: !r.received, paid_date: !r.received ? new Date().toISOString().slice(0, 10) : null })}><Stamp label={r.received ? "YES" : "NO"} tone={r.received ? "ok" : "work"} /></button> : <Stamp label="CANCELED" tone="mute" />}
                </td>
                <td className="p-2.5">
                  <div className="flex items-center justify-end gap-2 whitespace-nowrap">
                    {!r.canceled && sosReady.has(r.id) && <button className="font-mono text-xs font-semibold text-work underline" title="NYCHA invoice" onClick={() => genInvoice(r)}>INV</button>}
                    {!r.canceled && sosReady.has(r.id) && <button className="font-mono text-xs font-semibold text-carbon underline" title="Statement of Services" onClick={() => genSOS(r)}>SOS</button>}
                    <button className="text-inksoft" title="Documents" onClick={() => setAttachRel(r)}>📎{(r.attachments || []).length > 0 ? <span className="font-mono text-[10px]">{(r.attachments || []).length}</span> : null}</button>
                    <button className={r.canceled ? "text-ok" : "text-alert"} title={r.canceled ? "Restore" : "Mark canceled"} onClick={() => toggle(r, { canceled: !r.canceled })}>{r.canceled ? "↺" : "✕"}</button>
                  </div>
                </td>
              </tr>
            ))}
            {shown.length === 0 && !busy && (
              <tr><td colSpan={6} className="p-4 text-inksoft">{contracts.length === 0 ? "Upload a contract sheet to get started — it reads your columns as-is." : "Nothing matches. If this is the chase list — that's the goal."}</td></tr>
            )}
          </tbody>
        </table>
      </div>}
      {filter !== "hours" && list.length > limit && (
        <div className="mt-3 text-center"><button className="btn btn-ghost" onClick={() => setLimit(limit + 200)}>Show more ({list.length - limit} left)</button></div>
      )}
      {busy && <div className="mt-3 text-sm text-inksoft">Working…</div>}


      {/* ---------- attachments panel ---------- */}
      {attachRel && (
        <div className="fixed inset-0 z-40 overflow-y-auto bg-ink/50 px-2 py-10" onClick={() => setAttachRel(null)}>
          <div className="card mx-auto max-w-md bg-card p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 font-display text-base font-bold uppercase">Documents · Release {attachRel.rel_number}</div>
            {(attachRel.attachments || []).length === 0 && <div className="mb-3 text-sm text-inksoft">Nothing attached yet. Release PDFs and proposal sheets imported with “+ From PDF” attach themselves automatically — and job photos land here too.</div>}
            {(attachRel.attachments || []).filter((a) => isImg(a.name)).length > 0 && (
              <div className="mb-3 grid grid-cols-3 gap-1.5">
                {(attachRel.attachments || []).filter((a) => isImg(a.name)).map((a) => (
                  <div key={a.path} className="relative">
                    <button className="block w-full" onClick={() => openAttachment(a.path)} title={a.name}>
                      {photoUrls[a.path]
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={photoUrls[a.path]} alt={a.name} className="h-24 w-full rounded-sm border border-rulesoft object-cover" />
                        : <div className="grid h-24 w-full place-items-center rounded-sm border border-rulesoft text-xs text-inksoft">…</div>}
                    </button>
                    <button className="absolute right-1 top-1 rounded-sm bg-ink/70 px-1.5 text-xs text-paper" title="Delete photo" onClick={() => removeAttachment(attachRel, a.path)}>✕</button>
                  </div>
                ))}
              </div>
            )}
            {(attachRel.attachments || []).filter((a) => !isImg(a.name)).map((a) => (
              <div key={a.path} className="mb-1.5 flex items-center gap-1">
                <button className="block w-full rounded-sm border border-rulesoft p-2.5 text-left text-sm hover:border-work" onClick={() => openAttachment(a.path)}>
                  📄 {a.name}
                </button>
                <button className="shrink-0 px-1 text-xs text-alert" title="Delete file" onClick={() => removeAttachment(attachRel, a.path)}>✕</button>
              </div>
            ))}
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="btn btn-primary" onClick={() => photoInputRef.current?.click()} disabled={busy}>📷 Take photo</button>
              <button className="btn" onClick={() => attachInputRef.current?.click()} disabled={busy}>Upload file</button>
              <button className="btn btn-ghost" onClick={() => setAttachRel(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
      <input ref={attachInputRef} type="file" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f && attachRel) attachFile(attachRel, f); e.target.value = ""; }} />
      <input ref={photoInputRef} type="file" accept="image/*" capture="environment" multiple className="hidden"
        onChange={(e) => { const fs = Array.from(e.target.files || []); if (fs.length && attachRel) addPhotos(attachRel, fs); e.target.value = ""; }} />

      {invPreview && org && (
        <NychaInvoicePrint org={org} number={invPreview.number} date={invPreview.date}
          contractNumber={invPreview.cNumber} releaseNumber={invPreview.relNum} development={invPreview.dev}
          workOrder={invPreview.workOrder}
          items={invPreview.rows.map((it) => ({ line: it.line, code: it.code, category: it.category, description: it.description, unit: it.uom, qty: it.qty, unit_price: it.unit_price }))}
          onExcel={() => buildInvoiceXlsx({ org, cNumber: invPreview.cNumber, relNum: invPreview.relNum, workOrder: invPreview.workOrder, dev: invPreview.dev, number: invPreview.number, date: invPreview.date, rows: invPreview.rows })}
          close={() => setInvPreview(null)} />
      )}

      {sosView && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-ink/50 px-2 py-5">
          <div className="printable mx-auto max-w-4xl rounded-sm border-t-4 border-ink bg-white p-8 text-ink">
            <div className="border-2 border-ink bg-paper p-2 text-center font-display text-xl font-bold uppercase">NYCHA Statement of Service</div>
            <div className="my-4 grid grid-cols-2 gap-x-8 gap-y-1.5 border border-rulesoft p-3 text-[13px]">
              {([["Vendor", (org?.company || "").toUpperCase()], ["Date", prettyDate(new Date().toISOString().slice(0, 10))],
                ["Address", [org?.address1, org?.address2].filter(Boolean).join(", ")], ["PO", sosView.cNumber],
                ["Telephone", org?.phone || ""], ["Work order", sosView.ticket], ["Email", org?.email || ""], ["Release", sosView.relNum],
                ["Development", sosView.dev], ["Stairhall", sosView.stair], ["Apt", sosView.apt], ["Job address", sosView.addr]] as [string, string][]).map(([l, v]) => (
                <div key={l} className="flex gap-2 border-b border-rulesoft py-0.5"><span className="w-28 shrink-0 text-[11px] font-semibold uppercase tracking-wider text-inksoft">{l}</span><span>{v || "—"}</span></div>
              ))}
            </div>
            <table className="w-full border-collapse border border-ink text-[12px]">
              <thead><tr className="bg-paper text-left font-display text-[10px] uppercase tracking-widest">
                <th className="border border-ink p-1.5">Line</th><th className="border border-ink p-1.5">Item</th><th className="border border-ink p-1.5">Category</th>
                <th className="border border-ink p-1.5">Description</th><th className="border border-ink p-1.5">UOM</th>
                <th className="border border-ink p-1.5 text-right">Qty</th><th className="border border-ink p-1.5 text-right">Price</th><th className="border border-ink p-1.5 text-right">Total</th>
              </tr></thead>
              <tbody>
                {sosView.rows.map((it, i) => (
                  <tr key={i} className="align-top">
                    <td className="border border-rulesoft p-1.5 font-mono">{it.line}</td>
                    <td className="border border-rulesoft p-1.5 font-mono">{it.code}</td>
                    <td className="border border-rulesoft p-1.5 text-[11px]">{it.category}</td>
                    <td className="border border-rulesoft p-1.5">{it.description}</td>
                    <td className="border border-rulesoft p-1.5 font-mono text-[11px]">{it.uom}</td>
                    <td className="border border-rulesoft p-1.5 text-right font-mono">{it.qty}</td>
                    <td className="border border-rulesoft p-1.5 text-right font-mono">{fmt(it.unit_price)}</td>
                    <td className="border border-rulesoft p-1.5 text-right font-mono font-semibold">{fmt(it.qty * it.unit_price)}</td>
                  </tr>
                ))}
                <tr><td colSpan={7} className="border border-ink p-1.5 text-right font-display font-bold uppercase">Total</td>
                  <td className="border border-ink p-1.5 text-right font-mono text-base font-bold">{fmt(sosView.total)}</td></tr>
              </tbody>
            </table>
            <div className="mt-4 text-[11px] italic text-inksoft">
              I acknowledge and understand that offering, giving and/or accepting bribes, gratuities and/or gifts is a criminal offense under federal and New York state law.
            </div>
            <div className="mt-6 grid grid-cols-2 gap-10 text-[12px]">
              <div><div className="border-t border-ink pt-1 font-semibold">Vendor signature</div></div>
              <div><div className="border-t border-ink pt-1">Date</div></div>
            </div>
            <div className="mt-5 border-t-2 border-ink pt-2 text-[12px]">
              <div className="font-semibold">For NYCHA Internal Use Only:</div>
              <div className="mt-1 text-[11px] italic text-inksoft">I hereby certify that the above-described work, labor, material, equipment, and/or services as referenced in accordance with the above referenced Purchase Order has been completed and inspected by me to my satisfaction.</div>
              <div className="mt-5 grid grid-cols-2 gap-10">
                <div><div className="border-t border-ink pt-1">Inspected by — name and title</div></div>
                <div><div className="border-t border-ink pt-1">Signature</div></div>
                <div><div className="border-t border-ink pt-1">Contract Manager signature</div></div>
                <div><div className="border-t border-ink pt-1">WO # / Date</div></div>
              </div>
            </div>
            <div className="mt-4 text-[10px] text-inksoft">NYCHA 042.726 (Rev. 04/05/24) v2 · the Excel version includes the Itemized List of Materials section to fill in</div>
          </div>
          <div className="no-print mx-auto mt-3 flex max-w-4xl justify-end gap-2">
            <button className="btn bg-white" onClick={downloadSOS}>Download Excel</button>
            <button className="btn bg-white" onClick={() => window.print()}>Print / Save as PDF</button>
            <button className="btn btn-ghost bg-white" onClick={() => setSosView(null)}>Close</button>
          </div>
        </div>
      )}

      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
