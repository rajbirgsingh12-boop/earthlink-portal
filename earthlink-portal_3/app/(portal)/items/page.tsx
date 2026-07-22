"use client";
import { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { sb } from "@/lib/supabase";
import { fmt, parseNum } from "@/lib/format";
import type { Contract } from "@/lib/types";
import ContractPicker from "@/components/ContractPicker";
import { useLive } from "@/lib/useLive";

interface Item { id: string; code: string; description: string; unit: string; unit_price: number; category: string; line?: number; }

export default function Items() {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [sel, setSel] = useState<string>(""); // contract id, or "" = general book
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState({ code: "", description: "", unit: "EA", unit_price: "", category: "" });
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 2500); };
  const isContract = sel !== "";

  useEffect(() => {
    sb().from("contracts").select("id,number,name").order("number").then(({ data }) => {
      const cs = (data || []) as Contract[];
      setContracts(cs);
      if (cs[0]) setSel(cs[0].id); // default to the first contract's book
    });
  }, []);

  const load = async (target = sel) => {
    if (target) {
      const { data, error } = await sb().from("contract_items").select("*").eq("contract_id", target).order("line");
      if (error) { flash(/relation/i.test(error.message) ? "Run supabase/upgrade_proposal_creator.sql first" : error.message); setItems([]); return; }
      setItems(((data || []) as { id: string; line: number; code: string; category: string; description: string; uom: string; unit_price: number }[])
        .map((r) => ({ id: r.id, line: r.line, code: r.code, category: r.category, description: r.description, unit: r.uom, unit_price: r.unit_price })));
    } else {
      let { data, error } = await sb().from("price_items").select("*").order("line").order("code");
      if (error) ({ data } = await sb().from("price_items").select("*").order("code"));
      setItems((data || []) as Item[]);
    }
  };
  useEffect(() => { load(sel); setConfirmWipe(false); }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps

  // live: price book edits from anywhere show up without a reload
  useLive(["contract_items", "price_items", "contracts"], () => {
    load(sel);
    sb().from("contracts").select("id,number,name").order("number").then(({ data }) => setContracts((data || []) as Contract[]));
  }, { skipWhileTyping: true });

  const add = async () => {
    if (!draft.description) return;
    const { error } = isContract
      ? await sb().from("contract_items").insert({
          contract_id: sel, line: (items.reduce((mx, it) => Math.max(mx, it.line || 0), 0) + 1),
          code: draft.code, category: draft.category, description: draft.description, uom: draft.unit, unit_price: parseNum(draft.unit_price),
        })
      : await sb().from("price_items").insert({ ...draft, unit_price: parseNum(draft.unit_price) });
    if (error) { flash(error.message); return; }
    setDraft({ code: "", description: "", unit: "EA", unit_price: "", category: "" });
    load();
  };
  const del = async (id: string) => { await sb().from(isContract ? "contract_items" : "price_items").delete().eq("id", id); load(); };
  const removeAll = async () => {
    setBusy(true);
    const { error } = isContract
      ? await sb().from("contract_items").delete().eq("contract_id", sel)
      : await sb().from("price_items").delete().not("id", "is", null);
    setBusy(false); setConfirmWipe(false);
    if (error) { flash(error.message); return; }
    flash("Price book cleared");
    load();
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const wb = XLSX.read(ev.target?.result, { type: "array" });
        const raw: string[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: false });
        const hIdx = raw.findIndex((r) => r.some((c) => /desc|item|scope/i.test(c)));
        if (hIdx < 0) { flash("Need a header row with a Description/Item column"); return; }
        const headers = raw[hIdx].map((h) => String(h).toLowerCase().trim());
        const col = (re: RegExp) => headers.findIndex((h) => re.test(h));
        // match by header NAME; on NYCHA sheets "Item" is the code column and
        // "Description" the text — never let one pattern claim both
        const m = {
          line: col(/^line/),
          code: col(/^item$|code|sku|item ?#/),
          description: col(/^desc|item name|scope|work/),
          unit: col(/^uom|unit/),
          price: col(/unit ?price/) >= 0 ? col(/unit ?price/) : col(/^price|rate|cost|\$/) >= 0 ? col(/^price|rate|cost|\$/) : col(/amount/),
          category: col(/^categ|trade|type|division/),
        };
        if (m.description < 0) { m.description = m.code; m.code = -1; } // sheets where "Item" IS the description
        const rows = raw.slice(hIdx + 1).filter((r) => r.some((c) => String(c).trim() !== ""))
          .map((r, i) => ({
            line: m.line >= 0 ? parseInt(String(r[m.line]), 10) || i + 1 : i + 1,
            code: m.code >= 0 ? String(r[m.code]).trim() : "",
            description: m.description >= 0 ? String(r[m.description]).trim() : "",
            unit: m.unit >= 0 ? String(r[m.unit]).trim() || "EA" : "EA",
            unit_price: m.price >= 0 ? parseNum(r[m.price]) : 0,
            category: m.category >= 0 ? String(r[m.category]).trim() : "",
          })).filter((it) => it.description && !/^total$/i.test(it.description));
        if (rows.length === 0) { flash("No item rows found"); return; }
        if (isContract) {
          // replace this contract's book so re-uploads never duplicate
          await sb().from("contract_items").delete().eq("contract_id", sel);
          for (let i = 0; i < rows.length; i += 500) {
            const { error } = await sb().from("contract_items").insert(rows.slice(i, i + 500).map((r) => ({
              contract_id: sel, line: r.line, code: r.code, category: r.category, description: r.description, uom: r.unit, unit_price: r.unit_price,
            })));
            if (error) { flash(/relation/i.test(error.message) ? "Run supabase/upgrade_proposal_creator.sql first" : error.message); return; }
          }
          const c = contracts.find((x) => x.id === sel);
          flash(`${rows.length} lines loaded into contract ${c?.number || ""}`);
        } else {
          for (let i = 0; i < rows.length; i += 500) {
            let { error } = await sb().from("price_items").insert(rows.slice(i, i + 500));
            if (error && /column/i.test(error.message)) {
              ({ error } = await sb().from("price_items").insert(rows.slice(i, i + 500).map(({ line: _l, ...rest }) => rest)));
            }
            if (error) { flash(error.message); return; }
          }
          flash(`${rows.length} items added to the general book`);
        }
        load();
      } catch { flash("Couldn't read that file"); }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  const list = items.filter((it) => `${it.line || ""} ${it.code} ${it.description} ${it.category}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-display text-2xl font-bold uppercase">Price Book</div>
        <div className="flex gap-2">
          <button className="btn btn-ghost" onClick={() => setAddOpen(!addOpen)}>+ Add item</button>
          <button className="btn btn-ghost" onClick={() => fileRef.current?.click()}>Upload sheet</button>
          {items.length > 0 && !confirmWipe && <button className="btn btn-ghost text-alert" onClick={() => setConfirmWipe(true)}>Remove all</button>}
        </div>
      </div>
      <div className="mb-3">
        <div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Which price book?</div>
        <ContractPicker contracts={contracts} value={sel} onChange={setSel} extra={[{ id: "", label: "General (no contract)" }]} />
        {isContract && <div className="mt-1 text-xs text-inksoft">Uploads replace this contract&apos;s book — re-uploading never duplicates. Walk sheets and invoices for this contract use these lines and prices.</div>}
      </div>
      {confirmWipe && (
        <div className="card mb-3 border-alert p-3.5">
          <div className="mb-2 text-sm">Delete all <b>{items.length}</b> items from {isContract ? `contract ${contracts.find((x) => x.id === sel)?.number}'s book` : "the general book"}? This can&apos;t be undone — proposals and invoices already created keep their own copies of the lines.</div>
          <div className="flex gap-2">
            <button className="btn border-alert text-alert" onClick={removeAll} disabled={busy}>Yes, remove all</button>
            <button className="btn btn-ghost" onClick={() => setConfirmWipe(false)}>Cancel</button>
          </div>
        </div>
      )}
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFile} />
      {addOpen && (
        <div className="card mb-3 grid grid-cols-2 gap-2 p-3 md:grid-cols-6">
          <input className="field" placeholder="Code" value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
          <input className="field md:col-span-2" placeholder="Description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          <input className="field" placeholder="Unit" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} />
          <input className="field" placeholder="Price" inputMode="decimal" value={draft.unit_price} onChange={(e) => setDraft({ ...draft, unit_price: e.target.value })} />
          <button className="btn btn-primary" onClick={add}>Add</button>
        </div>
      )}
      <input className="field mb-3" placeholder="Search line #, code, description…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="card overflow-x-auto">
        <table className="w-full border-collapse text-sm" style={{ minWidth: 560 }}>
          <thead><tr className="border-b-[1.5px] border-ink text-left font-display text-xs uppercase tracking-widest text-inksoft">
            <th className="p-2.5">Line</th><th className="p-2.5">Item</th><th className="p-2.5">Description</th><th className="p-2.5">UOM</th><th className="p-2.5 text-right">Price</th><th></th></tr></thead>
          <tbody>
            {list.map((it) => (
              <tr key={it.id} className="border-b border-rulesoft align-top">
                <td className="p-2.5 font-mono text-xs">{it.line || ""}</td>
                <td className="p-2.5 font-mono text-xs">{it.code}</td>
                <td className="p-2.5">
                  {it.description}
                  {it.category && <div className="text-[11px] text-inksoft">{it.category}</div>}
                </td>
                <td className="p-2.5 font-mono text-xs">{it.unit}</td>
                <td className="p-2.5 text-right font-mono">{fmt(Number(it.unit_price))}</td>
                <td className="p-2.5 text-right"><button className="text-xs text-alert" onClick={() => del(it.id)}>✕</button></td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={6} className="p-4 text-inksoft">{isContract ? "This contract has no price book yet — hit Upload sheet and drop the contract's price sheet." : "No items yet. Upload a sheet or add the first item."}</td></tr>}
          </tbody>
        </table>
      </div>
      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
