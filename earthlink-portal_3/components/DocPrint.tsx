"use client";
import { fmt } from "@/lib/format";
import { LineItem, Org, subTotal, grandTotal, prettyDate } from "@/lib/docs";

interface Props {
  org: Org; title: string; number?: string; date?: string; clientName?: string; job?: string;
  items?: LineItem[]; taxPct?: number; terms?: boolean; due?: string | null; notes?: string;
  statementRows?: { number: string; date: string; days: number; balance: number }[];
  close: () => void;
}
export default function DocPrint(p: Props) {
  const sub = p.items ? subTotal(p.items) : 0;
  const total = p.items ? grandTotal(p.items, p.taxPct || 0) : (p.statementRows || []).reduce((s, r) => s + r.balance, 0);
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-ink/50 px-2 py-5">
      <div className="printable mx-auto max-w-3xl rounded-sm bg-white p-8 text-ink">
        <div className="flex items-start justify-between border-b-2 border-ink pb-3.5">
          <div>
            <div className="font-display text-2xl font-bold uppercase leading-tight">{p.org.company}</div>
            <div className="mt-1 whitespace-pre-line text-xs text-inksoft">
              {[p.org.address1, p.org.address2, p.org.phone, p.org.email, p.org.license ? `License ${p.org.license}` : ""].filter(Boolean).join("\n")}
            </div>
          </div>
          <div className="text-right">
            <div className="font-display text-xl font-bold uppercase text-work">{p.title}</div>
            {p.number && <div className="font-mono text-sm font-semibold">{p.number}</div>}
            <div className="font-mono text-xs text-inksoft">{prettyDate(p.date || new Date().toISOString().slice(0, 10))}</div>
          </div>
        </div>
        <div className="my-4 flex justify-between text-sm">
          <div>
            <div className="text-[10px] uppercase tracking-[.15em] text-inksoft">{p.statementRows ? "Statement for" : "Prepared for"}</div>
            <div className="text-[15px] font-semibold">{p.clientName || "—"}</div>
            {p.job && <div className="text-inksoft">{p.job}</div>}
          </div>
          {p.due && (
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-[.15em] text-inksoft">Terms</div>
              <div>{p.org.terms}</div>
              <div className="font-mono text-xs">Due {prettyDate(p.due)}</div>
            </div>
          )}
        </div>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b-[1.5px] border-ink text-left font-display text-xs uppercase tracking-widest text-inksoft">
              {p.items ? (<><th className="p-2">Description</th><th className="p-2">Unit</th><th className="p-2 text-right">Qty</th><th className="p-2 text-right">Unit price</th><th className="p-2 text-right">Amount</th></>)
                : (<><th className="p-2">Invoice</th><th className="p-2">Issued</th><th className="p-2 text-right">Days out</th><th className="p-2 text-right">Balance</th></>)}
            </tr>
          </thead>
          <tbody>
            {p.items?.map((it, i) => (
              <tr key={i} className="border-b border-rulesoft">
                <td className="p-2">{it.code ? <span className="font-mono text-[11px] text-inksoft">{it.code} · </span> : null}{it.description}</td>
                <td className="p-2 font-mono text-xs">{it.unit}</td>
                <td className="p-2 text-right font-mono">{it.qty}</td>
                <td className="p-2 text-right font-mono">{fmt(Number(it.unit_price))}</td>
                <td className="p-2 text-right font-mono font-semibold">{fmt(Number(it.qty) * Number(it.unit_price))}</td>
              </tr>
            ))}
            {p.statementRows?.map((r) => (
              <tr key={r.number} className="border-b border-rulesoft">
                <td className="p-2 font-mono">{r.number}</td><td className="p-2 font-mono text-xs">{prettyDate(r.date)}</td>
                <td className="p-2 text-right font-mono">{r.days}</td><td className="p-2 text-right font-mono font-semibold">{fmt(r.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3.5 flex justify-end">
          <div className="min-w-[220px]">
            {p.items && <div className="flex justify-between py-1 text-sm"><span className="text-inksoft">Subtotal</span><span className="font-mono">{fmt(sub)}</span></div>}
            {p.items && (p.taxPct || 0) > 0 && <div className="flex justify-between py-1 text-sm"><span className="text-inksoft">Tax ({p.taxPct}%)</span><span className="font-mono">{fmt(total - sub)}</span></div>}
            <div className="mt-1 flex justify-between border-t-2 border-ink pt-2">
              <span className="font-display font-bold uppercase">{p.statementRows ? "Total due" : "Total"}</span>
              <span className="font-mono text-lg font-semibold">{fmt(total)}</span>
            </div>
          </div>
        </div>
        {p.notes && <div className="mt-4 whitespace-pre-line border-t border-rulesoft pt-2.5 text-xs text-inksoft">{p.notes}</div>}
        <div className="mt-6 border-t border-rulesoft pt-2.5 text-[11px] text-inksoft">
          {p.terms ? `This proposal is valid for 30 days. Terms: ${p.org.terms}.` : p.due ? `Please remit payment per terms (${p.org.terms}). Thank you.` : `Balances shown are open as of today.`}
        </div>
      </div>
      <div className="no-print mx-auto mt-3 flex max-w-3xl justify-end gap-2">
        <button className="btn bg-white" onClick={() => window.print()}>Print / Save as PDF</button>
        <button className="btn btn-ghost bg-white" onClick={p.close}>Close</button>
      </div>
    </div>
  );
}
