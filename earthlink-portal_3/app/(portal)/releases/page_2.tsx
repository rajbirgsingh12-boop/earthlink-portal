"use client";
import { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { sb } from "@/lib/supabase";
import { fmt, parseNum } from "@/lib/format";
import Stamp from "@/components/Stamp";
import type { Contract, Release } from "@/lib/types";
import { parseReleasePdfText, type ReleaseItem } from "@/lib/parseRelease";

type Filter = "all" | "chase" | "payroll" | "canceled" | "hours";

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
  const [limit, setLimit] = useState(100);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [logged, setLogged] = useState<Record<string, number> | null>(null);
  const [pending, setPending] = useState<{ items: Omit<Release, "id" | "contract_id">[]; guess: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pdfPending, setPdfPending] = useState<{
    contract: string; rel: string; date: string; location: string; address: string;
    ticket: string; amount: number; hours: number; items: ReleaseItem[];
  } | null>(null);
  const pdfRef = useRef<HTMLInputElement>(null);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 2500); };

  const loadContracts = async () => {
    const { data } = await sb().from("contracts").select("id,number,name").order("number");
    const list = (data || []) as Contract[];
    setContracts(list);
    if (!active && list[0]) setActive(list[0].id);
  };
  useEffect(() => { loadContracts(); }, []);

  const loadRows = async (cid: string) => {
    if (!cid) { setRows([]); return; }
    setBusy(true);
    const all: Release[] = [];
    let from = 0;
    for (;;) {
      const { data } = await sb().from("releases").select("*").eq("contract_id", cid).order("id").range(from, from + 999);
      if (!data || data.length === 0) break;
      all.push(...(data as Release[]));
      if (data.length < 1000) break;
      from += 1000;
    }
    // sort numerically by release number when possible
    all.sort((a, b) => (parseFloat(a.rel_number) || 0) - (parseFloat(b.rel_number) || 0));
    setRows(all);
    setBusy(false);
  };
  useEffect(() => { loadRows(active); }, [active]);

  const loadLogged = async () => {
    const { data } = await sb().from("timesheet_entries").select("release_id,hours");
    const agg: Record<string, number> = {};
    (data || []).forEach((e: { release_id: string | null; hours: number[] }) => {
      if (!e.release_id) return;
      agg[e.release_id] = (agg[e.release_id] || 0) + (e.hours || []).reduce((s2, h) => s2 + (Number(h) || 0), 0);
    });
    setLogged(agg);
  };

  const live = rows.filter((r) => !r.canceled);
  const canceledRows = rows.filter((r) => r.canceled);
  const notR = live.filter((r) => !r.received && Number(r.amount) > 0);
  const prPend = live.filter((r) => !r.payroll_done && Number(r.amount) > 0);
  const tot = live.reduce((s, r) => s + Number(r.amount), 0);

  let list = live;
  if (filter === "chase") list = notR;
  if (filter === "payroll") list = prPend;
  if (filter === "canceled") list = canceledRows;
  if (q) list = list.filter((r) => `${r.rel_number} ${r.location} ${r.buildings} ${r.ticket}`.toLowerCase().includes(q.toLowerCase()));
  const shown = list.slice(0, limit);

  const toggle = async (r: Release, patch: Partial<Release>) => {
    setRows(rows.map((x) => (x.id === r.id ? { ...x, ...patch } : x)));
    const { error } = await sb().from("releases").update(patch).eq("id", r.id);
    if (error) { flash(error.message); loadRows(active); }
  };

  // ---------- import ----------
  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fname = file.name || "";
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const buf = ev.target?.result as ArrayBuffer;
        const redRows = await detectRedRows(buf);
        const wb = XLSX.read(buf, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const raw: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false, blankrows: true });
        const hIdx = raw.findIndex((r) => r.some((c) => /release/i.test(c)) && r.some((c) => /amount/i.test(c)));
        if (hIdx < 0) { flash("No header row with Release + Amount found"); return; }
        const headers = raw[hIdx].map((h) => String(h).toLowerCase());
        const col = (re: RegExp) => headers.findIndex((h) => re.test(h));
        const m = { rel: col(/^release/), location: col(/location/), buildings: col(/building/), ticket: col(/ticket/), amount: col(/amount/), pre: col(/pre/), date: col(/date|complet/), payroll: col(/payroll/), received: col(/receiv/), status: col(/status/), hours: col(/hour|labor/) };
        const pre = raw.slice(0, hIdx).flat().join(" ");
        const gm = pre.match(/contract\s*#?\s*([A-Za-z0-9-]+)/i) || fname.match(/(\d{5,})/);
        const items = raw.slice(hIdx + 1)
          .map((r, k) => ({ r, sheetRow: hIdx + 2 + k }))
          .filter(({ r }) => r.some((c) => String(c).trim() !== ""))
          .map(({ r, sheetRow }) => {
            const g = (i: number) => (i >= 0 ? String(r[i] ?? "").trim() : "");
            const rowText = r.join(" ");
            return {
              rel_number: g(m.rel), location: g(m.location), buildings: g(m.buildings), ticket: g(m.ticket),
              amount: m.amount >= 0 ? parseNum(r[m.amount]) : 0, pre_check: g(m.pre), date_completed: g(m.date),
              payroll_done: /^d/i.test(g(m.payroll)), received: /^y/i.test(g(m.received)),
              canceled: redRows.has(sheetRow) || /cancel|void/i.test(g(m.status) || rowText), labor_hours: m.hours >= 0 ? parseNum(r[m.hours]) : 0, assigned_to: null,
            };
          })
          .filter((it) => it.rel_number || it.amount > 0);
        setPending({ items, guess: gm ? gm[1] : "" });
      } catch { flash("Couldn't read that file — save as .xlsx or .csv"); }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  const runImport = async (mode: "replace" | "append") => {
    if (!pending) return;
    setBusy(true);
    const num = (pending.guess || "Contract").trim();
    let contract = contracts.find((c) => c.number === num);
    if (!contract) {
      const { data, error } = await sb().from("contracts").insert({ number: num, name: num }).select().single();
      if (error) { flash(error.message); setBusy(false); return; }
      contract = data as Contract;
    }
    if (mode === "replace") await sb().from("releases").delete().eq("contract_id", contract.id);
    for (let i = 0; i < pending.items.length; i += 500) {
      const chunk = pending.items.slice(i, i + 500).map((it) => ({ ...it, contract_id: contract!.id }));
      const { error } = await sb().from("releases").insert(chunk);
      if (error) { flash(error.message); break; }
    }
    setPending(null); setBusy(false);
    await loadContracts(); setActive(contract.id); await loadRows(contract.id);
    flash(`Loaded into ${num}`);
  };

  // ---------- release PDF import ----------
  const handlePdf = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
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
        if (!parsed) { flash("Couldn't read this PDF — is it a NYCHA blanket release?"); setBusy(false); return; }
        setPdfPending({
          contract: parsed.contract, rel: parsed.rel, date: parsed.orderDate,
          location: parsed.development, address: "", ticket: parsed.workOrders[0] || "",
          amount: parsed.total, hours: parsed.laborHours, items: parsed.items,
        });
        setBusy(false);
      } catch { flash("Couldn't read that PDF"); setBusy(false); }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  const savePdfRelease = async () => {
    if (!pdfPending) return;
    setBusy(true);
    const num = pdfPending.contract.trim() || "Contract";
    let contract = contracts.find((c) => c.number === num);
    if (!contract) {
      const { data, error } = await sb().from("contracts").insert({ number: num, name: num }).select().single();
      if (error) { flash(error.message); setBusy(false); return; }
      contract = data as Contract;
    }
    const { data: rel, error } = await sb().from("releases").insert({
      contract_id: contract.id, rel_number: pdfPending.rel, location: pdfPending.location,
      buildings: pdfPending.address, address: pdfPending.address, ticket: pdfPending.ticket,
      amount: pdfPending.amount, labor_hours: pdfPending.hours,
      date_completed: "", pre_check: "", payroll_done: false, received: false, canceled: false, assigned_to: null,
    }).select().single();
    if (error || !rel) { flash(error?.message || "Save failed"); setBusy(false); return; }
    if (pdfPending.items.length > 0) {
      const { error: e2 } = await sb().from("release_items").insert(
        pdfPending.items.map((it) => ({ release_id: (rel as Release).id, ...it }))
      );
      if (e2) flash(`Release saved, but items failed: ${e2.message}`);
    }
    const saved = pdfPending;
    setPdfPending(null); setBusy(false);
    await loadContracts(); setActive(contract.id); await loadRows(contract.id);
    flash(`Release ${saved.rel} added to ${num} — ${saved.items.length} line items`);
  };

  const exportSheet = () => {
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
          <button className="btn btn-ghost" onClick={() => pdfRef.current?.click()}>+ From PDF</button>
          <button className="btn btn-ghost" onClick={() => fileRef.current?.click()}>Upload sheet</button>
          {rows.length > 0 && <button className="btn btn-ghost" onClick={exportSheet}>Download</button>}
        </div>
      </div>
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFile} />
      <input ref={pdfRef} type="file" accept="application/pdf" className="hidden" onChange={handlePdf} />

      {pending && (
        <div className="card mb-4 border-work p-4">
          <div className="mb-2 font-display text-base font-semibold uppercase">Import {pending.items.length} releases</div>
          <label className="text-[11px] uppercase tracking-widest text-inksoft">Contract number</label>
          <input className="field mb-2 mt-1" value={pending.guess} onChange={(e) => setPending({ ...pending, guess: e.target.value })} />
          <div className="mb-3 font-mono text-xs text-inksoft">
            Total {fmt(pending.items.reduce((s, i) => s + i.amount, 0))} · canceled flagged: {pending.items.filter((i) => i.canceled).length}
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={() => runImport("replace")} disabled={busy}>Load (replace contract)</button>
            <button className="btn" onClick={() => runImport("append")} disabled={busy}>Append</button>
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
                <input className="field" inputMode={k === "amount" || k === "hours" ? "decimal" : "text"}
                  placeholder={k === "address" ? "e.g. Stairhall 15, Apt 526" : ""}
                  value={String(pdfPending[k])}
                  onChange={(e) => setPdfPending({ ...pdfPending, [k]: k === "amount" || k === "hours" ? parseNum(e.target.value) : e.target.value })} />
              </div>
            ))}
          </div>
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
            <button className="btn btn-ghost" onClick={() => setPdfPending(null)}>Cancel</button>
          </div>
        </div>
      )}

      {contracts.length > 1 && (
        <select className="field mb-3" value={active} onChange={(e) => { setActive(e.target.value); setLimit(100); }}>
          {contracts.map((c) => <option key={c.id} value={c.id}>{c.number}{c.name && c.name !== c.number ? ` — ${c.name}` : ""}</option>)}
        </select>
      )}

      {rows.length > 0 && (
        <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          {([["Released", fmt(tot), "text-ink"], ["Received", fmt(live.filter((r) => r.received).reduce((s, r) => s + Number(r.amount), 0)), "text-ok"], ["Not received", fmt(notR.reduce((s, r) => s + Number(r.amount), 0)), "text-work"], ["Payroll pending", fmt(prPend.reduce((s, r) => s + Number(r.amount), 0)), "text-alert"]] as [string, string, string][]).map(([l, v, cls]) => (
            <div key={l} className="card p-3">
              <div className="text-[10px] uppercase tracking-[.12em] text-inksoft">{l}</div>
              <div className={`font-mono text-base font-semibold ${cls}`}>{v}</div>
            </div>
          ))}
        </div>
      )}

      <div className="mb-3 flex flex-wrap gap-2">
        {([["all", "All"], ["chase", `Chase list (${notR.length})`], ["payroll", `Payroll to submit (${prPend.length})`], ["canceled", `Canceled (${canceledRows.length})`], ["hours", "Payroll check"]] as [Filter, string][]).map(([f, l]) => (
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
              {live.filter((r) => (Number(r.labor_hours) > 0 || (logged?.[r.id] || 0) > 0) && (!q || `${r.rel_number} ${r.location} ${r.buildings} ${r.ticket}`.toLowerCase().includes(q.toLowerCase()))).map((r) => {
                const got = logged?.[r.id] || 0;
                const need = Number(r.labor_hours) || 0;
                return (
                  <tr key={r.id} className="border-b border-rulesoft">
                    <td className="p-2.5 font-mono text-xs">{r.rel_number}</td>
                    <td className="p-2.5">{r.location}<div className="max-w-[220px] truncate text-[11px] text-inksoft">{r.buildings}</div></td>
                    <td className="p-2.5 text-right">
                      <input className="w-20 rounded-sm border border-rulesoft p-1.5 text-right font-mono" inputMode="decimal" defaultValue={need || ""} placeholder="0"
                        onBlur={(e) => toggle(r, { labor_hours: parseNum(e.target.value) })} />
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
                </td>
                <td className={`p-2.5 text-right font-mono ${r.canceled ? "line-through" : ""}`}>{fmt(Number(r.amount))}</td>
                <td className="p-2.5 text-center">
                  {!r.canceled && <button onClick={() => toggle(r, { payroll_done: !r.payroll_done })}><Stamp label={r.payroll_done ? "DONE" : "TO DO"} tone={r.payroll_done ? "ok" : "alert"} /></button>}
                </td>
                <td className="p-2.5 text-center">
                  {!r.canceled ? <button onClick={() => toggle(r, { received: !r.received })}><Stamp label={r.received ? "YES" : "NO"} tone={r.received ? "ok" : "work"} /></button> : <Stamp label="CANCELED" tone="mute" />}
                </td>
                <td className="p-2.5 text-center">
                  <button className={r.canceled ? "text-ok" : "text-alert"} title={r.canceled ? "Restore" : "Mark canceled"} onClick={() => toggle(r, { canceled: !r.canceled })}>{r.canceled ? "↺" : "✕"}</button>
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
      {busy && <div className="mt-3 text-sm text-inksoft">Working…</div>}
      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
