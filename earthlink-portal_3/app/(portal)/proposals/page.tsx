"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { matches } from "@/lib/search";
import { cached, forget, onCacheUser, remember } from "@/lib/cache";
import { useDebounced } from "@/lib/useDebounced";
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
import Modal from "@/components/Modal";
import { DEFAULT_CAP, billSurvey, hoursNote, sheetTotal, splitSurveyNotes, LABOR_KEY, type SheetLine, type HourPart } from "@/lib/surveyTemplate";
import { MOVEOUT_CONTRACT, MOVEOUT_RELEASE, RELEASE_LINES } from "@/lib/moveoutRelease";
import { contractKey } from "@/lib/matchRelease";
import type { SmartSurvey } from "@/lib/smartSurvey";
import { useLive } from "@/lib/useLive";
import PrintShell from "@/components/PrintShell";
import Letterhead from "@/components/Letterhead";
import { RowActions } from "@/components/ActionMenu";
import Disclosure from "@/components/Disclosure";
import PageHeader from "@/components/PageHeader";
import Toast, { useFlash } from "@/components/Toast";

interface Proposal {
  id: string; number: string; client_name: string; job: string; date: string; tax_pct: number; status: string; notes: string;
  contract_id?: string | null; development?: string; address?: string; apt?: string; stairhall?: string;
  walk_date?: string; release_number?: string; nycha_staff?: string; vendor_staff?: string;
  start_date?: string; finish_date?: string; total?: number; qty_map?: Record<string, number> | null;
}
interface ContractItem { id: string; line: number; code: string; category: string; description: string; uom: string; unit_price: number; }
type NychaLineItem = LineItem & { category?: string; line?: number };

const tone = (s: string) => (s === "approved" ? "work" : s === "sent" ? "carbon" : s === "invoiced" ? "mute" : s === "declined" ? "alert" : "mute");
// the status words on a sheet's stamp (the database keeps the short keys)
const STATUS_LABEL: Record<string, string> = { draft: "Draft", approved: "In a release", sent: "Sent", invoiced: "Invoiced", declined: "Declined" };
const statusLabel = (s: string) => STATUS_LABEL[s] || s;
// how a sheet is named everywhere: the location, then what the work is for
const sheetName = (p: { development?: string; address?: string; job?: string; number?: string }) =>
  [p.development || p.address, p.job].filter(Boolean).join(" · ") || p.number || "proposal";
const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|]/g, "-").slice(0, 120);
// what the office reads when the database says no: the upgrade it needs, or a
// plain "try again" (never the database's own words)
const UPGRADE_MSG = "The portal's database needs an upgrade before this works (Settings → System check).";
const needsUpgrade = (m: string) => /column|schema|relation|qty_map/i.test(m);
// what this phone showed last time paints before the first frame (on the server there is no frame to paint before)
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;
// what is remembered on this phone for the next open: the list, the contracts and each contract's price book
const CACHE = { list: "prop:list", contracts: "prop:contracts", catalog: (cid: string) => `prop:catalog:${cid}` };
const HEAD_FIELDS = [
  ["development", "Development"], ["apt", "Apt"], ["stairhall", "Stairhall"],
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
  // the whole note for a development, pasted off the phone: one walk sheet per apartment
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);
  const CONTRACT_KEY = "proposals.contract";
  const [saveState, setSaveState] = useState<"" | "saving" | "saved">("");
  const [showHead, setShowHead] = useState(false); // walk-sheet header fields tucked away until needed
  const { msg, flash } = useFlash();
  const sheetRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const upgradeHint = (m: string, what = "save") => (needsUpgrade(m) ? UPGRADE_MSG : `Couldn't ${what}. Check your signal and try again.`);
  // which answers came from the database on this visit (a remembered copy never overwrites one)
  const got = useRef({ list: false, contracts: false });

  const load = async () => {
    // the list never shows quantities — leaving qty_map out cuts the payload
    // by far the most; opening a sheet fetches its full row on demand
    const { data, error } = await sb().from("proposals")
      .select("id,number,client_name,job,date,tax_pct,status,notes,contract_id,development,address,apt,stairhall,walk_date,release_number,nycha_staff,vendor_staff,start_date,finish_date,total,created_at")
      .order("created_at", { ascending: false });
    if (error) { // older database without some columns — fall back to full rows
      const { data: d2, error: e2 } = await sb().from("proposals").select("*").order("created_at", { ascending: false });
      if (e2) { setListLoaded(true); return; } // bad signal: what is showing (remembered, or nothing) stays
      const rows = (d2 || []) as Proposal[];
      got.current.list = true;
      remember(CACHE.list, rows);
      setList(rows);
      setListLoaded(true);
      return;
    }
    const rows = (data || []) as Proposal[];
    got.current.list = true;
    remember(CACHE.list, rows);
    setList(rows);
    setListLoaded(true);
  };
  const loadContracts = async () => {
    const { data, error } = await sb().from("contracts").select("id,number,name").order("number");
    if (error) return;
    const cs = (data || []) as Contract[];
    got.current.contracts = true;
    remember(CACHE.contracts, cs);
    setContracts(cs);
    if (cs[0]) setPickId((cur) => cur || cs[0].id);
    // a remembered contract that no longer exists is let go of, so the chooser below picks again
    setListContract((cur) => (cur && cur !== "all" && cur !== "none" && !cs.some((c) => c.id === cur) ? "" : cur));
  };
  // What this phone showed last time paints at once (as soon as the signed-in
  // user is named; before the first paint when they already are) and the
  // database's answers, already on their way, replace it as they land.
  useBeforePaint(() => onCacheUser(() => {
    if (!got.current.list) {
      const rows = cached<Proposal[]>(CACHE.list);
      if (rows && rows.length) { setList(rows); setListLoaded(true); }
    }
    if (!got.current.contracts) {
      const cs = cached<Contract[]>(CACHE.contracts);
      if (cs && cs.length) { setContracts(cs); setPickId((cur) => cur || cs[0].id); }
    }
    const o = cached<Org>("org");
    if (o) setOrg((prev) => prev || o);
  }), []);
  useEffect(() => {
    load();
    sb().from("org").select("*").single().then(({ data }) => { if (data) { setOrg(data as Org); remember("org", data); } });
    loadContracts();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
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
    loadContracts();
    if (doc?.contract_id) {
      const cid = doc.contract_id;
      sb().from("contract_items").select("*").eq("contract_id", cid).order("line")
        .then(({ data, error }) => { if (error) return; const rows = (data || []) as ContractItem[]; remember(CACHE.catalog(cid), rows); setCatalog(rows); });
    }
  }, { skipWhileTyping: true });

  // load the contract's catalog whenever the open walk sheet's contract changes:
  // the book this phone showed last time (a couple of thousand lines) is on
  // screen at once, the database's copy replaces it one round trip later
  useEffect(() => {
    const cid = doc?.contract_id;
    if (!cid) { setCatalog(null); return; }
    setCatalog(cached<ContractItem[]>(CACHE.catalog(cid)));
    let live = true; // a sheet on another contract opened meanwhile: this answer is not for it
    sb().from("contract_items").select("*").eq("contract_id", cid).order("line")
      .then(({ data, error }) => {
        if (!live) return;
        if (error) { setCatalog((prev) => prev || []); return; } // bad signal: the remembered book stays
        const rows = (data || []) as ContractItem[];
        remember(CACHE.catalog(cid), rows);
        setCatalog(rows);
      });
    return () => { live = false; };
  }, [doc?.contract_id]);

  // ---------- open / create ----------
  const openDocId = useRef<string | null>(null); // guards the async fallback fetch below
  const openEditor = async (p: Proposal) => {
    openDocId.current = p.id;
    setDoc(p); setSearch(""); setCollapsed(new Set());
    window.scrollTo(0, 0); // the sheet opens at its top, however far down the list was
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
  // a double tap makes one sheet, not two (the ref catches a second tap that lands before the state does)
  const creatingNow = useRef(false);
  const [creating, setCreating] = useState(false);
  const newWalkSheet = async () => {
    if (contracts.length === 0) { flash("No contracts yet. Upload a release sheet or release PDF first"); return; }
    if (contracts.length > 1 && !pickOpen) { setPickOpen(true); return; }
    if (creatingNow.current) return;
    creatingNow.current = true; setCreating(true);
    try {
      setPickOpen(false);
      const number = await nextNumber("proposals", "PROP");
      forget(CACHE.list); // a write half done is never what the next open paints
      const { data, error } = await sb().from("proposals").insert({
        number, client_name: "New York City Housing Authority", contract_id: pickId || contracts[0].id,
      }).select().single();
      if (error) { flash(upgradeHint(error.message, "make the walk sheet")); return; }
      // the list follows the new sheet's contract, so it is on screen when the editor closes
      const made = data as Proposal;
      if (made.contract_id && listContract !== "all" && listContract !== made.contract_id) pickListContract(made.contract_id);
      await load(); openEditor(made);
    } finally { creatingNow.current = false; setCreating(false); }
  };

  // ---------- the survey PDF ----------
  // The foreman's survey, as a PDF (a Notes export, a photo made into a PDF,
  // a scan, our own form filled in). The server reads it — Claude when it's
  // switched on, the rules otherwise — into what each line is; the sheet is
  // then billed the way our move-out releases are (lib/moveoutRelease.ts):
  // the release's main lines first, the book's own line for anything else it
  // has one for, General Laborer hours for the rest. Over what a super will
  // sign, the owner ticks what comes off. The sheet then opens for a check.
  // A survey is a move-out job: it bills the move-out contract, whatever the
  // list is showing — and only that one, since the release's lines and prices
  // belong to it. Without it in the portal the upload says so.
  const isMoveout = (c: Contract) => contractKey(c.number) === MOVEOUT_CONTRACT; // "2442583", "2442583-332", "02442583" — the same contract, the way the rest of the app reads a number
  const surveyContract = () => contracts.find(isMoveout)?.id || "";
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
      flash("Blank survey saved. Fill the boxes on site, then upload it here");
    } catch (err) { flash(`Couldn't build the form (${err instanceof Error ? err.message.slice(0, 60) : "unknown"})`); }
  };
  // what a survey needs before it can be read, PDF or pasted note alike: a
  // contract to bill, and the move-out one among them
  const moveoutReady = () => {
    if (contracts.length === 0) { flash("No contracts yet. Upload a release sheet or release PDF first"); return false; }
    if (!surveyContract()) { flash(`The portal has no contract ${MOVEOUT_CONTRACT} (the move-out contract) yet. Upload one of its releases on the Releases tab first.`); return false; }
    return true;
  };
  const uploadSurvey = () => { if (moveoutReady()) surveyRef.current?.click(); };
  // what a survey read into, waiting to become the sheet
  // `development`: the development the sheet is for, when the note named it;
  // `pasted`: read off a pasted note, not a PDF (the notes say which)
  type SurveyPlan = { cid: string; file: string; who: string; sv: SmartSurvey; lines: SheetLine[]; labor: SheetLine | null; hours: HourPart[]; unmatched: string[]; twice: string[]; note?: string; bookNote?: string; catalog: ContractItem[]; development: string; pasted?: boolean };
  // the check box: every line the survey read, each with a tick to take it off
  // — the release's lines, the book's, and each small job in the hours
  const [trim, setTrim] = useState<{ plan: SurveyPlan; off: Set<string> } | null>(null);
  // a pasted note's apartments, one check box after another: which one is
  // up, how many sheets are made and skipped so far, and the lines written
  // before the first apartment (they go in the notes of the first sheet made)
  type PasteQueue = { plans: SurveyPlan[]; at: number; made: number; skipped: number; stray: string[] };
  const [pasteQueue, setPasteQueue] = useState<PasteQueue | null>(null);
  // on to the next apartment in the note, or the end of it: the list shows the sheets, nothing opens
  const nextInQueue = (q: PasteQueue, made: boolean) => {
    const next = { ...q, at: q.at + 1, made: q.made + (made ? 1 : 0), skipped: q.skipped + (made ? 0 : 1) };
    if (next.at < q.plans.length) { setPasteQueue(next); setTrim({ plan: q.plans[next.at], off: new Set() }); return; }
    setPasteQueue(null); setTrim(null);
    const strayNote = q.stray.length ? ` · ${q.stray.length} line${q.stray.length === 1 ? "" : "s"} before the first apartment${next.made ? " (in the first sheet's notes)" : ""}: ${q.stray.join("; ")}` : "";
    flash(`${next.made} walk sheet${next.made === 1 ? "" : "s"} made from the note (${next.skipped} skipped)${strayNote}`);
  };
  // the check box closed by hand: a note's queue stops where it is
  const closeCheck = () => {
    setTrim(null);
    if (!pasteQueue) return;
    const left = pasteQueue.plans.length - pasteQueue.at;
    setPasteQueue(null);
    flash(`Stopped: ${pasteQueue.made} walk sheet${pasteQueue.made === 1 ? "" : "s"} made from the note, ${left} apartment${left === 1 ? "" : "s"} not made`);
  };
  const HOUR_KEY = (i: number) => `h:${i}`;
  const planWhere = (sv: SmartSurvey) => [sv.address, sv.apt && `Apt ${sv.apt}`].filter(Boolean).join(" ");
  // what stays and what comes off; the laborer line is the hours kept, rounded up
  const applyOff = (plan: SurveyPlan, off: Set<string>) => {
    const keepLines = plan.lines.filter((l) => l.itemKey !== LABOR_KEY && !off.has(l.code));
    const offLines = plan.lines.filter((l) => l.itemKey !== LABOR_KEY && off.has(l.code));
    const hoursKept = plan.hours.filter((_, i) => !off.has(HOUR_KEY(i)));
    const hoursOff = plan.hours.filter((_, i) => off.has(HOUR_KEY(i)));
    const hourTotal = Math.ceil(hoursKept.reduce((sum, h) => sum + h.hours, 0) - 1e-9);
    const labor = plan.labor && hourTotal > 0 ? { ...plan.labor, qty: hourTotal, label: `General Laborer · ${hourTotal} hour${hourTotal === 1 ? "" : "s"}` } : null;
    return { keep: labor ? [...keepLines, labor] : keepLines, offLines, hoursKept, hoursOff, hourTotal };
  };
  // one walk sheet from the plan — what came off goes in its notes, so nothing is forgotten
  const makeSheet = async (plan: SurveyPlan, off: Set<string>) => {
    const { keep, offLines, hoursKept, hoursOff, hourTotal } = applyOff(plan, off);
    const total = sheetTotal(keep);
    const byCode = new Map(plan.catalog.map((c) => [c.code, c]));
    // the lines written before the first apartment of a pasted note ride on the first sheet made from it
    const stray = pasteQueue && pasteQueue.made === 0 ? pasteQueue.stray : [];
    const noteLines = [
      `✓ ${plan.who} from ${plan.pasted ? plan.file : `the survey PDF (${plan.file})`}`,
      ...(stray.length ? [`⚠ Lines before the first apartment: ${stray.join("; ")}`] : []),
      ...(hoursKept.length ? [`→ ${hourTotal} hour${hourTotal === 1 ? "" : "s"} General Laborer: ${hoursNote(hoursKept)}`] : []),
      ...(plan.twice.length ? [`Written twice: ${plan.twice.join("; ")}`] : []),
      ...(plan.unmatched.length ? [`⚠ Not on the move-out list: ${plan.unmatched.join("; ")}`] : []),
      ...(offLines.length ? [`Left off: ${offLines.map((l) => `${l.label} (${fmt(l.qty * l.unit_price)})`).join("; ")}`] : []),
      ...(hoursOff.length ? [`Hours left off: ${hoursNote(hoursOff)}`] : []),
    ];
    const number = await nextNumber("proposals", "PROP");
    const qty_map: Record<string, number> = {};
    keep.forEach((l) => { qty_map[l.code] = (qty_map[l.code] || 0) + l.qty; });
    forget(CACHE.list); // a write half done is never what the next open paints
    const { data, error: pe } = await sb().from("proposals").insert({
      number, client_name: "New York City Housing Authority", contract_id: plan.cid,
      job: plan.sv.kind || "Move-out", address: plan.sv.address, apt: plan.sv.apt, walk_date: localISO(), qty_map, total, notes: noteLines.join("\n"),
      ...(plan.development ? { development: plan.development } : {}),
    }).select().single();
    if (pe || !data) { flash(upgradeHint(pe?.message || "", "make the walk sheet")); return; }
    const pid = (data as Proposal).id;
    const full = keep.map((l, i) => ({ proposal_id: pid, code: l.code, description: l.description, unit: l.uom, qty: l.qty, unit_price: l.unit_price, sort: i, category: byCode.get(l.code)?.category || "", line: l.line }));
    let { error: ie } = await sb().from("proposal_items").insert(full);
    if (ie && /column/i.test(ie.message)) ({ error: ie } = await sb().from("proposal_items").insert(full.map(({ category: _c, line: _l, ...rest }) => rest)));
    if (ie) flash(upgradeHint(ie.message, "save the sheet's lines"));
    await load();
    pickListContract(plan.cid);
    const offCount = offLines.length + hoursOff.length;
    if (pasteQueue) {
      // one apartment of a pasted note: on to the next check box, no editor,
      // no flash per sheet (the end of the note says how many were made)
      nextInQueue(pasteQueue, true);
      return;
    }
    setTrim(null);
    flash(`Walk sheet ${number} made · ${fmt(total)}${offCount ? ` · ${offCount} left off (in the notes)` : ""} · check the counts`);
    openEditor(data as Proposal); // straight onto the sheet, counts in view
  };
  // the contract's price book, with the release's lines in it — the sheet,
  // its PDF and the release it becomes all read lines out of the book, so
  // the lines the survey bills have to be there. Added once, if missing.
  // Null when the book can't be read or added to (the snag is flashed).
  const moveoutCatalog = async (cid: string): Promise<{ catalog: ContractItem[]; bookNote: string } | null> => {
    const { data: cat, error } = await sb().from("contract_items").select("*").eq("contract_id", cid).order("line");
    if (error) { flash(upgradeHint(error.message, "load the price book")); return null; }
    let catalog = (cat || []) as ContractItem[];
    const have = new Set(catalog.map((c) => c.code));
    const missing = RELEASE_LINES.filter((r) => !have.has(r.code));
    let bookNote = "";
    if (missing.length) {
      const rows = missing.map((r) => ({ contract_id: cid, line: r.line, code: r.code, category: r.category, description: r.description, uom: r.uom, unit_price: r.unit_price }));
      const { data: added, error: ae } = await sb().from("contract_items").insert(rows).select();
      if (ae && /duplicate|unique/i.test(ae.message)) {
        // another phone got there first (the book holds each code once — RUN_ME section 16): take the book as it is now
        const { data: again } = await sb().from("contract_items").select("*").eq("contract_id", cid).order("line");
        catalog = (again || []) as ContractItem[];
      } else if (ae) { flash(needsUpgrade(ae.message) ? UPGRADE_MSG : `Couldn't add release ${MOVEOUT_RELEASE}'s lines to this contract's price book. Check your signal and try again.`); return null; }
      else {
        catalog = [...catalog, ...((added && added.length ? added : rows) as ContractItem[])];
        bookNote = `${missing.length} line${missing.length === 1 ? "" : "s"} from release ${MOVEOUT_RELEASE} added to this contract's price book`;
      }
    }
    remember(CACHE.catalog(cid), catalog); // the same book the editor opens with
    return { catalog, bookNote };
  };
  const handleSurveyPdf = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    const cid = surveyContract();
    if (!file || !cid) return;
    setSurveyBusy(true);
    try {
      const book = await moveoutCatalog(cid);
      if (!book) return;
      const { catalog, bookNote } = book;
      const form = new FormData();
      form.append("file", file);
      const token = (await sb().auth.getSession()).data.session?.access_token || "";
      const res = await fetch("/api/parse-survey", { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; survey?: SmartSurvey; readBy?: "claude" | "rules"; note?: string };
      if (!res.ok || !out.ok || !out.survey) { flash(out.error || `The survey couldn't be read${!res.ok ? ` (server said ${res.status})` : ""}. Try again.`); return; }
      const sv = out.survey;
      const who = out.readBy === "claude" ? "Read by Claude" : "Read by the portal's own reader";
      // the written items, billed the way the release bills them
      const billed = billSurvey(sv.items, catalog);
      const lines = billed.lines;
      const unmatched = billed.unmatched.map((it) => `${it.written}${it.note ? ` (${it.note})` : ""}`);
      if (lines.length === 0) { flash(`${who}: nothing on that survey is on the move-out list${out.note ? ` (${out.note})` : sv.items.length === 0 ? " (no lines read off the page)" : ""}`); return; }
      const plan: SurveyPlan = { cid, file: file.name, who, sv, lines, labor: lines.find((l) => l.itemKey === LABOR_KEY) || null, hours: billed.hours, unmatched, twice: billed.twice, note: out.note, bookNote, catalog, development: "" };
      // the check box: every line read, each with a tick to take it off — and
      // over what a super will sign, the sheet waits until enough comes off
      setTrim({ plan, off: new Set() });
    } catch (err) {
      flash(`Upload hit a snag, try again (${err instanceof Error ? err.message.slice(0, 80) : "unknown error"})`);
    } finally { setSurveyBusy(false); }
  };

  // ---------- the pasted note ----------
  // The whole note for a development, pasted off the phone's Notes app:
  //
  //   Grant houses Moveout
  //   Building 3 11K
  //   42 + 24 B and W
  //   2 24s door sliding closet
  //
  //   B1 5K
  //   1 24 inch door privacy
  //
  // A line with the building and apartment starts each apartment; the lines
  // under it are its survey (lib/surveyTemplate.ts splits it). Every apartment
  // is read on the server the way a PDF is (Claude, or the rules), billed
  // against the move-out book, and queued: one check box after another, one
  // walk sheet each. An apartment nothing on the list reads still gets its
  // check box, so its lines show before it is skipped.
  const openPasteNotes = () => { if (moveoutReady()) setPasteOpen(true); };
  type PastedRead = { survey: SmartSurvey; readBy: "claude" | "rules"; note?: string; text: string };
  const readPastedNotes = async () => {
    const cid = surveyContract();
    if (!cid) return;
    const split = splitSurveyNotes(pasteText);
    if (split.apartments.length === 0) { flash("No apartment found. Start each one with its building and apartment, like Building 3 11K"); return; }
    setPasteBusy(true);
    try {
      const book = await moveoutCatalog(cid);
      if (!book) return;
      // each apartment travels as its own survey: the building and apartment line, then its lines
      const headers = split.apartments.map((a) => `${a.address} ${a.apt}`.trim());
      const texts = split.apartments.map((a, i) => [headers[i], a.text].filter(Boolean).join("\n"));
      const token = (await sb().auth.getSession()).data.session?.access_token || "";
      const reads: PastedRead[] = [];
      for (let i = 0; i < texts.length; i += 12) { // the server reads up to 12 apartments at a time
        const res = await fetch("/api/parse-survey", {
          method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ texts: texts.slice(i, i + 12) }),
        });
        const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; surveys?: PastedRead[] };
        if (!res.ok || !out.ok || !out.surveys) { flash(out.error || `The note couldn't be read${!res.ok ? ` (server said ${res.status})` : ""}. Try again.`); return; }
        reads.push(...out.surveys);
      }
      if (reads.length !== texts.length) { flash("The note couldn't be read (the server sent back the wrong number of apartments)"); return; }
      const file = `pasted notes${split.development ? ` (${split.development})` : ""}`;
      const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
      const plans = split.apartments.map((a, i): SurveyPlan => {
        const { survey: sv, readBy, note } = reads[i];
        // the header is the split's: this building, this apartment, the note's kind of job
        if (a.address && norm(sv.address) !== norm(a.address)) sv.address = a.address;
        sv.apt = a.apt;
        sv.kind = a.kind || sv.kind || "Move-out";
        // a reader that hands the building line back as an item (nothing on the list is it) is handing back the header: not an item
        sv.items = sv.items.filter((it) => it.key || norm(it.written) !== norm(headers[i]));
        const who = readBy === "claude" ? "Read by Claude" : "Read by the portal's own reader";
        const billed = billSurvey(sv.items, book.catalog);
        const unmatched = billed.unmatched.map((it) => `${it.written}${it.note ? ` (${it.note})` : ""}`);
        // the book note is one event, said once; an apartment with no lines keeps its (empty) plan for the check box to show what wasn't read
        return { cid, file, who, sv, lines: billed.lines, labor: billed.lines.find((l) => l.itemKey === LABOR_KEY) || null, hours: billed.hours, unmatched, twice: billed.twice, note, bookNote: i === 0 ? book.bookNote : "", catalog: book.catalog, development: split.development, pasted: true };
      });
      setPasteOpen(false); setPasteText("");
      setPasteQueue({ plans, at: 0, made: 0, skipped: 0, stray: split.stray });
      setTrim({ plan: plans[0], off: new Set() });
    } catch (err) {
      flash(`Reading hit a snag, try again (${err instanceof Error ? err.message.slice(0, 80) : "unknown error"})`);
    } finally { setPasteBusy(false); }
  };

  // ---------- saving ----------
  const saveDoc = async (patch: Partial<Proposal>, silent = false) => {
    if (!doc) return;
    setDoc({ ...doc, ...patch });
    const { error } = await sb().from("proposals").update(patch).eq("id", doc.id);
    if (error) flash(upgradeHint(error.message)); else if (!silent) flash("Walk sheet saved");
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
    if (doc.contract_id && !catalog) { flash("Price book is still loading, one second"); return; }
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
      if (error) flash(upgradeHint(error.message, "save the sheet's lines"));
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
        // a code repeated on the sheet is one line in the book (the book holds each code once)
        const codesSeen = new Set<string>();
        const repeats = rows.filter((r) => { if (codesSeen.has(r.code)) return true; codesSeen.add(r.code); return false; }).length;
        const uniq = rows.filter((r, i) => rows.findIndex((x) => x.code === r.code) === i);
        if (uniq.length === 0) { flash("No lines found on that sheet"); return; }
        forget(CACHE.catalog(doc.contract_id!)); // a book half replaced is never what the next open paints
        const { error: de } = await sb().from("contract_items").delete().eq("contract_id", doc.contract_id!);
        if (de) { flash(upgradeHint(de.message, "replace the price book")); return; }
        for (let i = 0; i < uniq.length; i += 500) {
          const { error } = await sb().from("contract_items").insert(uniq.slice(i, i + 500).map((r) => ({ ...r, contract_id: doc.contract_id })));
          // the old book is already cleared: say so, or a half-loaded book looks complete
          if (error) { flash(needsUpgrade(error.message) ? UPGRADE_MSG : `Upload stopped partway: only ${i} of ${uniq.length} lines made it. Upload the sheet again to finish the book`); return; }
        }
        const { data } = await sb().from("contract_items").select("*").eq("contract_id", doc.contract_id!).order("line");
        const book = (data || []) as ContractItem[];
        remember(CACHE.catalog(doc.contract_id!), book);
        setCatalog(book);
        flash(`Loaded ${uniq.length} price book lines for this contract${repeats ? ` (${repeats} repeated code${repeats === 1 ? "" : "s"} skipped)` : ""}`);
      } catch { flash("Couldn't read that sheet. Save it as .xlsx or .csv"); }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  // ---------- export: NYCHA walk-sheet layout, used lines only, bordered ----------
  const exportWalkSheet = async () => {
    try { await ensureXLSX(); } catch { flash("Couldn't load the Excel engine. Check your signal and try again"); return; }
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
      flash(lines.length ? `PDF saved · ${lines.length} line${lines.length === 1 ? "" : "s"}` : "PDF saved · no quantities on that sheet yet");
    } catch (err) {
      flash(`Couldn't build the PDF (${err instanceof Error ? err.message.slice(0, 60) : "unknown"})`);
    } finally { setPdfBusy(""); }
  };

  // step 1: ask which release number this walk sheet becomes
  const addToRelease = (p: Proposal) => {
    if (!contracts.find((x) => x.id === p.contract_id)) { flash("That walk sheet isn't tied to a contract"); return; }
    setRelAsk({ p, value: (p.release_number || "").trim() });
  };
  // the Add to release dialog's one action: close it, then make or update the release
  const submitRelAsk = () => {
    if (!relAsk || !relAsk.value.trim()) return;
    const { p, value } = relAsk;
    setRelAsk(null);
    performAddToRelease(p, value.trim());
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
      if (error) { flash(upgradeHint(error.message, "update the release")); return; }
      await sb().from("release_items").delete().eq("release_id", relId);
    } else {
      const base = {
        contract_id: c.id, rel_number: rel, location: p.development || "", buildings: addr,
        ticket: "", amount: total, pre_check: "", date_completed: "", payroll_done: false, received: false, canceled: false, labor_hours: 0, assigned_to: null,
      };
      let { data, error } = await sb().from("releases").insert({ ...base, address: addr }).select().single();
      if (error && /column/i.test(error.message)) ({ data, error } = await sb().from("releases").insert(base).select().single());
      if (error || !data) { flash(upgradeHint(error?.message || "", "make the release")); return; }
      relId = (data as { id: string }).id;
    }
    const { error: e2 } = await sb().from("release_items").insert(its.map((it) => ({
      release_id: relId, line: it.line || 0, code: it.code, description: it.description,
      qty: Number(it.qty) || 0, uom: it.unit, unit_price: Number(it.unit_price) || 0,
      amount: (Number(it.qty) || 0) * (Number(it.unit_price) || 0),
    })));
    if (e2) { flash(needsUpgrade(e2.message) ? UPGRADE_MSG : "Release saved, but its lines didn't. Check your signal and try again."); return; }
    await sb().from("proposals").update({ status: "approved" }).eq("id", p.id);
    if (doc && doc.id === p.id) setDoc({ ...doc, status: "approved" });
    load();
    flash(`Release ${rel} ${existing && existing[0] ? "updated" : "created"} on contract ${c.number}. See the Releases tab`);
  };

  // ---------- delete (works from the dashboard) ----------
  const deleteProposal = async (p: Proposal) => {
    if (!window.confirm(`Delete walk sheet ${p.number}? This can't be undone.`)) return;
    // try the proposal itself first — if that fails for any reason, nothing
    // else has been touched. Old-style invoices block it via foreign key, so
    // only then clear them (and their lines) and try once more.
    forget(CACHE.list); // a write half done is never what the next open paints
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
    if (error) { flash("Couldn't delete the walk sheet. Check your signal and try again."); return; }
    if (doc && doc.id === p.id) setDoc(null);
    load(); flash("Walk sheet deleted");
  };

  // ---------- walk sheet grouping / filtering ----------
  // the search settles before the book is rebuilt, and only so many lines
  // are drawn at once — a contract book runs to a couple of thousand, and
  // redrawing them all on every letter is what made this feel stuck. Any
  // line that already has a quantity is always drawn, wherever it sits.
  const searchSettled = useDebounced(search);
  const SHOWN_LINES = 200;
  const { groups, hiddenLines } = useMemo(() => {
    if (!catalog) return { groups: [] as { category: string; rows: ContractItem[] }[], hiddenLines: 0 };
    const q = searchSettled.trim().toLowerCase();
    const found = q
      ? catalog.filter((ci) => String(ci.line) === q || matches(q, ci.code, ci.description, ci.category))
      : catalog;
    const filled = new Set(found.filter((ci) => parseNum(qty[ci.code] || "") > 0).map((ci) => ci.id));
    let room = Math.max(SHOWN_LINES, filled.size);
    const rows = found.filter((ci) => { if (filled.has(ci.id)) return true; if (room <= 0) return false; room -= 1; return true; });
    const out: { category: string; rows: ContractItem[] }[] = [];
    rows.forEach((ci) => {
      const g = out[out.length - 1];
      if (g && g.category === ci.category) g.rows.push(ci);
      else out.push({ category: ci.category, rows: [ci] });
    });
    return { groups: out, hiddenLines: found.length - rows.length };
  }, [catalog, searchSettled, qty]);
  // the total bar sits fixed along the bottom while a walk sheet is open: the toast lifts above it
  const barUp = !!(doc && doc.contract_id);
  useEffect(() => {
    document.documentElement.style.setProperty("--bottom-bar", barUp ? "56px" : "0px");
    return () => { document.documentElement.style.setProperty("--bottom-bar", "0px"); };
  }, [barUp]);

  // ================= WALK SHEET EDITOR =================
  if (doc && doc.contract_id) {
    const c = contracts.find((x) => x.id === doc.contract_id);
    return (
      <div key={doc.id} className="page-enter pb-24">
        {!!pdfBusy && <div className="busy-bar" aria-busy="true" aria-label="Working" />}
        <PageHeader title={doc.number} back={{ onClick: closeEditor }}
          stamp={<>
            <Stamp label={statusLabel(doc.status)} tone={tone(doc.status) as "ok"} />
            {saveState && <span className="text-xs text-inksoft">{saveState === "saving" ? "Saving…" : "Saved ✓"}</span>}
          </>}
          menu={[
            { label: "Preview and print", onSelect: () => setPrintOpen(true) },
            { label: "Download PDF", glyph: "⬇", disabled: !!pdfBusy, onSelect: () => downloadPdf(doc) },
            { label: "Walk sheet (Excel)", glyph: "⬇", onSelect: exportWalkSheet },
          ]} />
        <input ref={sheetRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleContractSheet} />

        <div className="card card-pad mb-3">
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            <div className="col-span-2"><label className="section-label mb-1" htmlFor="ws-work">Work</label>
              <input id="ws-work" className="field" placeholder="e.g. Move-out, plaster and paint" value={doc.job || ""}
                onChange={(e) => setDoc({ ...doc, job: e.target.value })} onBlur={(e) => saveDoc({ job: e.target.value }, true)} /></div>
            <div className="col-span-2"><div className="section-label mb-1">Contract</div>
              <ContractPicker contracts={contracts} value={doc.contract_id || ""} onChange={(id) => saveDoc({ contract_id: id }, true)} /></div>
            <div className="col-span-2"><label className="section-label mb-1" htmlFor="ws-address">Address</label>
              <input id="ws-address" className="field" placeholder="e.g. 21-10 41st Ave, Queensbridge" value={doc.address || ""}
                onChange={(e) => setDoc({ ...doc, address: e.target.value })} onBlur={(e) => saveDoc({ address: e.target.value }, true)} /></div>
          </div>
          <Disclosure className="mt-1.5 border-t border-rulesoft pt-1" label="Sheet header" sublabel="dates, staff, apt, release #"
            open={showHead} onToggle={() => setShowHead(!showHead)}>
            <div className="grid grid-cols-2 gap-2.5 pt-1.5 md:grid-cols-4">
              {HEAD_FIELDS.map(([k, label]) => (
                <div key={k}><label className="section-label mb-1" htmlFor={`ws-${k}`}>{label}</label>
                  <input id={`ws-${k}`} className="field" type={/date/.test(k) ? "date" : "text"} value={doc[k] || ""}
                    onChange={(e) => setDoc({ ...doc, [k]: e.target.value })}
                    onBlur={(e) => saveDoc({ [k]: e.target.value } as Partial<Proposal>, true)} /></div>
              ))}
            </div>
          </Disclosure>
        </div>

        {catalog === null ? (
          <div className="card">
            {[0, 1, 2].map((i) => (
              /* the book's shape, shimmering, while its lines load */
              <div key={`sk${i}`} className="flex items-start gap-3 border-b border-rulesoft p-3 last:border-b-0">
                <div className="min-w-0 flex-1"><div className="skeleton h-3 w-20" /><div className="skeleton mt-2 h-4 w-3/4" /></div>
                <div className="skeleton h-11 w-20" />
              </div>
            ))}
          </div>
        ) : catalog.length === 0 ? (
          <div className="card card-pad border-work">
            <div className="text-sm text-inksoft">
              No price book for contract {c?.number} yet. Upload the contract&apos;s price sheet once (the xlsx with Line, Item, Category, Description, UOM and Price columns); every walk sheet on this contract uses it.
            </div>
            <button type="button" className="btn btn-primary mt-3" onClick={() => sheetRef.current?.click()}>Upload price sheet</button>
          </div>
        ) : (
          <>
            <input type="search" enterKeyHint="search" autoComplete="off" className="field mb-1" placeholder="Search line #, code, description…"
              value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="mb-3 text-[12px] text-inksoft">
              {catalog.length} lines in this price book
              {hiddenLines > 0 ? ` · showing ${SHOWN_LINES} at a time, type to find the rest` : ""}
            </div>
            {groups.map((g, gi) => {
              const isOpen = !!searchSettled || !collapsed.has(g.category);
              const filled = g.rows.filter((ci) => parseNum(qty[ci.code] || "") > 0).length;
              return (
                <Disclosure key={`${g.category}-${gi}`} className="card mb-2 overflow-hidden px-3" label={g.category || "Uncategorized"}
                  right={`${filled ? `${filled} filled · ` : ""}${g.rows.length} line${g.rows.length === 1 ? "" : "s"}`}
                  open={isOpen} onToggle={() => { const next = new Set(collapsed); if (next.has(g.category)) next.delete(g.category); else next.add(g.category); setCollapsed(next); }}>
                  {g.rows.map((ci) => {
                    const n = parseNum(qty[ci.code] || "");
                    return (
                      <div key={ci.id} className={`-mx-3 flex items-start gap-3 border-t border-rulesoft px-3 py-2.5 ${n > 0 ? "bg-work/5" : ""}`}>
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-[12px] text-inksoft">#{ci.line} · {ci.code}</div>
                          <div className="text-[13px] leading-snug">{ci.description}</div>
                          <div className="font-mono text-[12px] text-inksoft">{fmt(Number(ci.unit_price))} / {ci.uom}</div>
                        </div>
                        <div className="shrink-0 text-right">
                          <input className="min-h-[44px] w-20 rounded-sm border border-rulesoft px-2 py-2.5 text-right font-mono text-base" inputMode="decimal" placeholder="qty"
                            aria-label={`Quantity, line ${ci.line} ${ci.code}`}
                            value={qty[ci.code] || ""} onChange={(e) => setLineQty(ci.code, e.target.value)} />
                          <div className="mt-0.5 font-mono text-xs font-semibold">{n > 0 ? fmt(n * Number(ci.unit_price)) : ""}</div>
                        </div>
                      </div>
                    );
                  })}
                </Disclosure>
              );
            })}
            {groups.length === 0 && <div className="empty">Nothing matches “{search}”. Clear the box to see every line.</div>}
          </>
        )}

        <div className="anim-sheet fixed inset-x-0 bottom-0 z-30 border-t-2 border-ink bg-card px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex max-w-5xl items-center justify-between">
            <span className="text-xs uppercase tracking-widest text-inksoft">{billed.length} line{billed.length === 1 ? "" : "s"} filled</span>
            <span className="font-mono text-xl font-semibold">Total {fmt(grand)}</span>
          </div>
        </div>

        {printOpen && (
          <PrintShell title={fileSafe(sheetName(doc))} onClose={() => setPrintOpen(false)} wide sheetClass="text-logo-ink"
            toolbar={<button type="button" className="btn btn-ghost bg-white" onClick={exportWalkSheet}>⬇ Walk sheet (Excel)</button>}>
              <Letterhead />
              {/* the same sheet the PDF download draws, in the logo's colors */}
              <div className="mt-5 flex items-start justify-between">
                <div>
                  <div className="font-display text-3xl font-bold uppercase tracking-wide text-logo-brown">Proposal</div>
                  <div className="text-[13px] text-logo-teal">NYCHA Walk Sheet</div>
                </div>
                <div className="text-right text-[13px] leading-snug">
                  <div><span className="text-[11px] font-bold uppercase tracking-widest text-logo-tan">Sheet # </span><b className="text-logo-brown">{doc.number}</b></div>
                  <div><span className="text-[11px] font-bold uppercase tracking-widest text-logo-tan">Date </span><b className="text-logo-brown">{new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })}</b></div>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-x-10 gap-y-2 bg-logo-cream px-4 py-3">
                {([["Contract #", c?.number], ["Development", doc.development],
                  ["Address", [doc.address, doc.apt && `Apt ${doc.apt}`, doc.stairhall && `Stairhall ${doc.stairhall}`].filter(Boolean).join(", ")],
                  ["Release #", doc.release_number], ["Walk date", doc.walk_date],
                  ["NYCHA staff", doc.nycha_staff], ["Vendor staff", doc.vendor_staff]] as [string, string | undefined][])
                  .filter(([l, v]) => v || l === "Contract #" || l === "Development").map(([l, v]) => (
                  <div key={l}>
                    <div className="text-[11px] font-bold uppercase tracking-widest text-logo-tan">{l}</div>
                    <div className="text-[14px] font-bold text-logo-brown">{v || ""}</div>
                  </div>
                ))}
              </div>
              {(doc.job || "").trim() && (
                <div className="mt-5">
                  <div className="text-[11px] font-bold uppercase tracking-widest text-logo-teal">Scope of Work</div>
                  <div className="mt-1 h-px w-8 bg-logo-teal" />
                  <div className="mt-2 text-[13px]">{doc.job}</div>
                </div>
              )}
              <table className="mt-6 w-full border-collapse text-[12px]">
                <thead><tr className="border-b-2 border-logo-brown text-left font-display text-[11px] uppercase tracking-widest text-logo-tan">
                  <th className="p-1.5">Line</th><th className="p-1.5">Item</th>
                  <th className="p-1.5">Description</th><th className="p-1.5">UOM</th>
                  <th className="p-1.5 text-right">Qty</th><th className="p-1.5 text-right">Price</th><th className="p-1.5 text-right">Total</th>
                </tr></thead>
                <tbody>
                  {billed.map((it, i) => (
                    <tr key={i} className="align-top border-b border-logo-hair">
                      <td className="p-1.5 font-mono text-logo-muted">{it.line}</td>
                      <td className="p-1.5 font-mono text-logo-muted">{it.code}</td>
                      <td className="p-1.5">
                        <div>{it.description}</div>
                        {it.category && <div className="text-[11px] text-logo-muted">Category: {it.category}</div>}
                      </td>
                      <td className="p-1.5 font-mono text-[11px] text-logo-muted">{it.unit}</td>
                      <td className="p-1.5 text-right font-mono">{it.qty.toLocaleString("en-US")}</td>
                      <td className="p-1.5 text-right font-mono text-logo-muted">{fmt(it.unit_price)}</td>
                      <td className="p-1.5 text-right font-mono font-semibold text-logo-brown">{fmt(it.qty * it.unit_price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-3 flex items-center justify-end gap-6 bg-logo-brown px-3 py-2.5 text-white">
                <div className="font-display text-[13px] font-bold uppercase tracking-widest">Total</div>
                <div className="font-mono text-lg font-bold">{fmt(grand)}</div>
              </div>
          </PrintShell>
        )}
        <Toast msg={msg} />
      </div>
    );
  }

  // ================= LEGACY EDITOR (old proposals without a contract) =================
  if (doc) {
    const total = grandTotal(items, doc.tax_pct);
    return (
      <div key={doc.id} className="page-enter">
        <PageHeader title={doc.number} back={{ onClick: closeEditor }} stamp={<Stamp label={statusLabel(doc.status)} tone={tone(doc.status) as "ok"} />} />
        <div className="card card-pad mb-3 text-sm text-inksoft">
          {doc.client_name || "No client"}{doc.job ? ` · ${doc.job}` : ""}. This is an older proposal, shown read-only. New work goes on walk sheets.
        </div>
        {items.length === 0 ? <div className="empty mb-3">No lines on this proposal.</div> : (
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
            </tbody>
          </table>
        </div>
        )}
        <div className="card card-pad flex justify-end"><div className="font-mono text-xl font-semibold">Total {fmt(total)}</div></div>
        <Toast msg={msg} />
      </div>
    );
  }

  // ================= LIST =================
  return (
    <div key="list" className="page-enter">
      {(surveyBusy || pasteBusy || !!pdfBusy) && <div className="busy-bar" aria-busy="true" aria-label="Working" />}
      <PageHeader title="Proposals" sub="NYCHA walk sheets, priced from the contract's price book"
        primary={<button type="button" className={`btn btn-primary${creating ? " btn-busy" : ""}`} aria-busy={creating || undefined} disabled={creating} onClick={newWalkSheet}>+ New walk sheet</button>}
        menu={[
          { label: "Upload survey PDF", glyph: "📄", disabled: surveyBusy, title: "Reads a survey PDF into a walk sheet", onSelect: uploadSurvey },
          { label: "Blank survey form (PDF)", glyph: "⬇", title: "The blank survey form to fill on site", onSelect: downloadSurveyForm },
        ]}>
        <button type="button" className="btn btn-ghost" data-paste-notes onClick={openPasteNotes} disabled={surveyBusy || pasteBusy} title="One walk sheet per apartment from a pasted note">📝 Paste notes</button>
      </PageHeader>
      <input ref={surveyRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={handleSurveyPdf} />
      {pasteOpen && (
        <Modal title="Paste the note" onClose={() => { if (!pasteBusy) setPasteOpen(false); }}
          primary={<button type="button" className={`btn btn-primary${pasteBusy ? " btn-busy" : ""}`} aria-busy={pasteBusy || undefined} data-paste-read onClick={readPastedNotes} disabled={pasteBusy || !pasteText.trim()}>Read the note</button>}
          secondary={<button type="button" className="btn btn-ghost" onClick={() => setPasteOpen(false)} disabled={pasteBusy}>Cancel</button>}>
          <div className="mb-2 text-[13px] text-inksoft">Start each apartment with its building and apartment on one line (Building 3 11K), then one item per line. The first line can name the development.</div>
          {/* 16px type: iOS zooms in on anything smaller when it gets the focus. The box never grows past what the
              phone's keyboard leaves of the sheet (title, this line and the Read button take about 16rem), so the
              note scrolls inside it and the Read button stays in reach; on a desk the rows decide */}
          <textarea data-paste-text className="field min-h-[7rem] text-[16px]" style={{ maxHeight: "calc(100dvh - var(--kb, 0px) - 16rem)" }} rows={12} value={pasteText} onChange={(e) => setPasteText(e.target.value)} disabled={pasteBusy} autoFocus
            placeholder={"Grant houses Moveout\nBuilding 3 11K\n42 + 24 B and W\n2 24s door sliding closet\n\nB1 5K\n1 24 inch door privacy"} />
        </Modal>
      )}
      {trim && (() => {
        const { plan, off } = trim;
        const a = applyOff(plan, off);
        const now = sheetTotal(a.keep);
        const over = now - DEFAULT_CAP;
        const nothing = a.keep.length === 0;
        const toggle = (key: string, on: boolean) => { const next = new Set(off); if (on) next.add(key); else next.delete(key); setTrim({ plan, off: next }); };
        const row = (key: string, title: string, sub: string, right: string, pair?: string) => (
          <label key={key} className={`flex min-h-[44px] cursor-pointer items-center gap-3 px-3 py-2 ${off.has(key) ? "bg-alert/5 line-through opacity-70" : ""}`}>
            <input type="checkbox" className="h-5 w-5 shrink-0" checked={off.has(key)} onChange={(e) => toggle(key, e.target.checked)} />
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold">{title}</span>
              <span className="block truncate text-[12px] text-inksoft">{sub}</span>
              {pair && <span className="block text-[12px] font-semibold text-alert">{pair}</span>}
            </span>
            <span className="shrink-0 font-mono text-[14px] font-semibold">{right}</span>
          </label>
        );
        return (
          <Modal wide title={over > 0 ? `Over ${fmt(DEFAULT_CAP)}` : pasteQueue ? `${[plan.sv.address, plan.sv.apt && `Apt ${plan.sv.apt}`].filter(Boolean).join(" · ") || "This apartment"} (${pasteQueue.at + 1} of ${pasteQueue.plans.length})` : "Check the walk sheet"} onClose={closeCheck}
            footer={<div className="flex flex-wrap items-center justify-between gap-2">
              <span className={`font-mono text-base font-semibold ${over > 0 ? "text-alert" : "text-ok"}`}>{fmt(now)} {over > 0 ? `· ${fmt(over)} over the ${fmt(DEFAULT_CAP)} cap` : `· under the ${fmt(DEFAULT_CAP)} cap ✓`}</span>
              <div className="flex flex-wrap gap-2">
                {pasteQueue && <button type="button" className="btn btn-ghost" data-skip-apartment disabled={surveyBusy} onClick={() => nextInQueue(pasteQueue, false)}>Skip this apartment</button>}
                <button type="button" className={`btn btn-primary${surveyBusy ? " btn-busy" : ""}`} aria-busy={surveyBusy || undefined} disabled={over > 0 || nothing || surveyBusy} title={over > 0 ? "Take more off first" : nothing ? "Nothing left on the sheet" : ""}
                  onClick={async () => { setSurveyBusy(true); try { await makeSheet(plan, off); } finally { setSurveyBusy(false); } }}>
                  Make the walk sheet
                </button>
              </div>
            </div>}>
            {pasteQueue && <div className="mb-1 text-[12px] text-inksoft">📝 From the note{plan.development ? `: ${plan.development}` : ""} · apartment {pasteQueue.at + 1} of {pasteQueue.plans.length}</div>}
            <div className="mb-2 text-[13px] text-inksoft">
              <b className="text-ink">{planWhere(plan.sv) || "This survey"}</b>: {plan.who.charAt(0).toLowerCase() + plan.who.slice(1)}, {plan.sv.items.length} line{plan.sv.items.length === 1 ? "" : "s"}, <b className="text-ink">{fmt(sheetTotal(plan.lines))}</b>{over > 0 ? <>, <b className="text-alert">{fmt(sheetTotal(plan.lines) - DEFAULT_CAP)} over</b> what a super will sign</> : null}.
              Tick anything that comes off; it&apos;s written in the sheet&apos;s notes so it isn&apos;t forgotten.
              {plan.hours.some((h) => h.also) ? " A job the price book also prices shows twice, as its hours and as the book's line. Tick off the one that doesn't apply." : ""}
            </div>
            <div className="divide-y divide-rulesoft rounded-sm border border-rulesoft">
              {plan.lines.filter((l) => l.itemKey !== LABOR_KEY).map((l) => row(l.code, l.label, `#${l.line} ${l.description} · ${l.qty} × ${fmt(l.unit_price)}`, fmt(l.qty * l.unit_price), l.alsoHours ? "Also in the hours below: keep one" : undefined))}
              {plan.hours.map((h, i) => row(HOUR_KEY(i), h.written, `${h.label} · General Laborer hours`, `${h.hours}h`, h.also ? `Also line #${plan.lines.find((l) => l.code === h.also)?.line ?? h.also} above: keep one` : undefined))}
              {plan.labor && a.hourTotal > 0 && (
                <div className="flex min-h-[44px] items-center gap-3 bg-paper px-3 py-2">
                  <span className="h-5 w-5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-semibold">General Laborer · {a.hourTotal} hour{a.hourTotal === 1 ? "" : "s"}</span>
                    <span className="block truncate text-[12px] text-inksoft">#{plan.labor.line} {plan.labor.description} · {a.hourTotal} × {fmt(plan.labor.unit_price)}: the hours above, rounded up</span>
                  </span>
                  <span className="shrink-0 font-mono text-[14px] font-semibold">{fmt(a.hourTotal * plan.labor.unit_price)}</span>
                </div>
              )}
            </div>
            {plan.twice.length > 0 && <div className="mt-2 text-[12px] text-inksoft">Written twice: {plan.twice.join("; ")}</div>}
            {plan.unmatched.length > 0 && (
              <div data-unmatched className="mt-2 rounded-sm border border-alert/40 bg-alert/5 px-3 py-2 text-[12px] text-alert">
                <span className="font-semibold">⚠ Not on the move-out list, add by hand on the sheet:</span> {plan.unmatched.join("; ")}
              </div>
            )}
            {plan.note && <div className="mt-1 text-[12px] text-alert">⚠ {plan.note}</div>}
            {plan.bookNote && <div className="mt-1 text-[12px] text-inksoft">{plan.bookNote}.</div>}
          </Modal>
        );
      })()}
      {pickOpen && (
        <Modal title="New walk sheet" onClose={() => setPickOpen(false)}
          primary={<button type="button" className={`btn btn-primary${creating ? " btn-busy" : ""}`} aria-busy={creating || undefined} disabled={creating} onClick={newWalkSheet}>Start walk sheet</button>}
          secondary={<button type="button" className="btn btn-ghost" onClick={() => setPickOpen(false)}>Cancel</button>}>
          <div className="section-label mb-1">Contract</div>
          <ContractPicker contracts={contracts} value={pickId} onChange={setPickId} />
        </Modal>
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
                <div className="section-label mb-1">Contract</div>
                <ContractPicker contracts={contracts} value={listContract} onChange={pickListContract}
                  extra={[{ id: "all", label: "All contracts" }, ...(strays.length > 0 ? [{ id: "none", label: `Not tied to a contract (${strays.length})` }] : [])]} />
              </div>
            )}
            <div className="mb-3 flex flex-wrap gap-2">
              {([["all", `All (${mine.length})`], ["draft", `Drafts (${mine.filter((p) => p.status === "draft").length})`], ["approved", `In a release (${mine.filter((p) => p.status === "approved").length})`]] as ["all" | "draft" | "approved", string][]).map(([f, l]) => (
                <button key={f} type="button" aria-pressed={listFilter === f} className={`btn btn-sm ${listFilter === f ? "btn-primary" : "btn-ghost"}`} onClick={() => setListFilter(f)}>{l}</button>
              ))}
            </div>
          </>
        );
      })()}
      <input type="search" enterKeyHint="search" autoComplete="off" className="field mb-3" placeholder="Search work, development, address, release #…" value={listQ} onChange={(e) => setListQ(e.target.value)} />
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
            return matches(listQ, p.number, p.job, p.client_name, p.development, p.address, p.apt, p.stairhall, p.release_number, c?.number);
          });
        // the whole row opens the sheet; its other actions sit behind the one ⋯
        const row = (p: Proposal) => (
          <div key={p.id} className="flex items-center gap-2 p-3">
            <button type="button" className="row-btn -my-3 -ml-3 flex min-w-0 flex-1 items-center justify-between gap-2 py-3 pl-3 pr-1" onClick={() => openEditor(p)}>
              <div className="min-w-0">
                <div className="text-[14px] font-semibold">
                  {(p.development || p.address || p.job)
                    ? <>{sheetName(p)}<span className="ml-1.5 font-mono text-[12px] font-normal text-inksoft">{p.number}</span></>
                    : <span className="font-mono">{p.number}</span>}
                </div>
                <div className="truncate text-[13px] text-inksoft">
                  {p.contract_id
                    ? [p.development && p.address, p.apt && `Apt ${p.apt}`, p.stairhall && `Stairhall ${p.stairhall}`, p.release_number && `Release ${p.release_number}`].filter(Boolean).join(" · ") || (p.development || p.address ? "" : "NYCHA walk")
                    : p.client_name || "No client"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2.5">
                <span className="font-mono text-[13px]">{fmt(Number(p.total) || 0)}</span>
                <Stamp label={statusLabel(p.status)} tone={tone(p.status) as "ok"} />
              </div>
            </button>
            <RowActions items={[
              { label: "Download PDF", glyph: "⬇", disabled: !!pdfBusy, onSelect: () => downloadPdf(p) },
              { label: "Add to release…", hidden: !p.contract_id, onSelect: () => addToRelease(p) },
              { label: "Delete…", destructive: true, onSelect: () => deleteProposal(p) }, // deleteProposal keeps its own confirm
            ]} />
          </div>
        );
        // one card per contract, in contract order; anything not tied to a
        // contract (the old free-form proposals) sits in its own card at the end
        const groups = [
          ...[...contracts].sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true })).map((c) => ({ key: c.id, label: contractLabel(c), rows: shown.filter((p) => p.contract_id === c.id) })),
          { key: "none", label: "Not tied to a contract", rows: shown.filter((p) => !p.contract_id || !contracts.some((c) => c.id === p.contract_id)) },
        ].filter((g) => g.rows.length > 0);
        // one contract on screen: its name is already in the picker, so the card needs no heading
        const single = listContract !== "all" && listContract !== "none";
        return (
          <>
            {!listLoaded && (
              <div className="card divide-y divide-rulesoft">
                {[0, 1, 2].map((i) => (
                  /* the list's shape, shimmering, while the sheets load */
                  <div key={`sk${i}`} className="p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="skeleton h-4 w-32" />
                      <div className="skeleton h-4 w-16" />
                    </div>
                    <div className="skeleton mt-2 h-3 w-1/2" />
                  </div>
                ))}
              </div>
            )}
            {groups.map((g) => (
              <div key={g.key} className="mb-4">
                {!single && (
                  <div className="mb-1.5 flex items-baseline justify-between gap-2">
                    <div className="section-label">{g.label}</div>
                    <div className="font-mono text-[12px] text-inksoft">{g.rows.length} · {fmt(g.rows.reduce((t, p) => t + (Number(p.total) || 0), 0))}</div>
                  </div>
                )}
                <div className="card divide-y divide-rulesoft">{g.rows.map(row)}</div>
              </div>
            ))}
            {listLoaded && groups.length === 0 && (
              <div className="empty">
                {contracts.length === 0 && list.length === 0 ? "No contracts yet. Upload a release on the Releases tab first; walk sheets live under a contract."
                  : list.length === 0 ? "No walk sheets yet. Tap + New walk sheet, upload the contract's price sheet once, and fill quantities as you walk the unit."
                  : listQ || listFilter !== "all" ? "Nothing matches that search."
                  : "No walk sheets on this contract yet. Pick another contract above, or All contracts."}
              </div>
            )}
          </>
        );
      })()}

      {relAsk && (
        <Modal title="Add to release" onClose={() => setRelAsk(null)}
          primary={<button type="button" className="btn btn-primary" disabled={!relAsk.value.trim()} onClick={submitRelAsk}>Add to release</button>}
          secondary={<button type="button" className="btn btn-ghost" onClick={() => setRelAsk(null)}>Cancel</button>}>
          <div className="mb-3 text-sm text-inksoft">
            {[relAsk.p.number, [relAsk.p.job, relAsk.p.development, relAsk.p.address].filter(Boolean).join(" · ") || "NYCHA walk", fmt(Number(relAsk.p.total) || 0)].join(" · ")}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); submitRelAsk(); }}>
            <label className="section-label" htmlFor="rel-number">Release number</label>
            <input id="rel-number" className="field mb-2 mt-1" autoFocus enterKeyHint="done" placeholder="e.g. 12" value={relAsk.value}
              onChange={(e) => setRelAsk({ ...relAsk, value: e.target.value })} />
          </form>
          <div className="text-xs text-inksoft">Makes release {relAsk.value.trim() || "(number above)"} on contract {contracts.find((x) => x.id === relAsk.p.contract_id)?.number} from this sheet&apos;s lines and total. If that release already exists, it&apos;s updated instead.</div>
        </Modal>
      )}

      <Toast msg={msg} />
    </div>
  );
}
