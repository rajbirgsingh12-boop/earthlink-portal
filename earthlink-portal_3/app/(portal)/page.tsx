"use client";
import { useEffect, useState } from "react";
import { sb } from "@/lib/supabase";
import { fmt } from "@/lib/format";

interface Row { amount: number; received: boolean; payroll_done: boolean; canceled: boolean; contract_id: string; }

export default function Home() {
  const [rows, setRows] = useState<Row[]>([]);
  const [contracts, setContracts] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data: c } = await sb().from("contracts").select("id");
      setContracts(c?.length || 0);
      const all: Row[] = [];
      let from = 0;
      for (;;) {
        const { data } = await sb().from("releases").select("amount,received,payroll_done,canceled,contract_id").range(from, from + 999);
        if (!data || data.length === 0) break;
        all.push(...(data as Row[]));
        if (data.length < 1000) break;
        from += 1000;
      }
      setRows(all);
      setLoading(false);
    })();
  }, []);

  const live = rows.filter((r) => !r.canceled);
  const tot = live.reduce((s, r) => s + Number(r.amount), 0);
  const notR = live.filter((r) => !r.received && r.amount > 0);
  const prPend = live.filter((r) => !r.payroll_done && r.amount > 0);

  const cards: [string, string, string][] = [
    ["Contracts", String(contracts), "text-ink"],
    ["Released (live)", fmt(tot), "text-ink"],
    ["Not received", fmt(notR.reduce((s, r) => s + Number(r.amount), 0)), "text-work"],
    ["Payroll pending", fmt(prPend.reduce((s, r) => s + Number(r.amount), 0)), "text-alert"],
  ];

  return (
    <div>
      <div className="mb-3 font-display text-2xl font-bold uppercase">The Board</div>
      {loading ? <div className="text-sm text-inksoft">Opening the books…</div> : (
        <>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            {cards.map(([l, v, cls]) => (
              <div key={l} className="card p-3.5">
                <div className="text-[10px] uppercase tracking-[.12em] text-inksoft">{l}</div>
                <div className={`font-mono text-lg font-semibold ${cls}`}>{v}</div>
              </div>
            ))}
          </div>
          <a href="/releases" className="btn btn-primary mt-5 inline-block">Open releases →</a>
        </>
      )}
    </div>
  );
}
