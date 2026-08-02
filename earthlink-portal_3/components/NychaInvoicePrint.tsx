"use client";
import { fmt } from "@/lib/format";
import { Org } from "@/lib/docs";
import { COMPANY } from "@/lib/company";
import PrintShell from "@/components/PrintShell";

// Mirrors the owner's NYCHA "Standard Invoice" Excel template: one outer box,
// Original To / FROM halves, CONTRACT-RELEASE-TERMS boxes, DEVELOPMENT and
// PERIOD boxes, a DESCRIPTION band with the line items, and the boxed
// TOTAL DOLLAR AMOUNT at the bottom. (The Excel download reproduces the
// template cell-for-cell — this is the same sheet for print/PDF.)
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

const shortDate = (iso: string) => { const m = (iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${Number(m[2])}/${Number(m[3])}/${m[1].slice(2)}` : iso; };

export default function NychaInvoicePrint(p: Props) {
  const total = p.items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);
  return (
    <PrintShell>
    <div className="fixed inset-0 z-50 overflow-y-auto bg-ink/50 px-2 py-5">
      <div className="printable mx-auto max-w-4xl bg-white p-8 font-sans text-ink">
        <div className="pb-2 text-center text-[26px] font-bold">Standard Invoice</div>
        <div className="border-2 border-ink">
          {/* date / invoice number band */}
          <div className="flex border-b border-ink text-[15px]">
            <div className="w-1/2 border-r border-ink px-2 py-1.5">DATE: {shortDate(p.date)}</div>
            <div className="w-1/2 px-2 py-1.5">INVOICE #: {p.number}</div>
          </div>
          <div className="flex">
            {/* left: Original To / Copy To / Attention */}
            <div className="w-1/2 border-r-2 border-ink px-2 py-1.5 text-[14px] leading-relaxed">
              <div>Original To:</div>
              <div className="font-bold">NEW YORK CITY HOUSING AUTHORITY</div>
              <div className="font-bold">ACCOUNTS PAYABLE</div>
              <div>P.O BOX 3636</div>
              <div>CHURCH STREET STATION</div>
              <div>NEW YORK, NY 10008</div>
              <div className="mt-3">COPY TO:</div>
              <div className="font-bold">New York City Housing Authority</div>
              <div>90 CHURCH STREET</div>
              <div>6TH FLOOR NEW YORK, NY 10008</div>
              <div className="mt-4">&nbsp;&nbsp;&nbsp;ATTENTION: BOROUGH PAYMENT UNIT</div>
            </div>
            {/* right: FROM + reference boxes */}
            <div className="w-1/2 text-[14px]">
              <div className="px-2 py-1.5 leading-relaxed">
                <div className="text-[15px] font-bold">FROM:</div>
                <div>VENDOR NAME:&nbsp; {(p.org.company || COMPANY.legalName).toUpperCase()}</div>
                <div>ADDRESS: {[p.org.address1, p.org.address2].filter(Boolean).join(" ").toUpperCase()}</div>
                <div className="mt-1 flex justify-between"><span>PHONE # {p.org.phone || COMPANY.phone}</span><span className="pr-1 font-bold">FAX # {COMPANY.fax}</span></div>
              </div>
              <div className="flex border-y border-ink">
                <div className="w-2/5 px-2 py-1">CONTRACT/ORDER#<div className="text-[16px] font-bold">{p.contractNumber || " "}</div></div>
                <div className="w-2/5 border-l border-ink px-2 py-1">RELEASE #<div className="text-[16px] font-bold">{p.releaseNumber || " "}</div></div>
                <div className="w-1/5 border-l border-ink px-2 py-1">TERMS:<div>{(p.org.terms || "").toUpperCase() || " "}</div></div>
              </div>
              <div className="border-b border-ink px-2 py-1">DEVELOPMENT<div className="min-h-[24px] font-semibold">{(p.development || "").toUpperCase() || " "}</div></div>
              <div className="px-2 py-1">PERIOD FROM <span className="inline-block min-w-[90px] border-b border-ink/40 text-center">{p.periodFrom ? shortDate(p.periodFrom) : " "}</span> TO <span className="inline-block min-w-[90px] border-b border-ink/40 text-center">{p.periodTo ? shortDate(p.periodTo) : " "}</span></div>
            </div>
          </div>
          {/* description band + items */}
          <div className="border-y-2 border-ink px-2 py-1 text-center text-[17px] font-bold tracking-wide">DESCRIPTION</div>
          <div className="min-h-[300px] px-2 py-2">
            <table className="w-full text-[13px]">
              <tbody>
                {p.items.map((it, i) => (
                  <tr key={i} className="align-top">
                    <td className="py-0.5 pr-2">{`${it.code}  ${it.description}`.trim()}</td>
                    <td className="py-0.5 pr-2 text-right font-mono">{it.qty}</td>
                    <td className="py-0.5 pr-2 text-center font-mono">{it.unit}</td>
                    <td className="py-0.5 pr-2 text-right font-mono">{fmt(Number(it.unit_price))}</td>
                    <td className="py-0.5 text-right font-mono">{fmt((Number(it.qty) || 0) * (Number(it.unit_price) || 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {/* boxed total under the sheet, like the template */}
        <div className="mt-1 flex items-center justify-end gap-3 text-[15px]">
          <span>TOTAL DOLLAR AMOUNT</span>
          <span className="min-w-[150px] border-2 border-ink px-2 py-1 text-right font-bold">{fmt(total)}</span>
        </div>
      </div>
      <div className="no-print mx-auto mt-3 flex max-w-4xl justify-end gap-2">
        {p.onExcel && <button className="btn bg-white" onClick={p.onExcel}>Download Excel</button>}
        <button className="btn bg-white" onClick={() => window.print()}>Print / Save as PDF</button>
        <button className="btn btn-ghost bg-white" onClick={p.close}>Close</button>
      </div>
    </div>
    </PrintShell>
  );
}
