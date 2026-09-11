"use client";
import { useEffect, useMemo, useRef, useState } from "react";
// styled fork of SheetJS — same API, plus cell borders/fonts for the export
// the export engine is heavy — it loads on demand, never with the page itself
let XLSX!: typeof import("xlsx-js-style");
const ensureXLSX = async () => { XLSX = XLSX || (await import("xlsx-js-style")); };
import { sb } from "@/lib/supabase";
import { fmt, parseNum, askFileName } from "@/lib/format";
import Stamp from "@/components/Stamp";
import { LineItem, Org, nextNumber, grandTotal, localISO } from "@/lib/docs";
import type { Contract } from "@/lib/types";
import ContractPicker, { contractLabel } from "@/components/ContractPicker";
import { DEFAULT_CAP, sheetTotal, splitToCap, type SheetLine } from "@/lib/surveyTemplate";
import type { SmartSurvey } from "@/lib/smartSurvey";
import { useLive } from "@/lib/useLive";
import PrintShell from "@/components/PrintShell";
import Letterhead from "@/components/Letterhead";
import ActionMenu, { RowActions } from "@/components/ActionMenu";
import Disclosure from "@/components/Disclosure";

interface Proposal {
  id: string; number: string; client_name: string; job: string; date: string; tax_pct: number; status: string; notes: string;
  contract_id?: string | null; development?: string; address?: string; apt?: string; stairhall?: string;
  walk_date?: string; release_number?: string; nycha_staff?: string; vendor_staff?: string;
  start_date?: string; finish_date?: string; total?: number; qty_map?: Record<string, number> | null;
}
interface ContractItem { id: string; line: number; code: string; category: string; description: string; uom: string; unit_price: number; }
type NychaLineItem = LineItem & { category?: string; line?: number };

const tone = (s: string) => (s === "approved" ? "work" : s === "sent" ? "carbon" : s === "invoiced" ? "mute" : s === "declined" ? "alert" : "mute");
// how a sheet is named everywhere: the location, then what the work is for
const sheetName = (p: { development?: string; address?: string; job?: string; number?: string }) =>
  [p.development || p.address, p.job].filter(Boolean).join(" — ") || p.number || "proposal";
const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|]/g, "-").slice(0, 120);
const HEAD_FIELDS = [
  ["development", "Development"], ["address", "Address"], ["apt", "Apt"], ["stairhall", "Stairhall"],
  ["nycha_staff", "NYCHA staff"], ["vendor_staff", "Vendor staff"], ["walk_date", "Walk date"],
  ["release_number", "Release #"], ["start_date", "Start date"], ["finish_date", "Finish date"],
] as const;

export default function Proposals() {
  const [list, setList] = useState<Proposal[]>([]);
  const [doc, setDoc] = useState<Proposal | null>(null);
  const [items, setItems] = useState<NychaLineItem[]>([]); // legacy (non-contract) proposals only
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [catalog, setCatalog] = useState<ContractItem[] | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [org, setOrg] = useState<Org | null>(null);
  const [search, setSearch] = useState("");
  const [printOpen, setPrintOpen] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const [pickId, setPickId] = useState("");
  const [relAsk, setRelAsk] = useState<{ p: Proposal; value: string } | null>(null);
  const [listQ, setListQ] = useState("");
  const [listFilter, setListFilter] = useState<"all" | "draft" | "approved">("all");
  // the contract whose walk sheets are on screen — one at a time, so two
  // contracts' sheets never sit in one long list. "" until the lists are in.
  const [listContract, setListContract] = useState("");
  const [listLoaded, setListLoaded] = useState(false);
  // the survey PDF: one tap, the sheet builds itself from the contract's lines
  const surveyRef = useRef<HTMLInputElement>(null);
  const [surveyBusy, setSurveyBusy] = useState(false);
  const CONTRACT_KEY = "proposals.contract";
  const [saveState, setSaveState] = useState<"" | "saving" | "saved">("");
  const [showHead, setShowHead] = useState(false); // walk-sheet header fields tucked away until needed
  const [msg, setMsg] = useState("");
  const sheetRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 3000); };
  const upgradeHint = (m: string) => (/column|schema|relation|qty_map/i.test(m) ? "Database needs the upgrade — run supabase/upgrade_proposal_creator.sql" : m);

  const load = async () => {
    // the list never shows quantities — leaving qty_map out cuts the payload
    // by far the most; opening a sheet fetches its full row on demand
    const { data, error } = await sb().from("proposals")
      .select("id,number,client_name,job,date,tax_pct,status,notes,contract_id,development,address,apt,stairhall,walk_date,release_number,nycha_staff,vendor_staff,start_date,finish_date,total,created_at")
      .order("created_at", { ascending: false });
    if (error) { // older database without some columns — fall back to full rows
      const { data: d2 } = await sb().from("proposals").select("*").order("created_at", { ascending: false });
      setList((d2 || []) as Proposal[]);
      setListLoaded(true);
      return;
    }
    setList((data || []) as Proposal[]);
    setListLoaded(true);
  };
  useEffect(() => {
    load();
    sb().from("org").select("*").single().then(({ data }) => data && setOrg(data as Org));
    sb().from("contracts").select("id,number,name").order("number").then(({ data }) => {
      const cs = (data || []) as Contract[];
      setContracts(cs); if (cs[0]) setPickId(cs[0].id);
    });
  }, []);
  // which contract opens first: the one picked last time, else the one the
  // newest walk sheet is on, else the first contract
  useEffect(() => {
    // both lists must be in — the newest sheet can't be found before the sheets are
    if (listContract || contracts.length === 0 || !listLoaded) return;
    let saved = "";
    try { saved = localStorage.getItem(CONTRACT_KEY) || ""; } catch { /* private mode */ }
    const strays = list.some((p) => !p.contract_id || !contracts.some((c) => c.id === p.contract_id));
    const valid = (id: string) => id === "all" || (id === "none" && strays) || contracts.some((c) => c.id === id);
    const newest = list.find((p) => p.contract_id && contracts.some((c) => c.id === p.contract_id))?.contract_id || "";
    const first = valid(saved) ? saved : newest || contracts[0].id;
    setListContract(first);
    if (contracts.some((c) => c.id === first)) setPickId(first); // a new walk sheet starts on the contract on screen
  }, [contracts, list, listLoaded]); // eslint-disable-line react-hooks/exhaustive-deps
  const pickListContract = (id: string) => {
    setListContract(id);
    if (contracts.some((c) => c.id === id)) setPickId(id);
    try { localStorage.setItem(CONTRACT_KEY, id); } catch { /* private mode */ }
  };

  // live: walk sheets, contracts and price books refresh without a reload
  useLive(["proposals", "contracts", "contract_items"], () => {
    load();
    sb().from("contracts").select("id,number,name").order("number").then(({ data }) => setContracts((data || []) as Contract[]));
    if (doc?.contract_id) {
      sb().from("contract_items").select("*").eq("contract_id", doc.contract_id).order("line")
        .then(({ data }) => setCatalog((data || []) as ContractItem[]));
    }
  }, { skipWhileTyping: true });

  // load the contract's catalog whenever the open walk sheet's contract changes
  useEffect(() => {
    if (!doc?.contract_id) { setCatalog(null); return; }
    sb().from("contract_items").select("*").eq("contract_id", doc.contract_id).order("line")
      .then(({ data }) => setCatalog((data || []) as ContractItem[]));
  }, [doc?.contract_id]);

  // ---------- open / create ----------
  const openDocId = useRef<string | null>(null); // guards the async fallback fetch below
  const openEditor = async (p: Proposal) => {
    openDocId.current = p.id;
    setDoc(p); setSearch(""); setCollapsed(new Set());
    setQty({}); // never show the previous sheet's quantities while this one loads
    qtyDirty.current = false;
    // the list rows travel without qty_map — the full sheet loads here
    if (p.qty_map === undefined) {
      const { data: full } = await sb().from("proposals").select("*").eq("id", p.id).single();
      if (openDocId.current !== p.id) return;
      if (full) { p = full as Proposal; setDoc(p); }
    }
    const m: Record<string, string> = {};
    Object.entries(p.qty_map || {}).forEach(([k, v]) => { if (Number(v) > 0) m[k] = String(v); });
    // fall back to line items ONLY for drafts saved before qty_map existed —
    // an empty {} map means the user cleared the sheet, and the old rows
    // resurrecting their quantities would undo that on every reopen
    if (Object.keys(m).length === 0 && p.qty_map == null) {
      const { data } = await sb().from("proposal_items").select("*").eq("proposal_id", p.id).order("sort");
      if (openDocId.current !== p.id) return; // user already opened a different sheet
      ((data || []) as NychaLineItem[]).forEach((it) => { if (Number(it.qty) > 0 && it.code) m[it.code] = String(it.qty); });
      if (!p.contract_id) setItems((data || []) as NychaLineItem[]);
    }
    if (openDocId.current === p.id) setQty(m);
  };
  const newWalkSheet = async () => {
    if (contracts.length === 0) { flash("No contracts yet — upload a release sheet or release PDF first"); return; }
    if (contracts.length > 1 && !pickOpen) { setPickOpen(true); return; }
    setPickOpen(false);
    const number = await nextNumber("proposals", "PROP");
    const { data, error } = await sb().from("proposals").insert({
      number, client_name: "New York City Housing Authority", contract_id: pickId || contracts[0].id,
    }).select().single();
    if (error) { flash(upgradeHint(error.message)); return; }
    // the list follows the new sheet's contract, so it is on screen when the editor closes
    const made = data as Proposal;
    if (made.contract_id && listContract !== "all" && listContract !== made.contract_id) pickListContract(made.contract_id);
    await load(); openEditor(made);
  };

  // ---------- the survey PDF ----------
  // The foreman's survey, as a PDF (a Notes export, a photo made into a PDF,
  // a scan). The server reads it beside the contract's price book — Claude
  // when it's switched on, the rules otherwise — and every written item comes
  // back as the book's own lines. Over the cap a super will sign, the rest
  // goes on a second sheet. The sheet then opens like any other, for a check.
  const surveyContract = () => (contracts.some((c) => c.id === listContract) ? listContract : contracts.length === 1 ? contracts[0].id : "");
  // the blank form — the same PDF every time, so the reader knows every box
  const downloadSurveyForm = async () => {
    try {
      const { buildSurveyFormPdf, SURVEY_FORM_NAME } = await import("@/lib/surveyForm");
      const logo = await fetch("/logo.png").then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? new Uint8Array(b) : undefined)).catch(() => undefined);
      const bytes = await buildSurveyFormPdf(logo);
      const ab = new ArrayBuffer(bytes.byteLength); new Uint8Array(ab).set(bytes);
      const url = URL.createObjectURL(new Blob([ab], { type: "application/pdf" }));
      const a = document.createElement("a"); a.href = url; a.download = SURVEY_FORM_NAME; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      flash("Blank survey saved — fill the boxes on site, then upload it here");
    } catch (err) { flash(`Couldn't build the form (${err instanceof Error ? err.message.slice(0, 60) : "unknown"})`); }
  };
  const uploadSurvey = () => {
    if (contracts.length === 0) { flash("No contracts yet — upload a release sheet or release PDF first"); return; }
    if (!surveyContract()) { flash("Pick a contract in the dropdown first — the survey bills that contract's lines"); return; }
    surveyRef.current?.click();
  };
  type SurveySheet = { job: string; lines: SheetLine[]; total: number };
  const handleSurveyPdf = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    const cid = surveyContract();
    if (!file || !cid) return;
    setSurveyBusy(true);
    try {
      const { data: cat, error } = await sb().from("contract_items").select("*").eq("contract_id", cid).order("line");
      if (error) { flash(upgradeHint(error.message)); return; }
      const catalog = (cat || []) as ContractItem[];
      if (catalog.length === 0) { flash("No price book for this contract yet — Price Book tab, upload the contract's sheet once"); return; }
      const form = new FormData();
      form.append("file", file);
      form.append("catalog", JSON.stringify(catalog.map((c) => ({ code: c.code, line: c.line, category: c.category, description: c.description, uom: c.uom, unit_price: c.unit_price }))));
      const token = (await sb().auth.getSession()).data.session?.access_token || "";
      const res = await fetch("/api/parse-survey", { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; survey?: SmartSurvey; readBy?: "claude" | "rules"; note?: string };
      if (!res.ok || !out.ok || !out.survey) { flash(out.error || `The survey couldn't be read (server said ${res.status})`); return; }
      const sv = out.survey;
      // the written items, onto the book's lines — one line per code, counts added up
      const byCode = new Map(catalog.map((c) => [c.code, c]));
      const lines: SheetLine[] = [];
      const unmatched: string[] = [];
      sv.items.forEach((it, i) => {
        if (!(it.qty > 0)) return;
        const real = it.lines.filter((l) => byCode.has(l.code) && l.qty > 0);
        if (real.length === 0) { unmatched.push(`${it.written}${it.note ? ` (${it.note})` : ""}`); return; }
        for (const l of real) {
          const c = byCode.get(l.code)!;
          const at = lines.find((x) => x.code === c.code);
          if (at) at.qty += l.qty;
          else lines.push({ code: c.code, qty: l.qty, unit_price: Number(c.unit_price) || 0, description: c.description, itemKey: String(i), label: it.written, uom: c.uom, line: c.line });
        }
      });
      if (lines.length === 0) { flash(`Nothing on that survey matched the price book${out.note ? ` — ${out.note}` : ""}`); return; }
      const total = sheetTotal(lines);
      const kind = sv.kind || "Move-out";
      const where = [sv.address, sv.apt && `Apt ${sv.apt}`].filter(Boolean).join(" ");
      // over what a super will sign? the last things written wait on a second sheet
      let cap = 0;
      if (total > DEFAULT_CAP) {
        const typed = window.prompt(`${where || "This survey"} comes to ${fmt(total)} — over ${fmt(DEFAULT_CAP)}.\n\nKeep the first sheet under $ (the rest goes on a second sheet). Leave it blank for one sheet.`, String(DEFAULT_CAP));
        if (typed === null) return;
        cap = Number(typed.replace(/[^0-9.]/g, "")) || 0;
      }
      const order = sv.items.map((_, i) => String(i));
      const split = splitToCap(lines, cap, order);
      const sheets: SurveySheet[] = split.rest.length > 0
        ? [{ job: `${kind} (1 of 2)`, lines: split.first, total: sheetTotal(split.first) }, { job: `${kind} (2 of 2)`, lines: split.rest, total: sheetTotal(split.rest) }]
        : [{ job: kind, lines, total }];
      const who = out.readBy === "claude" ? "Read by Claude" : "Read by the rules";
      const msg = `${who}: ${sv.items.length} lines on the survey → ${lines.length} contract lines, ${fmt(total)}.`
        + (sheets.length === 2 ? `\n\nTwo walk sheets: ${fmt(sheets[0].total)} now, ${fmt(sheets[1].total)} waits.` : "")
        + (unmatched.length ? `\n\nNO LINE IN THE PRICE BOOK for ${unmatched.length}: ${unmatched.slice(0, 8).join("; ")}${unmatched.length > 8 ? "…" : ""} — add those by hand on the sheet.` : "")
        + (out.note ? `\n\n⚠ ${out.note}` : "")
        + `\n\nMake the walk sheet${sheets.length === 2 ? "s" : ""} for ${where || "this survey"}?`;
      if (!window.confirm(msg)) return;
      const noteLines = [`✓ ${who} from the survey PDF (${file.name})`, ...(unmatched.length ? [`⚠ No price-book line for: ${unmatched.join("; ")}`] : [])];
      const made: Proposal[] = [];
      for (const sh of sheets) {
        const number = await nextNumber("proposals", "PROP");
        const qty_map: Record<string, number> = {};
        sh.lines.forEach((l) => { qty_map[l.code] = (qty_map[l.code] || 0) + l.qty; });
        const { data, error: pe } = await sb().from("proposals").insert({
          number, client_name: "New York City Housing Authority", contract_id: cid,
          job: sh.job, address: sv.address, apt: sv.apt, walk_date: localISO(), qty_map, total: sh.total, notes: noteLines.join("\n"),
        }).select().single();
        if (pe || !data) { flash(upgradeHint(pe?.message || "Couldn't make the walk sheet")); break; }
        const pid = (data as Proposal).id;
        const full = sh.lines.map((l, i) => ({ proposal_id: pid, code: l.code, description: l.description, unit: l.uom, qty: l.qty, unit_price: l.unit_price, sort: i, category: byCode.get(l.code)?.category || "", line: l.line }));
        let { error: ie } = await sb().from("proposal_items").insert(full);
        if (ie && /column/i.test(ie.message)) ({ error: ie } = await sb().from("proposal_items").insert(full.map(({ category: _c, line: _l, ...rest }) => rest)));
        if (ie) flash(ie.message);
        made.push(data as Proposal);
      }
      await load();
      if (made.length === 0) return;
      pickListContract(cid);
      flash(made.length === 1 ? `Walk sheet ${made[0].number} made — ${fmt(made[0].total || 0)} — check the counts` : `${made.length} walk sheets made: ${made.map((m) => `${m.number} (${fmt(m.total || 0)})`).join(" and ")}`);
      openEditor(made[0]); // straight onto the sheet, counts in view
    } catch (err) {
      flash(`Upload hit a snag — try again (${err instanceof Error ? err.message.slice(0, 80) : "unknown error"})`);
    } finally { setSurveyBusy(false); }
  };

  // ---------- saving ----------
  const saveDoc = async (patch: Partial<Proposal>, silent = false) => {
    if (!doc) return;
    setDoc({ ...doc, ...patch });
    const { error } = await sb().from("proposals").update(patch).eq("id", doc.id);
    if (error) flash(upgradeHint(error.message)); else if (!silent) flash("Saved");
    load();
  };

  const billed = useMemo<NychaLineItem[]>(() => {
    if (!catalog) return [];
    return catalog
      .map((ci) => ({ line: ci.line, code: ci.code, category: ci.category, description: ci.description, unit: ci.uom, qty: parseNum(qty[ci.code] || ""), unit_price: Number(ci.unit_price) }))
      .filter((it) => it.qty > 0);
  }, [catalog, qty]);
  const grand = billed.reduce((s, it) => s + it.qty * it.unit_price, 0);

  // autosave quantities (debounced) so a walkthrough can't be lost
  const PENDING_KEY = "elgc-qty-pending";
  const pendingSave = useRef<(() => Promise<void>) | null>(null);
  const scheduleAutosave = (nextQty: Record<string, string>) => {
    if (!doc) return;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const docId = doc.id;
    const map: Record<string, number> = {};
    Object.entries(nextQty).forEach(([k, v]) => { const n = parseNum(v); if (n > 0) map[k] = n; });
    const total = (catalog || []).reduce((s, ci) => s + (map[ci.code] || 0) * Number(ci.unit_price), 0);
    // parked locally too — a page killed mid-save (screen off, app switch)
    // gets pushed to the database on the next visit. The sheet's map as it was
    // when opened rides along, so recovery can tell whether someone else
    // edited in the meantime and back off instead of overwriting them.
    try { localStorage.setItem(PENDING_KEY, JSON.stringify({ docId, map, total, ts: Date.now(), base: doc.qty_map ?? null })); } catch {}
    const run = async () => {
      pendingSave.current = null;
      const { error } = await sb().from("proposals").update({ qty_map: map, total }).eq("id", docId);
      if (error) { setSaveState(""); flash(upgradeHint(error.message)); return; }
      try { localStorage.removeItem(PENDING_KEY); } catch {}
      setSaveState("saved");
      setTimeout(() => setSaveState(""), 1500);
    };
    pendingSave.current = run;
    saveTimer.current = setTimeout(run, 700);
  };
  // leaving the page fires any pending autosave immediately
  useEffect(() => {
    const flushNow = () => {
      if (pendingSave.current) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        pendingSave.current();
      }
    };
    window.addEventListener("pagehide", flushNow);
    document.addEventListener("visibilitychange", flushNow);
    return () => { window.removeEventListener("pagehide", flushNow); document.removeEventListener("visibilitychange", flushNow); };
  }, []);
  // recover an autosave the browser killed before it reached the database —
  // but never over edits someone made from another device in the meantime
  useEffect(() => {
    (async () => {
      try {
        const raw = localStorage.getItem(PENDING_KEY);
        if (!raw) return;
        const p = JSON.parse(raw) as { docId?: string; map?: Record<string, number>; total?: number; ts?: number; base?: Record<string, number> | null };
        if (!p?.docId || !p.map || !p.ts || Date.now() - p.ts > 6 * 3600_000) { localStorage.removeItem(PENDING_KEY); return; }
        const norm = (m: Record<string, number> | null | undefined) => JSON.stringify(Object.entries(m || {}).filter(([, v]) => Number(v) > 0).sort());
        const { data: cur } = await sb().from("proposals").select("qty_map").eq("id", p.docId).single();
        const dbMap = (cur as { qty_map?: Record<string, number> | null } | null)?.qty_map;
        // matches what this phone last saw (or is already the pending value) → safe to push
        if (norm(dbMap) !== norm(p.base) && norm(dbMap) !== norm(p.map)) { localStorage.removeItem(PENDING_KEY); return; }
        const { error } = await sb().from("proposals").update({ qty_map: p.map, total: p.total || 0 }).eq("id", p.docId);
        if (!error) { try { localStorage.removeItem(PENDING_KEY); } catch {} load(); }
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const qtyDirty = useRef(false); // did any quantity change since the sheet opened?
  const setLineQty = (code: string, v: string) => {
    qtyDirty.current = true;
    const next = { ...qty, [code]: v };
    if (!v) delete next[code];
    setQty(next); scheduleAutosave(next);
  };

  // explicit save: flush quantities + line items right now
  const saveNow = async () => {
    if (!doc) return;
    if (doc.contract_id && !catalog) { flash("Price book is still loading — one second"); return; }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    const map: Record<string, number> = {};
    Object.entries(qty).forEach(([k, v]) => { const n = parseNum(v); if (n > 0) map[k] = n; });
    const total = (catalog || []).reduce((s, ci) => s + (map[ci.code] || 0) * Number(ci.unit_price), 0);
    const { error } = await sb().from("proposals").update({ qty_map: map, total }).eq("id", doc.id);
    if (error) { setSaveState(""); flash(upgradeHint(error.message)); return; }
    await materialize();
    setSaveState("saved"); // the Saved ✓ indicator is the signal — no toast on top
    setTimeout(() => setSaveState(""), 1500);
    load();
  };

  // write the billed lines to proposal_items (used by print, invoices, statements)
  const materialize = async (): Promise<NychaLineItem[]> => {
    if (!doc) return [];
    // never wipe saved lines while the price book is still loading (billed would be [])
    if (doc.contract_id && !catalog) return [];
    const rows = doc.contract_id ? billed : items;
    await sb().from("proposal_items").delete().eq("proposal_id", doc.id);
    if (rows.length) {
      const full = rows.map((it, i) => ({ proposal_id: doc.id, code: it.code, description: it.description, unit: it.unit, qty: Number(it.qty) || 0, unit_price: Number(it.unit_price) || 0, sort: i, category: it.category || "", line: it.line || 0 }));
      let { error } = await sb().from("proposal_items").insert(full);
      if (error && /column/i.test(error.message)) ({ error } = await sb().from("proposal_items").insert(full.map(({ category: _c, line: _l, ...rest }) => rest)));
      if (error) flash(error.message);
    }
    return rows;
  };
  // closing only rewrites the saved lines when something changed — before, every
  // open-and-look deleted and re-inserted the whole sheet for nothing
  const closeEditor = async () => { if (doc?.contract_id && catalog && qtyDirty.current) await materialize(); setDoc(null); setItems([]); };

  // ---------- catalog upload (per contract, header-name matched) ----------
  const handleContractSheet = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !doc?.contract_id) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        await ensureXLSX();
        const wb = XLSX.read(ev.target?.result as ArrayBuffer, { type: "array" });
        const raw: (string | number)[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: false, blankrows: false });
        const hIdx = raw.findIndex((r) => r.some((c) => /^item$/i.test(String(c).trim())) && r.some((c) => /^price$/i.test(String(c).trim())));
        if (hIdx < 0) { flash("No header row with Item + Price columns found"); return; }
        const headers = raw[hIdx].map((h) => String(h).toLowerCase().trim());
        const col = (re: RegExp) => headers.findIndex((h) => re.test(h));
        const m = { line: col(/^line/), code: col(/^item/), category: col(/^categ/), description: col(/^desc/), uom: col(/^uom|^unit$/), price: col(/^price/) };
        if (m.code < 0 || m.description < 0) { flash("Couldn't find Item and Description columns in the header row"); return; }
        const rows = raw.slice(hIdx + 1)
          .map((r, i) => {
            const g = (ix: number) => (ix >= 0 && ix < r.length ? String(r[ix]).trim() : "");
            return {
              line: parseInt(g(m.line), 10) || i + 1, code: g(m.code), category: g(m.category),
              description: g(m.description), uom: g(m.uom), unit_price: m.price >= 0 ? parseNum(r[m.price]) : 0,
            };
          })
          .filter((r) => r.code && r.description && !/^total$/i.test(r.description));
        if (rows.length === 0) { flash("No item rows found in that sheet"); return; }
        const { error: de } = await sb().from("contract_items").delete().eq("contract_id", doc.contract_id!);
        if (de) { flash(upgradeHint(de.message)); return; }
        for (let i = 0; i < rows.length; i += 500) {
          const { error } = await sb().from("contract_items").insert(rows.slice(i, i + 500).map((r) => ({ ...r, contract_id: doc.contract_id })));
          // the old book is already cleared — say so, or a half-loaded book looks complete
          if (error) { flash(`Upload stopped partway (${upgradeHint(error.message)}) — upload the sheet again to finish the book`); return; }
        }
        const { data } = await sb().from("contract_items").select("*").eq("contract_id", doc.contract_id!).order("line");
        setCatalog((data || []) as ContractItem[]);
        flash(`Loaded ${rows.length} price book lines for this contract`);
      } catch { flash("Couldn't read that sheet — save as .xlsx or .csv"); }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  // ---------- export: NYCHA walk-sheet layout, used lines only, bordered ----------
  const exportWalkSheet = async () => {
    try { await ensureXLSX(); } catch { flash("Couldn't load the Excel engine \u2014 check your signal and try again"); return; }
    if (!doc || !catalog) return;
    await materialize();
    const c = contracts.find((x) => x.id === doc.contract_id);
    const asCode = (s: string) => (/^\d+$/.test(s) ? Number(s) : s);
    const used = catalog.filter((ci) => parseNum(qty[ci.code] || "") > 0);
    const aoa: (string | number)[][] = [
      ["PO:", "", c ? asCode(c.number) : "", "", "NYCHA Staff:", doc.nycha_staff || "", ""],
      ["Vendor:", "", (org?.company || "").toUpperCase(), "", "Vendor Staff:", doc.vendor_staff || "", ""],
      ["Development:", "", doc.development || "", "", "Walk Date:", doc.walk_date || "", ""],
      ["Stairhall:", "", doc.stairhall || "", "", "Release #:", doc.release_number || "", ""],
      ["Apt:", "", doc.apt || "", "", "Start Date:", doc.start_date || "", ""],
      ["Address:", "", doc.address || "", "", "Finish Date:", doc.finish_date || "", ""],
      [],
      ["Line", "Item", "Category", "Description", "UOM", "Quantity", "Price", "Total Cost"],
      ...used.map((ci) => {
        const n = parseNum(qty[ci.code] || "");
        return [ci.line, asCode(ci.code), ci.category, ci.description, ci.uom, n, Number(ci.unit_price), n * Number(ci.unit_price)];
      }),
      ["", "", "", "", "", "Total", "", grand],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 7 }, { wch: 12 }, { wch: 34 }, { wch: 80 }, { wch: 15 }, { wch: 12 }, { wch: 12 }, { wch: 14 }];
    ws["!merges"] = Array.from({ length: 6 }, (_, r) => [
      { s: { r, c: 0 }, e: { r, c: 1 } },
      { s: { r, c: 5 }, e: { r, c: 6 } },
    ]).flat();
    // styling: bold header labels, bordered table grid, money formats
    const thin = { style: "thin", color: { rgb: "000000" } };
    const box = { top: thin, bottom: thin, left: thin, right: thin };
    const shade = { patternType: "solid", fgColor: { rgb: "E8E4DA" } };
    // create missing cells so the grid never has border holes
    const cellAt = (r: number, col: number) => ws[XLSX.utils.encode_cell({ r, c: col })] || (ws[XLSX.utils.encode_cell({ r, c: col })] = { t: "s", v: "" });
    // header block: shaded bold labels in bordered boxes, bordered value cells
    for (let r = 0; r < 6; r++) {
      for (const col of [0, 1, 4]) cellAt(r, col).s = { font: { bold: true }, fill: shade, border: box, alignment: { vertical: "center" } };
      for (const col of [2, 5, 6]) cellAt(r, col).s = { border: box, alignment: { horizontal: col === 2 ? "left" : "center", vertical: "center" } };
    }
    const headerRow = 7, firstItem = 8, totalRow = firstItem + used.length;
    for (let r = headerRow; r <= totalRow; r++) {
      for (let col = 0; col < 8; col++) {
        const cell = cellAt(r, col);
        const s: Record<string, unknown> = { border: box, alignment: { vertical: "center", wrapText: col === 3, horizontal: r === headerRow ? "center" : col >= 4 ? "right" : "left" } };
        if (r === headerRow || r === totalRow) s.font = { bold: true };
        if (r === headerRow) s.fill = { patternType: "solid", fgColor: { rgb: "E8E4DA" } };
        cell.s = s;
        if (r > headerRow && (col === 6 || col === 7) && typeof cell.v === "number") cell.z = "#,##0.00";
      }
    }
    ws["!rows"] = [];
    for (let r = 0; r < 6; r++) ws["!rows"][r] = { hpt: 20 };
    ws["!rows"][headerRow] = { hpt: 24 };
    ws["!rows"][totalRow] = { hpt: 22 };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const fname = askFileName(`${fileSafe(sheetName(doc))}.xlsx`);
    if (!fname) return;
    XLSX.writeFile(wb, fname);
  };

  // ---------- add a proposal to its contract as a release (works from the dashboard) ----------
  const itemsFor = async (p: Proposal): Promise<NychaLineItem[]> => {
    if (doc && doc.id === p.id) return materialize(); // editor open: use live quantities
    if (!p.contract_id) {
      // an old free-form proposal keeps its lines saved as rows
      const { data } = await sb().from("proposal_items").select("*").eq("proposal_id", p.id).order("sort");
      return ((data || []) as NychaLineItem[]).map((it) => ({ ...it, qty: Number(it.qty) || 0, unit_price: Number(it.unit_price) || 0 }));
    }
    // list rows travel without qty_map — fetch it for this one sheet
    let qmap = p.qty_map;
    if (qmap === undefined) {
      const { data: full } = await sb().from("proposals").select("qty_map").eq("id", p.id).single();
      qmap = (full as { qty_map?: Record<string, number> | null } | null)?.qty_map ?? null;
    }
    const { data } = await sb().from("contract_items").select("*").eq("contract_id", p.contract_id!).order("line");
    const map = qmap || {};
    return ((data || []) as ContractItem[])
      .filter((ci) => Number(map[ci.code]) > 0)
      .map((ci) => ({ line: ci.line, code: ci.code, category: ci.category, description: ci.description, unit: ci.uom, qty: Number(map[ci.code]), unit_price: Number(ci.unit_price) }));
  };
  // ---------- the sheet as a PDF file, straight from the list ----------
  const [pdfBusy, setPdfBusy] = useState("");
  const downloadPdf = async (p: Proposal) => {
    if (pdfBusy) return;
    setPdfBusy(p.id);
    try {
      const lines = await itemsFor(p);
      const c = contracts.find((x) => x.id === p.contract_id);
      const { buildWalkSheetPdf, walkSheetFileName } = await import("@/lib/walkSheetPdf");
      const logo = await fetch("/logo.png").then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? new Uint8Array(b) : undefined)).catch(() => undefined);
      const fields = {
        number: p.number, contractNumber: c?.number, development: p.development, address: p.address, apt: p.apt, stairhall: p.stairhall,
        job: p.job, releaseNumber: p.release_number, walkDate: p.walk_date, nychaStaff: p.nycha_staff, vendorStaff: p.vendor_staff,
        lines: lines.map((it) => ({ line: it.line, code: it.code, category: it.category, description: it.description, unit: it.unit, qty: Number(it.qty) || 0, unit_price: Number(it.unit_price) || 0 })),
      };
      const bytes = await buildWalkSheetPdf(fields, logo);
      const ab = new ArrayBuffer(bytes.byteLength); new Uint8Array(ab).set(bytes);
      const url = URL.createObjectURL(new Blob([ab], { type: "application/pdf" }));
      const a = document.createElement("a"); a.href = url; a.download = walkSheetFileName(fields); a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      flash(lines.length ? `PDF saved — ${lines.length} line${lines.length === 1 ? "" : "s"}` : "PDF saved — no quantities on that sheet yet");
    } catch (err) {
      flash(`Couldn't build the PDF (${err instanceof Error ? err.message.slice(0, 60) : "unknown"})`);
    } finally { setPdfBusy(""); }
  };

  // step 1: ask which release number this walk sheet becomes
  const addToRelease = (p: Proposal) => {
    if (!contracts.find((x) => x.id === p.contract_id)) { flash("That proposal isn't tied to a contract"); return; }
    setRelAsk({ p, value: (p.release_number || "").trim() });
  };
  // step 2: create/update the release under that number
  const performAddToRelease = async (p: Proposal, rel: string) => {
    const c = contracts.find((x) => x.id === p.contract_id);
    if (!c) return;
    if (rel !== (p.release_number || "").trim()) {
      await sb().from("proposals").update({ release_number: rel }).eq("id", p.id);
      p = { ...p, release_number: rel };
    }
    const its = await itemsFor(p);
    if (its.length === 0) { flash("No quantities entered on that walk sheet yet"); return; }
    const total = its.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);
    const addr = [p.address, p.apt && `Apt ${p.apt}`, p.stairhall && `Stairhall ${p.stairhall}`].filter(Boolean).join(", ");
    // same update-or-create rule as the PDF import: one release per number per contract
    const { data: existing } = await sb().from("releases").select("id").eq("contract_id", c.id).eq("rel_number", rel).limit(1);
    let relId: string;
    if (existing && existing[0]) {
      relId = (existing[0] as { id: string }).id;
      let { error } = await sb().from("releases").update({ amount: total, location: p.development || "", buildings: addr, address: addr }).eq("id", relId);
      if (error && /column/i.test(error.message)) ({ error } = await sb().from("releases").update({ amount: total, location: p.development || "", buildings: addr }).eq("id", relId));
      if (error) { flash(error.message); return; }
      await sb().from("release_items").delete().eq("release_id", relId);
    } else {
      const base = {
        contract_id: c.id, rel_number: rel, location: p.development || "", buildings: addr,
        ticket: "", amount: total, pre_check: "", date_completed: "", payroll_done: false, received: false, canceled: false, labor_hours: 0, assigned_to: null,
      };
      let { data, error } = await sb().from("releases").insert({ ...base, address: addr }).select().single();
      if (error && /column/i.test(error.message)) ({ data, error } = await sb().from("releases").insert(base).select().single());
      if (error || !data) { flash(error?.message || "Couldn't create the release"); return; }
      relId = (data as { id: string }).id;
    }
    const { error: e2 } = await sb().from("release_items").insert(its.map((it) => ({
      release_id: relId, line: it.line || 0, code: it.code, description: it.description,
      qty: Number(it.qty) || 0, uom: it.unit, unit_price: Number(it.unit_price) || 0,
      amount: (Number(it.qty) || 0) * (Number(it.unit_price) || 0),
    })));
    if (e2) { flash(`Release saved, but line items failed: ${e2.message}`); return; }
    await sb().from("proposals").update({ status: "approved" }).eq("id", p.id);
    if (doc && doc.id === p.id) setDoc({ ...doc, status: "approved" });
    load();
    flash(`Release ${rel} ${existing && existing[0] ? "updated" : "created"} on contract ${c.number} — see the Releases tab`);
  };

  // ---------- delete (works from the dashboard) ----------
  const deleteProposal = async (p: Proposal) => {
    if (!window.confirm(`Delete walk sheet ${p.number}? This can't be undone.`)) return;
    // try the proposal itself first — if that fails for any reason, nothing
    // else has been touched. Old-style invoices block it via foreign key, so
    // only then clear them (and their lines) and try once more.
    let { error } = await sb().from("proposals").delete().eq("id", p.id);
    if (error) {
      const { data: invs } = await sb().from("invoices").select("id").eq("proposal_id", p.id);
      const invIds = ((invs || []) as { id: string }[]).map((i) => i.id);
      if (invIds.length > 0) {
        await sb().from("invoice_items").delete().in("invoice_id", invIds);
        await sb().from("invoices").delete().in("id", invIds);
      }
      await sb().from("proposal_items").delete().eq("proposal_id", p.id);
      ({ error } = await sb().from("proposals").delete().eq("id", p.id));
    }
    if (error) { flash(error.message); return; }
    if (doc && doc.id === p.id) setDoc(null);
    load(); flash("Walk sheet deleted");
  };

  // ---------- walk sheet grouping / filtering ----------
  const groups = useMemo(() => {
    if (!catalog) return [];
    const q = search.trim().toLowerCase();
    const rows = q
      ? catalog.filter((ci) => String(ci.line) === q || ci.code.toLowerCase().includes(q) || ci.description.toLowerCase().includes(q) || ci.category.toLowerCase().includes(q))
      : catalog;
    const out: { category: string; rows: ContractItem[] }[] = [];
    rows.forEach((ci) => {
      const g = out[out.length - 1];
      if (g && g.category === ci.category) g.rows.push(ci);
      else out.push({ category: ci.category, rows: [ci] });
    });
    return out;
  }, [catalog, search]);

  // ================= WALK SHEET EDITOR =================
  if (doc && doc.contract_id) {
    const c = contracts.find((x) => x.id === doc.contract_id);
    return (
      <div className="pb-24">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <button className="btn btn-ghost" onClick={closeEditor}>← Back</button>
            <span className="font-mono font-semibold">{doc.number}</span>
            <Stamp label={doc.status.toUpperCase()} tone={tone(doc.status) as "ok"} />
            {saveState && <span className="text-xs text-inksoft">{saveState === "saving" ? "Saving…" : "Saved ✓"}</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={async () => { await saveNow(); setDoc(null); setItems([]); }}>Save & close</button>
            <ActionMenu label="⋯" items={[
              { label: "View PDF", onSelect: () => { setPrintOpen(true); setTimeout(() => window.print(), 400); } },
              { label: "⬇ Walk sheet (Excel)", onSelect: exportWalkSheet },
            ]} />
          </div>
        </div>
        <input ref={sheetRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleContractSheet} />

        <div className="card mb-3 p-3.5">
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            <div className="col-span-2"><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Name</div>
              <input className="field" placeholder="e.g. Queensbridge 41st Ave Apt 3F move-out" value={doc.job || ""}
                onChange={(e) => setDoc({ ...doc, job: e.target.value })} onBlur={(e) => saveDoc({ job: e.target.value }, true)} /></div>
            <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Contract / PO</div>
              <ContractPicker contracts={contracts} value={doc.contract_id || ""} onChange={(id) => saveDoc({ contract_id: id }, true)} /></div>
            <div className="col-span-2"><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Address of the location</div>
              <input className="field" placeholder="e.g. 21-10 41st Ave, Queensbridge" value={doc.address || ""}
                onChange={(e) => setDoc({ ...doc, address: e.target.value })} onBlur={(e) => saveDoc({ address: e.target.value }, true)} /></div>
          </div>
          <Disclosure className="mt-1.5 border-t border-rulesoft pt-1" label="Sheet header" sublabel="dates, staff, apt, release #"
            open={showHead} onToggle={() => setShowHead(!showHead)}>
            <div className="grid grid-cols-2 gap-2.5 pt-1.5 md:grid-cols-4">
              {HEAD_FIELDS.map(([k, label]) => (
                <div key={k}><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">{label}</div>
                  <input className="field" type={/date/.test(k) ? "date" : "text"} value={doc[k] || ""}
                    onChange={(e) => setDoc({ ...doc, [k]: e.target.value })}
                    onBlur={(e) => saveDoc({ [k]: e.target.value } as Partial<Proposal>, true)} /></div>
              ))}
            </div>
          </Disclosure>
        </div>

        {(catalog || []).length === 0 ? (
          <div className="card border-work p-4">
            <div className="text-sm text-inksoft">
              No price book loaded for contract {c?.number} yet. Tap <b>Upload price book</b> and pick the contract price sheet —
              the xlsx with Line / Item / Category / Description / UOM / Price columns (a blank walk sheet works). One time per contract.
            </div>
            <button className="btn btn-primary mt-3" onClick={() => sheetRef.current?.click()}>Upload price book</button>
          </div>
        ) : (
          <>
            <input className="field mb-1" placeholder="Search line #, code, or word…"
              value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="mb-3 text-[11px] text-inksoft">{catalog!.length} lines in this price book</div>
            {groups.map((g, gi) => {
              const isOpen = !!search || !collapsed.has(g.category);
              const filled = g.rows.filter((ci) => parseNum(qty[ci.code] || "") > 0).length;
              return (
                <div key={`${g.category}-${gi}`} className="card mb-2 overflow-hidden">
                  <button className="flex w-full items-center justify-between gap-2 bg-ink/5 px-3 py-2.5 text-left"
                    onClick={() => { const next = new Set(collapsed); if (next.has(g.category)) next.delete(g.category); else next.add(g.category); setCollapsed(next); }}>
                    <span className="font-display text-[13px] font-semibold uppercase tracking-wider">{isOpen ? "▾" : "▸"} {g.category || "Uncategorized"}</span>
                    <span className="shrink-0 font-mono text-xs text-inksoft">{filled > 0 ? `${filled} filled · ` : ""}{g.rows.length} lines</span>
                  </button>
                  {isOpen && g.rows.map((ci) => {
                    const n = parseNum(qty[ci.code] || "");
                    return (
                      <div key={ci.id} className={`flex items-start gap-3 border-t border-rulesoft px-3 py-2.5 ${n > 0 ? "bg-work/5" : ""}`}>
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-[11px] text-inksoft">#{ci.line} · {ci.code}</div>
                          <div className="text-[13px] leading-snug">{ci.description}</div>
                          <div className="font-mono text-[11px] text-inksoft">{fmt(Number(ci.unit_price))} / {ci.uom}</div>
                        </div>
                        <div className="shrink-0 text-right">
                          <input className="w-20 rounded-sm border border-rulesoft p-2 text-right font-mono text-base" inputMode="decimal" placeholder="qty"
                            value={qty[ci.code] || ""} onChange={(e) => setLineQty(ci.code, e.target.value)} />
                          <div className="mt-0.5 font-mono text-xs font-semibold">{n > 0 ? fmt(n * Number(ci.unit_price)) : ""}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {groups.length === 0 && <div className="card p-4 text-sm text-inksoft">Nothing matches “{search}”.</div>}
          </>
        )}

        <div className="fixed inset-x-0 bottom-0 z-30 border-t-2 border-ink bg-card px-4 py-3">
          <div className="mx-auto flex max-w-5xl items-center justify-between">
            <span className="text-xs uppercase tracking-widest text-inksoft">{billed.length} lines with qty</span>
            <span className="font-mono text-xl font-semibold">Total {fmt(grand)}</span>
          </div>
        </div>

        {printOpen && (
          <PrintShell title={fileSafe(sheetName(doc))}>
          <div className="fixed inset-0 z-50 overflow-y-auto bg-ink/50 px-2 py-5">
            <div className="printable mx-auto max-w-4xl rounded-sm border-t-4 border-ink bg-white p-8 text-ink">
              <Letterhead />
              {/* same band-and-rule look as the PACT proposal letter */}
              <div className="mt-4 flex items-end justify-between border-b-[3px] border-work pb-2">
                <div className="font-display text-2xl font-bold uppercase tracking-wide text-work">Proposal — NYCHA Walk Sheet</div>
                <div className="text-right text-[12px] leading-tight">
                  <div><span className="text-[11px] uppercase tracking-widest text-inksoft">Sheet # </span><b className="font-mono">{doc.number}</b></div>
                </div>
              </div>
              <div className="mt-4 bg-card px-3 py-2 text-[13px]">
                {([["Contract #", c?.number], ["Development", doc.development],
                  ["Address", [doc.address, doc.apt && `Apt ${doc.apt}`].filter(Boolean).join(" · ")],
                  ["For", doc.job]] as [string, string | undefined][]).map(([l, v]) => (
                  <div key={l} className="flex gap-3 py-0.5"><span className="w-28 shrink-0 text-[11px] uppercase tracking-widest text-inksoft">{l}</span><b>{v || "—"}</b></div>
                ))}
              </div>
              <table className="mt-4 w-full border-collapse text-[12px]">
                <thead><tr className="border-b-2 border-work bg-card text-left font-display text-[11px] uppercase tracking-widest text-inksoft">
                  <th className="p-1.5">Line</th><th className="p-1.5">Item</th><th className="p-1.5">Category</th>
                  <th className="p-1.5">Description</th><th className="p-1.5">UOM</th>
                  <th className="p-1.5 text-right">Qty</th><th className="p-1.5 text-right">Price</th><th className="p-1.5 text-right">Total</th>
                </tr></thead>
                <tbody>
                  {billed.map((it, i) => (
                    <tr key={i} className="align-top border-b border-rulesoft">
                      <td className="p-1.5 font-mono text-inksoft">{it.line}</td>
                      <td className="p-1.5 font-mono text-inksoft">{it.code}</td>
                      <td className="p-1.5 text-[11px] text-inksoft">{it.category}</td>
                      <td className="p-1.5">{it.description}</td>
                      <td className="p-1.5 font-mono text-[11px] text-inksoft">{it.unit}</td>
                      <td className="p-1.5 text-right font-mono">{it.qty}</td>
                      <td className="p-1.5 text-right font-mono text-inksoft">{fmt(it.unit_price)}</td>
                      <td className="p-1.5 text-right font-mono font-semibold">{fmt(it.qty * it.unit_price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-2 flex items-center justify-end gap-4 bg-work px-3 py-2 text-white">
                <div className="font-display text-[13px] font-bold uppercase tracking-widest">Total</div>
                <div className="font-mono text-base font-bold">{fmt(grand)}</div>
              </div>
            </div>
            <div className="no-print mx-auto mt-3 flex max-w-4xl flex-wrap justify-end gap-2">
              <button className="btn btn-primary" onClick={exportWalkSheet}>⬇ Walk sheet (Excel)</button>
              <button className="btn bg-white" onClick={() => window.print()}>Print / Save as PDF</button>
              <button className="btn btn-ghost bg-white" onClick={() => setPrintOpen(false)}>Close</button>
            </div>
          </div>
          </PrintShell>
        )}
        {msg && <div className="fixed bottom-16 left-1/2 z-[60] -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
      </div>
    );
  }

  // ================= LEGACY EDITOR (old proposals without a contract) =================
  if (doc) {
    const total = grandTotal(items, doc.tax_pct);
    return (
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <button className="btn btn-ghost" onClick={closeEditor}>← Back</button>
            <span className="font-mono font-semibold">{doc.number}</span>
            <Stamp label={doc.status.toUpperCase()} tone={tone(doc.status) as "ok"} />
          </div>
        </div>
        <div className="card mb-3 p-3.5 text-sm text-inksoft">
          {doc.client_name || "No client"}{doc.job ? ` · ${doc.job}` : ""} — this is an old-style proposal (read-only line list below). New work happens in NYCHA walk sheets.
        </div>
        <div className="card mb-3 overflow-x-auto">
          <table className="w-full border-collapse text-sm" style={{ minWidth: 540 }}>
            <thead><tr className="border-b-[1.5px] border-ink text-left font-display text-xs uppercase tracking-widest text-inksoft">
              <th className="w-3/5 p-2.5">Item</th><th className="p-2.5">Unit</th><th className="p-2.5 text-right">Qty</th><th className="p-2.5 text-right">Unit $</th><th className="p-2.5 text-right">Total</th></tr></thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className="border-b border-rulesoft">
                  <td className="p-2.5">{it.code ? <span className="font-mono text-[11px] text-inksoft">{it.code} · </span> : null}{it.description}</td>
                  <td className="p-2.5 font-mono text-xs">{it.unit}</td>
                  <td className="p-2.5 text-right font-mono">{it.qty}</td>
                  <td className="p-2.5 text-right font-mono">{fmt(Number(it.unit_price))}</td>
                  <td className="p-2.5 text-right font-mono font-semibold">{fmt(Number(it.qty) * Number(it.unit_price))}</td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={5} className="p-4 text-inksoft">No lines.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="card flex justify-end p-3.5"><div className="font-mono text-xl font-semibold">Total {fmt(total)}</div></div>
        {msg && <div className="fixed bottom-5 left-1/2 z-[60] -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
      </div>
    );
  }

  // ================= LIST =================
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-display text-2xl font-bold uppercase">Proposals</div>
        <div className="flex flex-wrap gap-2">
          <button className="btn" onClick={uploadSurvey} disabled={surveyBusy} title="The survey written on site, as a PDF — the walk sheet builds itself from the contract's lines, kept under what a super will sign">{surveyBusy ? "Reading the survey…" : "📄 Upload a survey (PDF)"}</button>
          <button className="btn btn-primary" onClick={newWalkSheet}>+ New NYCHA walk sheet</button>
          <ActionMenu label="⋯" items={[
            { label: "⬇ Blank survey (PDF)", title: "The survey form, organized by what gets checked — fill the boxes on the phone or print it", onSelect: downloadSurveyForm },
          ]} />
        </div>
      </div>
      <input ref={surveyRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={handleSurveyPdf} />
      {pickOpen && (
        <div className="card mb-3 border-work p-4">
          <div className="mb-2 text-[11px] uppercase tracking-widest text-inksoft">Which contract is this walk for?</div>
          <div className="mb-3"><ContractPicker contracts={contracts} value={pickId} onChange={setPickId} /></div>
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={newWalkSheet}>Start walk sheet</button>
            <button className="btn btn-ghost" onClick={() => setPickOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
      {(() => {
        // the contract on screen; sheets not tied to any contract get their own choice
        const strays = list.filter((p) => !p.contract_id || !contracts.some((c) => c.id === p.contract_id));
        const onContract = (p: Proposal) => listContract === "all" || !listContract ? true
          : listContract === "none" ? strays.includes(p) : p.contract_id === listContract;
        const mine = list.filter(onContract);
        return (
          <>
            {contracts.length > 0 && (
              <div className="mb-3">
                <div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Contract</div>
                <ContractPicker contracts={contracts} value={listContract} onChange={pickListContract}
                  extra={[{ id: "all", label: "All contracts" }, ...(strays.length > 0 ? [{ id: "none", label: `Not tied to a contract (${strays.length})` }] : [])]} />
              </div>
            )}
            <div className="mb-3 flex flex-wrap gap-2">
              {([["all", `All (${mine.length})`], ["draft", `Drafts (${mine.filter((p) => p.status === "draft").length})`], ["approved", `In a release (${mine.filter((p) => p.status === "approved").length})`]] as ["all" | "draft" | "approved", string][]).map(([f, l]) => (
                <button key={f} className={`btn ${listFilter === f ? "btn-primary" : "btn-ghost"} px-3 py-1.5 text-[13px]`} onClick={() => setListFilter(f)}>{l}</button>
              ))}
            </div>
          </>
        );
      })()}
      <input className="field mb-3" placeholder="Search name, development, address, release #…" value={listQ} onChange={(e) => setListQ(e.target.value)} />
      {(() => {
        const strays = list.filter((p) => !p.contract_id || !contracts.some((c) => c.id === p.contract_id));
        const onContract = (p: Proposal) => listContract === "all" || !listContract ? true
          : listContract === "none" ? strays.includes(p) : p.contract_id === listContract;
        const shown = list
          .filter(onContract)
          .filter((p) => listFilter === "all" || p.status === listFilter)
          .filter((p) => {
            if (!listQ) return true;
            const c = contracts.find((x) => x.id === p.contract_id);
            return `${p.number} ${p.job} ${p.client_name} ${p.development || ""} ${p.address || ""} ${p.apt || ""} ${p.stairhall || ""} ${p.release_number || ""} ${c?.number || ""}`
              .toLowerCase().includes(listQ.toLowerCase());
          });
        // on a phone the name and total take the whole first line; the buttons
        // sit under them instead of squeezing the name into a column
        const row = (p: Proposal) => (
          <div key={p.id} className="flex flex-wrap items-center gap-2 p-3.5">
            <button className="flex w-full min-w-0 items-center justify-between gap-2 text-left sm:w-auto sm:flex-1" onClick={() => openEditor(p)}>
              <div className="min-w-0">
                <div className="text-[14px] font-semibold">
                  {(p.development || p.address || p.job)
                    ? <>{sheetName(p)}<span className="ml-1.5 font-mono text-[11px] font-normal text-inksoft">{p.number}</span></>
                    : <span className="font-mono">{p.number}</span>}
                </div>
                <div className="truncate text-[13px] text-inksoft">
                  {p.contract_id
                    ? [p.development && p.address, p.apt && `Apt ${p.apt}`, p.stairhall && `Stair ${p.stairhall}`, p.release_number && `Rel ${p.release_number}`].filter(Boolean).join(" · ") || (p.development || p.address ? "" : "NYCHA walk")
                    : p.client_name || "No client"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2.5">
                <span className="font-mono text-[13px]">{fmt(Number(p.total) || 0)}</span>
                <Stamp label={p.status.toUpperCase()} tone={tone(p.status) as "ok"} />
              </div>
            </button>
            <span className="ml-auto flex items-center gap-2">
              <button type="button" className="btn btn-ghost min-h-[44px] px-2.5 text-[12px]" disabled={!!pdfBusy} title="The sheet as a PDF file — no need to open it" onClick={() => downloadPdf(p)}>{pdfBusy === p.id ? "…" : "⬇ PDF"}</button>
              {p.contract_id && <button type="button" className="btn btn-ghost min-h-[44px] px-2.5 text-[12px]" title="Make (or update) the release on this contract from this sheet" onClick={() => addToRelease(p)}>→ Release</button>}
              <RowActions items={[
                { label: "Add to release…", hidden: !p.contract_id, onSelect: () => addToRelease(p) },
                { label: "Delete…", destructive: true, onSelect: () => deleteProposal(p) }, // deleteProposal keeps its own confirm
              ]} />
            </span>
          </div>
        );
        // one card per contract, in contract order; anything not tied to a
        // contract (the old free-form proposals) sits in its own card at the end
        const groups = [
          ...[...contracts].sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true })).map((c) => ({ key: c.id, label: c.name && c.name !== c.number ? `Contract ${c.number} · ${c.name}` : `Contract ${c.number}`, rows: shown.filter((p) => p.contract_id === c.id) })),
          { key: "none", label: "Not tied to a contract", rows: shown.filter((p) => !p.contract_id || !contracts.some((c) => c.id === p.contract_id)) },
        ].filter((g) => g.rows.length > 0);
        return (
          <>
            {groups.map((g) => (
              <div key={g.key} className="mb-4">
                <div className="mb-1.5 flex items-baseline justify-between gap-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">{g.label}</div>
                  <div className="font-mono text-[11px] text-inksoft">{g.rows.length} · {fmt(g.rows.reduce((t, p) => t + (Number(p.total) || 0), 0))}</div>
                </div>
                <div className="card divide-y divide-rulesoft">{g.rows.map(row)}</div>
              </div>
            ))}
            {groups.length === 0 && (
              <div className="card p-5 text-sm text-inksoft">
                {list.length === 0 ? "No walk sheets yet. Tap + New NYCHA walk sheet, load the contract price book once, and fill quantities as you walk the unit."
                  : listQ || listFilter !== "all" ? "Nothing matches that search."
                  : "No walk sheets on this contract yet — pick another above, or All contracts."}
              </div>
            )}
          </>
        );
      })()}

      {relAsk && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-ink/50 px-4" onClick={() => setRelAsk(null)}>
          <div className="card w-full max-w-sm bg-card p-5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-1 font-display text-lg font-bold uppercase">Add to release</div>
            <div className="mb-3 text-sm text-inksoft">
              {relAsk.p.number} · {[relAsk.p.job, relAsk.p.development, relAsk.p.address].filter(Boolean).join(" · ") || "NYCHA walk"} — {fmt(Number(relAsk.p.total) || 0)}
            </div>
            <label className="text-[11px] uppercase tracking-widest text-inksoft">Release number</label>
            <input className="field mb-2 mt-1" autoFocus placeholder="e.g. 12" value={relAsk.value}
              onChange={(e) => setRelAsk({ ...relAsk, value: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter" && relAsk.value.trim()) { const { p, value } = relAsk; setRelAsk(null); performAddToRelease(p, value.trim()); } }} />
            <div className="mb-4 text-xs text-inksoft">The release is created on contract {contracts.find((x) => x.id === relAsk.p.contract_id)?.number} with this walk sheet&apos;s lines and total. If release {relAsk.value.trim() || "…"} already exists there, it&apos;s updated — never duplicated.</div>
            <div className="flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={() => setRelAsk(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={!relAsk.value.trim()}
                onClick={() => { const { p, value } = relAsk; setRelAsk(null); performAddToRelease(p, value.trim()); }}>Create release</button>
            </div>
          </div>
        </div>
      )}

      {msg && <div className="fixed bottom-5 left-1/2 z-[60] -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
