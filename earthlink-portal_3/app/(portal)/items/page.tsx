"use client";
import { useEffect, useRef, useState } from "react";
import { matches } from "@/lib/search";
import { useDebounced } from "@/lib/useDebounced";
// the sheet reader is heavy: it loads on demand, never with the page itself
let XLSX!: typeof import("xlsx-js-style");
const ensureXLSX = async () => { XLSX = XLSX || (await import("xlsx-js-style")); };
import { sb } from "@/lib/supabase";
import { fmt, parseNum } from "@/lib/format";
import type { Contract } from "@/lib/types";
import ContractPicker from "@/components/ContractPicker";
import PageHeader from "@/components/PageHeader";
import { RowActions } from "@/components/ActionMenu";
import Toast, { useFlash } from "@/components/Toast";
import { useLive } from "@/lib/useLive";

interface Item { id: string; code: string; description: string; unit: string; unit_price: number; category: string; line?: number; }

// what the office reads when the database says no: the upgrade it needs, or a
// plain "try again" (never the database's own words)
const UPGRADE_MSG = "The portal's database needs an upgrade before this works (Settings → System check).";
const dbMsg = (m: string, what: string) => (/relation|column|schema cache/i.test(m) ? UPGRADE_MSG : `Couldn't ${what}. Check your signal and try again.`);

export default function Items() {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [sel, setSel] = useState<string>(""); // contract id, or "" = general book
  const [items, setItems] = useState<Item[]>([]);
  // which book the rows on screen belong to: until it is the one picked, the list is loading
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const loaded = loadedFor === sel;
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState({ code: "", description: "", unit: "EA", unit_price: "", category: "" });
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { msg, flash } = useFlash();
  const isContract = sel !== "";
  const selRef = useRef(sel); selRef.current = sel;

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
      if (target !== selRef.current) return; // another book was picked while this one loaded
      if (error) { flash(dbMsg(error.message, "load the price book")); setItems([]); setLoadedFor(target); return; }
      setItems(((data || []) as { id: string; line: number; code: string; category: string; description: string; uom: string; unit_price: number }[])
        .map((r) => ({ id: r.id, line: r.line, code: r.code, category: r.category, description: r.description, unit: r.uom, unit_price: r.unit_price })));
    } else {
      let { data, error } = await sb().from("price_items").select("*").order("line").order("code");
      if (error) ({ data } = await sb().from("price_items").select("*").order("code"));
      if (target !== selRef.current) return;
      setItems((data || []) as Item[]);
    }
    setLoadedFor(target);
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
    if (error) { flash(dbMsg(error.message, "add the line")); return; }
    setDraft({ code: "", description: "", unit: "EA", unit_price: "", category: "" });
    flash("Line added");
    load();
  };
  const del = async (id: string) => {
    const { error } = await sb().from(isContract ? "contract_items" : "price_items").delete().eq("id", id);
    if (error) { flash(dbMsg(error.message, "delete the line")); return; }
    flash("Line deleted");
    load();
  };

  // ---------- inline editing: one row at a time flips into input mode ----------
  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState({ line: "", code: "", description: "", category: "", unit: "", unit_price: "" });
  const startEdit = (it: Item) => {
    setEditId(it.id);
    setEdit({ line: String(it.line || ""), code: it.code || "", description: it.description || "", category: it.category || "", unit: it.unit || "", unit_price: String(it.unit_price ?? "") });
  };
  const saveEdit = async () => {
    if (!editId) return;
    const base = { code: edit.code, category: edit.category, description: edit.description, unit_price: parseNum(edit.unit_price), line: Math.round(parseNum(edit.line)) };
    const payload = isContract ? { ...base, uom: edit.unit } : { ...base, unit: edit.unit };
    let { error } = await sb().from(isContract ? "contract_items" : "price_items").update(payload).eq("id", editId);
    if (error && /column|schema cache/i.test(error.message)) {
      const { line: _l, ...rest } = payload;
      ({ error } = await sb().from(isContract ? "contract_items" : "price_items").update(rest).eq("id", editId));
    }
    if (error) { flash(dbMsg(error.message, "save the line")); return; }
    setEditId(null); flash("Line saved");
    load();
  };
  // Enter in any box of the row being edited saves it
  const enterSaves = (e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); saveEdit(); } };
  const removeAll = async () => {
    setBusy(true);
    const { error } = isContract
      ? await sb().from("contract_items").delete().eq("contract_id", sel)
      : await sb().from("price_items").delete().not("id", "is", null);
    setBusy(false); setConfirmWipe(false);
    if (error) { flash(dbMsg(error.message, "clear the price book")); return; }
    flash("Price book cleared");
    load();
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      setBusy(true);
      try {
        await ensureXLSX();
        const wb = XLSX.read(ev.target?.result, { type: "array" });
        const raw: string[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: false });
        // a real header row has several labeled columns: a decorative title
        // like "Price Items 2024" must not swallow the actual header below it
        let hIdx = raw.findIndex((r) => r.filter((c) => String(c).trim() !== "").length >= 2 && r.some((c) => /desc|item|scope/i.test(c)));
        if (hIdx < 0) hIdx = raw.findIndex((r) => r.some((c) => /desc|item|scope/i.test(c)));
        if (hIdx < 0) { flash("Need a header row with a Description or Item column"); return; }
        const headers = raw[hIdx].map((h) => String(h).toLowerCase().trim());
        const col = (re: RegExp) => headers.findIndex((h) => re.test(h));
        // match by header NAME; on NYCHA sheets "Item" is the code column and
        // "Description" the text, so one pattern must never claim both
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
        if (rows.length === 0) { flash("No lines found on that sheet"); return; }
        if (isContract) {
          // a code repeated on the sheet is one line in the book (the book holds each code once; lines with no code are all kept)
          const seenCodes = new Set<string>();
          const kept = rows.filter((r) => { if (!r.code) return true; if (seenCodes.has(r.code)) return false; seenCodes.add(r.code); return true; });
          rows.length = 0; rows.push(...kept);
          // replace this contract's book so re-uploads never duplicate
          const { error: de } = await sb().from("contract_items").delete().eq("contract_id", sel);
          if (de) { flash(dbMsg(de.message, "replace the price book")); return; }
          for (let i = 0; i < rows.length; i += 500) {
            const { error } = await sb().from("contract_items").insert(rows.slice(i, i + 500).map((r) => ({
              contract_id: sel, line: r.line, code: r.code, category: r.category, description: r.description, uom: r.unit, unit_price: r.unit_price,
            })));
            // the old book is already cleared: say so, or a half-loaded book looks complete
            if (error) { flash(/relation/i.test(error.message) ? UPGRADE_MSG : `Upload stopped partway: only ${i} of ${rows.length} lines made it. Upload the sheet again to finish the book`); return; }
          }
          const c = contracts.find((x) => x.id === sel);
          flash(`${rows.length} lines loaded into contract ${c?.number || ""}`);
        } else {
          for (let i = 0; i < rows.length; i += 500) {
            let { error } = await sb().from("price_items").insert(rows.slice(i, i + 500));
            if (error && /column/i.test(error.message)) {
              ({ error } = await sb().from("price_items").insert(rows.slice(i, i + 500).map(({ line: _l, ...rest }) => rest)));
            }
            if (error) { flash(dbMsg(error.message, "add the lines")); return; }
          }
          flash(`${rows.length} lines added to the general book`);
        }
        load();
      } catch { flash("Couldn't read that sheet. Save it as .xlsx or .csv"); }
      finally { setBusy(false); }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  // the search settles before the table is rebuilt, and only the first
  // SHOWN lines are drawn: a 1,500-line book redrawn on every letter is
  // what made this feel stuck
  const qd = useDebounced(q);
  const found = items.filter((it) => matches(qd, it.line || "", it.code, it.description, it.category));
  const SHOWN = 150;
  const list = found.slice(0, SHOWN);
  const more = found.length - list.length;
  const bookName = isContract ? `contract ${contracts.find((x) => x.id === sel)?.number}'s book` : "the general book";

  return (
    <div>
      {busy && <div className="busy-bar" aria-busy="true" aria-label="Working" />}
      <PageHeader title="Price Book"
        primary={<button type="button" className="btn btn-primary" onClick={() => setAddOpen(!addOpen)}>{addOpen ? "Close" : "+ Add line"}</button>}
        menu={[
          { label: "Upload price sheet", glyph: "📄", onSelect: () => fileRef.current?.click() },
          { label: "Remove all…", destructive: true, hidden: items.length === 0 || confirmWipe, onSelect: () => setConfirmWipe(true) },
        ]} />
      <div className="mb-3">
        <div className="section-label mb-1">Price book</div>
        <ContractPicker contracts={contracts} value={sel} onChange={setSel} extra={[{ id: "", label: "General (no contract)" }]} />
        {isContract && <div className="mt-1 text-xs text-inksoft">Walk sheets and invoices on this contract price from these lines. Uploading a sheet replaces the whole book.</div>}
      </div>
      {confirmWipe && (
        <div className="card card-pad anim-open mb-3 border-alert">
          <div className="mb-2 text-sm">Delete all <b>{items.length}</b> lines from {bookName}? This can&apos;t be undone. Walk sheets and invoices already made keep their own copies of the lines.</div>
          <div className="flex gap-2">
            <button type="button" className="btn border-alert text-alert" onClick={removeAll} disabled={busy}>Yes, remove all</button>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmWipe(false)}>Cancel</button>
          </div>
        </div>
      )}
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFile} />
      {addOpen && (
        <form onSubmit={(e) => { e.preventDefault(); add(); }} className="card anim-open mb-3 grid grid-cols-2 gap-2 p-3 md:grid-cols-7">
          <input className="field" placeholder="Code" autoFocus value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
          <input className="field md:col-span-2" placeholder="Description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          <input className="field" placeholder="Category" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
          <input className="field" placeholder="Unit" autoCapitalize="characters" spellCheck={false} value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} />
          <input className="field" placeholder="Price" inputMode="decimal" enterKeyHint="done" value={draft.unit_price} onChange={(e) => setDraft({ ...draft, unit_price: e.target.value })} />
          <button type="submit" className="btn btn-primary">Add line</button>
        </form>
      )}
      <input type="search" enterKeyHint="search" autoComplete="off" className="field mb-1" placeholder="Search line #, code, description…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mb-3 text-[12px] text-inksoft">
        {found.length === items.length ? `${items.length} line${items.length === 1 ? "" : "s"} in this book` : `${found.length} of ${items.length} lines match`}
        {more > 0 ? ` · showing the first ${SHOWN}, type more to narrow it down` : ""}
      </div>
      {!loaded ? (
        <div className="card">
          {[0, 1, 2].map((i) => (
            /* the table's shape, shimmering, while the book loads */
            <div key={`sk${i}`} className="border-b border-rulesoft p-3 last:border-b-0">
              <div className="flex items-center justify-between gap-2">
                <div className="skeleton h-4 w-24" />
                <div className="skeleton h-4 w-16" />
              </div>
              <div className="skeleton mt-2 h-3 w-2/3" />
            </div>
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="empty">
          {items.length === 0
            ? (isContract ? "No price book for this contract yet. Upload the contract's price sheet (⋯ → Upload price sheet)." : "No lines yet. Upload a price sheet or add the first line.")
            : "Nothing matches that search. Clear the box to see every line."}
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full border-collapse text-sm" style={{ minWidth: 560 }}>
            <thead className="sticky top-[105px] bg-card"><tr className="border-b-[1.5px] border-ink text-left font-display text-xs uppercase tracking-widest text-inksoft">
              <th className="p-2.5">Line</th><th className="p-2.5">Code</th><th className="p-2.5">Description</th><th className="p-2.5">UOM</th><th className="p-2.5 text-right">Price</th><th></th></tr></thead>
            <tbody>
              {list.map((it) => (
                editId === it.id ? (
                  <tr key={it.id} className="anim-row border-b border-rulesoft bg-paper align-top">
                    <td className="p-1.5"><input className="field w-16 px-1.5 py-1.5 text-right font-mono" inputMode="numeric" aria-label="Line #" value={edit.line} onChange={(e) => setEdit({ ...edit, line: e.target.value })} onKeyDown={enterSaves} /></td>
                    <td className="p-1.5"><input className="field w-24 px-1.5 py-1.5 font-mono" aria-label="Code" value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value })} onKeyDown={enterSaves} /></td>
                    <td className="p-1.5">
                      <input className="field mb-1" placeholder="Description" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} onKeyDown={enterSaves} />
                      <input className="field" placeholder="Category" value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })} onKeyDown={enterSaves} />
                    </td>
                    <td className="p-1.5"><input className="field w-16 px-1.5 py-1.5 text-center font-mono" aria-label="Unit" autoCapitalize="characters" spellCheck={false} value={edit.unit} onChange={(e) => setEdit({ ...edit, unit: e.target.value })} onKeyDown={enterSaves} /></td>
                    <td className="p-1.5"><input className="field w-24 px-1.5 py-1.5 text-right font-mono" inputMode="decimal" aria-label="Price" enterKeyHint="done" value={edit.unit_price}
                      onChange={(e) => setEdit({ ...edit, unit_price: e.target.value })} onKeyDown={enterSaves} /></td>
                    <td className="whitespace-nowrap p-1.5 text-right">
                      <button type="button" className="btn btn-primary btn-sm" onClick={saveEdit}>Save</button>
                      <button type="button" className="btn btn-ghost btn-sm ml-1.5" onClick={() => setEditId(null)}>Cancel</button>
                    </td>
                  </tr>
                ) : (
                  <tr key={it.id} className="anim-row border-b border-rulesoft align-top">
                    <td className="p-2.5 font-mono text-xs">{it.line || ""}</td>
                    <td className="p-2.5 font-mono text-xs">{it.code}</td>
                    <td className="p-2.5">
                      {it.description}
                      {it.category && <div className="text-[12px] text-inksoft">{it.category}</div>}
                    </td>
                    <td className="p-2.5 font-mono text-xs">{it.unit}</td>
                    <td className="p-2.5 text-right font-mono">{fmt(Number(it.unit_price))}</td>
                    <td className="whitespace-nowrap p-1.5 text-right">
                      <RowActions items={[
                        { label: "Edit line", onSelect: () => startEdit(it) },
                        { label: "Delete line…", destructive: true, confirm: "Delete this line from the price book? Walk sheets and invoices already made keep their own copy.", onSelect: () => del(it.id) },
                      ]} />
                    </td>
                  </tr>
                )
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Toast msg={msg} />
    </div>
  );
}
