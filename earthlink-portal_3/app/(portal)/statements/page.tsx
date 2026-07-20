"use client";
import { useEffect, useState } from "react";
// styled fork of SheetJS — same API, plus cell borders/fonts for the export
import * as XLSX from "xlsx-js-style";
import { sb } from "@/lib/supabase";
import { fmt } from "@/lib/format";
import { Org, prettyDate } from "@/lib/docs";
import type { Contract, Release } from "@/lib/types";

export default function Statements() {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [sel, setSel] = useState("");
  const [rows, setRows] = useState<Release[]>([]);
  const [org, setOrg] = useState<Org | null>(null);
  const [printOpen, setPrintOpen] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    sb().from("contracts").select("id,number,name").order("number").then(({ data }) => {
      const cs = (data || []) as Contract[];
      setContracts(cs); if (cs[0]) setSel(cs[0].id);
    });
    sb().from("org").select("*").single().then(({ data }) => data && setOrg(data as Org));
  }, []);

  useEffect(() => {
    if (!sel) { setRows([]); return; }
    sb().from("releases").select("*").eq("contract_id", sel).then(({ data }) => {
      const all = ((data || []) as Release[]).filter((r) => !r.canceled && Number(r.amount) > 0 && !r.received);
      all.sort((a, b) => (parseFloat(a.rel_number) || 0) - (parseFloat(b.rel_number) || 0));
      setRows(all);
    });
  }, [sel]);

  const contract = contracts.find((c) => c.id === sel);
  const days = (r: Release) => (r.invoice_sent ? Math.max(0, Math.floor((new Date(today).getTime() - new Date(r.invoice_sent + "T00:00:00").getTime()) / 86400000)) : null);
  const buckets: [string, number][] = [["0–30", 0], ["31–60", 0], ["61–90", 0], ["90+", 0]];
  let notInvoiced = 0;
  rows.forEach((r) => {
    const d = days(r); const v = Number(r.amount);
    if (d === null) notInvoiced += v;
    else if (d <= 30) buckets[0][1] += v; else if (d <= 60) buckets[1][1] += v; else if (d <= 90) buckets[2][1] += v; else buckets[3][1] += v;
  });
  const total = rows.reduce((s, r) => s + Number(r.amount), 0);
  const sorted = [...rows].sort((a, b) => (days(b) ?? -1) - (days(a) ?? -1));

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
      aoa.push([/^\d+$/.test(r.rel_number) ? Number(r.rel_number) : r.rel_number, r.location || "", r.buildings || "", r.invoice_sent ? prettyDate(r.invoice_sent) : "not invoiced", d === null ? "" : d, Number(r.amount)]);
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
    XLSX.writeFile(wb, `statement_${contract.number}.xlsx`);
  };

  return (
    <div>
      <div className="mb-3 font-display text-2xl font-bold uppercase">Statements</div>
      <select className="field mb-3" value={sel} onChange={(e) => setSel(e.target.value)}>
        {contracts.map((c) => <option key={c.id} value={c.id}>Contract {c.number}{c.name && c.name !== c.number ? ` — ${c.name}` : ""}</option>)}
      </select>
      {contract && (
        <>
          <div className="card overflow-x-auto">
            <table className="w-full border-collapse text-sm" style={{ minWidth: 560 }}>
              <thead><tr className="border-b-[1.5px] border-ink text-left font-display text-xs uppercase tracking-widest text-inksoft">
                <th className="p-2.5">Release</th><th className="p-2.5">Location</th><th className="p-2.5">Invoiced</th><th className="p-2.5 text-right">Days out</th><th className="p-2.5 text-right">Balance</th></tr></thead>
              <tbody>
                {sorted.map((r) => {
                  const d = days(r);
                  return (
                    <tr key={r.id} className="border-b border-rulesoft">
                      <td className="p-2.5 font-mono text-[13px]">{r.rel_number}</td>
                      <td className="p-2.5">{r.location}<div className="max-w-[220px] truncate text-[11px] text-inksoft">{r.buildings}</div></td>
                      <td className="p-2.5 font-mono text-xs">{r.invoice_sent ? prettyDate(r.invoice_sent) : "—"}</td>
                      <td className={`p-2.5 text-right font-mono ${d !== null && d > 60 ? "text-alert" : ""}`}>{d === null ? "—" : d}</td>
                      <td className="p-2.5 text-right font-mono font-semibold">{fmt(Number(r.amount))}</td>
                    </tr>
                  );
                })}
                {sorted.length === 0 && <tr><td colSpan={5} className="p-4 text-inksoft">Nothing outstanding on contract {contract.number}. All square. 🎉</td></tr>}
                {sorted.length > 0 && <tr><td colSpan={4} className="p-2.5 font-display font-bold uppercase">Total due</td><td className="p-2.5 text-right font-mono text-base font-bold">{fmt(total)}</td></tr>}
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
                <button className="btn btn-primary" onClick={() => setPrintOpen(true)}>Preview</button>
                <button className="btn" onClick={downloadExcel}>Excel</button>
              </div>
            </>
          )}
          {printOpen && org && (
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
                          <td className="border border-rulesoft p-1.5 text-right font-mono font-semibold">{fmt(Number(r.amount))}</td>
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
          )}
        </>
      )}
      {contracts.length === 0 && <div className="text-sm text-inksoft">Statements build themselves from each contract&apos;s outstanding releases. Nothing here until a contract exists.</div>}
    </div>
  );
}
