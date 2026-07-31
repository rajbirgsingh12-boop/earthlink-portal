"use client";
import { useDeferredValue, useEffect, useRef, useState } from "react";
// styled fork of SheetJS — same API, plus cell borders/fonts for the SOS export
// the export engine is heavy — it loads on demand, never with the page itself
let XLSX!: typeof import("xlsx-js-style");
const ensureXLSX = async () => { XLSX = XLSX || (await import("xlsx-js-style")); };
import { sb } from "@/lib/supabase";
import { myProfile } from "@/lib/profile";
import { fmt, parseNum, askFileName } from "@/lib/format";
import Stamp from "@/components/Stamp";
import type { Contract, Release } from "@/lib/types";
import { parseReleasePdfText, quickReleaseId, type ReleaseItem } from "@/lib/parseRelease";
import { prettyDate, localISO, type Org } from "@/lib/docs";
import { canonTrade, checkLabor, aggregateLogged } from "@/lib/labor";
import { useLive } from "@/lib/useLive";
import ContractPicker from "@/components/ContractPicker";
import NychaInvoicePrint from "@/components/NychaInvoicePrint";
import { gatherReleaseDoc, buildInvoiceXlsx, type DocRow } from "@/lib/releaseDoc";
import PrintShell from "@/components/PrintShell";
import { shrinkImage } from "@/lib/shrinkImage";
import { useNumBuffer } from "@/lib/numBuffer";
import { planFolder, isReleaseFileName, parseReleaseFileName, contractKey, type FileMatch } from "@/lib/matchRelease";

type Filter = "all" | "chase" | "payroll" | "received" | "canceled" | "hours";
// just the bits of a pdfjs document the folder scan touches
// one file in the folder-attach plan: where it goes, or that it makes a new release
type PlanRow = FileMatch & {
  file: File;
  relNum?: string;
  newRel?: { contractNum: string; rel: string };
  willCreate?: boolean;
  skipped?: boolean; // already received — the file is deliberately left alone
};
type PdfDocLite = {
  getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }>;
  destroy: () => Promise<void>;
};
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
  const dq = useDeferredValue(q); // heavy filtering runs on this, a beat behind the keystrokes
  const [limit, setLimit] = useState(100);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [logged, setLogged] = useState<Record<string, number> | null>(null);
  const [pending, setPending] = useState<{ items: Omit<Release, "id" | "contract_id">[]; guess: string; omit?: string[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pdfPending, setPdfPending] = useState<{
    contract: string; rel: string; date: string; location: string; address: string;
    ticket: string; amount: number; hours: number; items: ReleaseItem[];
    breakdown: { cls: string; hours: number }[]; propNote: string;
    pdfFile?: File; propFile?: File;
  } | null>(null);
  const pdfRef = useRef<HTMLInputElement>(null);
  const propRef = useRef<HTMLInputElement>(null);
  // ---- whole-folder attach: every file matched to the release it belongs to ----
  const folderRef = useRef<HTMLInputElement>(null);
  const [folderPlan, setFolderPlan] = useState<{
    // relNum is kept even when the release isn't in this contract, so the list can
    // still be shown in release order
    rows: PlanRow[]; folder: string; ignored: number; capped: number;
    notPdf?: number; notRelease?: number; otherContract?: number;
    // releases/contracts the scan actually matched against — may span several
    // contracts, so this doesn't depend on whichever one is open
    rels: Release[]; contracts: Contract[];
  } | null>(null);
  // rows the office chose to re-pick by hand (a select per row would be thousands of nodes)
  const [folderEdit, setFolderEdit] = useState<Set<number>>(new Set());
  const [folderProgress, setFolderProgress] = useState("");

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
  // ---- line-item editor (release_items feed the SOS form and the invoice) ----
  type RelItemRow = { id?: string; line: number; code: string; description: string; qty: number; uom: string; unit_price: number };
  const [itemsRel, setItemsRel] = useState<Release | null>(null);
  const [relItems, setRelItems] = useState<RelItemRow[] | null>(null);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 2500); };
  const numBuf = useNumBuffer();
  // accountants can look but not touch — their writes would be silent no-ops under RLS
  const [role, setRole] = useState("");
  const readOnly = role === "accountant";
  const loadSeq = useRef(0); // drops stale loadRows responses after fast contract switches

  const loadContracts = async () => {
    const { data } = await sb().from("contracts").select("id,number,name").order("number");
    const list = (data || []) as Contract[];
    setContracts(list);
    if (!active && list[0]) setActive(list[0].id);
  };
  useEffect(() => {
    loadContracts();
    loadLogged();
    sb().from("org").select("*").single().then(({ data }) => data && setOrg(data as Org));
    (async () => {
      const prof = await myProfile();
      setRole(prof?.role || "");
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadRows = async (cid: string, silent = false) => {
    if (!cid) { setRows([]); return; }
    const token = ++loadSeq.current; // a newer load makes this one throw its results away
    if (!silent) setBusy(true);
    const all: Release[] = [];
    let from = 0;
    for (;;) {
      const { data } = await sb().from("releases").select("*").eq("contract_id", cid).order("id").range(from, from + 999);
      if (!data || data.length === 0) break;
      all.push(...(data as Release[]));
      if (data.length < 1000) break;
      from += 1000;
    }
    if (token !== loadSeq.current) return;
    // sort numerically by release number when possible
    all.sort((a, b) => (parseFloat(a.rel_number) || 0) - (parseFloat(b.rel_number) || 0));
    setRows(all);
    if (!silent) setBusy(false);
    // which releases can produce an SOS? those with imported line items,
    // or a walk sheet (with quantities) whose Release # matches
    const ready = new Set<string>();
    // one tiny answer from the database (run supabase/upgrade_speed.sql) —
    // otherwise fall back to downloading a row id per line item
    const { data: withItems, error: wiErr } = await sb().rpc("releases_with_items", { cid });
    if (!wiErr && Array.isArray(withItems)) {
      (withItems as string[]).forEach((id) => ready.add(id));
    } else {
      const ids = all.map((r) => r.id);
      // all chunks fetch together — serially this scan alone took seconds on a big contract
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
      await Promise.all(chunks.map(async (chunk) => {
        // page inside each chunk too — 200 releases can hold >1000 line items
        for (let f = 0; ; f += 1000) {
          const { data: its } = await sb().from("release_items").select("release_id").in("release_id", chunk).range(f, f + 999);
          ((its || []) as { release_id: string }[]).forEach((it) => ready.add(it.release_id));
          if (!its || its.length < 1000) break;
        }
      }));
    }
    const { data: props } = await sb().from("proposals").select("release_number,qty_map").eq("contract_id", cid);
    if (token !== loadSeq.current) return;
    // "007" and "7" are the same release — compare with leading zeros stripped
    const relNorm = (v: unknown) => String(v ?? "").trim().replace(/^0+(?=\d)/, "");
    const walkNums = new Set(
      ((props || []) as { release_number?: string; qty_map?: Record<string, number> | null }[])
        .filter((p) => p.release_number && p.qty_map && Object.keys(p.qty_map).length > 0)
        .map((p) => relNorm(p.release_number))
    );
    const itemsSet = new Set(ready);
    all.forEach((r) => { if (walkNums.has(relNorm(r.rel_number))) ready.add(r.id); });
    setSosReady(ready);
    setStageData({ items: itemsSet, walks: walkNums });
  };

  // hours punched on the Payroll tab flow straight here: a release with its
  // required hours met lights the PAY stage even before payroll is marked done
  const hoursMet = (r: Release) => { const need = Number(r.labor_hours) || 0; return need > 0 && (logged?.[r.id] || 0) >= need; };

  // the release's life at a glance: each stage lights up from data already
  // entered (payroll complete implies the work is done, so no separate stage)
  const pipeline = (r: Release): [string, boolean][] => [
    ["WALK SHEET", stageData.walks.has(String(r.rel_number).trim())],
    ["RELEASE", stageData.items.has(r.id)],
    ["PAYROLL", r.payroll_done || hoursMet(r)],
    ["INVOICED", !!r.invoice_sent],
    ["PAID", r.received],
  ];
  useEffect(() => { loadRows(active); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  // live: releases, their items, walk sheets, contracts AND payroll hours refresh this page
  // enabled stays keyed to the contract only — flipping it with busy would tear
  // down and rejoin the realtime channel on every import; a ref skips instead
  const busyRef = useRef(busy); busyRef.current = busy;
  useLive(["releases", "release_items", "proposals", "contracts", "timesheet_entries"], () => { if (busyRef.current) return; loadRows(active, true); loadContracts(); loadLogged(); }, { enabled: !!active, delay: 1500, skipWhileTyping: true });

  const loadLogged = async () => {
    // the database sums the hours itself (run supabase/upgrade_speed.sql) —
    // one number per release instead of the whole timesheet history
    const { data: sums, error } = await sb().rpc("logged_hours_by_release");
    if (!error && Array.isArray(sums)) {
      const agg: Record<string, number> = {};
      (sums as { release_id: string; hours: number }[]).forEach((s) => { agg[s.release_id] = Number(s.hours) || 0; });
      setLogged(agg);
      return;
    }
    // fallback: paginated scan — an unranged select silently stops at 1000 rows
    const all: { release_id: string | null; hours: number[] }[] = [];
    for (let from = 0; ; from += 1000) {
      // only rows tied to a release — shop/misc hours can't affect these chips
      const { data } = await sb().from("timesheet_entries").select("release_id,hours").not("release_id", "is", null).order("id").range(from, from + 999);
      all.push(...((data || []) as typeof all));
      if (!data || data.length < 1000) break;
    }
    const agg: Record<string, number> = {};
    all.forEach((e) => {
      if (!e.release_id) return;
      agg[e.release_id] = (agg[e.release_id] || 0) + (e.hours || []).reduce((s2, h) => s2 + (Number(h) || 0), 0);
    });
    setLogged(agg);
  };

  const live = rows.filter((r) => !r.canceled);
  const canceledRows = rows.filter((r) => r.canceled);
  // same release number twice in one contract = something to clean up
  const relCounts: Record<string, number> = {};
  live.forEach((r) => { const k = String(r.rel_number).trim(); if (k) relCounts[k] = (relCounts[k] || 0) + 1; });
  // chase = work done and payroll submitted, waiting on NYCHA's money
  const notR = live.filter((r) => r.payroll_done && !r.received && Number(r.amount) > 0);
  // payroll to submit = still open releases whose payroll isn't in yet
  const prPend = live.filter((r) => !r.payroll_done && !r.received && Number(r.amount) > 0);
  const tot = live.reduce((s, r) => s + Number(r.amount), 0);

  const receivedRows = live.filter((r) => r.received);
  // paid releases are done business — keep the working list clean
  let list = live.filter((r) => !r.received);
  if (filter === "chase") list = notR;
  if (filter === "payroll") list = prPend;
  if (filter === "received") list = receivedRows;
  if (filter === "canceled") list = canceledRows;
  if (dq) list = list.filter((r) => `${r.rel_number} ${r.location} ${r.buildings} ${r.ticket}`.toLowerCase().includes(dq.toLowerCase()));
  const shown = list.slice(0, limit);
  // the hours tab draws from this list — computed here so its Show more knows the full count
  const hoursList = live.filter((r) => (Number(r.labor_hours) > 0 || (logged?.[r.id] || 0) > 0) && (!dq || `${r.rel_number} ${r.location} ${r.buildings} ${r.ticket}`.toLowerCase().includes(dq.toLowerCase())));

  const toggle = async (r: Release, patch: Partial<Release>) => {
    setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, ...patch } : x)));
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
        // select * so the per-entry classification comes along once the column exists
        const { data: ents } = await sb().from("timesheet_entries").select("*").eq("release_id", r.id);
        const { data: allEmps } = await sb().from("employees").select("id,trade");
        const tradeById = new Map(((allEmps || []) as { id: string; trade: string }[]).map((e) => [e.id, canonTrade(e.trade)]));
        const logged = aggregateLogged((ents || []) as { release_id: string | null; employee_id: string; hours: number[]; trade?: string | null }[], tradeById)[r.id] || {};
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
    const today = localISO();
    if (!r.invoice_sent && !readOnly) {
      // generating the invoice records the sent date (feeds the statement aging);
      // toggle() flashes on failure and knows the legacy-column fallback
      await toggle(r, { invoice_sent: today });
    }
    setSosView(null); // one preview at a time — two would print as one concatenated PDF
    setInvPreview({ number: `${c?.number || ""}-${r.rel_number}`, date: today, cNumber: c?.number || "", relNum: r.rel_number, dev: d.dev, workOrder: r.ticket || "", rows: d.rows });
  };

  // ---------- Statement of Services (NYCHA form 042.726) ----------
  const genSOS = async (r: Release) => {
    setBusy(true);
    const c = contracts.find((x) => x.id === active);
    // prefer the walk sheet (proposal) tied to this release number ("007" = "7")
    const relNorm2 = (v: unknown) => String(v ?? "").trim().replace(/^0+(?=\d)/, "");
    const { data: props } = await sb().from("proposals").select("*")
      .eq("contract_id", active).not("release_number", "is", null)
      .order("created_at", { ascending: false });
    const matches = ((props || []) as { release_number?: string; qty_map?: Record<string, number> | null; development?: string; address?: string; apt?: string; stairhall?: string }[])
      .filter((p) => relNorm2(p.release_number) === relNorm2(r.rel_number));
    // the newest sheet WITH quantities wins — an empty duplicate draft on top
    // must not hide a filled one underneath
    const prop = matches.find((p) => p.qty_map && Object.keys(p.qty_map).length > 0) ?? matches[0];
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
    setInvPreview(null); // one preview at a time
    setSosView({
      relNum: r.rel_number, ticket: r.ticket || "", cNumber: c?.number || "",
      dev: r.location || prop?.development || "", addr: r.address || r.buildings || prop?.address || "",
      stair: prop?.stairhall || "", apt: prop?.apt || "",
      rows, total: rows.reduce((s, it) => s + it.qty * it.unit_price, 0),
    });
  };

  const downloadSOS = async () => {
    try { await ensureXLSX(); } catch { flash("Couldn't load the Excel engine \u2014 check your signal and try again"); return; }
    if (!sosView) return;
    const { relNum, ticket, cNumber, dev, addr, stair, apt, rows, total } = sosView;
    const today = prettyDate(localISO());

    const aoa: (string | number)[][] = [];
    const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];
    const wide = (row: number, from = 0, to = 8) => merges.push({ s: { r: row, c: from }, e: { r: row, c: to } });
    aoa.push(["NYCHA STATEMENT OF SERVICE"]); wide(0);
    aoa.push(["Vendor:", "", (org?.company || "").toUpperCase()]);
    aoa.push(["Address:", "", [org?.address1, org?.address2].filter(Boolean).join(", "), "", "", "Date:", today]);
    aoa.push(["Telephone:", "", org?.phone || ""]);
    aoa.push(["Email:", "", org?.email || ""]);
    aoa.push([]);
    aoa.push(["PO:", "", /^[1-9]\d*$/.test(cNumber) ? Number(cNumber) : cNumber]);
    aoa.push(["Work order:", "", ticket]);
    aoa.push(["Release:", "", /^[1-9]\d*$/.test(relNum) ? Number(relNum) : relNum]);
    aoa.push(["Development:", "", dev]);
    aoa.push(["Stairhall:", "", stair]);
    aoa.push(["Apt:", "", apt]);
    aoa.push(["Address:", "", addr]);
    aoa.push([]);
    const headerRow = aoa.length;
    aoa.push(["Line", "Item", "Category", "Description", "UOM", "Quantity Authorized", "Price", "Total Cost"]);
    // keep item codes as text — NYCHA codes carry a leading zero (062001351)
    rows.forEach((it) => aoa.push([it.line, /^[1-9]\d*$/.test(it.code) ? Number(it.code) : it.code, it.category, it.description, it.uom, it.qty, it.unit_price, it.qty * it.unit_price]));
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
      for (const col of [0, 1]) { ensure(row, col); style(row, col, { font: { bold: true }, fill: shade, border: box, alignment: { vertical: "center" } }); }
      ensure(row, 2); style(row, 2, { border: box, alignment: { vertical: "center" } });
      if (row === 2) { style(row, 5, { font: { bold: true }, fill: shade, border: box, alignment: { vertical: "center" } }); ensure(row, 6); style(row, 6, { border: box, alignment: { horizontal: "center", vertical: "center" } }); }
    }
    for (let row = headerRow; row <= totalRow; row++) {
      for (let col = 0; col < 8; col++) {
        const cell = ensure(row, col);
        const s: Record<string, unknown> = { border: box, alignment: { vertical: "center", wrapText: col === 3, horizontal: row === headerRow ? "center" : col >= 4 ? "right" : "left" } };
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
    ws["!rows"][0] = { hpt: 26 }; ws["!rows"][headerRow] = { hpt: 24 }; ws["!rows"][totalRow] = { hpt: 22 }; ws["!rows"][matHeader] = { hpt: 22 };
    for (const row of [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12]) ws["!rows"][row] = { hpt: 19 };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const fname = askFileName(`SOS_${cNumber}_rel${relNum}.xlsx`);
    if (!fname) return;
    XLSX.writeFile(wb, fname);
  };

  // ---------- line-item editor ----------
  const openItems = async (r: Release) => {
    setItemsRel(r); setRelItems(null);
    const { data } = await sb().from("release_items").select("*").eq("release_id", r.id).order("line");
    setRelItems(((data || []) as RelItemRow[]).map((it) => ({
      id: it.id, line: Number(it.line) || 0, code: it.code || "", description: it.description || "",
      qty: Number(it.qty) || 0, uom: it.uom || "EA", unit_price: Number(it.unit_price) || 0,
    })));
  };
  const saveItems = async () => {
    if (!itemsRel || !relItems) return;
    setBusy(true);
    const rows = relItems.filter((it) => it.description.trim() || it.code.trim());
    // hold the current rows — if the re-insert fails they go straight back
    const { data: prevRows } = await sb().from("release_items").select("*").eq("release_id", itemsRel.id);
    const { error: de } = await sb().from("release_items").delete().eq("release_id", itemsRel.id);
    if (de) { flash(de.message); setBusy(false); return; }
    if (rows.length > 0) {
      const { error } = await sb().from("release_items").insert(rows.map((it, i) => ({
        release_id: itemsRel.id, line: it.line || i + 1, code: it.code, description: it.description,
        qty: it.qty, uom: it.uom, unit_price: it.unit_price, amount: it.qty * it.unit_price,
      })));
      if (error) {
        if (prevRows && prevRows.length > 0) await sb().from("release_items").insert(prevRows as Record<string, unknown>[]);
        flash(`Couldn't save the new lines (${error.message}) — the old ones were kept`);
        setBusy(false); return;
      }
    }
    setBusy(false);
    setItemsRel(null); setRelItems(null);
    loadRows(active, true);
    flash(`Line items saved — ${rows.length} line${rows.length === 1 ? "" : "s"}, ${fmt(rows.reduce((s, it) => s + it.qty * it.unit_price, 0))}`);
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

  // uploads the files, then writes the attachment list ONCE against the freshest
  // row — the old one-at-a-time loop overwrote itself and kept only the last photo
  const attachFileList = async (r: Release, files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    const added: { name: string; path: string }[] = [];
    for (const file of files) {
      const up = await uploadAttachment(r, file);
      if (up) added.push(up);
    }
    if (added.length > 0) {
      const { data: cur } = await sb().from("releases").select("attachments").eq("id", r.id).single();
      const existing = ((cur as { attachments?: { name: string; path: string }[] } | null)?.attachments)
        || r.attachments || [];
      const list = [...existing.filter((a) => !added.some((b) => b.path === a.path)), ...added];
      const { error } = await sb().from("releases").update({ attachments: list }).eq("id", r.id);
      if (error) flash(error.message);
      else {
        setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, attachments: list } : x)));
        setAttachRel((prev) => (prev && prev.id === r.id ? { ...prev, attachments: list } : prev));
        flash(added.length === 1 ? `Attached ${added[0].name}` : `Attached ${added.length} files`);
      }
    }
    setBusy(false);
  };
  const attachFile = (r: Release, file: File) => attachFileList(r, [file]);

  const openAttachment = async (path: string) => {
    const { data, error } = await sb().storage.from("docs").createSignedUrl(path, 3600);
    if (error || !data) { flash(error?.message || "Couldn't open the file"); return; }
    window.open(data.signedUrl, "_blank");
  };

  const removeAttachment = async (r: Release, path: string) => {
    // fresh list — another phone may have attached files since this render;
    // and the row updates first, so a failed write never orphans the entry
    const { data: cur } = await sb().from("releases").select("attachments").eq("id", r.id).single();
    const list = (((cur as Release | null)?.attachments) || r.attachments || []).filter((a) => a.path !== path);
    const { error } = await sb().from("releases").update({ attachments: list }).eq("id", r.id);
    if (error) { flash(error.message); return; }
    await sb().storage.from("docs").remove([path]);
    setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, attachments: list } : x)));
    setAttachRel((prev) => (prev && prev.id === r.id ? { ...prev, attachments: list } : prev));
  };

  // timestamped job photos straight from the phone camera — shrunk before upload;
  // second-resolution stamp so retakes moments apart never overwrite each other
  const addPhotos = async (r: Release, files: File[]) => {
    const shrunk = await Promise.all(files.map((f) => shrinkImage(f)));
    const stamp = new Date().toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "");
    await attachFileList(r, shrunk.map((f, i) => {
      const ext = (f.name.match(/\.\w+$/) || [".jpg"])[0];
      return new File([f], `photo_${stamp}${files.length > 1 ? `_${i + 1}` : ""}${ext}`, { type: f.type });
    }));
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
        await ensureXLSX();
        const redRows = await detectRedRows(buf);
        const wb = XLSX.read(buf, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const raw: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false, blankrows: true });
        const hIdx = raw.findIndex((r) => r.some((c) => /release/i.test(c)) && r.some((c) => /amount/i.test(c)));
        if (hIdx < 0) { flash("No header row with Release + Amount found"); return; }
        // red-row numbers from the XML are absolute — offset by where the sheet's used range starts
        const rangeBase = XLSX.utils.decode_range(String(sheet["!ref"] || "A1")).s.r;
        const headers = raw[hIdx].map((h) => String(h).toLowerCase());
        const col = (re: RegExp) => headers.findIndex((h) => re.test(h));
        const m = { rel: col(/^release/), location: col(/location/), buildings: col(/building/), ticket: col(/ticket/), amount: col(/amount/), adjusted: col(/adjust/), pre: col(/pre/), date: col(/date|complet/), payroll: col(/payroll/), received: col(/receiv/), status: col(/status/), hours: col(/hour|labor/) };
        const pre = raw.slice(0, hIdx).flat().join(" ");
        const gm = pre.match(/contract\s*#?\s*([A-Za-z0-9-]+)/i) || fname.match(/(\d{5,})/);
        const items = raw.slice(hIdx + 1)
          .map((r, k) => ({ r, sheetRow: rangeBase + hIdx + 2 + k }))
          .filter(({ r }) => r.some((c) => String(c).trim() !== ""))
          .map(({ r, sheetRow }) => {
            const g = (i: number) => (i >= 0 ? String(r[i] ?? "").trim() : "");
            const rowText = r.join(" ");
            // an Adjusted value is NYCHA's corrected amount — it wins over Amount
            const adjV = m.adjusted >= 0 ? parseNum(r[m.adjusted]) : 0;
            return {
              rel_number: g(m.rel), location: g(m.location), buildings: g(m.buildings), ticket: g(m.ticket),
              amount: adjV > 0 ? adjV : m.amount >= 0 ? parseNum(r[m.amount]) : 0, pre_check: g(m.pre), date_completed: g(m.date),
              payroll_done: /^d/i.test(g(m.payroll)), received: /^y/i.test(g(m.received)),
              canceled: redRows.has(sheetRow) || /cancel|void/i.test(g(m.status) || rowText), labor_hours: m.hours >= 0 ? parseNum(r[m.hours]) : 0, assigned_to: null,
            };
          })
          .filter((it) => it.rel_number || it.amount > 0);
        // fields whose column isn't in this sheet — updates must leave them alone
        const omit: string[] = [];
        if (m.location < 0) omit.push("location");
        if (m.buildings < 0) omit.push("buildings");
        if (m.ticket < 0) omit.push("ticket");
        if (m.pre < 0) omit.push("pre_check");
        if (m.date < 0) omit.push("date_completed");
        if (m.payroll < 0) omit.push("payroll_done");
        if (m.received < 0) omit.push("received");
        if (m.hours < 0) omit.push("labor_hours");
        setPending({ items, guess: gm ? gm[1] : "", omit });
      } catch { flash("Couldn't read that file — save as .xlsx or .csv"); }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  // finds the contract in the DATABASE (not just this page's list, which can be
  // stale right after another import created it), creating it if truly new
  const resolveContract = async (num: string): Promise<Contract | null> => {
    const { data: found } = await sb().from("contracts").select("id,number,name").eq("number", num).limit(1);
    if (found && found[0]) return found[0] as Contract;
    const { data, error } = await sb().from("contracts").insert({ number: num, name: num }).select().single();
    if (data) return data as Contract;
    if (error && /duplicate|unique/i.test(error.message)) {
      const { data: again } = await sb().from("contracts").select("id,number,name").eq("number", num).limit(1);
      if (again && again[0]) return again[0] as Contract;
    }
    flash(error?.message || "Couldn't create the contract");
    return null;
  };

  const runImport = async (mode: "replace" | "append") => {
    if (!pending) return;
    setBusy(true);
    const num = (pending.guess || "Contract").trim();
    const contract = await resolveContract(num);
    if (!contract) { setBusy(false); return; }
    if (mode === "replace") {
      // merge-style replace: releases already here are UPDATED in place (payroll
      // links, photos and invoice dates survive), new ones are added, leftovers
      // are deleted where nothing depends on them — payroll-linked ones are kept
      // full rows, and across every twin of this contract number — so the sheet
      // always lands on the ORIGINAL of a duplicated release, never the copy
      const twinIds = contracts.filter((c) => contractKey(c.number) === contractKey(contract.number)).map((c) => c.id);
      if (!twinIds.includes(contract.id)) twinIds.push(contract.id);
      const existing: Release[] = [];
      for (const tid of twinIds) {
        for (let from = 0; ; from += 1000) {
          const { data: page } = await sb().from("releases").select("*").eq("contract_id", tid).range(from, from + 999);
          existing.push(...((page || []) as Release[]));
          if (!page || page.length < 1000) break;
        }
      }
      // one normalizer for release numbers everywhere ("007" and "7" are the same release)
      const relKey = (v: unknown) => String(v ?? "").trim().replace(/^0+(?=\d)/, "");
      const byNum = new Map<string, Release[]>();
      existing.forEach((r) => {
        const k = relKey(r.rel_number);
        if (!k) return;
        if (!byNum.has(k)) byNum.set(k, []);
        byNum.get(k)!.push(r);
      });
      let updated = 0, added = 0;
      const toInsert: typeof pending.items = [];
      const matched = new Set<string>();
      const keeperByNum = new Map<string, Release>();
      const toUpdate: { id: string; patch: Record<string, unknown> }[] = [];
      const sheetSeen = new Set<string>();
      for (const it of pending.items) {
        const k = relKey(it.rel_number);
        // the same number twice in one sheet must not become a second row
        if (k && sheetSeen.has(k)) continue;
        if (k) sheetSeen.add(k);
        const group = k ? byNum.get(k) : undefined;
        if (group && group.length > 0) {
          matched.add(k);
          // the received / invoiced / photographed one is the original — it gets
          // the sheet's update; any copies get merged away below
          const keeper = [...group].sort((a, b) => relScore(b) - relScore(a))[0];
          keeperByNum.set(k, keeper);
          const { assigned_to: _a, ...patch } = it;
          // a column the sheet doesn't have says nothing — it must not blank or
          // un-receive what's already stored
          for (const key of pending.omit || []) delete (patch as Record<string, unknown>)[key];
          toUpdate.push({ id: keeper.id, patch });
        } else toInsert.push(it);
      }
      // all updates go as bulk writes, 500 rows per request — the database matches
      // each row by its id and only touches the sheet's columns, so photos,
      // invoice dates and payroll links survive exactly as before
      for (let i = 0; i < toUpdate.length; i += 500) {
        const chunk = toUpdate.slice(i, i + 500).map((u) => ({ id: u.id, ...u.patch }));
        setFolderProgress(`Updating ${Math.min(i + 500, toUpdate.length)} of ${toUpdate.length} releases…`);
        let { error } = await sb().from("releases").upsert(chunk);
        if (error) {
          // fall back to row-by-row (in parallel) so one odd row can't sink the import
          const results = await Promise.all(chunk.map(({ id, ...patch }) => sb().from("releases").update(patch).eq("id", id)));
          const bad = results.find((r) => r.error);
          if (bad?.error) { flash(bad.error.message); setFolderProgress(""); setBusy(false); return; }
          error = null;
        }
        updated += chunk.length;
      }
      setFolderProgress("");
      // sort out everything that ISN'T a keeper:
      //  - a copy of a matched number → rescue its photos onto the original, then remove
      //  - not in the sheet but RECEIVED → left completely alone (paid history is sacred)
      //  - not in the sheet, not received → removed (canceled if payroll hours block it)
      const keepIds = new Set<string>([...keeperByNum.values()].map((r) => r.id));
      const removeIds: string[] = [];
      const attachPatches: { id: string; attachments: { name: string; path: string }[] }[] = [];
      let keptReceived = 0;
      const copyPairs: { copyId: string; keeperId: string }[] = [];
      for (const r of existing) {
        if (keepIds.has(r.id)) continue;
        const k = relKey(r.rel_number);
        const keeper = keeperByNum.get(k);
        if (keeper) {
          // duplicate copy — its attachments move to the original before it goes
          const extra = (r.attachments || []).filter((a) => !(keeper.attachments || []).some((b) => b.path === a.path));
          if (extra.length > 0) {
            keeper.attachments = [...(keeper.attachments || []), ...extra];
            const prior = attachPatches.find((p) => p.id === keeper.id);
            if (prior) prior.attachments = keeper.attachments;
            else attachPatches.push({ id: keeper.id, attachments: keeper.attachments });
          }
          removeIds.push(r.id);
          copyPairs.push({ copyId: r.id, keeperId: keeper.id });
        } else if (r.received) {
          keptReceived += 1; // paid but missing from the sheet — never deleted
        } else {
          removeIds.push(r.id);
        }
      }
      // photos move with checked writes — an upsert here could silently fail
      for (let i = 0; i < attachPatches.length; i += 10) {
        const chunk = attachPatches.slice(i, i + 10);
        const results = await Promise.all(chunk.map((pch) => sb().from("releases").update({ attachments: pch.attachments }).eq("id", pch.id)));
        results.forEach((res, j) => {
          if (res.error) {
            // rescue failed — keep the copies pointing at this keeper so nothing is lost
            const keeperId = chunk[j].id;
            copyPairs.filter((cp) => cp.keeperId === keeperId).forEach((cp) => {
              const at = removeIds.indexOf(cp.copyId);
              if (at >= 0) removeIds.splice(at, 1);
            });
          }
        });
      }
      // line items live on the copies too — deleting a copy cascades its items
      // away, so they move to the original first (only when the original has none)
      if (copyPairs.length > 0) {
        const keeperIds = [...new Set(copyPairs.map((cp) => cp.keeperId))];
        const hasItems = new Set<string>();
        for (let i = 0; i < keeperIds.length; i += 200) {
          const { data: its } = await sb().from("release_items").select("release_id").in("release_id", keeperIds.slice(i, i + 200));
          ((its || []) as { release_id: string }[]).forEach((it) => hasItems.add(it.release_id));
        }
        for (const cp of copyPairs) {
          if (!removeIds.includes(cp.copyId)) continue;
          if (hasItems.has(cp.keeperId)) continue; // the original's items win
          const { error: mv } = await sb().from("release_items").update({ release_id: cp.keeperId }).eq("release_id", cp.copyId);
          if (!mv) hasItems.add(cp.keeperId); // only the first copy donates — never stack
        }
      }
      let removed = 0, kept = 0;
      for (let i = 0; i < removeIds.length; i += 100) {
        const slice = removeIds.slice(i, i + 100);
        if (removeIds.length > 100) setFolderProgress(`Cleaning up ${Math.min(i + 100, removeIds.length)} of ${removeIds.length}…`);
        const { error } = await sb().from("releases").delete().in("id", slice);
        if (!error) { removed += slice.length; continue; }
        // some are blocked (payroll hours linked) — cancel those instead so they
        // stop counting toward the totals; the hours stay safe, restore any time
        const results = await Promise.all(slice.map((id) => sb().from("releases").delete().eq("id", id).then((r) => ({ id, error: r.error }))));
        const blocked = results.filter((r) => r.error).map((r) => r.id);
        removed += slice.length - blocked.length;
        if (blocked.length > 0) {
          await sb().from("releases").update({ canceled: true }).in("id", blocked);
          kept += blocked.length;
        }
      }
      setFolderProgress("");
      for (let i = 0; i < toInsert.length; i += 500) {
        const chunk = toInsert.slice(i, i + 500).map((it) => ({ ...it, contract_id: contract!.id }));
        const { error } = await sb().from("releases").insert(chunk);
        if (error) { flash(error.message); break; }
        added += chunk.length;
      }
      setPending(null); setBusy(false);
      await loadContracts(); setActive(contract.id); await loadRows(contract.id);
      flash(`Loaded into ${num} — ${updated} updated, ${added} added${removed ? `, ${removed} removed (incl. duplicate copies)` : ""}${keptReceived ? `, ${keptReceived} received release${keptReceived === 1 ? "" : "s"} not in the sheet left untouched` : ""}${kept ? `, ${kept} moved to Canceled (payroll hours linked — restore from the Canceled list if needed)` : ""}`);
      return;
    }
    for (let i = 0; i < pending.items.length; i += 500) {
      const chunk = pending.items.slice(i, i + 500).map((it) => ({ ...it, contract_id: contract!.id }));
      const { error } = await sb().from("releases").insert(chunk);
      if (error) { flash(error.message); break; }
    }
    setPending(null); setBusy(false);
    await loadContracts(); setActive(contract.id); await loadRows(contract.id);
    flash(`Loaded into ${num}`);
  };

  // ---------- fix duplicates: merge twin contracts, then twin releases ----------
  // Repairs what a bad import created: contract rows sharing one number get
  // merged into the one holding the most releases, then releases sharing a
  // number keep the original (received / invoiced / with photos) and the copy's
  // attachments and line items are moved over before the copy is deleted.
  // the original wins: received > invoiced > payroll-done > has photos > first
  const relScore = (r: Release) =>
    (r.received ? 8 : 0) + (r.invoice_sent ? 4 : 0) + (r.payroll_done ? 2 : 0) + Math.min(1, (r.attachments || []).length);

  // core merge, shared by the button, the sheet import and the folder attach
  const mergeDuplicatesCore = async (cur: Contract, allContracts: Contract[]) => {
    const key = contractKey(cur.number);
    const twins = allContracts.filter((c) => contractKey(c.number) === key);
    // releases across every twin contract row
    const all: Release[] = [];
    for (const t of twins) {
      for (let f = 0; ; f += 1000) {
        const { data } = await sb().from("releases").select("*").eq("contract_id", t.id).range(f, f + 999);
        all.push(...((data || []) as Release[]));
        if (!data || data.length < 1000) break;
      }
    }
    // keeper contract = the twin holding the most releases
    const keeperContract = [...twins].sort((a, b) =>
      all.filter((r) => r.contract_id === b.id).length - all.filter((r) => r.contract_id === a.id).length)[0];
    let contractsMerged = 0;
    for (const t of twins) {
      if (t.id === keeperContract.id) continue;
      setFolderProgress(`Merging contract ${t.number} into ${keeperContract.number}…`);
      await sb().from("releases").update({ contract_id: keeperContract.id }).eq("contract_id", t.id);
      await sb().from("contract_items").update({ contract_id: keeperContract.id }).eq("contract_id", t.id).then(() => null, () => null);
      await sb().from("proposals").update({ contract_id: keeperContract.id }).eq("contract_id", t.id).then(() => null, () => null);
      const { error } = await sb().from("contracts").delete().eq("id", t.id);
      if (!error) contractsMerged += 1;
    }
    all.forEach((r) => { if (twins.some((t) => t.id === r.contract_id)) r.contract_id = keeperContract.id; });
    // group releases by number; more than one copy = a duplicate to merge
    const groupsByNum = new Map<string, Release[]>();
    all.forEach((r) => {
      const k = String(r.rel_number || "").trim().replace(/^0+(?=\d)/, "");
      if (!k) return;
      if (!groupsByNum.has(k)) groupsByNum.set(k, []);
      groupsByNum.get(k)!.push(r);
    });
    const dupGroups = [...groupsByNum.values()].filter((g) => g.length > 1);
    let merged = 0, blocked = 0, gi = 0;
    const goneIds = new Set<string>(); // rows deleted below — never patched afterwards
    for (const g of dupGroups) {
      gi += 1;
      setFolderProgress(`Merging duplicate releases ${gi} of ${dupGroups.length}…`);
      const keep = [...g].sort((a, b) => relScore(b) - relScore(a))[0];
      const { data: keepItems } = await sb().from("release_items").select("id").eq("release_id", keep.id).limit(1);
      let keeperHasItems = (keepItems || []).length > 0;
      for (const dupe of g) {
        if (dupe.id === keep.id) continue;
        // the copy's paperwork moves to the original before the copy goes
        if (!keeperHasItems) {
          const { error: mvErr } = await sb().from("release_items").update({ release_id: keep.id }).eq("release_id", dupe.id);
          if (!mvErr) keeperHasItems = true; // later copies must never stack more items on
        } else {
          await sb().from("release_items").delete().eq("release_id", dupe.id).then(() => null, () => null);
        }
        const mergedAtt = [
          ...(keep.attachments || []),
          ...((dupe.attachments || []).filter((a) => !(keep.attachments || []).some((b) => b.path === a.path))),
        ];
        if (mergedAtt.length !== (keep.attachments || []).length) {
          await sb().from("releases").update({ attachments: mergedAtt }).eq("id", keep.id);
          keep.attachments = mergedAtt;
        }
        const { error } = await sb().from("releases").delete().eq("id", dupe.id);
        if (error) { await sb().from("releases").update({ canceled: true }).eq("id", dupe.id); blocked += 1; }
        else { merged += 1; goneIds.add(dupe.id); }
      }
    }
    // strip duplicate documents on every remaining release: the same name twice
    // (same file merged in from a copy under a different storage path) and the
    // stacked "name (2).pdf" copies both collapse down to one entry
    setFolderProgress("Cleaning up duplicate file copies…");
    let attCopies = 0;
    const attPatches: { id: string; attachments: { name: string; path: string }[] }[] = [];
    const deadPaths: string[] = [];
    const survivors = new Map<string, Release>();
    all.forEach((r) => { if (!goneIds.has(r.id) && !survivors.has(r.id)) survivors.set(r.id, r); });
    for (const r of survivors.values()) {
      const atts = r.attachments || [];
      if (atts.length < 2) continue;
      const seen = new Map<string, { name: string; path: string }>();
      const keepList: { name: string; path: string }[] = [];
      for (const a of atts) {
        const base = a.name.replace(/ \((\d+)\)(\.[^.]+)$/i, "$2").toLowerCase();
        const prior = seen.get(base);
        if (!prior) { seen.set(base, a); keepList.push(a); continue; }
        attCopies += 1;
        // the plain-named one on this release's own folder is the original
        const priorIsCopy = / \(\d+\)\.[^.]+$/i.test(prior.name) || !prior.path.startsWith(`${r.id}/`);
        const curIsCopy = / \(\d+\)\.[^.]+$/i.test(a.name) || !a.path.startsWith(`${r.id}/`);
        if (priorIsCopy && !curIsCopy) {
          if (prior.path !== a.path) deadPaths.push(prior.path);
          keepList[keepList.indexOf(prior)] = a; seen.set(base, a);
        } else {
          if (prior.path !== a.path) deadPaths.push(a.path);
        }
      }
      if (keepList.length !== atts.length) attPatches.push({ id: r.id, attachments: keepList });
    }
    // plain updates, a few at a time — never upsert here: an upsert that touches a
    // just-deleted id turns into an INSERT and fails the whole batch silently
    for (let i = 0; i < attPatches.length; i += 10) {
      const chunk = attPatches.slice(i, i + 10);
      const results = await Promise.all(chunk.map((p) => sb().from("releases").update({ attachments: p.attachments }).eq("id", p.id)));
      const bad = results.find((r) => r.error);
      if (bad?.error) flash(`Some file cleanups didn't save: ${bad.error.message}`);
    }
    // only paths no surviving release still points to (AFTER the cleanup) get removed
    const finalLists = new Map<string, { name: string; path: string }[]>();
    survivors.forEach((r) => finalLists.set(r.id, r.attachments || []));
    attPatches.forEach((p) => finalLists.set(p.id, p.attachments));
    const stillUsed = new Set<string>();
    finalLists.forEach((list) => list.forEach((a) => stillUsed.add(a.path)));
    const removable = [...new Set(deadPaths)].filter((p) => !stillUsed.has(p));
    for (let i = 0; i < removable.length; i += 100) {
      await sb().storage.from("docs").remove(removable.slice(i, i + 100)).then(() => null, () => null);
    }
    setFolderProgress("");
    return { merged, blocked, contractsMerged, attCopies, dupGroups: dupGroups.length, keeperContractId: keeperContract.id };
  };

  // every contract in one go — for when duplicates are spread across the board
  const fixDuplicatesEverywhere = async () => {
    if (!window.confirm(
      "Fix duplicates in EVERY contract?\n\nFor each release number only the original is kept (received / invoiced / photos win) — copies are merged into it and removed, and stacked file copies like \"name (2).pdf\" are cleaned off. Nothing received or payroll-linked is ever deleted."
    )) return;
    setBusy(true);
    const doneKeys = new Set<string>();
    let merged = 0, contractsMerged = 0, blocked = 0, attCopies = 0;
    for (const c of contracts) {
      const key = contractKey(c.number);
      if (!key || doneKeys.has(key)) continue;
      doneKeys.add(key);
      setFolderProgress(`Checking contract ${key}…`);
      const res = await mergeDuplicatesCore(c, contracts).catch(() => null);
      if (res) { merged += res.merged; contractsMerged += res.contractsMerged; blocked += res.blocked; attCopies += res.attCopies; }
    }
    setFolderProgress(""); setBusy(false);
    await loadContracts();
    if (active) await loadRows(active);
    flash(
      merged + contractsMerged + attCopies === 0
        ? "No duplicates found anywhere — everything is clean"
        : `All contracts cleaned — ${merged} duplicate release${merged === 1 ? "" : "s"} merged away${contractsMerged ? `, ${contractsMerged} twin contract${contractsMerged === 1 ? "" : "s"} merged` : ""}${attCopies ? `, ${attCopies} duplicate file cop${attCopies === 1 ? "y" : "ies"} removed` : ""}${blocked ? `, ${blocked} moved to Canceled (payroll linked)` : ""}.`
    );
  };

  const fixDuplicates = async () => {
    const cur = contracts.find((c) => c.id === active);
    if (!cur) return;
    const key = contractKey(cur.number);
    if (!window.confirm(
      `Fix duplicates for contract ${key}?\n\nDuplicate copies of the same release will be merged into the original — the original's payment status, photos and line items always win, and the copy's attachments move over before the copy is removed. Nothing that's been received or has payroll hours is deleted.`
    )) return;
    setBusy(true);
    setFolderProgress("Checking for duplicates…");
    const res = await mergeDuplicatesCore(cur, contracts);
    setBusy(false);
    await loadContracts();
    setActive(res.keeperContractId);
    await loadRows(res.keeperContractId);
    flash(
      res.dupGroups === 0 && res.contractsMerged === 0
        ? "No duplicates found — this contract is clean"
        : `Done — ${res.merged} duplicate release${res.merged === 1 ? "" : "s"} merged away${res.contractsMerged ? `, ${res.contractsMerged} twin contract${res.contractsMerged === 1 ? "" : "s"} merged` : ""}${res.attCopies ? `, ${res.attCopies} duplicate file cop${res.attCopies === 1 ? "y" : "ies"} removed` : ""}${res.blocked ? `, ${res.blocked} moved to Canceled (payroll hours linked)` : ""}. Totals are back to the real numbers.`
    );
  };

  // ---------- attach a whole folder: each file lands on its own release ----------
  const MAX_FOLDER_FILES = 5000;
  // a contract's own name may be wrong or missing — the number is what identifies it
  const contractLabelOf = (c: { number: string; name?: string | null }) =>
    c.name && c.name !== c.number ? `${c.number} (${c.name})` : `contract ${c.number}`;
  const handleFolder = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const all = Array.from(e.target.files || []).filter((f) => f.size > 0);
    e.target.value = "";
    if (all.length === 0) return;
    // every PDF is opened and its header read — the file itself decides whether it
    // is a release, so odd file names never cause one to be skipped. Anything that
    // isn't a release PDF is simply left alone.
    const pdfs = all.filter((f) => /\.pdf$/i.test(f.name));
    const notPdf = all.length - pdfs.length;
    if (pdfs.length === 0) { flash(`No PDFs in that folder (${all.length} file${all.length === 1 ? "" : "s"})`); return; }
    const files = pdfs.slice(0, MAX_FOLDER_FILES);
    const relPath = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;

    setBusy(true);
    setFolderProgress(`Reading 0 of ${files.length}…`);
    const plan: PlanRow[] = [];
    let notRelease = 0, otherContract = 0;
    let planRels: Release[] = [];
    let planContracts: Contract[] = [];
    try {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      // page 1 only, a few at a time, and each document is closed straight after —
      // a thousand-file folder would otherwise crawl and eat memory
      const readOne = async (file: File) => {
        let ident: { contract: string; rel: string } | null = null;
        let fromFile = true;
        let doc: PdfDocLite | null = null;
        try {
          doc = (await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise) as unknown as PdfDocLite;
          const tc = await (await doc.getPage(1)).getTextContent();
          ident = quickReleaseId((tc.items as { str?: string }[]).map((it) => it.str || "").join(" "));
        } catch { ident = null; }
        finally { try { await doc?.destroy(); } catch { /* already gone */ } }
        if (!ident) {
          const guess = parseReleaseFileName(file.name); // scan with no text layer
          if (guess) { ident = { contract: guess.contract, rel: guess.rel }; fromFile = false; }
        }
        return { file, ident, fromFile };
      };
      const BATCH = 4;
      const read: { file: File; ident: { contract: string; rel: string } | null; fromFile: boolean }[] = [];
      for (let i = 0; i < files.length; i += BATCH) {
        const chunk = files.slice(i, i + BATCH);
        read.push(...await Promise.all(chunk.map(readOne)));
        setFolderProgress(`Reading ${Math.min(i + BATCH, files.length)} of ${files.length}…`);
      }

      // Each file names its own contract, so the releases are looked up per file —
      // it doesn't matter which contract happens to be open, and a contract whose
      // NAME is wrong still matches because matching is on the number.
      const wanted = [...new Set(read.map((r) => r.ident && contractKey(r.ident.contract)).filter(Boolean) as string[])];
      setFolderProgress("Finding the contracts…");
      const { data: allC } = await sb().from("contracts").select("id,number,name");
      // the same contract number can exist as more than one row ("2215867" and
      // "2215867-2") — ALL of them count, and their releases are searched together.
      // Picking just one row here is what once made already-imported releases look
      // "new" and created duplicates.
      const cByKey = new Map<string, Contract[]>();
      ((allC || []) as Contract[]).forEach((c) => {
        const k = contractKey(c.number);
        if (!k) return;
        if (!cByKey.has(k)) cByKey.set(k, []);
        cByKey.get(k)!.push(c);
      });
      const cids = wanted.flatMap((k) => (cByKey.get(k) || []).map((c) => c.id));
      const relsAll: Release[] = [];
      for (let i = 0; i < cids.length; i += 20) {
        for (let f = 0; ; f += 1000) {
          const { data } = await sb().from("releases").select("*").in("contract_id", cids.slice(i, i + 20)).range(f, f + 999);
          relsAll.push(...((data || []) as Release[]));
          if (!data || data.length < 1000) break;
        }
      }
      // keyed contract+release, so #2 on Brooklyn never collides with #2 on Manhattan
      const byKey = new Map<string, Release[]>();
      relsAll.forEach((r) => {
        const ck = contractKey(((allC || []) as Contract[]).find((c) => c.id === r.contract_id)?.number || "");
        const rk = String(r.rel_number || "").trim().replace(/^0+(?=\d)/, "");
        if (!ck || !rk) return;
        const k = `${ck}:${rk}`;
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k)!.push(r);
      });
      planRels = relsAll;
      planContracts = (allC || []) as Contract[];

      for (const { file, ident, fromFile } of read) {
        const base = { path: relPath(file), name: file.name, file };
        if (!ident) { notRelease += 1; continue; } // not a release PDF — leave it alone
        const ck = contractKey(ident.contract);
        const cands = cByKey.get(ck) || [];
        const contract = cands[0];
        const cLabel = contract ? contractLabelOf(contract) : `contract ${ident.contract}`;
        if (!contract) {
          // neither the contract nor the release is on file — both get made from the PDF
          otherContract += 1;
          plan.push({
            ...base, relNum: ident.rel, relId: null, confidence: "none",
            newRel: { contractNum: ident.contract, rel: ident.rel }, willCreate: true,
            why: `new — contract ${ident.contract} and release #${ident.rel} will be created`,
          });
          continue;
        }
        const found = byKey.get(`${ck}:${ident.rel}`) || [];
        if (found.length === 1) {
          if (found[0].received) {
            // received = closed. Nothing gets attached, created or changed on it.
            plan.push({ ...base, relNum: ident.rel, relId: null, confidence: "none", skipped: true,
              why: `release #${ident.rel} is already received — left alone` });
          } else {
            plan.push({
              ...base, relNum: ident.rel, relId: found[0].id, confidence: fromFile ? "high" : "low",
              why: `release #${ident.rel} · ${cLabel}${fromFile ? "" : " — from the file name (PDF unreadable)"}`,
            });
          }
        } else if (found.length === 0) {
          // the release isn't on file yet — build it from what the PDF says
          plan.push({
            ...base, relNum: ident.rel, relId: null, confidence: "none",
            newRel: { contractNum: ident.contract, rel: ident.rel }, willCreate: true,
            why: `new release #${ident.rel} in ${cLabel} — will be created`,
          });
        } else {
          // the number exists more than once — the file goes to the ORIGINAL
          // (received / invoiced / photographed wins); the copies get merged
          // away automatically after the attach
          const keeper = [...found].sort((a, b) => relScore(b) - relScore(a))[0];
          if (keeper.received) {
            plan.push({ ...base, relNum: ident.rel, relId: null, confidence: "none", skipped: true,
              why: `release #${ident.rel} is already received — left alone` });
          } else {
            plan.push({
              ...base, relNum: ident.rel, relId: keeper.id, confidence: fromFile ? "high" : "low",
              why: `release #${ident.rel} · ${cLabel} — original of ${found.length} copies (duplicates get cleaned up)`,
            });
          }
        }
      }
    } catch {
      // pdfjs wouldn't load — fall back to names alone so the import still works
      const guessed = planFolder(files.map((f) => ({ relativePath: relPath(f) })), rows);
      guessed.forEach((m, i) => plan.push({ ...m, file: files[i] }));
      planRels = rows;
    }
    setFolderProgress(""); setBusy(false);
    if (plan.length === 0) {
      flash(`Read ${files.length} PDF${files.length === 1 ? "" : "s"} — none of them are NYCHA release PDFs`);
      return;
    }
    const top = (relPath(files[0]).split("/")[0] || "").trim();
    setFolderPlan({
      rows: plan, folder: top, capped: pdfs.length - files.length,
      ignored: notPdf + notRelease, notPdf, notRelease, otherContract,
      rels: planRels, contracts: planContracts,
    });
  };

  // full read of a release PDF — needed to build a release that isn't on file yet
  const fullParse = async (
    file: File,
    pdfjs: typeof import("pdfjs-dist") | null
  ) => {
    if (!pdfjs) return null;
    let doc: PdfDocLite | null = null;
    try {
      const loaded = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
      doc = loaded as unknown as PdfDocLite;
      let text = "";
      for (let pg = 1; pg <= loaded.numPages; pg++) {
        const tc = await (await loaded.getPage(pg)).getTextContent();
        text += tc.items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n";
      }
      return parseReleasePdfText(text);
    } catch { return null; }
    finally { try { await doc?.destroy(); } catch { /* already gone */ } }
  };

  const runFolderAttach = async () => {
    if (!folderPlan) return;
    const todo = folderPlan.rows.filter((r) => r.relId || r.willCreate);
    if (todo.length === 0) { flash("Nothing to attach — pick a release for at least one file"); return; }
    setBusy(true);
    const pdfjsEarly = await import("pdfjs-dist").catch(() => null);
    if (pdfjsEarly) pdfjsEarly.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

    // ---- releases the app doesn't have yet are built from their own PDF first ----
    let made = 0; const madeFailed: string[] = [];
    let recvFilesSkipped = 0; // files aimed at received releases — deliberately dropped
    let alreadyAttached = 0;  // same file name already on the release — re-run of the same folder
    const toMake = new Map<string, PlanRow[]>(); // contract+release → its files
    todo.filter((r) => r.willCreate && !r.relId && r.newRel)
      .forEach((r) => {
        const k = `${contractKey(r.newRel!.contractNum)}:${r.newRel!.rel}`;
        if (!toMake.has(k)) toMake.set(k, []);
        toMake.get(k)!.push(r);
      });
    const madeIds = new Map<string, string>(); // same key → the new release's id
    const madeRels = new Map<string, Release>(); // and the row itself, for the steps below

    // final gate before anything is created: a FRESH look at the database.
    // If a release with this number already exists on any twin of the contract —
    // received, payroll-linked, whatever — it is reused, never created again.
    // This holds even if the screen's list is stale or another device just imported.
    const freshByKey = new Map<string, { id: string; canceled: boolean; received: boolean }>();
    if (toMake.size > 0) {
      setFolderProgress("Double-checking against the database…");
      const keys = [...new Set([...toMake.keys()].map((k) => k.split(":")[0]))];
      for (const ck of keys) {
        const ids = folderPlan.contracts.filter((c) => contractKey(c.number) === ck).map((c) => c.id);
        if (ids.length === 0) continue;
        for (let f = 0; ; f += 1000) {
          const { data } = await sb().from("releases").select("id,rel_number,canceled,received").in("contract_id", ids).range(f, f + 999);
          ((data || []) as { id: string; rel_number: string; canceled: boolean; received: boolean }[]).forEach((r) => {
            const rk = String(r.rel_number || "").trim().replace(/^0+(?=\d)/, "");
            if (!rk) return;
            const k = `${ck}:${rk}`;
            const cur = freshByKey.get(k);
            // a live release beats a canceled one as the reuse target
            if (!cur || (cur.canceled && !r.canceled)) freshByKey.set(k, { id: r.id, canceled: !!r.canceled, received: !!r.received });
          });
          if (!data || data.length < 1000) break;
        }
      }
    }
    let reused = 0;
    let mk = 0;
    for (const [key, group] of toMake) {
      mk += 1;
      setFolderProgress(`Creating release ${mk} of ${toMake.size}…`);
      const already = freshByKey.get(key);
      if (already?.received) { recvFilesSkipped += group.length; continue; } // received = untouchable
      if (already) { madeIds.set(key, already.id); reused += 1; continue; }
      let relId: string | null = null;
      for (const item of group) {
        const parsed = await fullParse(item.file, pdfjsEarly);
        if (!parsed) continue;
        // reuse the existing contract with this number — when the number exists as
        // several rows, the one that actually holds releases wins, so a duplicate
        // twin contract is never created
        const ck2 = contractKey(parsed.contract.trim() || item.newRel!.contractNum);
        const cands2 = folderPlan.contracts.filter((c) => contractKey(c.number) === ck2);
        const contract =
          cands2.sort((a, b) =>
            folderPlan.rels.filter((r) => r.contract_id === b.id).length -
            folderPlan.rels.filter((r) => r.contract_id === a.id).length)[0]
          || await resolveContract(parsed.contract.trim() || item.newRel!.contractNum);
        if (!contract) break;
        const breakdown = parsed.items.filter((it) => it.uom === "HOUR")
          .map((it) => ({ cls: it.description.replace(/,?\s*Regular Hours/i, "").trim(), hours: it.qty }));
        const payload: Record<string, unknown> = {
          contract_id: contract.id, rel_number: parsed.rel, location: parsed.development,
          buildings: "", ticket: parsed.workOrders[0] || "", amount: parsed.total,
          labor_hours: parsed.laborHours, labor_breakdown: breakdown,
          date_completed: "", pre_check: "", payroll_done: false, received: false, canceled: false, assigned_to: null,
        };
        const strip = (o: Record<string, unknown>) => { const { labor_breakdown: _b, labor_hours: _h, ...rest } = o; return rest; };
        let { data: rel, error } = await sb().from("releases").insert(payload).select().single();
        if (error && /column|schema cache/i.test(error.message)) {
          ({ data: rel, error } = await sb().from("releases").insert(strip(payload)).select().single());
        }
        if (error || !rel) { madeFailed.push(`#${item.newRel!.rel}`); break; }
        relId = (rel as Release).id;
        madeRels.set(relId, rel as Release);
        made += 1;
        break; // one file is enough to build the release; the rest just attach to it
      }
      if (relId) madeIds.set(key, relId);
      else if (!madeFailed.length) madeFailed.push(key.split(":")[1]);
    }

    // group by release so each release's attachment list is written once —
    // and nothing, ever, lands on a release that's already received
    const isReceivedRel = (id: string) => {
      const rel = madeRels.get(id) || folderPlan.rels.find((x) => x.id === id) || rows.find((x) => x.id === id);
      return !!rel?.received;
    };
    const byRel = new Map<string, PlanRow[]>();
    todo.forEach((r) => {
      const id = r.relId || (r.newRel ? madeIds.get(`${contractKey(r.newRel.contractNum)}:${r.newRel.rel}`) : null);
      if (!id) return; // its release couldn't be created — reported below
      if (isReceivedRel(id)) { recvFilesSkipped += 1; return; }
      if (!byRel.has(id)) byRel.set(id, []);
      byRel.get(id)!.push(r);
    });
    let ok = 0; const bad: string[] = [];
    let n = 0;
    // line items are read out of the same PDFs so the SOS and invoice are ready —
    // but never for a release that's already been paid, and never over line items
    // that are already there (someone may have edited them by hand)
    let sosMade = 0, skipPaid = 0, skipHave = 0, noItems = 0;
    const pdfjs = pdfjsEarly;
    for (const [relId, group] of byRel) {
      // a fresh release PDF for a canceled row means the release is live again
      const relRow = madeRels.get(relId) || folderPlan.rels.find((x) => x.id === relId) || rows.find((x) => x.id === relId);
      if (relRow?.canceled) {
        const { error: unc } = await sb().from("releases").update({ canceled: false }).eq("id", relId);
        if (!unc) { relRow.canceled = false; setRows((prev) => prev.map((x) => (x.id === relId ? { ...x, canceled: false } : x))); }
      }
      const { data: cur } = await sb().from("releases").select("attachments").eq("id", relId).single();
      const existing = ((cur as { attachments?: { name: string; path: string }[] } | null)?.attachments) || [];
      const added: { name: string; path: string }[] = [];
      const taken = new Set(existing.map((a) => a.name.toLowerCase()));
      // a file already attached under the same name IS this file (re-running the
      // same folder) — skip it instead of stacking "name (2).pdf" copies
      const jobs: { item: PlanRow; name: string; path: string }[] = [];
      for (const item of group) {
        const name = item.file.name;
        if (taken.has(name.toLowerCase())) { alreadyAttached += 1; continue; }
        taken.add(name.toLowerCase());
        jobs.push({ item, name, path: `${relId}/${name}` });
      }
      const POOL = 6;
      for (let i = 0; i < jobs.length; i += POOL) {
        const chunk = jobs.slice(i, i + POOL);
        const results = await Promise.all(chunk.map(async (j) => {
          try {
            // photos get shrunk on the way in, same as camera uploads
            const raw = isImg(j.item.file.name) ? await shrinkImage(j.item.file) : j.item.file;
            const { error } = await sb().storage.from("docs").upload(j.path, raw, { upsert: true });
            return { j, sent: !error };
          } catch { return { j, sent: false }; }
        }));
        results.forEach(({ j, sent }) => {
          if (sent) { added.push({ name: j.name, path: j.path }); ok += 1; }
          else bad.push(j.item.name);
        });
        n += chunk.length;
        setFolderProgress(`Attaching ${Math.min(n, todo.length)} of ${todo.length}…`);
      }
      if (added.length > 0) {
        const list = [...existing.filter((a) => !added.some((b) => b.path === a.path)), ...added];
        const { error } = await sb().from("releases").update({ attachments: list }).eq("id", relId);
        if (error) { bad.push(`${added.length} on one release`); }
        else setRows((prev) => prev.map((x) => (x.id === relId ? { ...x, attachments: list } : x)));
      }

      // ---- read the line items so SOS + Invoice are ready on this release ----
      const rel = madeRels.get(relId) || folderPlan.rels.find((x) => x.id === relId) || rows.find((x) => x.id === relId);
      if (!rel || !pdfjs) continue;
      if (rel.received) { skipPaid += 1; continue; }        // already paid — leave it as it was
      // line items already on file (possibly hand-edited) are never overwritten —
      // checked against the database because these releases can span contracts
      const { data: had } = await sb().from("release_items").select("id").eq("release_id", relId).limit(1);
      if ((had || []).length > 0) { skipHave += 1; continue; }
      let filled = false;
      for (const item of group) {
        if (!/\.pdf$/i.test(item.file.name)) continue;
        setFolderProgress(`Reading line items · ${item.name}`);
        let doc: PdfDocLite | null = null;
        try {
          const loaded = await pdfjs.getDocument({ data: await item.file.arrayBuffer() }).promise;
          doc = loaded as unknown as PdfDocLite;
          let text = "";
          for (let pg = 1; pg <= loaded.numPages; pg++) {
            const tc = await (await loaded.getPage(pg)).getTextContent();
            text += tc.items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n";
          }
          const parsed = parseReleasePdfText(text);
          if (!parsed || parsed.items.length === 0) continue;
          const { error } = await sb().from("release_items").insert(parsed.items.map((it) => ({ release_id: relId, ...it })));
          if (error) { bad.push(`line items for #${rel.rel_number}`); break; }
          sosMade += 1; filled = true;
          // required labour comes off the same PDF — only filled in when it's missing
          if (!Number(rel.labor_hours) && parsed.laborHours > 0) {
            const breakdown = parsed.items.filter((it) => it.uom === "HOUR")
              .map((it) => ({ cls: it.description.replace(/,?\s*Regular Hours/i, "").trim(), hours: it.qty }));
            const patch = { labor_hours: parsed.laborHours, labor_breakdown: breakdown };
            const { error: le } = await sb().from("releases").update(patch).eq("id", relId);
            if (le && /column|schema cache/i.test(le.message)) { /* older database — skip quietly */ }
          }
          break;
        } catch { /* try the next file for this release */ }
        finally { try { await doc?.destroy(); } catch { /* already gone */ } }
      }
      if (!filled && !rel.received) noItems += 1;
    }
    // if everything landed on one contract, show that contract — the folder may
    // well belong to a different one than was open when it was picked
    const touched = [...new Set([...byRel.keys()]
      .map((id) => (madeRels.get(id) || folderPlan.rels.find((r) => r.id === id))?.contract_id)
      .filter(Boolean))] as string[];
    const target = touched.length === 1 ? touched[0] : active;
    setFolderPlan(null); setFolderEdit(new Set());
    // any duplicates in the touched contracts get merged away automatically —
    // the original keeps everything, copies disappear, totals stay honest
    let autoMerged = 0;
    const { data: freshC } = await sb().from("contracts").select("id,number,name");
    const allC2 = (freshC || contracts) as Contract[];
    for (const cid of touched) {
      const cur = allC2.find((c) => c.id === cid);
      if (!cur) continue;
      const res = await mergeDuplicatesCore(cur, allC2).catch(() => null);
      if (res) autoMerged += res.merged + res.contractsMerged;
    }
    setFolderProgress(""); setBusy(false);
    if (target && target !== active) { await loadContracts(); setActive(target); }
    if (target) await loadRows(target, true); // lights up the SOS / Invoice buttons
    flash(
      `Attached ${ok} file${ok === 1 ? "" : "s"} to ${byRel.size} release${byRel.size === 1 ? "" : "s"}`
      + (made ? ` · ${made} new release${made === 1 ? "" : "s"} created` : "")
      + (reused ? ` · ${reused} already existed — files attached to the originals instead` : "")
      + (autoMerged ? ` · ${autoMerged} duplicate${autoMerged === 1 ? "" : "s"} merged away` : "")
      + (madeFailed.length ? ` · ${madeFailed.length} couldn't be created` : "")
      + (sosMade ? ` · SOS + invoice ready on ${sosMade}` : "")
      + (alreadyAttached ? ` · ${alreadyAttached} already attached before — skipped` : "")
      + (recvFilesSkipped ? ` · ${recvFilesSkipped} file${recvFilesSkipped === 1 ? "" : "s"} for received releases left alone` : "")
      + (skipPaid ? ` · ${skipPaid} already paid, left alone` : "")
      + (skipHave ? ` · ${skipHave} already had line items` : "")
      + (noItems ? ` · ${noItems} had no readable line items` : "")
      + (bad.length ? ` · ${bad.length} failed` : "")
    );
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
            const nc = await resolveContract(num);
            if (!nc) { failed.push(file.name); continue; }
            contract = nc; cCache.set(num, contract);
          }
          used.add(contract.id);
          const breakdown = parsed.items.filter((it) => it.uom === "HOUR")
            .map((it) => ({ cls: it.description.replace(/,?\s*Regular Hours/i, "").trim(), hours: it.qty }));
          const { data: existing } = await sb().from("releases").select("id").eq("contract_id", contract.id).eq("rel_number", parsed.rel).limit(1);
          let relId: string;
          const stripNew = (o: Record<string, unknown>) => { const { labor_breakdown: _b, labor_hours: _h, ...rest } = o; return rest; };
          if (existing && existing[0]) {
            relId = (existing[0] as { id: string }).id;
            const patch: Record<string, unknown> = {
              amount: parsed.total, labor_hours: parsed.laborHours, labor_breakdown: breakdown,
              ticket: parsed.workOrders[0] || "", location: parsed.development,
            };
            let { error } = await sb().from("releases").update(patch).eq("id", relId);
            if (error && /column|schema cache/i.test(error.message)) ({ error } = await sb().from("releases").update(stripNew(patch)).eq("id", relId));
            if (error) { failed.push(file.name); continue; }
            await sb().from("release_items").delete().eq("release_id", relId);
          } else {
            const payload: Record<string, unknown> = {
              contract_id: contract.id, rel_number: parsed.rel, location: parsed.development,
              buildings: "", ticket: parsed.workOrders[0] || "", amount: parsed.total,
              labor_hours: parsed.laborHours, labor_breakdown: breakdown,
              date_completed: "", pre_check: "", payroll_done: false, received: false, canceled: false, assigned_to: null,
            };
            let { data: rel, error } = await sb().from("releases").insert(payload).select().single();
            if (error && /column|schema cache/i.test(error.message)) ({ data: rel, error } = await sb().from("releases").insert(stripNew(payload)).select().single());
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
        if (!parsed) {
          flash(/Purchase Order No/i.test(text)
            ? "That's a PACT purchase order — upload it under PACT → Jobs → 📄 Upload PO (PDF)"
            : "Couldn't read this PDF — is it a NYCHA blanket release?");
          setBusy(false); return;
        }
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
    reader.onload = async (ev) => {
      try {
        await ensureXLSX();
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
    const contract = await resolveContract(num);
    if (!contract) { setBusy(false); return; }
    // if this release number already exists on the contract, UPDATE it instead of duplicating
    const { data: existing } = await sb().from("releases").select("id,buildings,address")
      .eq("contract_id", contract.id).eq("rel_number", pdfPending.rel).limit(1);
    const prior = (existing || [])[0] as (Release & { address?: string }) | undefined;
    let relId: string;
    // works even before RUN_ME.sql adds the labor/address columns
    const stripNew = (o: Record<string, unknown>) => { const { labor_breakdown: _b, labor_hours: _h, address: _a, ...rest } = o; return rest; };
    if (prior) {
      const patch: Record<string, unknown> = {
        amount: pdfPending.amount, labor_hours: pdfPending.hours,
        labor_breakdown: pdfPending.breakdown, ticket: pdfPending.ticket, location: pdfPending.location,
      };
      if (pdfPending.address) { patch.address = pdfPending.address; patch.buildings = pdfPending.address; }
      let { error } = await sb().from("releases").update(patch).eq("id", prior.id);
      if (error && /column|schema cache/i.test(error.message)) {
        ({ error } = await sb().from("releases").update(stripNew(patch)).eq("id", prior.id));
        if (!error) flash("Saved — run supabase/RUN_ME.sql so labor hours & address save too");
      }
      if (error) { flash(error.message); setBusy(false); return; }
      relId = prior.id;
      await sb().from("release_items").delete().eq("release_id", relId);
    } else {
      const payload: Record<string, unknown> = {
        contract_id: contract.id, rel_number: pdfPending.rel, location: pdfPending.location,
        buildings: pdfPending.address, address: pdfPending.address, ticket: pdfPending.ticket,
        amount: pdfPending.amount, labor_hours: pdfPending.hours, labor_breakdown: pdfPending.breakdown,
        date_completed: "", pre_check: "", payroll_done: false, received: false, canceled: false, assigned_to: null,
      };
      let { data: rel, error } = await sb().from("releases").insert(payload).select().single();
      if (error && /column|schema cache/i.test(error.message)) {
        ({ data: rel, error } = await sb().from("releases").insert(stripNew(payload)).select().single());
        if (!error) flash("Saved — run supabase/RUN_ME.sql so labor hours & address save too");
      }
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

  const exportSheet = async () => {
    try { await ensureXLSX(); } catch { flash("Couldn't load the Excel engine \u2014 check your signal and try again"); return; }
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
          {!readOnly && <button className="btn btn-ghost" onClick={() => pdfRef.current?.click()}>+ From PDF(s)</button>}
          {!readOnly && <button className="btn btn-ghost" onClick={() => folderRef.current?.click()}>📁 Attach folder</button>}
          {!readOnly && contracts.length > 0 && <button className="btn btn-ghost" onClick={fixDuplicatesEverywhere} disabled={busy}>🧹 Fix all duplicates</button>}
          {!readOnly && <button className="btn btn-ghost" onClick={() => fileRef.current?.click()}>Upload sheet</button>}
          {rows.length > 0 && <button className="btn btn-ghost" onClick={exportSheet}>Download</button>}
        </div>
      </div>
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFile} />
      <input ref={pdfRef} type="file" accept="application/pdf" multiple className="hidden" onChange={handlePdf} />
      {/* folder picker — webkitdirectory isn't in React's types, hence the cast */}
      <input ref={folderRef} type="file" multiple className="hidden" onChange={handleFolder}
        {...({ webkitdirectory: "", directory: "" } as unknown as Record<string, string>)} />
      <input ref={propRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleProposal} />

      {!folderPlan && folderProgress && (
        <div className="card mb-4 border-work p-4 text-sm">
          <b>{folderProgress}</b>
          <div className="text-[12px] text-inksoft">Working — leave this tab open until it finishes.</div>
        </div>
      )}

      {/* folder review — nothing uploads until this is confirmed */}
      {folderPlan && (() => {
        const matched = folderPlan.rows.filter((r) => r.relId).length;
        const creating = folderPlan.rows.filter((r) => !r.relId && r.willCreate).length;
        const skippedRecv = folderPlan.rows.filter((r) => r.skipped).length;
        const unmatched = folderPlan.rows.length - matched - creating - skippedRecv;
        // pick from every release the scan matched against — which may span contracts
        const planRelsList = folderPlan.rels.length > 0 ? folderPlan.rels : rows;
        const cNumOf = (r: Release) => folderPlan.contracts.find((c) => c.id === r.contract_id)?.number || "";
        const manyContracts = new Set(planRelsList.map((r) => r.contract_id)).size > 1;
        const relOptions = [...planRelsList].sort(
          (a, b) => String(cNumOf(a)).localeCompare(String(cNumOf(b)), undefined, { numeric: true })
            || String(a.rel_number).localeCompare(String(b.rel_number), undefined, { numeric: true })
        );
        const relById = new Map(planRelsList.map((r) => [r.id, r]));
        const setRow = (i: number, value: string) =>
          setFolderPlan((prev) => prev && ({
            ...prev,
            rows: prev.rows.map((r, k) => {
              if (k !== i) return r;
              if (value === "__new__" && r.newRel) return { ...r, relId: null, willCreate: true, why: `new release #${r.newRel.rel} — will be created` };
              if (!value) return { ...r, relId: null, willCreate: false, why: "skipped" };
              return { ...r, relId: value, willCreate: false, why: "picked by hand" };
            }),
          }));
        return (
          <div className="card mb-4 border-work p-4">
            <div className="mb-1 font-display text-base font-semibold uppercase">
              Attach folder{folderPlan.folder ? ` “${folderPlan.folder}”` : ""}
            </div>
            <div className="mb-3 text-[13px] text-inksoft">
              <b className="text-ok">{matched} matched</b>
              {creating > 0 && <> · <b className="text-work">{creating} new release{creating === 1 ? "" : "s"} to create</b></>}
              {skippedRecv > 0 && <> · {skippedRecv} for received releases — left alone</>}
              {unmatched > 0 && <> · <b className="text-alert">{unmatched} need a release</b> (leave blank to skip)</>}
              {" — nothing uploads until you press Attach."}
              <div className="mt-1 text-[12px]">
                Read {folderPlan.rows.length + (folderPlan.notRelease || 0)} PDF{folderPlan.rows.length === 1 ? "" : "s"} in this folder
                {(folderPlan.notRelease || 0) > 0 && <> · {folderPlan.notRelease} weren&apos;t release PDFs (left alone)</>}
                {(folderPlan.notPdf || 0) > 0 && <> · {folderPlan.notPdf} non-PDF file{folderPlan.notPdf === 1 ? "" : "s"} skipped</>}
                {(folderPlan.otherContract || 0) > 0 && <> · {folderPlan.otherContract} bring in a contract that isn&apos;t in the app yet (it&apos;ll be created too)</>}
                {manyContracts && <> · files are matched to their own contract, whichever one is open</>}
                {folderPlan.capped > 0 && <> · {folderPlan.capped} past the {MAX_FOLDER_FILES}-file limit — run it again for the rest</>}
              </div>
            </div>
            {(() => {
              // rows needing a decision come first and get a picker; matched rows stay
              // compact (a dropdown on every one of a thousand rows would lock up the page).
              // Both groups run in release order — #1, #2 … #10000 — not folder order.
              const numOf = ({ r }: { r: PlanRow }) => {
                const n = r.relId ? relById.get(r.relId)?.rel_number : (r.relNum || r.newRel?.rel);
                const v = parseFloat(String(n ?? "").replace(/[^\d.]/g, ""));
                return Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER; // no number → last
              };
              const inRelOrder = (a: { r: PlanRow }, b: typeof a) =>
                numOf(a) - numOf(b) || a.r.name.localeCompare(b.r.name, undefined, { numeric: true });
              const idx = folderPlan.rows.map((r, i) => ({ r, i }));
              const needs = idx.filter(({ r }) => !r.relId && !r.willCreate && !r.skipped).sort(inRelOrder);
              const ok = idx.filter(({ r }) => r.relId || r.willCreate).sort(inRelOrder);
              const SHOWN = 300;
              const picker = (i: number, row: PlanRow) => (
                <select className="field w-60 px-2 py-1.5 text-[13px]"
                  value={row.relId || (row.willCreate ? "__new__" : "")}
                  onChange={(e) => { setRow(i, e.target.value); setFolderEdit((p) => { const n = new Set(p); n.delete(i); return n; }); }}>
                  {row.newRel && <option value="__new__">➕ Make release #{row.newRel.rel} (from this PDF)</option>}
                  <option value="">— skip this file —</option>
                  {relOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {manyContracts ? `${cNumOf(o)} · ` : ""}#{o.rel_number} — {o.location || "no location"}
                    </option>
                  ))}
                </select>
              );
              return (
                <div className="max-h-80 overflow-y-auto rounded-sm border border-rulesoft">
                  {needs.length > 0 && (
                    <div className="sticky top-0 z-10 border-b border-rulesoft bg-alert/10 px-2 py-1 text-[11px] font-semibold uppercase tracking-widest text-alert">
                      Need a release — {needs.length}
                    </div>
                  )}
                  {needs.slice(0, SHOWN).map(({ r, i }) => (
                    <div key={`n${i}`} className="flex flex-wrap items-center gap-2 border-b border-rulesoft bg-alert/5 p-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px]">
                          {r.relNum && <><b className="font-mono">#{r.relNum}</b> <span className="text-inksoft">·</span> </>}
                          {r.name}
                        </div>
                        <div className="truncate text-[11px] text-inksoft">{r.why}</div>
                      </div>
                      {folderEdit.has(i)
                        ? picker(i, r)
                        : <button className="btn px-2.5 py-1 text-[12px]" onClick={() => setFolderEdit((prev) => new Set(prev).add(i))}>pick release</button>}
                    </div>
                  ))}
                  {needs.length > SHOWN && (
                    <div className="border-b border-rulesoft p-2 text-[12px] text-inksoft">…and {needs.length - SHOWN} more needing a release — sort these out, attach, then run the folder again.</div>
                  )}
                  {ok.length > 0 && (
                    <div className="sticky top-0 z-10 border-b border-rulesoft bg-paper px-2 py-1 text-[11px] font-semibold uppercase tracking-widest text-inksoft">
                      In release order — {ok.length}
                    </div>
                  )}
                  {ok.slice(0, SHOWN).map(({ r, i }) => {
                    const relNo = r.relId ? relById.get(r.relId)?.rel_number : r.newRel?.rel;
                    return (
                    <div key={`m${i}`} className="flex flex-wrap items-center gap-2 border-b border-rulesoft p-2 last:border-b-0">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px]">
                          <b className="font-mono">#{relNo ?? "?"}</b>
                          {!r.relId && r.willCreate && <span className="ml-1 rounded-[2px] border border-work px-1 py-px font-mono text-[9px] font-semibold text-work">NEW</span>}
                          <span className="text-inksoft"> · </span>{r.name}
                        </div>
                        <div className="truncate text-[11px] text-inksoft">{r.why}</div>
                      </div>
                      {folderEdit.has(i)
                        ? picker(i, r)
                        : (
                          <button className="text-[11px] text-inksoft underline"
                            onClick={() => setFolderEdit((p) => new Set(p).add(i))}>change</button>
                        )}
                    </div>
                    );
                  })}
                  {ok.length > SHOWN && (
                    <div className="p-2 text-[12px] text-inksoft">…and {ok.length - SHOWN} more matched files — all of them will be attached.</div>
                  )}
                </div>
              );
            })()}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button className="btn btn-primary" disabled={busy || matched + creating === 0} onClick={runFolderAttach}>
                {busy
                  ? folderProgress || "Attaching…"
                  : `Attach ${matched + creating} file${matched + creating === 1 ? "" : "s"}${creating > 0 ? ` · make ${creating} release${creating === 1 ? "" : "s"}` : ""}`}
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => { setFolderPlan(null); setFolderEdit(new Set()); }}>Cancel</button>
              {unmatched > 0 && !busy && (
                <span className="text-[11px] text-inksoft">Files left blank are skipped — nothing is deleted either way.</span>
              )}
            </div>
          </div>
        );
      })()}

      {pending && (
        <div className="card mb-4 border-work p-4">
          <div className="mb-2 font-display text-base font-semibold uppercase">Import {pending.items.length} releases</div>
          <label className="text-[11px] uppercase tracking-widest text-inksoft">Contract number</label>
          <input className="field mb-2 mt-1" value={pending.guess} onChange={(e) => setPending({ ...pending, guess: e.target.value })} />
          <div className="mb-3 font-mono text-xs text-inksoft">
            Total {fmt(pending.items.reduce((s, i) => s + i.amount, 0))} · canceled flagged: {pending.items.filter((i) => i.canceled).length}
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={() => runImport("replace")} disabled={busy}>Load</button>
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
                {k === "amount" || k === "hours" ? (
                  <input className="field" inputMode="decimal"
                    {...numBuf(`pdf:${k}`, Number(pdfPending[k]) || 0,
                      (n) => setPdfPending((prev) => (prev ? { ...prev, [k]: n } : prev)))} />
                ) : (
                  <input className="field"
                    placeholder={k === "address" ? "e.g. Stairhall 15, Apt 526" : ""}
                    value={String(pdfPending[k])}
                    onChange={(e) => setPdfPending({ ...pdfPending, [k]: e.target.value })} />
                )}
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

      {(contracts.length > 1 || (active && !readOnly)) && (
        <div className="mb-3 flex items-center gap-2">
          {contracts.length > 1 && (
            <div className="min-w-0 flex-1"><ContractPicker contracts={contracts} value={active} onChange={(id) => { setActive(id); setLimit(100); }} /></div>
          )}
          {active && !readOnly && (
            <button className="btn btn-ghost whitespace-nowrap" title="Give this contract a name you'll recognize"
              onClick={async () => {
                const c = contracts.find((x) => x.id === active);
                if (!c) return;
                const name = window.prompt(`Name for contract ${c.number}:`, c.name && c.name !== c.number ? c.name : "");
                if (name === null) return;
                const clean = name.trim() || c.number;
                const { error } = await sb().from("contracts").update({ name: clean }).eq("id", c.id);
                if (error) { flash(error.message); return; }
                setContracts((prev) => prev.map((x) => (x.id === c.id ? { ...x, name: clean } : x)));
                flash("Contract name saved");
              }}>✎ Name</button>
          )}
        </div>
      )}
      {/* which contract is this really? the developments in it say so — handy when a
          contract's name doesn't match the work that's actually in it */}
      {active && rows.length > 0 && (() => {
        const c = contracts.find((x) => x.id === active);
        const devs = [...new Set(rows.map((r) => (r.location || "").trim()).filter(Boolean))];
        const twinCount = c ? contracts.filter((x) => contractKey(x.number) === contractKey(c.number)).length : 1;
        const numCounts = new Map<string, number>();
        rows.forEach((r) => {
          const k = String(r.rel_number || "").trim().replace(/^0+(?=\d)/, "");
          if (k) numCounts.set(k, (numCounts.get(k) || 0) + 1);
        });
        const dupNums = [...numCounts.values()].filter((n) => n > 1).length;
        const hasDupes = twinCount > 1 || dupNums > 0;
        return (
          <div className="mb-3 -mt-1 flex flex-wrap items-center gap-2 text-[11px] text-inksoft">
            <span>
              Contract <b className="font-mono">{c?.number}</b> · {rows.length} release{rows.length === 1 ? "" : "s"}
              {devs.length > 0 && <> · {devs.slice(0, 4).join(", ")}{devs.length > 4 ? `, +${devs.length - 4} more` : ""}</>}
            </span>
            {hasDupes && !readOnly && (
              <button className="btn btn-ghost px-2.5 py-1 text-[11px] text-alert" onClick={fixDuplicates} disabled={busy}>
                🧹 Fix duplicates{dupNums > 0 ? ` (${dupNums} release #s doubled)` : twinCount > 1 ? " (contract listed twice)" : ""}
              </button>
            )}
          </div>
        );
      })()}

      {rows.length > 0 && (() => {
        const rec = live.filter((r) => r.received).reduce((s, r) => s + Number(r.amount), 0);
        const outst = live.filter((r) => !r.received).reduce((s, r) => s + Number(r.amount), 0);
        const pct = tot > 0 ? Math.round((rec / tot) * 100) : 0;
        return (
          <div className="card mb-3 p-3">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-[13px]">
              {([["Released", fmt(tot), "text-ink"], [`Received ${pct}%`, fmt(rec), "text-ok"], ["Waiting", fmt(outst), "text-work"], ["Chase", fmt(notR.reduce((s, r) => s + Number(r.amount), 0)), "text-work"], ["Payroll left", fmt(prPend.reduce((s, r) => s + Number(r.amount), 0)), "text-alert"]] as [string, string, string][]).map(([l, v, cls]) => (
                <span key={l} className={cls}><span className="mr-1 text-[10px] uppercase tracking-[.12em] text-inksoft">{l}</span><b>{v}</b></span>
              ))}
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-sm bg-rulesoft">
              <div className="h-full bg-ok transition-all duration-300" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })()}

      <div className="mb-3 flex flex-wrap gap-2">
        {([["all", "Open"], ["chase", `Chase (${notR.length})`], ["payroll", `Payroll (${prPend.length})`], ["received", `Received (${receivedRows.length})`], ["canceled", `Canceled (${canceledRows.length})`], ["hours", "Hours"]] as [Filter, string][]).map(([f, l]) => (
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
              {hoursList.slice(0, limit).map((r) => {
                const got = logged?.[r.id] || 0;
                const need = Number(r.labor_hours) || 0;
                return (
                  <tr key={r.id} className="border-b border-rulesoft">
                    <td className="p-2.5 font-mono text-xs">{r.rel_number}</td>
                    <td className="p-2.5">{r.location}<div className="max-w-[220px] truncate text-[11px] text-inksoft">{r.buildings}</div>{(r.labor_breakdown || []).length > 0 && <div className="max-w-[220px] truncate text-[11px] text-inksoft">{(r.labor_breakdown || []).map((b) => `${b.cls} ${b.hours}h`).join(" · ")}</div>}</td>
                    <td className="p-2.5 text-right">
                      <input className="w-20 rounded-sm border border-rulesoft p-1.5 text-right font-mono" inputMode="decimal" defaultValue={need || ""} placeholder="0" readOnly={readOnly}
                        onBlur={(e) => !readOnly && toggle(r, { labor_hours: parseNum(e.target.value) })} />
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
                    const got = logged?.[r.id] || 0;
                    const need = Number(r.labor_hours) || 0;
                    return (
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {stages.map(([l, done], i) => (
                          <span key={l} title={l} className={`rounded-[2px] border px-1 py-px font-mono text-[9px] font-semibold tracking-wide ${
                            done ? "border-ok bg-ok/10 text-ok" : i === current ? "border-work text-work" : "border-rulesoft text-rule"
                          }`}>{l}</span>
                        ))}
                        {(need > 0 || got > 0) && (
                          <span className={`ml-1 font-mono text-[10px] ${need > 0 && got >= need ? "text-ok" : "text-work"}`}
                            title="Payroll hours logged vs the release minimum — live from the Payroll tab">
                            ⏱ {got}{need > 0 ? `/${need}` : ""}h{need > 0 && got >= need ? " ✓" : ""}
                          </span>
                        )}
                        {relCounts[String(r.rel_number).trim()] > 1 && (
                          <span className="ml-1 rounded-[2px] border border-alert px-1 py-px font-mono text-[9px] font-semibold text-alert" title="This release number appears more than once on this contract — cancel or delete the extra copy">DUPLICATE</span>
                        )}
                      </div>
                    );
                  })()}
                </td>
                <td className={`p-2.5 text-right font-mono ${r.canceled ? "line-through" : ""}`}>{fmt(Number(r.amount))}</td>
                <td className="p-2.5 text-center">
                  {!r.canceled && (readOnly ? <Stamp label={r.payroll_done ? "DONE" : "TO DO"} tone={r.payroll_done ? "ok" : "alert"} /> :
                    <button onClick={() => togglePayroll(r)}><Stamp label={r.payroll_done ? "DONE" : "TO DO"} tone={r.payroll_done ? "ok" : "alert"} /></button>)}
                </td>
                <td className="p-2.5 text-center">
                  {r.canceled ? <Stamp label="CANCELED" tone="mute" /> : readOnly ? <Stamp label={r.received ? "YES" : "NO"} tone={r.received ? "ok" : "work"} /> :
                    <button onClick={() => {
                      if (r.received && !window.confirm(`Release ${r.rel_number} is marked received${r.paid_date ? ` (paid ${prettyDate(r.paid_date)})` : ""} — switch it back to NOT received? The paid date is cleared.`)) return;
                      toggle(r, { received: !r.received, paid_date: !r.received ? localISO() : null });
                    }}><Stamp label={r.received ? "YES" : "NO"} tone={r.received ? "ok" : "work"} /></button>}
                </td>
                <td className="p-2.5">
                  <div className="flex items-center justify-end gap-2 whitespace-nowrap">
                    {!r.canceled && !readOnly && <button className="font-mono text-xs font-semibold text-inksoft underline" title="Edit this release's line items" onClick={() => openItems(r)}>Items</button>}
                    {!r.canceled && sosReady.has(r.id) && <button className="font-mono text-xs font-semibold text-work underline" title="Make the NYCHA invoice" onClick={() => genInvoice(r)}>Invoice</button>}
                    {!r.canceled && sosReady.has(r.id) && <button className="font-mono text-xs font-semibold text-carbon underline" title="Make the Statement of Services form" onClick={() => genSOS(r)}>SOS form</button>}
                    <button className="text-inksoft" title="Documents" onClick={() => setAttachRel(r)}>📎{(r.attachments || []).length > 0 ? <span className="font-mono text-[10px]">{(r.attachments || []).length}</span> : null}</button>
                    {!readOnly && <button className={r.canceled ? "text-ok" : "text-alert"} title={r.canceled ? "Restore" : "Mark canceled"} onClick={() => toggle(r, { canceled: !r.canceled })}>{r.canceled ? "↺" : "✕"}</button>}
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
      {filter === "hours" && hoursList.length > limit && (
        <div className="mt-3 text-center"><button className="btn btn-ghost" onClick={() => setLimit(limit + 200)}>Show more ({hoursList.length - limit} left)</button></div>
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
                    {!readOnly && <button className="absolute right-1 top-1 rounded-sm bg-ink/70 px-1.5 text-xs text-paper" title="Delete photo" onClick={() => removeAttachment(attachRel, a.path)}>✕</button>}
                  </div>
                ))}
              </div>
            )}
            {(attachRel.attachments || []).filter((a) => !isImg(a.name)).map((a) => (
              <div key={a.path} className="mb-1.5 flex items-center gap-1">
                <button className="block w-full rounded-sm border border-rulesoft p-2.5 text-left text-sm hover:border-work" onClick={() => openAttachment(a.path)}>
                  📄 {a.name}
                </button>
                {!readOnly && <button className="shrink-0 px-1 text-xs text-alert" title="Delete file" onClick={() => removeAttachment(attachRel, a.path)}>✕</button>}
              </div>
            ))}
            <div className="mt-3 flex flex-wrap gap-2">
              {!readOnly && <button className="btn btn-primary" onClick={() => photoInputRef.current?.click()} disabled={busy}>📷 Take photo</button>}
              {!readOnly && <button className="btn" onClick={() => attachInputRef.current?.click()} disabled={busy}>Upload file</button>}
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
          onExcel={() => { const fname = askFileName(`invoice_${invPreview.cNumber}_rel${invPreview.relNum}.xlsx`); if (fname) buildInvoiceXlsx({ org, cNumber: invPreview.cNumber, relNum: invPreview.relNum, workOrder: invPreview.workOrder, dev: invPreview.dev, number: invPreview.number, date: invPreview.date, rows: invPreview.rows, filename: fname }); }}
          close={() => setInvPreview(null)} />
      )}

      {sosView && (
        <PrintShell>
        <div className="fixed inset-0 z-50 overflow-y-auto bg-ink/50 px-2 py-5">
          <div className="printable mx-auto max-w-4xl rounded-sm border-t-4 border-ink bg-white p-8 text-ink">
            <div className="border-2 border-ink bg-paper p-2 text-center font-display text-xl font-bold uppercase">NYCHA Statement of Service</div>
            <div className="my-4 grid grid-cols-2 gap-x-8 gap-y-1.5 border border-rulesoft p-3 text-[13px]">
              {([["Vendor", (org?.company || "").toUpperCase()], ["Date", prettyDate(localISO())],
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
        </PrintShell>
      )}

      {itemsRel && (() => {
        const COLS = "56px 96px minmax(170px,1fr) 60px 72px 88px 88px 22px";
        const setIt = (i: number, patch: Partial<RelItemRow>) =>
          setRelItems((prev) => (prev ? prev.map((x, j) => (j === i ? { ...x, ...patch } : x)) : prev));
        return (
          <div className="fixed inset-0 z-50 overflow-y-auto bg-ink/50 px-2 py-6">
            <div className="card mx-auto max-w-4xl border-work bg-card p-4">
              <div className="mb-1 font-display text-lg font-bold uppercase">Line items · Release #{itemsRel.rel_number}</div>
              <div className="mb-3 text-[13px] text-inksoft">
                {itemsRel.location} — these lines feed the SOS form and the invoice.
                {stageData.walks.has(String(itemsRel.rel_number).trim()) ? " Note: a walk sheet is linked to this release number, and walk-sheet quantities win on documents." : ""}
              </div>
              {relItems === null ? <div className="p-4 text-sm text-inksoft">Loading…</div> : (
                <>
                  <div className="overflow-x-auto">
                    <div className="min-w-[680px]">
                      <div className="mb-1 grid gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-inksoft" style={{ gridTemplateColumns: COLS }}>
                        <span>Line</span><span>Item code</span><span>Description of work</span><span>UOM</span>
                        <span className="text-right">Qty</span><span className="text-right">Price</span><span className="text-right">Total</span><span />
                      </div>
                      {relItems.map((it, i) => (
                        <div key={i} className="mb-1.5 grid items-center gap-1.5" style={{ gridTemplateColumns: COLS }}>
                          <input className="field px-1.5 py-1.5 text-right font-mono" inputMode="numeric" value={it.line || ""}
                            onChange={(e) => setIt(i, { line: parseNum(e.target.value) })} />
                          <input className="field px-1.5 py-1.5 font-mono" value={it.code}
                            onChange={(e) => setIt(i, { code: e.target.value })} />
                          <input className="field" placeholder="What the line is for" value={it.description}
                            onChange={(e) => setIt(i, { description: e.target.value })} />
                          <input className="field px-1 py-1.5 text-center font-mono" value={it.uom}
                            onChange={(e) => setIt(i, { uom: e.target.value })} />
                          <input className="field px-1.5 py-1.5 text-right font-mono" inputMode="decimal"
                            {...numBuf(`ri:${i}:q`, it.qty, (n) => setIt(i, { qty: n }))} />
                          <input className="field px-1.5 py-1.5 text-right font-mono" inputMode="decimal"
                            {...numBuf(`ri:${i}:p`, it.unit_price, (n) => setIt(i, { unit_price: n }))} />
                          <span className="text-right font-mono text-[12px]">{fmt(it.qty * it.unit_price)}</span>
                          <button className="text-alert" title="Remove line" onClick={() => setRelItems((prev) => (prev ? prev.filter((_, j) => j !== i) : prev))}>✕</button>
                        </div>
                      ))}
                      {relItems.length === 0 && <div className="p-3 text-sm text-inksoft">No line items yet — add them below and the SOS/Invoice buttons light up for this release.</div>}
                    </div>
                  </div>
                  <button className="btn btn-ghost mt-1 px-3 py-1.5 text-[13px]"
                    onClick={() => setRelItems((prev) => [...(prev || []), { line: (prev || []).reduce((m, x) => Math.max(m, x.line), 0) + 1, code: "", description: "", qty: 1, uom: "EA", unit_price: 0 }])}>+ Add line</button>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-sm font-semibold">Total {fmt(relItems.reduce((s, it) => s + it.qty * it.unit_price, 0))}</span>
                    <div className="flex gap-2">
                      <button className="btn btn-primary" onClick={saveItems} disabled={busy}>Save & close</button>
                      <button className="btn btn-ghost" onClick={() => { setItemsRel(null); setRelItems(null); }}>Cancel</button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {msg && <div className="fixed bottom-5 left-1/2 z-[60] -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
