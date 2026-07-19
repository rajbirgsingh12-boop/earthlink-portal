"use client";
import { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { sb } from "@/lib/supabase";
import { fmt, parseNum } from "@/lib/format";

interface Item { id: string; code: string; description: string; unit: string; unit_price: number; category: string; }

export default function Items() {
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState({ code: "", description: "", unit: "EA", unit_price: "", category: "" });
  const [msg, setMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 2500); };

  const load = async () => {
    const { data } = await sb().from("price_items").select("*").order("code");
    setItems((data || []) as Item[]);
  };
  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!draft.description) return;
    const { error } = await sb().from("price_items").insert({ ...draft, unit_price: parseNum(draft.unit_price) });
    if (error) { flash(error.message); return; }
    setDraft({ code: "", description: "", unit: "EA", unit_price: "", category: "" });
    load();
  };
  const del = async (id: string) => { await sb().from("price_items").delete().eq("id", id); load(); };

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
        const headers = raw[hIdx].map((h) => String(h).toLowerCase());
        const col = (re: RegExp) => headers.findIndex((h) => re.test(h));
        const m = { code: col(/code|sku|item ?#|no\./), description: col(/desc|item name|scope|work|item$/), unit: col(/unit|uom/), price: col(/price|rate|cost|amount|\$/), category: col(/categ|trade|type|division/) };
        const rows = raw.slice(hIdx + 1).filter((r) => r.some((c) => String(c).trim() !== ""))
          .map((r) => ({
            code: m.code >= 0 ? String(r[m.code]).trim() : "",
            description: m.description >= 0 ? String(r[m.description]).trim() : "",
            unit: m.unit >= 0 ? String(r[m.unit]).trim() || "EA" : "EA",
            unit_price: m.price >= 0 ? parseNum(r[m.price]) : 0,
            category: m.category >= 0 ? String(r[m.category]).trim() : "",
          })).filter((it) => it.description);
        for (let i = 0; i < rows.length; i += 500) {
          const { error } = await sb().from("price_items").insert(rows.slice(i, i + 500));
          if (error) { flash(error.message); break; }
        }
        flash(`${rows.length} items added`); load();
      } catch { flash("Couldn't read that file"); }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  const list = items.filter((it) => `${it.code} ${it.description} ${it.category}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <div className="font-display text-2xl font-bold uppercase">Price Book</div>
        <button className="btn btn-ghost" onClick={() => fileRef.current?.click()}>Upload sheet</button>
      </div>
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFile} />
      <div className="card mb-3 grid grid-cols-2 gap-2 p-3 md:grid-cols-6">
        <input className="field" placeholder="Code" value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
        <input className="field md:col-span-2" placeholder="Description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        <input className="field" placeholder="Unit" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} />
        <input className="field" placeholder="Price" inputMode="decimal" value={draft.unit_price} onChange={(e) => setDraft({ ...draft, unit_price: e.target.value })} />
        <button className="btn btn-primary" onClick={add}>Add</button>
      </div>
      <input className="field mb-3" placeholder="Search the book…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="card overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead><tr className="border-b-[1.5px] border-ink text-left font-display text-xs uppercase tracking-widest text-inksoft">
            <th className="p-2.5">Code</th><th className="p-2.5">Description</th><th className="p-2.5">Unit</th><th className="p-2.5 text-right">Price</th><th></th></tr></thead>
          <tbody>
            {list.map((it) => (
              <tr key={it.id} className="border-b border-rulesoft">
                <td className="p-2.5 font-mono text-xs">{it.code}</td>
                <td className="p-2.5">{it.description}{it.category && <span className="text-xs text-inksoft"> · {it.category}</span>}</td>
                <td className="p-2.5 font-mono text-xs">{it.unit}</td>
                <td className="p-2.5 text-right font-mono">{fmt(Number(it.unit_price))}</td>
                <td className="p-2.5 text-right"><button className="text-xs text-alert" onClick={() => del(it.id)}>✕</button></td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={5} className="p-4 text-inksoft">No items yet. Upload your price sheet or add the first item.</td></tr>}
          </tbody>
        </table>
      </div>
      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
