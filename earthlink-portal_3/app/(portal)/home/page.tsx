"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { sb } from "@/lib/supabase";
import { fmt } from "@/lib/format";
import { prettyDate, localISO } from "@/lib/docs";
import { canonTrade, checkLabor, aggregateLogged } from "@/lib/labor";
import { useLive } from "@/lib/useLive";
import Stamp from "@/components/Stamp";
import type { Contract } from "@/lib/types";

interface Row {
  id: string; contract_id: string; rel_number: string; location: string; amount: number;
  received: boolean; payroll_done: boolean; canceled: boolean; invoice_sent: string | null;
  labor_hours: number; labor_breakdown: { cls: string; hours: number }[] | null;
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
      // one round of parallel fetches — serial awaits doubled the board's load
      // time on a phone; only the columns the board actually uses come over
      const fetchReleases = async () => {
        const all: Row[] = [];
        let from = 0;
        for (;;) {
          // ordered — pages of an unordered scan can overlap between requests,
          // double-counting money in the totals
          const { data } = await sb().from("releases")
            .select("id,contract_id,rel_number,location,amount,received,payroll_done,canceled,invoice_sent,labor_hours,labor_breakdown")
            .order("id").range(from, from + 999);
          if (!data || data.length === 0) break;
          all.push(...(data as Row[]));
          if (data.length < 1000) break;
          from += 1000;
        }
        return all;
      };
      const fri0 = new Date(localISO() + "T00:00:00");
      fri0.setDate(fri0.getDate() + ((5 - fri0.getDay() + 7) % 7));
      const [{ data: c }, all, { data: props }, { data: allEmps }, { data: wk }] = await Promise.all([
        sb().from("contracts").select("id,number,name").order("number"),
        fetchReleases(),
        sb().from("proposals").select("*").eq("status", "draft").order("created_at"),
        sb().from("employees").select("id,trade"),
        sb().from("timesheet_weeks").select("id").eq("week_ending", localISO(fri0)),
      ]);
      setContracts((c || []) as Contract[]);
      setRows(all);
      // walk sheets with quantities that never became a release / got delivered
      setWalks(((props || []) as Prop[]).filter((p) => p.contract_id && p.qty_map && Object.keys(p.qty_map).length > 0));
      // payroll shortfalls against release minimums
      const need = all.filter((r) => !r.canceled && !r.received && !r.payroll_done && (Number(r.labor_hours) > 0 || (r.labor_breakdown || []).length > 0));
      if (need.length > 0) {
        const needIds = need.map((r) => r.id);
        const ents: { release_id: string | null; employee_id: string; hours: number[]; trade?: string | null }[] = [];
        // chunks fetch together, each page-looped and ordered
        await Promise.all(Array.from({ length: Math.ceil(needIds.length / 200) }, (_, x) => x * 200).map(async (i) => {
          for (let f = 0; ; f += 1000) { // paginated — an unranged select stops silently at 1000
            const { data: chunk } = await sb().from("timesheet_entries").select("*").in("release_id", needIds.slice(i, i + 200)).order("id").range(f, f + 999);
            ents.push(...((chunk || []) as typeof ents));
            if (!chunk || chunk.length < 1000) break;
          }
        }));
        const tradeById = new Map(((allEmps || []) as { id: string; trade: string }[]).map((e) => [e.id, canonTrade(e.trade)]));
        const byRel = aggregateLogged(ents, tradeById);
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
      // has anyone entered hours for the current payroll week? (all week rows
      // for that Friday — with an accidental duplicate week the hours could
      // live on either copy, and reading just one falsely nags)
      if (wk && wk.length > 0) {
        const ids = (wk as { id: string }[]).map((w) => w.id);
        const { data: es } = await sb().from("timesheet_entries").select("hours").in("week_id", ids);
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

  const cards: [string, string, string][] = [
    ["Contracts", String(contracts.length), "text-ink"],
    ["Released (live)", fmt(tot), "text-ink"],
    ["Not received", fmt(open.reduce((s, r) => s + Number(r.amount), 0)), "text-work"],
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
           ["🧾", "Make an invoice", "/statements"], ["📄", "See the releases", "/releases"]] as [string, string, string][]).map(([icon, label, href]) => (
          <Link key={href} href={href} className="card flex items-center gap-2.5 p-3.5 transition-shadow hover:shadow">
            <span className="text-xl">{icon}</span>
            <span className="font-display text-[14px] font-semibold uppercase leading-tight tracking-wide">{label}</span>
          </Link>
        ))}
      </div>
      {loading ? (
        /* the board's shape, shimmering — no text flash, no layout jump */
        <div aria-label="Opening the books…">
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="card p-3.5"><div className="skeleton mb-2 h-3 w-20" /><div className="skeleton h-6 w-24" /></div>
            ))}
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="card p-3.5">
                <div className="skeleton mb-3 h-4 w-32" />
                <div className="skeleton mb-2 h-3 w-full" />
                <div className="skeleton mb-2 h-3 w-5/6" />
                <div className="skeleton h-3 w-2/3" />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          {payrollNudge && (
            <Link href="/payroll" className="card mb-2.5 block border-alert p-3 text-[14px]">
              ⏱ <b>No hours entered for this week yet.</b> Tap here, hit Make payroll, and punch them in before Friday.
            </Link>
          )}
          {stale.length > 0 && (
            <Link href="/statements" className="card mb-2.5 block border-work p-3 text-[14px]">
              🧾 <b>{stale.length} invoice{stale.length === 1 ? "" : "s"} out over 45 days</b> — worth a call. Tap to see who owes what.
            </Link>
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
                <Link href="/statements" className="text-xs text-inksoft underline">Statements →</Link>
              </div>
              {oldest.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-2 border-t border-rulesoft py-2 text-[13px] first:border-t-0">
                  <span className="min-w-0 truncate"><span className="font-mono font-semibold">#{r.rel_number}</span> <span className="text-inksoft">{r.location || cNum(r.contract_id)}</span></span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span className="font-mono">{fmt(Number(r.amount))}</span>
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
                <Link href="/proposals" className="text-xs text-inksoft underline">Proposals →</Link>
              </div>
              {walks.slice(0, 5).map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-2 border-t border-rulesoft py-2 text-[13px] first:border-t-0">
                  <span className="min-w-0 truncate">{p.job || p.development || p.number}<span className="text-inksoft"> · {prettyDate(localISO(new Date(p.created_at)))}</span></span>
                  <span className="shrink-0 font-mono">{fmt(Number(p.total) || 0)}</span>
                </div>
              ))}
              {walks.length === 0 && <div className="py-2 text-[13px] text-inksoft">Every walk sheet has been delivered. 🎉</div>}
              {walks.length > 5 && <div className="mt-1 border-t border-rulesoft pt-2 text-xs text-inksoft">+{walks.length - 5} more drafts</div>}
            </div>

            <div className="card p-3.5">
              <div className="mb-2 flex items-baseline justify-between">
                <div className="font-display text-sm font-bold uppercase">Payroll short</div>
                <Link href="/payroll" className="text-xs text-inksoft underline">Payroll →</Link>
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

          <Link href="/releases" className="btn btn-primary mt-5 inline-block">Open releases →</Link>
        </>
      )}
    </div>
  );
}
