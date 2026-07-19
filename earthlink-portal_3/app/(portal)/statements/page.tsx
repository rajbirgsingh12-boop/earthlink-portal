"use client";
import { useEffect, useState } from "react";
import { sb } from "@/lib/supabase";
import { fmt } from "@/lib/format";
import DocPrint from "@/components/DocPrint";
import { Org, prettyDate } from "@/lib/docs";

interface Invoice { id: string; number: string; client_name: string; date: string; tax_pct: number; status: string; }

export default function Statements() {
  const [invs, setInvs] = useState<Invoice[]>([]);
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [client, setClient] = useState("");
  const [org, setOrg] = useState<Org | null>(null);
  const [printOpen, setPrintOpen] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    (async () => {
      const { data } = await sb().from("invoices").select("*").eq("status", "open");
      setInvs((data || []) as Invoice[]);
      const { data: its } = await sb().from("invoice_items").select("invoice_id,qty,unit_price");
      const t: Record<string, number> = {};
      (its || []).forEach((r: { invoice_id: string; qty: number; unit_price: number }) => { t[r.invoice_id] = (t[r.invoice_id] || 0) + Number(r.qty) * Number(r.unit_price); });
      setTotals(t);
      const { data: o } = await sb().from("org").select("*").single();
      if (o) setOrg(o as Org);
    })();
  }, []);

  const clients = [...new Set(invs.map((i) => i.client_name).filter(Boolean))];
  const mine = invs.filter((i) => i.client_name === client);
  const bal = (i: Invoice) => (totals[i.id] || 0) * (1 + Number(i.tax_pct) / 100);
  const days = (iso: string) => Math.floor((new Date(today).getTime() - new Date(iso).getTime()) / 86400000);
  const buckets: [string, number][] = [["0–30", 0], ["31–60", 0], ["61–90", 0], ["90+", 0]];
  mine.forEach((i) => { const d = days(i.date); const v = bal(i); if (d <= 30) buckets[0][1] += v; else if (d <= 60) buckets[1][1] += v; else if (d <= 90) buckets[2][1] += v; else buckets[3][1] += v; });
  const total = mine.reduce((s, i) => s + bal(i), 0);

  return (
    <div>
      <div className="mb-3 font-display text-2xl font-bold uppercase">Statements</div>
      <select className="field mb-3" value={client} onChange={(e) => setClient(e.target.value)}>
        <option value="">Pick a client…</option>
        {clients.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      {client && (
        <>
          <div className="card overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead><tr className="border-b-[1.5px] border-ink text-left font-display text-xs uppercase tracking-widest text-inksoft">
                <th className="p-2.5">Invoice</th><th className="p-2.5">Issued</th><th className="p-2.5 text-right">Days out</th><th className="p-2.5 text-right">Balance</th></tr></thead>
              <tbody>
                {mine.map((i) => (
                  <tr key={i.id} className="border-b border-rulesoft">
                    <td className="p-2.5 font-mono text-[13px]">{i.number}</td>
                    <td className="p-2.5 font-mono text-xs">{prettyDate(i.date)}</td>
                    <td className="p-2.5 text-right font-mono">{days(i.date)}</td>
                    <td className="p-2.5 text-right font-mono font-semibold">{fmt(bal(i))}</td>
                  </tr>
                ))}
                {mine.length === 0 && <tr><td colSpan={4} className="p-4 text-inksoft">Nothing open. {client} is square.</td></tr>}
                {mine.length > 0 && <tr><td colSpan={3} className="p-2.5 font-display font-bold uppercase">Total due</td><td className="p-2.5 text-right font-mono text-base font-bold">{fmt(total)}</td></tr>}
              </tbody>
            </table>
          </div>
          {mine.length > 0 && (
            <>
              <div className="mt-3 grid grid-cols-4 gap-2">
                {buckets.map(([b, v]) => (
                  <div key={b} className="card p-2.5 text-center">
                    <div className="text-[10px] uppercase tracking-widest text-inksoft">{b} days</div>
                    <div className={`font-mono text-[13px] font-semibold ${b === "90+" && v > 0 ? "text-alert" : ""}`}>{fmt(v)}</div>
                  </div>
                ))}
              </div>
              <button className="btn btn-primary mt-3.5" onClick={() => setPrintOpen(true)}>Print statement</button>
            </>
          )}
          {printOpen && org && <DocPrint org={org} title="Statement of Account" clientName={client} statementRows={mine.map((i) => ({ number: i.number, date: i.date, days: days(i.date), balance: bal(i) }))} close={() => setPrintOpen(false)} />}
        </>
      )}
      {!client && clients.length === 0 && <div className="text-sm text-inksoft">Statements build themselves from open invoices. Nothing here until the first invoice exists.</div>}
    </div>
  );
}
