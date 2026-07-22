"use client";
import { useEffect, useState } from "react";
import { sb } from "@/lib/supabase";
import { fmt } from "@/lib/format";
import { prettyDate } from "@/lib/docs";
import { canonTrade, checkLabor, aggregateLogged } from "@/lib/labor";
import { useLive } from "@/lib/useLive";
import Stamp from "@/components/Stamp";
import type { Contract } from "@/lib/types";

interface Row {
  id: string; contract_id: string; rel_number: string; location: string; amount: number;
  received: boolean; payroll_done: boolean; canceled: boolean; invoice_sent: string | null;
  labor_hours: number; labor_breakdown: { cls: string; hours: number }[] | null;
  amount_received?: number | null;
}
interface Prop { id: string; number: string; job: string; development?: string; release_number?: string; status: string; total?: number; contract_id?: string | null; created_at: string; qty_map?: Record<string, number> | null; }

export default function Home() {
  const [rows, setRows] = useState<Row[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [walks, setWalks] = useState<Prop[]>([]);
  const [shorts, setShorts] = useState<{ r: Row; missing: number }[]>([]);
  const [weekHours, setWeekHours] = useState<number | null>(null); // null = no week made yet
  const [loading, setLoading] = useState(true);
  const today = new Date();

  const [reloadTick, setReloadTick] = useState(0);
  // live: releases / walk sheets / payroll / contracts refresh the board
  useLive(["releases", "proposals", "timesheet_entries", "contracts", "employees"], () => setReloadTick((t) => t + 1), { delay: 500 });

  useEffect(() => {
    (async () => {
      const { data: c } = await sb().from("contracts").select("id,number,name").order("number");
      setContracts((c || []) as Contract[]);
      const all: Row[] = [];
      let from = 0;
      for (;;) {
        const { data } = await sb().from("releases").select("*").range(from, from + 999);
        if (!data || data.length === 0) break;
        all.push(...(data as Row[]));
        if (data.length < 1000) break;
        from += 1000;
      }
      setRows(all);
      // walk sheets with quantities that never became a release / got delivered
      const { data: props } = await sb().from("proposals").select("*").eq("status", "draft").order("created_at");
      setWalks(((props || []) as Prop[]).filter((p) => p.contract_id && p.qty_map && Object.keys(p.qty_map).length > 0));
      // payroll shortfalls against release minimums
      const need = all.filter((r) => !r.canceled && !r.received && !r.payroll_done && (Number(r.labor_hours) > 0 || (r.labor_breakdown || []).length > 0));
      if (need.length > 0) {
        const { data: ents } = await sb().from("timesheet_entries").select("release_id,employee_id,hours");
        const { data: allEmps } = await sb().from("employees").select("id,trade");
        const tradeById = new Map(((allEmps || []) as { id: string; trade: string }[]).map((e) => [e.id, canonTrade(e.trade)]));
        const byRel = aggregateLogged((ents || []) as { release_id: string | null; employee_id: string; hours: number[] }[], tradeById);
        setShorts(need
          .map((r) => {
            const res = checkLabor(r.labor_breakdown || [], Number(r.labor_hours) || 0, byRel[r.id] || {});
            const missing = Math.max(res.totalRequired - res.totalLogged, res.shorts.reduce((s, x) => s + (x.required - x.logged), 0));
            return { r, missing, ok: res.ok };
          })
          .filter((x) => !x.ok && x.missing > 0)
          .sort((a, b) => b.missing - a.missing)
          .slice(0, 5)
          .map(({ r, missing }) => ({ r, missing })));
      }
      // has anyone entered hours for the current payroll week?
      const fri = new Date();
      fri.setDate(fri.getDate() + ((5 - fri.getDay() + 7) % 7));
      const { data: wk } = await sb().from("timesheet_weeks").select("id").eq("week_ending", fri.toISOString().slice(0, 10)).limit(1);
      if (wk && wk[0]) {
        const { data: es } = await sb().from("timesheet_entries").select("hours").eq("week_id", (wk[0] as { id: string }).id);
        setWeekHours(((es || []) as { hours: number[] }[]).reduce((s, e) => s + (e.hours || []).reduce((a, h) => a + (Number(h) || 0), 0), 0));
      } else setWeekHours(null);
      setLoading(false);
    })();
  }, [reloadTick]);

  const cNum = (id: string) => contracts.find((x) => x.id === id)?.number || "";
  const live = rows.filter((r) => !r.canceled);
  const tot = live.reduce((s, r) => s + Number(r.amount), 0);
  const open = live.filter((r) => !r.received && Number(r.amount) > 0);
  const prPend = live.filter((r) => !r.payroll_done && !r.received && Number(r.amount) > 0);
  const days = (iso: string) => Math.max(0, Math.floor((today.getTime() - new Date(iso + "T00:00:00").getTime()) / 86400000));
  const oldest = open.filter((r) => r.invoice_sent).sort((a, b) => days(b.invoice_sent!) - days(a.invoice_sent!)).slice(0, 5);
  const notInvoiced = open.filter((r) => !r.invoice_sent);

  const balOf = (r: Row) => Math.max(0, Number(r.amount) - (Number(r.amount_received) || 0));
  const cards: [string, string, string][] = [
    ["Contracts", String(contracts.length), "text-ink"],
    ["Released (live)", fmt(tot), "text-ink"],
    ["Not received", fmt(open.reduce((s, r) => s + balOf(r), 0)), "text-work"],
    ["Payroll pending", fmt(prPend.reduce((s, r) => s + Number(r.amount), 0)), "text-alert"],
  ];

  // gentle nudges so nothing slips just because nobody looked
  const dow = today.getDay(); // Wed=3 Thu=4 Fri=5
  const payrollNudge = (dow >= 3 && dow <= 5) && (weekHours === null || weekHours === 0);
  const stale = open.filter((r) => r.invoice_sent && days(r.invoice_sent!) > 45);

  return (
    <div>
      <div className="mb-3 font-display text-2xl font-bold uppercase">The Board</div>
      {/* plain-language launcher — jump straight to the everyday jobs */}
      <div className="mb-4 grid grid-cols-2 gap-2.5 md:grid-cols-4">
        {([["⏱", "Enter today's hours", "/payroll"], ["📋", "Fill out a walk sheet", "/proposals"],
           ["🧾", "Make an invoice", "/statements"], ["📅", "See the schedule", "/schedule"]] as [string, string, string][]).map(([icon, label, href]) => (
          <a key={href} href={href} className="card flex items-center gap-2.5 p-3.5 transition-shadow hover:shadow">
            <span className="text-xl">{icon}</span>
            <span className="font-display text-[14px] font-semibold uppercase leading-tight tracking-wide">{label}</span>
          </a>
        ))}
      </div>
      {loading ? <div className="text-sm text-inksoft">Opening the books…</div> : (
        <>
          {payrollNudge && (
            <a href="/payroll" className="card mb-2.5 block border-alert p-3 text-[14px]">
              ⏱ <b>No hours entered for this week yet.</b> Tap here, hit Make payroll, and punch them in before Friday.
            </a>
          )}
          {stale.length > 0 && (
            <a href="/statements" className="card mb-2.5 block border-work p-3 text-[14px]">
              🧾 <b>{stale.length} invoice{stale.length === 1 ? "" : "s"} out over 45 days</b> — worth a call. Tap to see who owes what.
            </a>
          )}
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            {cards.map(([l, v, cls]) => (
              <div key={l} className="card p-3.5">
                <div className="text-[10px] uppercase tracking-[.12em] text-inksoft">{l}</div>
                <div className={`font-mono text-lg font-semibold ${cls}`}>{v}</div>
              </div>
            ))}
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <div className="card p-3.5">
              <div className="mb-2 flex items-baseline justify-between">
                <div className="font-display text-sm font-bold uppercase">Chase these first</div>
                <a href="/statements" className="text-xs text-inksoft underline">Statements →</a>
              </div>
              {oldest.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-2 border-t border-rulesoft py-2 text-[13px] first:border-t-0">
                  <span className="min-w-0 truncate"><span className="font-mono font-semibold">#{r.rel_number}</span> <span className="text-inksoft">{r.location || cNum(r.contract_id)}</span></span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span className="font-mono">{fmt(balOf(r))}</span>
                    <Stamp label={`${days(r.invoice_sent!)}D`} tone={days(r.invoice_sent!) > 60 ? "alert" : "work"} />
                  </span>
                </div>
              ))}
              {oldest.length === 0 && <div className="py-2 text-[13px] text-inksoft">No invoiced money outstanding.</div>}
              {notInvoiced.length > 0 && <div className="mt-1 border-t border-rulesoft pt-2 text-xs text-inksoft">{notInvoiced.length} unpaid release{notInvoiced.length === 1 ? "" : "s"} not invoiced yet — {fmt(notInvoiced.reduce((s, r) => s + Number(r.amount), 0))}</div>}
            </div>

            <div className="card p-3.5">
              <div className="mb-2 flex items-baseline justify-between">
                <div className="font-display text-sm font-bold uppercase">Walk sheets undelivered</div>
                <a href="/proposals" className="text-xs text-inksoft underline">Proposals →</a>
              </div>
              {walks.slice(0, 5).map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-2 border-t border-rulesoft py-2 text-[13px] first:border-t-0">
                  <span className="min-w-0 truncate">{p.job || p.development || p.number}<span className="text-inksoft"> · {prettyDate(p.created_at.slice(0, 10))}</span></span>
                  <span className="shrink-0 font-mono">{fmt(Number(p.total) || 0)}</span>
                </div>
              ))}
              {walks.length === 0 && <div className="py-2 text-[13px] text-inksoft">Every walk sheet has been delivered. 🎉</div>}
              {walks.length > 5 && <div className="mt-1 border-t border-rulesoft pt-2 text-xs text-inksoft">+{walks.length - 5} more drafts</div>}
            </div>

            <div className="card p-3.5">
              <div className="mb-2 flex items-baseline justify-between">
                <div className="font-display text-sm font-bold uppercase">Payroll short</div>
                <a href="/payroll" className="text-xs text-inksoft underline">Payroll →</a>
              </div>
              {shorts.map(({ r, missing }) => (
                <div key={r.id} className="flex items-center justify-between gap-2 border-t border-rulesoft py-2 text-[13px] first:border-t-0">
                  <span className="min-w-0 truncate"><span className="font-mono font-semibold">#{r.rel_number}</span> <span className="text-inksoft">{r.location || cNum(r.contract_id)}</span></span>
                  <Stamp label={`NEED ${missing}H`} tone="alert" />
                </div>
              ))}
              {shorts.length === 0 && <div className="py-2 text-[13px] text-inksoft">Every open release meets its labor minimum.</div>}
            </div>
          </div>

          <a href="/releases" className="btn btn-primary mt-5 inline-block">Open releases →</a>
        </>
      )}
    </div>
  );
}
