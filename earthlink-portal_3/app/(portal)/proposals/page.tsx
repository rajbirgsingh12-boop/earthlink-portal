"use client";
import { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { sb } from "@/lib/supabase";
import { fmt, parseNum } from "@/lib/format";
import Stamp from "@/components/Stamp";
import DocPrint from "@/components/DocPrint";
import { LineItem, Org, nextNumber, grandTotal, addDays } from "@/lib/docs";
import type { Contract } from "@/lib/types";

interface Proposal {
  id: string; number: string; client_name: string; job: string; date: string; tax_pct: number; status: string; notes: string;
  contract_id?: string | null; development?: string; address?: string; apt?: string; stairhall?: string;
  walk_date?: string; release_number?: string; total?: number;
}
interface PriceItem { id: string; code: string; description: string; unit: string; unit_price: number; }
interface ContractItem { id: string; line: number; code: string; category: string; description: string; uom: string; unit_price: number; }
type NychaLineItem = LineItem & { category?: string; line?: number };

const tone = (s: string) => (s === "approved" ? "work" : s === "sent" ? "carbon" : s === "invoiced" ? "mute" : s === "declined" ? "alert" : "mute");

export default function Proposals() {
  const [list, setList] = useState<Proposal[]>([]);
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [doc, setDoc] = useState<Proposal | null>(null);
  const [items, setItems] = useState<NychaLineItem[]>([]);
  const [book, setBook] = useState<PriceItem[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [contractItems, setContractItems] = useState<ContractItem[] | null>(null);
  const sheetRef = useRef<HTMLInputElement>(null);
  const [clients, setClients] = useState<string[]>([]);
  const [org, setOrg] = useState<Org | null>(null);
  const [search, setSearch] = useState("");
  const [printOpen, setPrintOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 2500); };

  const load = async () => {
    const { data } = await sb().from("proposals").select("*").order("created_at", { ascending: false });
    setList((data || []) as Proposal[]);
    const { data: its } = await sb().from("proposal_items").select("proposal_id,qty,unit_price");
    const t: Record<string, number> = {};
    (its || []).forEach((r: { proposal_id: string; qty: number; unit_price: number }) => { t[r.proposal_id] = (t[r.proposal_id] || 0) + Number(r.qty) * Number(r.unit_price); });
    setTotals(t);
  };
  useEffect(() => {
    load();
    sb().from("price_items").select("id,code,description,unit,unit_price").then(({ data }) => setBook((data || []) as PriceItem[]));
    sb().from("clients").select("name").then(({ data }) => setClients((data || []).map((c: { name: string }) => c.name)));
    sb().from("org").select("*").single().then(({ data }) => data && setOrg(data as Org));
    sb().from("contracts").select("id,number,name").order("number").then(({ data }) => setContracts((data || []) as Contract[]));
  }, []);

  // NYCHA mode: load the contract's price catalog whenever the proposal's contract changes
  useEffect(() => {
    if (!doc?.contract_id) { setContractItems(null); return; }
    sb().from("contract_items").select("*").eq("contract_id", doc.contract_id).order("line")
      .then(({ data }) => setContractItems((data || []) as ContractItem[]));
  }, [doc?.contract_id]);

  const openEditor = async (p: Proposal) => {
    setDoc(p); setOpenId(p.id);
    const { data } = await sb().from("proposal_items").select("*").eq("proposal_id", p.id).order("sort");
    setItems(((data || []) as LineItem[]));
  };
  const newProposal = async () => {
    const number = await nextNumber("proposals", "PROP");
    const { data, error } = await sb().from("proposals").insert({ number }).select().single();
    if (error) { flash(error.message); return; }
    await load(); openEditor(data as Proposal);
  };
  const newNychaProposal = async () => {
    if (contracts.length === 0) { flash("Add a contract first (upload releases or a price sheet)"); return; }
    const number = await nextNumber("proposals", "PROP");
    const { data, error } = await sb().from("proposals").insert({
      number, client_name: "New York City Housing Authority", contract_id: contracts[0].id,
    }).select().single();
    if (error) { flash(/column|schema/i.test(error.message) ? "Database needs the upgrade — run supabase/upgrade_proposal_creator.sql" : error.message); return; }
    await load(); openEditor(data as Proposal);
  };
  const saveDoc = async (patch: Partial<Proposal>, silent = false) => {
    if (!doc) return;
    const next = { ...doc, ...patch }; setDoc(next);
    const { error } = await sb().from("proposals").update(patch).eq("id", doc.id);
    if (error) flash(error.message); else if (!silent) flash("Saved");
    load();
  };
  const saveItems = async (next: NychaLineItem[]) => {
    if (!doc) return;
    setItems(next);
    await sb().from("proposal_items").delete().eq("proposal_id", doc.id);
    if (next.length) {
      const full = next.map((it, i) => ({ proposal_id: doc.id, code: it.code, description: it.description, unit: it.unit, qty: Number(it.qty) || 0, unit_price: Number(it.unit_price) || 0, sort: i, category: it.category || "", line: it.line || 0 }));
      let { error } = await sb().from("proposal_items").insert(full);
      if (error && /column/i.test(error.message)) {
        // pre-upgrade database — insert without the NYCHA columns
        ({ error } = await sb().from("proposal_items").insert(full.map(({ category: _c, line: _l, ...rest }) => rest)));
      }
      if (error) flash(error.message);
    }
    // keep proposals.total in sync (best-effort; column exists after the upgrade)
    await sb().from("proposals").update({ total: next.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0) }).eq("id", doc.id);
    load();
  };

  // ---------- NYCHA: contract price sheet upload + walk sheet export ----------
  const handleContractSheet = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !doc?.contract_id) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const wb = XLSX.read(ev.target?.result as ArrayBuffer, { type: "array" });
        const raw: string[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: false, blankrows: false });
        const hIdx = raw.findIndex((r) => r.some((c) => /^item$/i.test(String(c).trim())) && r.some((c) => /^price$/i.test(String(c).trim())));
        if (hIdx < 0) { flash("No header row with Item + Price columns found"); return; }
        const headers = raw[hIdx].map((h) => String(h).toLowerCase().trim());
        const col = (re: RegExp) => headers.findIndex((h) => re.test(h));
        const m = { line: col(/^line/), code: col(/^item/), category: col(/^categ/), description: col(/^desc/), uom: col(/^uom|^unit$/), price: col(/^price/) };
        const rows = raw.slice(hIdx + 1)
          .map((r, i) => ({
            line: m.line >= 0 ? parseInt(String(r[m.line]), 10) || i + 1 : i + 1,
            code: m.code >= 0 ? String(r[m.code]).trim() : "",
            category: m.category >= 0 ? String(r[m.category]).trim() : "",
            description: m.description >= 0 ? String(r[m.description]).trim() : "",
            uom: m.uom >= 0 ? String(r[m.uom]).trim() : "",
            unit_price: m.price >= 0 ? parseNum(r[m.price]) : 0,
          }))
          .filter((r) => r.code && r.description && !/^total$/i.test(r.description));
        if (rows.length === 0) { flash("No item rows found in that sheet"); return; }
        await sb().from("contract_items").delete().eq("contract_id", doc.contract_id!);
        for (let i = 0; i < rows.length; i += 500) {
          const { error } = await sb().from("contract_items").insert(rows.slice(i, i + 500).map((r) => ({ ...r, contract_id: doc.contract_id })));
          if (error) { flash(/relation|column/i.test(error.message) ? "Database needs the upgrade — run supabase/upgrade_proposal_creator.sql" : error.message); return; }
        }
        const { data } = await sb().from("contract_items").select("*").eq("contract_id", doc.contract_id!).order("line");
        setContractItems((data || []) as ContractItem[]);
        flash(`Loaded ${rows.length} catalog lines for this contract`);
      } catch { flash("Couldn't read that sheet — save as .xlsx or .csv"); }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  const exportWalkSheet = () => {
    if (!doc) return;
    const c = contracts.find((x) => x.id === doc.contract_id);
    const qtyByCode = new Map(items.map((it) => [it.code, Number(it.qty) || 0]));
    const catalog = (contractItems && contractItems.length > 0)
      ? contractItems
      : items.map((it, i) => ({ line: it.line || i + 1, code: it.code, category: it.category || "", description: it.description, uom: it.unit, unit_price: Number(it.unit_price) }));
    const aoa: (string | number)[][] = [
      ["PO:", "", c?.number || "", "", "NYCHA Staff:", ""],
      ["Vendor:", "", org?.company?.toUpperCase() || "", "", "Vendor Staff:", ""],
      ["Development:", "", doc.development || "", "", "Walk Date:", doc.walk_date || ""],
      ["Stairhall:", "", doc.stairhall || "", "", "Release #:", doc.release_number || ""],
      ["Apt:", "", doc.apt || "", "", "Start Date:", ""],
      ["Address:", "", doc.address || "", "", "Finish Date:", ""],
      [],
      ["Line", "Item", "Category", "Description", "UOM", "Quantity Authorized", "Price", "Total Cost"],
      ...catalog.map((r) => {
        const qty = qtyByCode.get(r.code) || 0;
        return [r.line, r.code, r.category, r.description, r.uom, qty || "", Number(r.unit_price), qty * Number(r.unit_price)];
      }),
      ["", "", "", "", "", "Total", "", items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0)],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 6 }, { wch: 10 }, { wch: 28 }, { wch: 60 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    XLSX.writeFile(wb, `proposal_${c?.number || "sheet"}${doc.release_number ? `_rel${doc.release_number}` : ""}.xlsx`);
  };
  const convert = async () => {
    if (!doc || !org) return;
    const number = await nextNumber("invoices", "INV");
    const termDays = parseInt(org.terms.match(/\d+/)?.[0] || "30", 10);
    const today = new Date().toISOString().slice(0, 10);
    const c = contracts.find((x) => x.id === doc.contract_id);
    const base = { number, proposal_id: doc.id, client_name: doc.client_name, job: doc.job || [doc.development, doc.address].filter(Boolean).join(" · "), date: today, due_date: addDays(today, termDays), tax_pct: doc.tax_pct };
    const nychaExtra = c ? { contract_number: c.number, release_number: doc.release_number || "", development: doc.development || "" } : {};
    let { data, error } = await sb().from("invoices").insert({ ...base, ...nychaExtra }).select().single();
    if (error && /column/i.test(error.message)) ({ data, error } = await sb().from("invoices").insert(base).select().single());
    if (error || !data) { flash(error?.message || "Failed"); return; }
    const full = items.map((it, i) => ({ invoice_id: data.id, code: it.code, description: it.description, unit: it.unit, qty: Number(it.qty) || 0, unit_price: Number(it.unit_price) || 0, sort: i, category: it.category || "" }));
    let { error: e2 } = await sb().from("invoice_items").insert(full);
    if (e2 && /column/i.test(e2.message)) ({ error: e2 } = await sb().from("invoice_items").insert(full.map(({ category: _c, ...rest }) => rest)));
    if (e2) flash(e2.message);
    await saveDoc({ status: "invoiced" }, true);
    flash(`${number} created`); window.location.href = "/invoices";
  };

  const nychaBook: PriceItem[] | null = doc?.contract_id && contractItems && contractItems.length > 0
    ? contractItems.map((ci) => ({ id: ci.id, code: ci.code, description: ci.description, unit: ci.uom, unit_price: Number(ci.unit_price) }))
    : null;
  const matches = search ? (nychaBook || book).filter((b) => `${b.code} ${b.description}`.toLowerCase().includes(search.toLowerCase())).slice(0, 6) : [];
  const catFor = (code: string) => (contractItems || []).find((ci) => ci.code === code);

  if (openId && doc) {
    const total = grandTotal(items, doc.tax_pct);
    return (
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <button className="btn btn-ghost" onClick={() => { setOpenId(null); setDoc(null); }}>← Back</button>
            <span className="font-mono font-semibold">{doc.number}</span>
            <Stamp label={doc.status.toUpperCase()} tone={tone(doc.status) as "ok"} />
          </div>
          <div className="flex flex-wrap gap-2">
            {doc.contract_id && <button className="btn" onClick={exportWalkSheet}>Walk sheet (xlsx)</button>}
            {doc.contract_id && <button className="btn btn-ghost" onClick={() => sheetRef.current?.click()}>{(contractItems || []).length > 0 ? "Reload catalog" : "Upload contract catalog"}</button>}
            <button className="btn" onClick={() => setPrintOpen(true)}>Print / PDF</button>
            {doc.status === "draft" && <button className="btn" onClick={() => saveDoc({ status: "sent" })}>Mark sent</button>}
            {doc.status === "sent" && <button className="btn" onClick={() => saveDoc({ status: "approved" })}>Mark approved</button>}
            {doc.status !== "invoiced" && <button className="btn btn-primary" onClick={convert}>→ Invoice</button>}
          </div>
        </div>
        <input ref={sheetRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleContractSheet} />
        {doc.contract_id ? (
          <div className="card mb-3 grid grid-cols-2 gap-2.5 p-3.5 md:grid-cols-4">
            <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Contract / PO</div>
              <select className="field" value={doc.contract_id} onChange={(e) => saveDoc({ contract_id: e.target.value }, true)}>
                {contracts.map((c) => <option key={c.id} value={c.id}>{c.number}</option>)}
              </select></div>
            {([["development", "Development"], ["address", "Address"], ["apt", "Apt"], ["stairhall", "Stairhall"], ["walk_date", "Walk date"], ["release_number", "Release #"]] as ["development" | "address" | "apt" | "stairhall" | "walk_date" | "release_number", string][]).map(([k, label]) => (
              <div key={k}><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">{label}</div>
                <input className="field" type={k === "walk_date" ? "date" : "text"} value={doc[k] || ""}
                  onChange={(e) => setDoc({ ...doc, [k]: e.target.value })} onBlur={(e) => saveDoc({ [k]: e.target.value } as Partial<Proposal>, true)} /></div>
            ))}
            <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Date</div>
              <input className="field" type="date" value={doc.date} onChange={(e) => saveDoc({ date: e.target.value }, true)} /></div>
          </div>
        ) : (
        <div className="card mb-3 grid gap-2.5 p-3.5 md:grid-cols-3">
          <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Client</div>
            <input className="field" list="clientlist" value={doc.client_name} onChange={(e) => setDoc({ ...doc, client_name: e.target.value })} onBlur={(e) => saveDoc({ client_name: e.target.value }, true)} />
            <datalist id="clientlist">{clients.map((c) => <option key={c} value={c} />)}</datalist></div>
          <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Job / location</div>
            <input className="field" value={doc.job} onChange={(e) => setDoc({ ...doc, job: e.target.value })} onBlur={(e) => saveDoc({ job: e.target.value }, true)} /></div>
          <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Date</div>
            <input className="field" type="date" value={doc.date} onChange={(e) => saveDoc({ date: e.target.value }, true)} /></div>
        </div>
        )}
        {doc.contract_id && (contractItems || []).length === 0 && (
          <div className="card mb-3 border-work p-3 text-sm text-inksoft">
            No price catalog loaded for this contract yet. Click <b>Upload contract catalog</b> and drop the contract price sheet
            (the xlsx with Line / Item / Category / Description / UOM / Price columns) — after that, item search and the walk-sheet
            export use the contract's own lines and prices.
          </div>
        )}
        <div className="relative mb-3">
          <input className="field" placeholder="Type a line item… (searches your price book)" value={search} onChange={(e) => setSearch(e.target.value)} />
          {search && (
            <div className="card absolute inset-x-0 top-full z-10 shadow-lg">
              {matches.map((b) => (
                <button key={b.id} className="flex w-full justify-between gap-2 border-b border-rulesoft p-2.5 text-left text-sm" onClick={() => { const ci = catFor(b.code); saveItems([...items, { code: b.code, description: b.description, unit: b.unit, qty: 1, unit_price: Number(b.unit_price), category: ci?.category, line: ci?.line }]); setSearch(""); }}>
                  <span><span className="font-mono text-[11px] text-inksoft">{b.code}</span> {b.description}</span>
                  <span className="shrink-0 font-mono text-xs">{fmt(Number(b.unit_price))}/{b.unit}</span>
                </button>
              ))}
              <button className="w-full p-2.5 text-left text-sm text-work" onClick={() => { saveItems([...items, { code: "", description: search, unit: "EA", qty: 1, unit_price: 0 }]); setSearch(""); }}>+ Add "{search}" as custom line</button>
            </div>
          )}
        </div>
        <div className="card mb-3 overflow-x-auto">
          <table className="w-full border-collapse text-sm" style={{ minWidth: 540 }}>
            <thead><tr className="border-b-[1.5px] border-ink text-left font-display text-xs uppercase tracking-widest text-inksoft">
              <th className="w-2/5 p-2.5">Item</th><th className="p-2.5">Unit</th><th className="p-2.5 text-right">Qty</th><th className="p-2.5 text-right">Unit $</th><th className="p-2.5 text-right">Total</th><th></th></tr></thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className="border-b border-rulesoft">
                  <td className="p-1.5"><input className="w-full bg-transparent p-1" value={it.description} onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} onBlur={() => saveItems(items)} /></td>
                  <td className="p-1.5"><input className="w-14 bg-transparent p-1 font-mono" value={it.unit} onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, unit: e.target.value } : x))} onBlur={() => saveItems(items)} /></td>
                  <td className="p-1.5 text-right"><input className="w-16 rounded-sm border border-rulesoft p-1.5 text-right font-mono" inputMode="decimal" value={it.qty} onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, qty: parseNum(e.target.value) || (e.target.value as unknown as number) } : x))} onBlur={() => saveItems(items)} /></td>
                  <td className="p-1.5 text-right"><input className="w-24 rounded-sm border border-rulesoft p-1.5 text-right font-mono" inputMode="decimal" value={it.unit_price} onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, unit_price: parseNum(e.target.value) || (e.target.value as unknown as number) } : x))} onBlur={() => saveItems(items)} /></td>
                  <td className="p-2.5 text-right font-mono font-semibold">{fmt(Number(it.qty) * Number(it.unit_price))}</td>
                  <td className="p-2.5"><button className="text-xs text-alert" onClick={() => saveItems(items.filter((_, j) => j !== i))}>✕</button></td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={6} className="p-4 text-inksoft">No lines yet — type in the search box above.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="card flex flex-wrap items-center justify-end gap-5 p-3.5">
          <label className="flex items-center gap-2 text-xs uppercase tracking-widest text-inksoft">Tax %
            <input className="field w-20 text-right font-mono" inputMode="decimal" value={doc.tax_pct} onChange={(e) => saveDoc({ tax_pct: parseNum(e.target.value) }, true)} /></label>
          <div className="font-mono text-xl font-semibold">Total {fmt(total)}</div>
        </div>
        <textarea className="field mt-3 min-h-[70px]" placeholder="Notes / exclusions (shows on the proposal)" value={doc.notes} onChange={(e) => setDoc({ ...doc, notes: e.target.value })} onBlur={(e) => saveDoc({ notes: e.target.value }, true)} />
        {printOpen && org && <DocPrint org={org} title="Proposal" number={doc.number} date={doc.date} clientName={doc.client_name} job={doc.job} items={items} taxPct={doc.tax_pct} terms notes={doc.notes} close={() => setPrintOpen(false)} />}
        {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-display text-2xl font-bold uppercase">Proposals</div>
        <div className="flex gap-2">
          <button className="btn btn-primary" onClick={newNychaProposal}>+ NYCHA walk sheet</button>
          <button className="btn" onClick={newProposal}>+ Blank proposal</button>
        </div>
      </div>
      <div className="card divide-y divide-rulesoft">
        {list.map((p) => (
          <button key={p.id} className="flex w-full items-center justify-between gap-2 p-3.5 text-left" onClick={() => openEditor(p)}>
            <div className="min-w-0">
              <div className="font-mono text-[13px] font-semibold">{p.number}</div>
              <div className="truncate text-[13px] text-inksoft">
                {p.contract_id
                  ? [p.development || "NYCHA", p.address, p.apt && `Apt ${p.apt}`, p.release_number && `Rel ${p.release_number}`].filter(Boolean).join(" · ")
                  : `${p.client_name || "No client"}${p.job ? ` · ${p.job}` : ""}`}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2.5">
              <span className="font-mono text-[13px]">{fmt((totals[p.id] || 0) * (1 + Number(p.tax_pct) / 100))}</span>
              <Stamp label={p.status.toUpperCase()} tone={tone(p.status) as "ok"} />
            </div>
          </button>
        ))}
        {list.length === 0 && <div className="p-5 text-sm text-inksoft">No proposals yet. Hit + New proposal, type line items, done in five minutes.</div>}
      </div>
      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
