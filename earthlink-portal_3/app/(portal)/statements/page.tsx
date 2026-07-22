"use client";
import { useEffect, useState } from "react";
// styled fork of SheetJS — same API, plus cell borders/fonts for the export
import * as XLSX from "xlsx-js-style";
import { sb } from "@/lib/supabase";
import { fmt, askFileName } from "@/lib/format";
import { Org, prettyDate } from "@/lib/docs";
import type { Contract, Release } from "@/lib/types";
import ContractPicker from "@/components/ContractPicker";
import { useLive } from "@/lib/useLive";
import NychaInvoicePrint from "@/components/NychaInvoicePrint";
import { gatherReleaseDoc, buildInvoiceXlsx, type DocRow } from "@/lib/releaseDoc";
import PrintShell from "@/components/PrintShell";
import { useNumBuffer } from "@/lib/numBuffer";

export default function Statements() {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [sel, setSel] = useState("");
  const [tq, setTq] = useState(""); // filter the outstanding list on screen
  const [rows, setRows] = useState<Release[]>([]);
  const [org, setOrg] = useState<Org | null>(null);
  const [printOpen, setPrintOpen] = useState(false);
  const [invPreview, setInvPreview] = useState<{ number: string; date: string; cNumber: string; relNum: string; dev: string; workOrder: string; rows: DocRow[] } | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [msg, setMsg] = useState("");
  const num = useNumBuffer();
  const today = new Date().toISOString().slice(0, 10);

  const genInvoice = async (r: Release) => {
    const c = contracts.find((x) => x.id === sel);
    const d = await gatherReleaseDoc(sel, r);
    if (d.rows.length === 0) { return; }
    if (!r.invoice_sent) {
      await sb().from("releases").update({ invoice_sent: today }).eq("id", r.id);
      setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, invoice_sent: today } : x)));
    }
    setPrintOpen(false); // one preview at a time — two would print as one concatenated PDF
    setInvPreview({ number: `${c?.number || ""}-${r.rel_number}`, date: today, cNumber: c?.number || "", relNum: r.rel_number, dev: r.location || d.dev, workOrder: r.ticket || "", rows: d.rows });
  };

  useEffect(() => {
    (async () => {
      const { data } = await sb().from("contracts").select("id,number,name").order("number");
      const cs = (data || []) as Contract[];
      // only contracts with an active statement (something still owed)
      const { data: rel } = await sb().from("releases").select("contract_id,amount,received,canceled");
      const open = new Set(
        ((rel || []) as { contract_id: string; amount: number; received: boolean; canceled: boolean }[])
          .filter((r) => !r.canceled && !r.received && Number(r.amount) > 0)
          .map((r) => r.contract_id)
      );
      const activeContracts = cs.filter((c) => open.has(c.id));
      setContracts(activeContracts);
      if (activeContracts[0]) setSel(activeContracts[0].id);
    })();
    sb().from("org").select("*").single().then(({ data }) => data && setOrg(data as Org));
  }, []);

  // live: releases, their items and walk sheets refresh the statement
  useLive(["releases", "release_items", "proposals", "contracts"], () => setReloadTick((t) => t + 1), { enabled: !!sel });

  useEffect(() => {
    if (!sel) { setRows([]); return; }
    (async () => {
      const { data } = await sb().from("releases").select("*").eq("contract_id", sel);
      const all = ((data || []) as Release[]).filter((r) => !r.canceled && Number(r.amount) > 0 && !r.received);
      // only releases with real release data connected — imported line items
      // or a walk sheet with quantities on the same release number
      const ready = new Set<string>();
      const ids = all.map((r) => r.id);
      for (let i = 0; i < ids.length; i += 200) {
        const { data: its } = await sb().from("release_items").select("release_id").in("release_id", ids.slice(i, i + 200));
        ((its || []) as { release_id: string }[]).forEach((it) => ready.add(it.release_id));
      }
      const { data: props } = await sb().from("proposals").select("release_number,qty_map").eq("contract_id", sel);
      const walkNums = new Set(
        ((props || []) as { release_number?: string; qty_map?: Record<string, number> | null }[])
          .filter((p) => p.release_number && p.qty_map && Object.keys(p.qty_map).length > 0)
          .map((p) => String(p.release_number).trim())
      );
      const connected = all.filter((r) => ready.has(r.id) || walkNums.has(String(r.rel_number).trim()));
      connected.sort((a, b) => (parseFloat(a.rel_number) || 0) - (parseFloat(b.rel_number) || 0));
      setRows(connected);
    })();
  }, [sel, reloadTick]);

  const contract = contracts.find((c) => c.id === sel);
  const days = (r: Release) => (r.invoice_sent ? Math.max(0, Math.floor((new Date(today).getTime() - new Date(r.invoice_sent + "T00:00:00").getTime()) / 86400000)) : null);
  // true remaining balance — partial payments come off the top
  const bal = (r: Release) => Math.max(0, Number(r.amount) - (Number(r.amount_received) || 0));
  const buckets: [string, number][] = [["0–30", 0], ["31–60", 0], ["61–90", 0], ["90+", 0]];
  let notInvoiced = 0;
  rows.forEach((r) => {
    const d = days(r); const v = bal(r);
    if (d === null) notInvoiced += v;
    else if (d <= 30) buckets[0][1] += v; else if (d <= 60) buckets[1][1] += v; else if (d <= 90) buckets[2][1] += v; else buckets[3][1] += v;
  });
  const total = rows.reduce((s, r) => s + bal(r), 0);
  const sorted = [...rows].sort((a, b) => (days(b) ?? -1) - (days(a) ?? -1));

  // record a partial payment; paying in full marks the release received
  const savePaid = async (r: Release, n: number) => {
    const patch: Partial<Release> = { amount_received: n };
    if (Number(r.amount) > 0 && n >= Number(r.amount)) { patch.received = true; patch.paid_date = today; }
    setRows((prev) => (patch.received ? prev.filter((x) => x.id !== r.id) : prev.map((x) => (x.id === r.id ? { ...x, ...patch } : x))));
    const { error } = await sb().from("releases").update(patch).eq("id", r.id);
    if (error) setMsg(/column|schema cache/i.test(error.message) ? "Run supabase/upgrade_payments.sql first" : error.message);
    else if (patch.received) setMsg(`#${r.rel_number} paid in full — moved to received`);
    if (!error && !patch.received) return;
    setTimeout(() => setMsg(""), 3000);
  };

  const downloadExcel = () => {
    if (!contract) return;
    const aoa: (string | number)[][] = [];
    aoa.push(["STATEMENT OF ACCOUNT"]);
    aoa.push([(org?.company || "").toUpperCase()]);
    aoa.push([[org?.address1, org?.address2].filter(Boolean).join(", ")]);
    aoa.push([[org?.phone, org?.email].filter(Boolean).join(" · ")]);
    aoa.push([]);
    aoa.push(["Contract / PO:", /^\d+$/.test(contract.number) ? Number(contract.number) : contract.number, "", "Date:", prettyDate(today)]);
    aoa.push([]);
    const headerRow = aoa.length;
    aoa.push(["Release", "Development", "Location", "Invoiced", "Days out", "Balance"]);
    sorted.forEach((r) => {
      const d = days(r);
      aoa.push([/^\d+$/.test(r.rel_number) ? Number(r.rel_number) : r.rel_number, r.location || "", r.buildings || "", r.invoice_sent ? prettyDate(r.invoice_sent) : "not invoiced", d === null ? "" : d, bal(r)]);
    });
    const totalRow = aoa.length;
    aoa.push(["", "", "", "", "Total due", total]);
    aoa.push([]);
    aoa.push(["Aging:", `0–30: ${fmt(buckets[0][1])}`, `31–60: ${fmt(buckets[1][1])}`, `61–90: ${fmt(buckets[2][1])}`, `90+: ${fmt(buckets[3][1])}`, `Not invoiced: ${fmt(notInvoiced)}`]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 12 }, { wch: 30 }, { wch: 40 }, { wch: 16 }, { wch: 12 }, { wch: 16 }];
    ws["!merges"] = [0, 1, 2, 3].map((r) => ({ s: { r, c: 0 }, e: { r, c: 5 } }));
    const thin = { style: "thin", color: { rgb: "000000" } };
    const box = { top: thin, bottom: thin, left: thin, right: thin };
    const shade = { patternType: "solid", fgColor: { rgb: "E8E4DA" } };
    const cellAt = (row: number, col: number) => ws[XLSX.utils.encode_cell({ r: row, c: col })];
    const c0 = cellAt(0, 0); if (c0) c0.s = { font: { bold: true, sz: 14 }, alignment: { horizontal: "center" }, fill: shade, border: box };
    const c5 = cellAt(5, 0); if (c5) c5.s = { font: { bold: true } };
    const c53 = cellAt(5, 3); if (c53) c53.s = { font: { bold: true } };
    for (let row = headerRow; row <= totalRow; row++) {
      for (let col = 0; col < 6; col++) {
        const cell = cellAt(row, col) || (ws[XLSX.utils.encode_cell({ r: row, c: col })] = { t: "s", v: "" });
        cell.s = { border: box, ...(row === headerRow ? { font: { bold: true }, fill: shade } : {}), ...(row === totalRow ? { font: { bold: true } } : {}) };
        if (col === 5 && typeof cell.v === "number") cell.z = "#,##0.00";
      }
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const fname = askFileName(`statement_${contract.number}.xlsx`);
    if (!fname) return;
    XLSX.writeFile(wb, fname);
  };

  return (
    <div>
      <div className="mb-3 font-display text-2xl font-bold uppercase">Invoices &amp; Statements</div>
      <div className="mb-3"><ContractPicker contracts={contracts} value={sel} onChange={setSel} /></div>
      {contract && (
        <>
          <input className="field mb-3" placeholder="Search release #, development…" value={tq} onChange={(e) => setTq(e.target.value)} />
          <div className="card overflow-x-auto">
            <table className="w-full border-collapse text-sm" style={{ minWidth: 560 }}>
              <thead><tr className="border-b-[1.5px] border-ink text-left font-display text-xs uppercase tracking-widest text-inksoft">
                <th className="p-2.5">Release</th><th className="p-2.5">Location</th><th className="p-2.5">Invoiced</th><th className="p-2.5 text-right">Days out</th><th className="p-2.5 text-right">Paid so far</th><th className="p-2.5 text-right">Balance</th><th className="p-2.5"></th></tr></thead>
              <tbody>
                {sorted.filter((r) => !tq.trim() || `${r.rel_number} ${r.location} ${r.buildings}`.toLowerCase().includes(tq.trim().toLowerCase())).map((r) => {
                  const d = days(r);
                  return (
                    <tr key={r.id} className="border-b border-rulesoft">
                      <td className="p-2.5 font-mono text-[13px]">{r.rel_number}</td>
                      <td className="p-2.5">{r.location}<div className="max-w-[220px] truncate text-[11px] text-inksoft">{r.buildings}</div></td>
                      <td className="p-2.5">
                        <input type="date" className="rounded-sm border border-rulesoft p-1 font-mono text-xs" defaultValue={r.invoice_sent || ""}
                          onChange={async (e) => {
                            const v = e.target.value || null;
                            await sb().from("releases").update({ invoice_sent: v }).eq("id", r.id);
                            setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, invoice_sent: v } : x)));
                          }} />
                      </td>
                      <td className={`p-2.5 text-right font-mono ${d !== null && d > 60 ? "text-alert" : ""}`}>{d === null ? "—" : d}</td>
                      <td className="p-2.5 text-right">
                        <input className="w-24 rounded-sm border border-rulesoft p-1.5 text-right font-mono text-[13px]" inputMode="decimal" placeholder="0"
                          title={`NYCHA has paid this much of ${fmt(Number(r.amount))} so far`}
                          {...num(`${r.id}:paid`, Number(r.amount_received) || 0,
                            () => {},
                            (n) => savePaid(r, n))} />
                      </td>
                      <td className="p-2.5 text-right font-mono font-semibold">{fmt(bal(r))}</td>
                      <td className="p-2.5 text-right"><button className="font-mono text-xs font-semibold text-work underline" title="Make the NYCHA invoice" onClick={() => genInvoice(r)}>Invoice</button></td>
                    </tr>
                  );
                })}
                {sorted.length === 0 && <tr><td colSpan={7} className="p-4 text-inksoft">Nothing outstanding on contract {contract.number}. All square. 🎉</td></tr>}
                {sorted.length > 0 && <tr><td colSpan={5} className="p-2.5 font-display font-bold uppercase">Total due</td><td className="p-2.5 text-right font-mono text-base font-bold">{fmt(total)}</td><td></td></tr>}
              </tbody>
            </table>
          </div>
          {sorted.length > 0 && (
            <>
              <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-5">
                {[...buckets, ["Not invoiced", notInvoiced] as [string, number]].map(([b, v]) => (
                  <div key={b} className="card p-2.5 text-center">
                    <div className="text-[10px] uppercase tracking-widest text-inksoft">{b}{b !== "Not invoiced" ? " days" : ""}</div>
                    <div className={`font-mono text-[13px] font-semibold ${b === "90+" && v > 0 ? "text-alert" : ""}`}>{fmt(v)}</div>
                  </div>
                ))}
              </div>
              <div className="mt-3.5 flex gap-2">
                <button className="btn btn-primary" onClick={() => { setInvPreview(null); setPrintOpen(true); }}>Preview</button>
                <button className="btn" onClick={downloadExcel}>Excel</button>
              </div>
            </>
          )}
          {printOpen && org && (
            <PrintShell>
            <div className="fixed inset-0 z-50 overflow-y-auto bg-ink/50 px-2 py-5">
              <div className="printable mx-auto max-w-3xl rounded-sm border-t-4 border-ink bg-white p-8 text-ink">
                <div className="border-2 border-ink bg-paper p-2 text-center font-display text-xl font-bold uppercase">Statement of Account</div>
                <div className="my-4 flex justify-between text-[13px]">
                  <div>
                    <div className="font-display text-lg font-bold uppercase">{org.company}</div>
                    <div className="text-inksoft">{[org.address1, org.address2].filter(Boolean).join(", ")}</div>
                    <div className="text-inksoft">{[org.phone, org.email].filter(Boolean).join(" · ")}</div>
                  </div>
                  <div className="text-right">
                    <div><span className="text-[11px] uppercase tracking-wider text-inksoft">Contract / PO </span><span className="font-mono font-semibold">{contract.number}</span></div>
                    <div className="font-mono text-xs text-inksoft">{prettyDate(today)}</div>
                  </div>
                </div>
                <table className="w-full border-collapse border border-ink text-[12px]">
                  <thead><tr className="bg-paper text-left font-display text-[10px] uppercase tracking-widest">
                    <th className="border border-ink p-1.5">Release</th><th className="border border-ink p-1.5">Development</th>
                    <th className="border border-ink p-1.5">Invoiced</th><th className="border border-ink p-1.5 text-right">Days out</th>
                    <th className="border border-ink p-1.5 text-right">Balance</th>
                  </tr></thead>
                  <tbody>
                    {sorted.map((r) => {
                      const d = days(r);
                      return (
                        <tr key={r.id} className="align-top">
                          <td className="border border-rulesoft p-1.5 font-mono">{r.rel_number}</td>
                          <td className="border border-rulesoft p-1.5">{r.location}{r.buildings ? <span className="text-[11px] text-inksoft"> · {r.buildings}</span> : ""}</td>
                          <td className="border border-rulesoft p-1.5 font-mono text-[11px]">{r.invoice_sent ? prettyDate(r.invoice_sent) : "not invoiced"}</td>
                          <td className="border border-rulesoft p-1.5 text-right font-mono">{d === null ? "—" : d}</td>
                          <td className="border border-rulesoft p-1.5 text-right font-mono font-semibold">{fmt(bal(r))}</td>
                        </tr>
                      );
                    })}
                    <tr><td colSpan={4} className="border border-ink p-1.5 text-right font-display font-bold uppercase">Total due</td>
                      <td className="border border-ink p-1.5 text-right font-mono text-base font-bold">{fmt(total)}</td></tr>
                  </tbody>
                </table>
                <div className="mt-3 text-[11px] text-inksoft">
                  Aging — 0–30: {fmt(buckets[0][1])} · 31–60: {fmt(buckets[1][1])} · 61–90: {fmt(buckets[2][1])} · 90+: {fmt(buckets[3][1])} · Not invoiced: {fmt(notInvoiced)}
                </div>
              </div>
              <div className="no-print mx-auto mt-3 flex max-w-3xl justify-end gap-2">
                <button className="btn bg-white" onClick={downloadExcel}>Download Excel</button>
                <button className="btn bg-white" onClick={() => window.print()}>Print / Save as PDF</button>
                <button className="btn btn-ghost bg-white" onClick={() => setPrintOpen(false)}>Close</button>
              </div>
            </div>
            </PrintShell>
          )}
        </>
      )}
      {invPreview && org && (
        <NychaInvoicePrint org={org} number={invPreview.number} date={invPreview.date}
          contractNumber={invPreview.cNumber} releaseNumber={invPreview.relNum} development={invPreview.dev}
          workOrder={invPreview.workOrder}
          items={invPreview.rows.map((it) => ({ line: it.line, code: it.code, category: it.category, description: it.description, unit: it.uom, qty: it.qty, unit_price: it.unit_price }))}
          onExcel={() => { const fname = askFileName(`invoice_${invPreview.cNumber}_rel${invPreview.relNum}.xlsx`); if (fname) buildInvoiceXlsx({ org, cNumber: invPreview.cNumber, relNum: invPreview.relNum, workOrder: invPreview.workOrder, dev: invPreview.dev, number: invPreview.number, date: invPreview.date, rows: invPreview.rows, filename: fname }); }}
          close={() => setInvPreview(null)} />
      )}
      {contracts.length === 0 && <div className="text-sm text-inksoft">No active statements — nothing is currently owed on any contract. Releases you haven&apos;t been paid for show up here automatically.</div>}
      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
