"use client";
import { useEffect, useState } from "react";
import { sb } from "@/lib/supabase";
import { fmt, parseNum } from "@/lib/format";
import Stamp from "@/components/Stamp";
import DocPrint from "@/components/DocPrint";
import { LineItem, Org, nextNumber, grandTotal, addDays } from "@/lib/docs";

interface Proposal { id: string; number: string; client_name: string; job: string; date: string; tax_pct: number; status: string; notes: string; }
interface PriceItem { id: string; code: string; description: string; unit: string; unit_price: number; }

const tone = (s: string) => (s === "approved" ? "work" : s === "sent" ? "carbon" : s === "invoiced" ? "mute" : s === "declined" ? "alert" : "mute");

export default function Proposals() {
  const [list, setList] = useState<Proposal[]>([]);
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [doc, setDoc] = useState<Proposal | null>(null);
  const [items, setItems] = useState<LineItem[]>([]);
  const [book, setBook] = useState<PriceItem[]>([]);
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
  }, []);

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
  const saveDoc = async (patch: Partial<Proposal>, silent = false) => {
    if (!doc) return;
    const next = { ...doc, ...patch }; setDoc(next);
    const { error } = await sb().from("proposals").update(patch).eq("id", doc.id);
    if (error) flash(error.message); else if (!silent) flash("Saved");
    load();
  };
  const saveItems = async (next: LineItem[]) => {
    if (!doc) return;
    setItems(next);
    await sb().from("proposal_items").delete().eq("proposal_id", doc.id);
    if (next.length) await sb().from("proposal_items").insert(next.map((it, i) => ({ proposal_id: doc.id, code: it.code, description: it.description, unit: it.unit, qty: Number(it.qty) || 0, unit_price: Number(it.unit_price) || 0, sort: i })));
    load();
  };
  const convert = async () => {
    if (!doc || !org) return;
    const number = await nextNumber("invoices", "INV");
    const termDays = parseInt(org.terms.match(/\d+/)?.[0] || "30", 10);
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await sb().from("invoices").insert({ number, proposal_id: doc.id, client_name: doc.client_name, job: doc.job, date: today, due_date: addDays(today, termDays), tax_pct: doc.tax_pct }).select().single();
    if (error || !data) { flash(error?.message || "Failed"); return; }
    await sb().from("invoice_items").insert(items.map((it, i) => ({ invoice_id: data.id, code: it.code, description: it.description, unit: it.unit, qty: Number(it.qty) || 0, unit_price: Number(it.unit_price) || 0, sort: i })));
    await saveDoc({ status: "invoiced" }, true);
    flash(`${number} created`); window.location.href = "/invoices";
  };

  const matches = search ? book.filter((b) => `${b.code} ${b.description}`.toLowerCase().includes(search.toLowerCase())).slice(0, 6) : [];

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
            <button className="btn" onClick={() => setPrintOpen(true)}>Print / PDF</button>
            {doc.status === "draft" && <button className="btn" onClick={() => saveDoc({ status: "sent" })}>Mark sent</button>}
            {doc.status === "sent" && <button className="btn" onClick={() => saveDoc({ status: "approved" })}>Mark approved</button>}
            {doc.status !== "invoiced" && <button className="btn btn-primary" onClick={convert}>→ Invoice</button>}
          </div>
        </div>
        <div className="card mb-3 grid gap-2.5 p-3.5 md:grid-cols-3">
          <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Client</div>
            <input className="field" list="clientlist" value={doc.client_name} onChange={(e) => setDoc({ ...doc, client_name: e.target.value })} onBlur={(e) => saveDoc({ client_name: e.target.value }, true)} />
            <datalist id="clientlist">{clients.map((c) => <option key={c} value={c} />)}</datalist></div>
          <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Job / location</div>
            <input className="field" value={doc.job} onChange={(e) => setDoc({ ...doc, job: e.target.value })} onBlur={(e) => saveDoc({ job: e.target.value }, true)} /></div>
          <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Date</div>
            <input className="field" type="date" value={doc.date} onChange={(e) => saveDoc({ date: e.target.value }, true)} /></div>
        </div>
        <div className="relative mb-3">
          <input className="field" placeholder="Type a line item… (searches your price book)" value={search} onChange={(e) => setSearch(e.target.value)} />
          {search && (
            <div className="card absolute inset-x-0 top-full z-10 shadow-lg">
              {matches.map((b) => (
                <button key={b.id} className="flex w-full justify-between gap-2 border-b border-rulesoft p-2.5 text-left text-sm" onClick={() => { saveItems([...items, { code: b.code, description: b.description, unit: b.unit, qty: 1, unit_price: Number(b.unit_price) }]); setSearch(""); }}>
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
      <div className="mb-3 flex items-baseline justify-between">
        <div className="font-display text-2xl font-bold uppercase">Proposals</div>
        <button className="btn btn-primary" onClick={newProposal}>+ New proposal</button>
      </div>
      <div className="card divide-y divide-rulesoft">
        {list.map((p) => (
          <button key={p.id} className="flex w-full items-center justify-between gap-2 p-3.5 text-left" onClick={() => openEditor(p)}>
            <div className="min-w-0">
              <div className="font-mono text-[13px] font-semibold">{p.number}</div>
              <div className="truncate text-[13px] text-inksoft">{p.client_name || "No client"}{p.job ? ` · ${p.job}` : ""}</div>
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
