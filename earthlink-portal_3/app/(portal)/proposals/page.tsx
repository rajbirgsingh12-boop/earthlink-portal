"use client";
import { useEffect, useMemo, useRef, useState } from "react";
// styled fork of SheetJS — same API, plus cell borders/fonts for the export
import * as XLSX from "xlsx-js-style";
import { sb } from "@/lib/supabase";
import { fmt, parseNum } from "@/lib/format";
import Stamp from "@/components/Stamp";
import DocPrint from "@/components/DocPrint";
import { LineItem, Org, nextNumber, grandTotal, addDays } from "@/lib/docs";
import type { Contract } from "@/lib/types";

interface Proposal {
  id: string; number: string; client_name: string; job: string; date: string; tax_pct: number; status: string; notes: string;
  contract_id?: string | null; development?: string; address?: string; apt?: string; stairhall?: string;
  walk_date?: string; release_number?: string; nycha_staff?: string; vendor_staff?: string;
  start_date?: string; finish_date?: string; total?: number; qty_map?: Record<string, number> | null;
}
interface ContractItem { id: string; line: number; code: string; category: string; description: string; uom: string; unit_price: number; }
type NychaLineItem = LineItem & { category?: string; line?: number };

const tone = (s: string) => (s === "approved" ? "work" : s === "sent" ? "carbon" : s === "invoiced" ? "mute" : s === "declined" ? "alert" : "mute");
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
  const [saveState, setSaveState] = useState<"" | "saving" | "saved">("");
  const [msg, setMsg] = useState("");
  const sheetRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 3000); };
  const upgradeHint = (m: string) => (/column|schema|relation|qty_map/i.test(m) ? "Database needs the upgrade — run supabase/upgrade_proposal_creator.sql" : m);

  const load = async () => {
    const { data } = await sb().from("proposals").select("*").order("created_at", { ascending: false });
    setList((data || []) as Proposal[]);
  };
  useEffect(() => {
    load();
    sb().from("org").select("*").single().then(({ data }) => data && setOrg(data as Org));
    sb().from("contracts").select("id,number,name").order("number").then(({ data }) => {
      const cs = (data || []) as Contract[];
      setContracts(cs); if (cs[0]) setPickId(cs[0].id);
    });
  }, []);

  // load the contract's catalog whenever the open walk sheet's contract changes
  useEffect(() => {
    if (!doc?.contract_id) { setCatalog(null); return; }
    sb().from("contract_items").select("*").eq("contract_id", doc.contract_id).order("line")
      .then(({ data }) => setCatalog((data || []) as ContractItem[]));
  }, [doc?.contract_id]);

  // ---------- open / create ----------
  const openEditor = async (p: Proposal) => {
    setDoc(p); setSearch(""); setCollapsed(new Set());
    const m: Record<string, string> = {};
    Object.entries(p.qty_map || {}).forEach(([k, v]) => { if (Number(v) > 0) m[k] = String(v); });
    if (Object.keys(m).length === 0) {
      // resume older drafts saved before qty_map existed
      const { data } = await sb().from("proposal_items").select("*").eq("proposal_id", p.id).order("sort");
      ((data || []) as NychaLineItem[]).forEach((it) => { if (Number(it.qty) > 0 && it.code) m[it.code] = String(it.qty); });
      if (!p.contract_id) setItems((data || []) as NychaLineItem[]);
    }
    setQty(m);
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
    await load(); openEditor(data as Proposal);
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
  const scheduleAutosave = (nextQty: Record<string, string>) => {
    if (!doc) return;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const docId = doc.id;
    saveTimer.current = setTimeout(async () => {
      const map: Record<string, number> = {};
      Object.entries(nextQty).forEach(([k, v]) => { const n = parseNum(v); if (n > 0) map[k] = n; });
      const total = (catalog || []).reduce((s, ci) => s + (map[ci.code] || 0) * Number(ci.unit_price), 0);
      const { error } = await sb().from("proposals").update({ qty_map: map, total }).eq("id", docId);
      if (error) { setSaveState(""); flash(upgradeHint(error.message)); return; }
      setSaveState("saved");
      setTimeout(() => setSaveState(""), 1500);
    }, 700);
  };
  const setLineQty = (code: string, v: string) => {
    const next = { ...qty, [code]: v };
    if (!v) delete next[code];
    setQty(next); scheduleAutosave(next);
  };

  // write the billed lines to proposal_items (used by print, invoices, statements)
  const materialize = async (): Promise<NychaLineItem[]> => {
    if (!doc) return [];
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
  const closeEditor = async () => { if (doc?.contract_id) await materialize(); setDoc(null); setItems([]); };

  // ---------- catalog upload (per contract, header-name matched) ----------
  const handleContractSheet = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !doc?.contract_id) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
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
        await sb().from("contract_items").delete().eq("contract_id", doc.contract_id!);
        for (let i = 0; i < rows.length; i += 500) {
          const { error } = await sb().from("contract_items").insert(rows.slice(i, i + 500).map((r) => ({ ...r, contract_id: doc.contract_id })));
          if (error) { flash(upgradeHint(error.message)); return; }
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
    if (!doc || !catalog) return;
    await materialize();
    const c = contracts.find((x) => x.id === doc.contract_id);
    const asCode = (s: string) => (/^\d+$/.test(s) ? Number(s) : s);
    const used = catalog.filter((ci) => parseNum(qty[ci.code] || "") > 0);
    const aoa: (string | number)[][] = [
      ["PO:", "", c ? asCode(c.number) : "", "", "NYCHA Staff:", doc.nycha_staff || ""],
      ["Vendor:", "", (org?.company || "").toUpperCase(), "", "Vendor Staff:", doc.vendor_staff || ""],
      ["Development:", "", doc.development || "", "", "Walk Date:", doc.walk_date || ""],
      ["Stairhall:", "", doc.stairhall || "", "", "Release #:", doc.release_number || ""],
      ["Apt:", "", doc.apt || "", "", "Start Date:", doc.start_date || ""],
      ["Address:", "", doc.address || "", "", "Finish Date:", doc.finish_date || ""],
      [],
      ["Line", "Item", "Category", "Description", "UOM", "Quantity Authorized", "Price", "Total Cost"],
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
    const cellAt = (r: number, col: number) => ws[XLSX.utils.encode_cell({ r, c: col })];
    for (let r = 0; r < 6; r++) {
      for (const col of [0, 4]) { const cell = cellAt(r, col); if (cell) cell.s = { font: { bold: true } }; }
    }
    const headerRow = 7, firstItem = 8, totalRow = firstItem + used.length;
    for (let r = headerRow; r <= totalRow; r++) {
      for (let col = 0; col < 8; col++) {
        const cell = cellAt(r, col);
        if (!cell) continue;
        const s: Record<string, unknown> = { border: box, alignment: { vertical: "top", wrapText: col === 3 } };
        if (r === headerRow || r === totalRow) s.font = { bold: true };
        if (r === headerRow) s.fill = { patternType: "solid", fgColor: { rgb: "E8E4DA" } };
        cell.s = s;
        if (r > headerRow && (col === 6 || col === 7) && typeof cell.v === "number") cell.z = "#,##0.00";
      }
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    XLSX.writeFile(wb, `proposal_sheet_${c?.number || ""}${doc.release_number ? `_rel${doc.release_number}` : ""}.xlsx`);
  };

  // ---------- add a proposal to its contract as a release (works from the dashboard) ----------
  const itemsFor = async (p: Proposal): Promise<NychaLineItem[]> => {
    if (doc && doc.id === p.id) return materialize(); // editor open: use live quantities
    const { data } = await sb().from("contract_items").select("*").eq("contract_id", p.contract_id!).order("line");
    const map = p.qty_map || {};
    return ((data || []) as ContractItem[])
      .filter((ci) => Number(map[ci.code]) > 0)
      .map((ci) => ({ line: ci.line, code: ci.code, category: ci.category, description: ci.description, unit: ci.uom, qty: Number(map[ci.code]), unit_price: Number(ci.unit_price) }));
  };
  const addToRelease = async (p: Proposal) => {
    const c = contracts.find((x) => x.id === p.contract_id);
    if (!c) { flash("That proposal isn't tied to a contract"); return; }
    const rel = (p.release_number || "").trim();
    if (!rel) { flash(`Open ${p.number} and fill in Release # first — the release needs its number`); return; }
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
    const { error } = await sb().from("proposals").delete().eq("id", p.id);
    if (error) { flash(error.message); return; }
    if (doc && doc.id === p.id) setDoc(null);
    load(); flash("Walk sheet deleted");
  };

  // ---------- convert to invoice ----------
  const convert = async () => {
    if (!doc || !org) return;
    const its = await materialize();
    if (its.length === 0) { flash("No quantities entered yet"); return; }
    const number = await nextNumber("invoices", "INV");
    const termDays = parseInt(org.terms.match(/\d+/)?.[0] || "30", 10);
    const today = new Date().toISOString().slice(0, 10);
    const c = contracts.find((x) => x.id === doc.contract_id);
    const base = { number, proposal_id: doc.id, client_name: doc.client_name, job: doc.job || [doc.development, doc.address].filter(Boolean).join(" · "), date: today, due_date: addDays(today, termDays), tax_pct: doc.tax_pct };
    const nychaExtra = c ? { contract_number: c.number, release_number: doc.release_number || "", development: doc.development || "" } : {};
    let { data, error } = await sb().from("invoices").insert({ ...base, ...nychaExtra }).select().single();
    if (error && /column/i.test(error.message)) ({ data, error } = await sb().from("invoices").insert(base).select().single());
    if (error || !data) { flash(error?.message || "Failed"); return; }
    const full = its.map((it, i) => ({ invoice_id: data.id, code: it.code, description: it.description, unit: it.unit, qty: Number(it.qty) || 0, unit_price: Number(it.unit_price) || 0, sort: i, category: it.category || "" }));
    let { error: e2 } = await sb().from("invoice_items").insert(full);
    if (e2 && /column/i.test(e2.message)) ({ error: e2 } = await sb().from("invoice_items").insert(full.map(({ category: _c, ...rest }) => rest)));
    if (e2) flash(e2.message);
    await saveDoc({ status: "invoiced" }, true);
    flash(`${number} created`); window.location.href = "/invoices";
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
            <button className="btn" onClick={exportWalkSheet}>Walk sheet (xlsx)</button>
            <button className="btn btn-ghost" onClick={() => sheetRef.current?.click()}>{(catalog || []).length > 0 ? "Reload price book" : "Upload price book"}</button>
          </div>
        </div>
        <input ref={sheetRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleContractSheet} />

        <div className="card mb-3 grid grid-cols-2 gap-2.5 p-3.5 md:grid-cols-4">
          <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Contract / PO</div>
            <select className="field" value={doc.contract_id} onChange={(e) => saveDoc({ contract_id: e.target.value }, true)}>
              {contracts.map((x) => <option key={x.id} value={x.id}>{x.number}</option>)}
            </select></div>
          {HEAD_FIELDS.map(([k, label]) => (
            <div key={k}><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">{label}</div>
              <input className="field" type={/date/.test(k) ? "date" : "text"} value={doc[k] || ""}
                onChange={(e) => setDoc({ ...doc, [k]: e.target.value })}
                onBlur={(e) => saveDoc({ [k]: e.target.value } as Partial<Proposal>, true)} /></div>
          ))}
        </div>

        {(catalog || []).length === 0 ? (
          <div className="card border-work p-4 text-sm text-inksoft">
            No price book loaded for contract {c?.number} yet. Tap <b>Upload price book</b> and pick the contract price sheet —
            the xlsx with Line / Item / Category / Description / UOM / Price columns (a blank walk sheet works). One time per contract.
          </div>
        ) : (
          <>
            <input className="field mb-3" placeholder={`Search ${catalog!.length} lines — line #, item code, or any word (“cabinet”)…`}
              value={search} onChange={(e) => setSearch(e.target.value)} />
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

        {msg && <div className="fixed bottom-16 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
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
          <div className="flex flex-wrap gap-2">
            <button className="btn" onClick={() => setPrintOpen(true)}>Print / PDF</button>
            {doc.status !== "invoiced" && <button className="btn btn-primary" onClick={convert}>→ Invoice</button>}
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
        {printOpen && org && <DocPrint org={org} title="Proposal" number={doc.number} date={doc.date} clientName={doc.client_name} job={doc.job} items={items} taxPct={doc.tax_pct} terms notes={doc.notes} close={() => setPrintOpen(false)} />}
        {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
      </div>
    );
  }

  // ================= LIST =================
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-display text-2xl font-bold uppercase">Proposals</div>
        <button className="btn btn-primary" onClick={newWalkSheet}>+ New NYCHA walk sheet</button>
      </div>
      {pickOpen && (
        <div className="card mb-3 border-work p-4">
          <div className="mb-2 text-[11px] uppercase tracking-widest text-inksoft">Which contract is this walk for?</div>
          <select className="field mb-3" value={pickId} onChange={(e) => setPickId(e.target.value)}>
            {contracts.map((x) => <option key={x.id} value={x.id}>{x.number}{x.name && x.name !== x.number ? ` — ${x.name}` : ""}</option>)}
          </select>
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={newWalkSheet}>Start walk sheet</button>
            <button className="btn btn-ghost" onClick={() => setPickOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="card divide-y divide-rulesoft">
        {list.map((p) => (
          <div key={p.id} className="p-3.5">
            <button className="flex w-full items-center justify-between gap-2 text-left" onClick={() => openEditor(p)}>
              <div className="min-w-0">
                <div className="font-mono text-[13px] font-semibold">{p.number}</div>
                <div className="truncate text-[13px] text-inksoft">
                  {p.contract_id
                    ? [p.development || "NYCHA walk", p.address, p.apt && `Apt ${p.apt}`, p.stairhall && `Stair ${p.stairhall}`, p.release_number && `Rel ${p.release_number}`].filter(Boolean).join(" · ")
                    : `${p.client_name || "No client"}${p.job ? ` · ${p.job}` : ""}`}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2.5">
                <span className="font-mono text-[13px]">{fmt(Number(p.total) || 0)}</span>
                <Stamp label={p.status.toUpperCase()} tone={tone(p.status) as "ok"} />
              </div>
            </button>
            <div className="mt-2 flex flex-wrap gap-2">
              {p.contract_id && <button className="btn btn-primary px-3 py-1.5 text-[13px]" onClick={() => addToRelease(p)}>→ Add to release</button>}
              <button className="btn btn-ghost px-3 py-1.5 text-[13px] text-alert" onClick={() => deleteProposal(p)}>Delete</button>
            </div>
          </div>
        ))}
        {list.length === 0 && <div className="p-5 text-sm text-inksoft">No walk sheets yet. Tap + New NYCHA walk sheet, load the contract price book once, and fill quantities as you walk the unit.</div>}
      </div>
      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
