"use client";
import { useEffect, useState } from "react";
import { sb } from "@/lib/supabase";
import { fmt } from "@/lib/format";
import Stamp from "@/components/Stamp";
import DocPrint from "@/components/DocPrint";
import NychaInvoicePrint, { type NychaItem } from "@/components/NychaInvoicePrint";
import { LineItem, Org, prettyDate } from "@/lib/docs";

interface Invoice {
  id: string; number: string; client_name: string; job: string; date: string; due_date: string | null; tax_pct: number; status: string; paid_date: string | null;
  contract_number?: string; release_number?: string; development?: string; work_order?: string;
  period_from?: string | null; period_to?: string | null;
}

export default function Invoices() {
  const [list, setList] = useState<Invoice[]>([]);
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [org, setOrg] = useState<Org | null>(null);
  const [printInv, setPrintInv] = useState<Invoice | null>(null);
  const [printItems, setPrintItems] = useState<(LineItem & { category?: string })[]>([]);
  const today = new Date().toISOString().slice(0, 10);

  const load = async () => {
    const { data } = await sb().from("invoices").select("*").order("created_at", { ascending: false });
    setList((data || []) as Invoice[]);
    const { data: its } = await sb().from("invoice_items").select("invoice_id,qty,unit_price");
    const t: Record<string, number> = {};
    (its || []).forEach((r: { invoice_id: string; qty: number; unit_price: number }) => { t[r.invoice_id] = (t[r.invoice_id] || 0) + Number(r.qty) * Number(r.unit_price); });
    setTotals(t);
  };
  useEffect(() => { load(); sb().from("org").select("*").single().then(({ data }) => data && setOrg(data as Org)); }, []);

  const total = (i: Invoice) => (totals[i.id] || 0) * (1 + Number(i.tax_pct) / 100);
  const setPaid = async (i: Invoice, paid: boolean) => {
    await sb().from("invoices").update(paid ? { status: "paid", paid_date: today } : { status: "open", paid_date: null }).eq("id", i.id);
    load();
  };
  const openPrint = async (i: Invoice) => {
    const { data } = await sb().from("invoice_items").select("*").eq("invoice_id", i.id).order("sort");
    setPrintItems((data || []) as LineItem[]); setPrintInv(i);
  };

  return (
    <div>
      <div className="mb-3 font-display text-2xl font-bold uppercase">Invoices</div>
      <div className="card divide-y divide-rulesoft">
        {list.map((i) => {
          const late = i.status === "open" && i.due_date && i.due_date < today;
          return (
            <div key={i.id} className="p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-mono text-[13px] font-semibold">{i.number}</span>
                  <span className="ml-2 text-[13px] text-inksoft">{i.client_name}</span>
                  <div className="font-mono text-[11px] text-inksoft">issued {prettyDate(i.date)} · due {prettyDate(i.due_date)}{i.paid_date ? ` · paid ${prettyDate(i.paid_date)}` : ""}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2.5">
                  <span className="font-mono text-sm font-semibold">{fmt(total(i))}</span>
                  <Stamp label={late ? "OVERDUE" : i.status.toUpperCase()} tone={late ? "alert" : i.status === "paid" ? "ok" : "work"} />
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button className="btn btn-ghost px-3 py-1.5 text-[13px]" onClick={() => openPrint(i)}>Print / PDF</button>
                {i.status === "open"
                  ? <button className="btn border-ok px-3 py-1.5 text-[13px] text-ok" onClick={() => setPaid(i, true)}>Record payment</button>
                  : <button className="btn btn-ghost px-3 py-1.5 text-[13px]" onClick={() => setPaid(i, false)}>Reopen</button>}
              </div>
            </div>
          );
        })}
        {list.length === 0 && <div className="p-5 text-sm text-inksoft">No invoices yet. Convert a proposal and it lands here with the same line items.</div>}
      </div>
      {printInv && org && (printInv.contract_number ? (
        <NychaInvoicePrint org={org} number={printInv.number} date={printInv.date}
          contractNumber={printInv.contract_number} releaseNumber={printInv.release_number || ""}
          development={printInv.development || ""} workOrder={printInv.work_order}
          periodFrom={printInv.period_from} periodTo={printInv.period_to}
          items={printItems.map((it): NychaItem => ({ line: null, code: it.code, category: it.category, description: it.description, unit: it.unit, qty: Number(it.qty), unit_price: Number(it.unit_price) }))}
          close={() => setPrintInv(null)} />
      ) : (
        <DocPrint org={org} title="Invoice" number={printInv.number} date={printInv.date} clientName={printInv.client_name} job={printInv.job} items={printItems} taxPct={printInv.tax_pct} due={printInv.due_date} close={() => setPrintInv(null)} />
      ))}
    </div>
  );
}
