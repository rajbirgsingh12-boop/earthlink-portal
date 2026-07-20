"use client";
import { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { sb } from "@/lib/supabase";
import { fmt, parseNum } from "@/lib/format";

interface Item { id: string; code: string; description: string; unit: string; unit_price: number; category: string; line?: number; }

export default function Items() {
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState({ code: "", description: "", unit: "EA", unit_price: "", category: "" });
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 2500); };

  const load = async () => {
    let { data, error } = await sb().from("price_items").select("*").order("line").order("code");
    if (error) ({ data } = await sb().from("price_items").select("*").order("code")); // pre-upgrade: no line column yet
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
  const removeAll = async () => {
    setBusy(true);
    const { error } = await sb().from("price_items").delete().not("id", "is", null);
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
          price: col(/^price|rate|cost|amount|\$/),
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
        for (let i = 0; i < rows.length; i += 500) {
          let { error } = await sb().from("price_items").insert(rows.slice(i, i + 500));
          if (error && /column/i.test(error.message)) {
            // pre-upgrade database — insert without the line column
            ({ error } = await sb().from("price_items").insert(rows.slice(i, i + 500).map(({ line: _l, ...rest }) => rest)));
          }
          if (error) { flash(error.message); break; }
        }
        flash(`${rows.length} items added`); load();
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
          <button className="btn btn-ghost" onClick={() => fileRef.current?.click()}>Upload sheet</button>
          {items.length > 0 && !confirmWipe && <button className="btn btn-ghost text-alert" onClick={() => setConfirmWipe(true)}>Remove all</button>}
        </div>
      </div>
      {confirmWipe && (
        <div className="card mb-3 border-alert p-3.5">
          <div className="mb-2 text-sm">Delete all <b>{items.length}</b> price book items? This can&apos;t be undone — proposals and invoices already created keep their own copies of the lines.</div>
          <div className="flex gap-2">
            <button className="btn border-alert text-alert" onClick={removeAll} disabled={busy}>Yes, remove all</button>
            <button className="btn btn-ghost" onClick={() => setConfirmWipe(false)}>Cancel</button>
          </div>
        </div>
      )}
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFile} />
      <div className="card mb-3 grid grid-cols-2 gap-2 p-3 md:grid-cols-6">
        <input className="field" placeholder="Code" value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
        <input className="field md:col-span-2" placeholder="Description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        <input className="field" placeholder="Unit" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} />
        <input className="field" placeholder="Price" inputMode="decimal" value={draft.unit_price} onChange={(e) => setDraft({ ...draft, unit_price: e.target.value })} />
        <button className="btn btn-primary" onClick={add}>Add</button>
      </div>
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
            {list.length === 0 && <tr><td colSpan={6} className="p-4 text-inksoft">No items yet. Upload your price sheet or add the first item.</td></tr>}
          </tbody>
        </table>
      </div>
      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
