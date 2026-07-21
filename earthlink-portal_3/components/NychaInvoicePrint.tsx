"use client";
import { fmt } from "@/lib/format";
import { Org, prettyDate } from "@/lib/docs";

// Matches Earth Link's NYCHA "Standard Invoice" xlsx layout: Original To /
// copy to / FROM blocks, contract-release-development header, and the
// Line·Item·Category·Description·UOM·Qty·Price·Total table.
export interface NychaItem {
  line?: number | null; code: string; category?: string; description: string;
  unit: string; qty: number; unit_price: number;
}
interface Props {
  org: Org; number: string; date: string;
  contractNumber: string; releaseNumber: string; development: string;
  workOrder?: string; periodFrom?: string | null; periodTo?: string | null;
  items: NychaItem[]; close: () => void; onExcel?: () => void;
}

export default function NychaInvoicePrint(p: Props) {
  const total = p.items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);
  const Label = ({ children }: { children: React.ReactNode }) => (
    <span className="text-[10px] uppercase tracking-[.12em] text-inksoft">{children}</span>
  );
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-ink/50 px-2 py-5">
      <div className="printable mx-auto max-w-4xl rounded-sm bg-white p-8 text-ink">
        <div className="flex items-baseline justify-between border-b-2 border-ink pb-2">
          <div className="font-display text-2xl font-bold uppercase">Standard Invoice</div>
          <div className="text-right">
            <div className="font-mono text-sm font-semibold">Invoice # {p.number}</div>
            <div className="font-mono text-xs text-inksoft">Date: {prettyDate(p.date)}</div>
          </div>
        </div>

        <div className="my-4 grid grid-cols-2 gap-6 text-[13px] leading-snug">
          <div>
            <Label>Original to</Label>
            <div className="font-semibold">NEW YORK CITY HOUSING AUTHORITY</div>
            <div>ACCOUNTS PAYABLE</div>
            <div>P.O. BOX 3636, CHURCH STREET STATION</div>
            <div>NEW YORK, NY 10008-3636</div>
            <div className="mt-2.5"><Label>Copy to</Label></div>
            <div>NEW YORK CITY HOUSING AUTHORITY</div>
            <div>90 CHURCH STREET, 6TH FLOOR</div>
            <div>NEW YORK, NY 10008</div>
            <div className="font-semibold">ATTENTION: BOROUGH PAYMENT UNIT</div>
          </div>
          <div>
            <Label>From</Label>
            <div className="font-semibold uppercase">{p.org.company}</div>
            <div>{p.org.address1}</div>
            <div>{p.org.address2}</div>
            <div>{[p.org.phone && `Phone ${p.org.phone}`, p.org.email].filter(Boolean).join(" · ")}</div>
            {p.org.license && <div>License {p.org.license}</div>}
          </div>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-x-6 gap-y-1.5 border-y border-rulesoft py-2.5 text-[13px] md:grid-cols-3">
          <div><Label>Contract / PO</Label><div className="font-mono font-semibold">{p.contractNumber || "—"}</div></div>
          <div><Label>Release</Label><div className="font-mono font-semibold">{p.releaseNumber || "—"}</div></div>
          <div><Label>Development</Label><div className="font-semibold">{p.development || "—"}</div></div>
          {p.workOrder && <div><Label>Work order</Label><div className="font-mono">{p.workOrder}</div></div>}
          <div><Label>Period from</Label><div className="font-mono">{p.periodFrom ? prettyDate(p.periodFrom) : "—"}</div></div>
          <div><Label>Period to</Label><div className="font-mono">{p.periodTo ? prettyDate(p.periodTo) : "—"}</div></div>
        </div>

        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b-[1.5px] border-ink text-left font-display text-[10px] uppercase tracking-widest text-inksoft">
              <th className="p-1.5">Line</th><th className="p-1.5">Item</th><th className="p-1.5">Category</th>
              <th className="p-1.5">Description</th><th className="p-1.5">UOM</th>
              <th className="p-1.5 text-right">Qty</th><th className="p-1.5 text-right">Price</th>
              <th className="p-1.5 text-right">Total Cost</th>
            </tr>
          </thead>
          <tbody>
            {p.items.map((it, i) => (
              <tr key={i} className="border-b border-rulesoft align-top">
                <td className="p-1.5 font-mono">{it.line || i + 1}</td>
                <td className="p-1.5 font-mono">{it.code}</td>
                <td className="max-w-[120px] p-1.5 text-[11px]">{it.category || ""}</td>
                <td className="p-1.5">{it.description}</td>
                <td className="p-1.5 font-mono text-[11px]">{it.unit}</td>
                <td className="p-1.5 text-right font-mono">{it.qty}</td>
                <td className="p-1.5 text-right font-mono">{fmt(Number(it.unit_price))}</td>
                <td className="p-1.5 text-right font-mono font-semibold">{fmt((Number(it.qty) || 0) * (Number(it.unit_price) || 0))}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-3 flex justify-end">
          <div className="min-w-[220px] border-t-2 border-ink pt-2">
            <div className="flex justify-between">
              <span className="font-display font-bold uppercase">Total</span>
              <span className="font-mono text-lg font-semibold">{fmt(total)}</span>
            </div>
          </div>
        </div>

        <div className="mt-8 grid grid-cols-2 gap-10 text-[12px]">
          <div><div className="border-t border-ink pt-1">Vendor signature</div></div>
          <div><div className="border-t border-ink pt-1">Date</div></div>
        </div>
        <div className="mt-6 border-t border-rulesoft pt-2 text-[11px] text-inksoft">
          Mail to: NYCHA Disbursements, P.O. Box 3636, New York, NY 10008-3636 · Questions: Disbursements 212-306-6500
        </div>
      </div>
      <div className="no-print mx-auto mt-3 flex max-w-4xl justify-end gap-2">
        {p.onExcel && <button className="btn bg-white" onClick={p.onExcel}>Download Excel</button>}
        <button className="btn bg-white" onClick={() => window.print()}>Print / Save as PDF</button>
        <button className="btn btn-ghost bg-white" onClick={p.close}>Close</button>
      </div>
    </div>
  );
}
