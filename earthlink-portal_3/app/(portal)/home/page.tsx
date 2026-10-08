"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { sb } from "@/lib/supabase";
import { fmt } from "@/lib/format";
import { fmt0, fmtShort } from "@/lib/money";
import { prettyDate, localISO } from "@/lib/docs";
import { canonTrade, checkLabor, aggregateLogged } from "@/lib/labor";
import { useLive } from "@/lib/useLive";
import { myProfile, useProfile } from "@/lib/profile";
import { cached, cachedAt, remember, onCacheUser } from "@/lib/cache";
import { useCountUp } from "@/lib/useCountUp";
import Stamp from "@/components/Stamp";
import type { Contract } from "@/lib/types";
import "./home.css";

// Home is the morning band: the day, the greeting, the three dollar figures that
// need action, who is on the job today, then the everyday jobs and the three
// attention cards. Not a PACT page: every role sees the NYCHA dollars it always
// has, and nothing is read from pact_jobs. The band is this page's heading (the
// one page without PageHeader); the tab title still comes from the layout.

interface Row {
  id: string; contract_id: string; rel_number: string; location: string; amount: number;
  received: boolean; payroll_done: boolean; canceled: boolean; invoice_sent: string | null;
  labor_hours: number; labor_breakdown: { cls: string; hours: number }[] | null;
}
interface Prop { id: string; number: string; job: string; development?: string; status: string; total?: number; contract_id?: string | null; created_at: string; qty_map?: Record<string, number> | null; }
interface Day { id: string; employee_id: string; pact_job_id: string | null; release_id: string | null; texted: boolean; send_at: string | null; }
type Bucket = "0 to 30" | "31 to 45" | "46 to 60" | "over 60";

// everything the page paints, derived once from the raw rows, small enough to cache
interface View {
  contractsN: number; tot: number;
  openSum: number; openN: number; staleN: number;   // open = live, not received, amount > 0; stale = open, invoiced over 45 days ago
  notInvSum: number; notInvN: number;               // open without invoice_sent
  prSum: number; prN: number;                       // live, not payroll_done, not received, amount > 0
  oldest: { id: string; rel_number: string; name: string; amount: number; invoice_sent: string }[]; // 5 oldest invoiced unpaid
  aging: { k: Bucket; sum: number }[];              // open invoiced money by days since invoice_sent
  walks: { id: string; name: string; when: string; total: number }[]; walksN: number; // first 5 undelivered drafts
  shorts: { id: string; rel_number: string; name: string; missing: number }[] | null; // null = round 2 not in yet
  weekHours: number | null;                         // null = nothing logged for this Friday yet
  today: { people: number; notTexted: number; held: number; nobody: number; pact: boolean } | null; // null = not readable for this role
}
interface Raw { contracts: Contract[]; rows: Row[]; props: Prop[]; days: Day[] | null; held: number; nobody: number; weekHours: number | null; }

const CACHE_KEY = "home:board";
const DAY_MS = 24 * 3600_000;
// the everyday jobs, one tap each (Help quotes these labels word for word)
const LAUNCHERS: [string, string][] = [
  ["Enter today's hours", "/payroll"], ["Fill out a walk sheet", "/proposals"],
  ["Make an invoice", "/package"], ["See the releases", "/releases"],
];
const WALK_LABEL = "Proposals"; // what the nav calls that page (layout.tsx); Help says the same word
// the aging strip: a labelled sequential ramp, light to red, never the green or copper
const BUCKETS: [Bucket, string][] = [["0 to 30", "bg-rule"], ["31 to 45", "bg-carbon"], ["46 to 60", "bg-alert/60"], ["over 60", "bg-alert"]];
type Tone = "plain" | "alert" | "ok";
interface Num { label: string; href: string; value: number | null; chip: { tone: Tone; text: string } | null; }
const PLACEHOLDERS: Num[] = [
  { label: "Payment not received", href: "/package", value: null, chip: null },
  { label: "Not invoiced yet", href: "/package", value: null, chip: null },
  { label: "Payroll to do", href: "/payroll", value: null, chip: null },
];

const fridayOf = (d: Date) => {
  const fri0 = new Date(localISO(d) + "T00:00:00");
  fri0.setDate(fri0.getDate() + ((5 - fri0.getDay() + 7) % 7));
  return fri0;
};
const daysSince = (iso: string, d: Date) => Math.max(0, Math.floor((d.getTime() - new Date(iso + "T00:00:00").getTime()) / 86400000));
const sumHours = (es: { hours: number[] }[]) => es.reduce((s, e) => s + (e.hours || []).reduce((a, h) => a + (Number(h) || 0), 0), 0);
const st = (i: number) => ({ "--i": i } as CSSProperties);

// the raw rows become the view once, here, so the cache holds something small
function build(raw: Raw, shorts: View["shorts"], now: Date): View {
  const cNum = (id: string) => raw.contracts.find((x) => x.id === id)?.number || "";
  const nameOf = (r: Row) => r.location || cNum(r.contract_id);
  const sum = (rs: Row[]) => rs.reduce((s, r) => s + Number(r.amount), 0);
  const live = raw.rows.filter((r) => !r.canceled);
  const open = live.filter((r) => !r.received && Number(r.amount) > 0);
  const prPend = live.filter((r) => !r.payroll_done && !r.received && Number(r.amount) > 0);
  const days = (iso: string) => daysSince(iso, now);
  const invoiced = open.filter((r) => r.invoice_sent);
  const oldest = invoiced.slice().sort((a, b) => days(b.invoice_sent!) - days(a.invoice_sent!)).slice(0, 5)
    .map((r) => ({ id: r.id, rel_number: r.rel_number, name: nameOf(r), amount: Number(r.amount), invoice_sent: r.invoice_sent! }));
  const notInvoiced = open.filter((r) => !r.invoice_sent);
  const stale = invoiced.filter((r) => days(r.invoice_sent!) > 45);
  const aging = BUCKETS.map(([k]) => ({ k, sum: 0 }));
  invoiced.forEach((r) => { const n = days(r.invoice_sent!); aging[n <= 30 ? 0 : n <= 45 ? 1 : n <= 60 ? 2 : 3].sum += Number(r.amount); });
  // walk sheets with quantities that never became a release / got delivered
  const walks = raw.props.filter((p) => p.contract_id && p.qty_map && Object.keys(p.qty_map).length > 0);
  const today = raw.days === null ? null : {
    people: new Set(raw.days.map((x) => x.employee_id)).size,
    notTexted: raw.days.filter((x) => !x.texted && !x.send_at).length, // a text set up for later is not a red flag
    held: raw.held, nobody: raw.nobody,
    pact: raw.days.some((x) => !!x.pact_job_id) || raw.held + raw.nobody > 0,
  };
  return {
    contractsN: raw.contracts.length, tot: sum(live),
    openSum: sum(open), openN: open.length, staleN: stale.length,
    notInvSum: sum(notInvoiced), notInvN: notInvoiced.length,
    prSum: sum(prPend), prN: prPend.length,
    oldest, aging,
    walks: walks.slice(0, 5).map((p) => ({ id: p.id, name: p.job || p.development || p.number, when: localISO(new Date(p.created_at)), total: Number(p.total) || 0 })),
    walksN: walks.length,
    shorts, weekHours: raw.weekHours, today,
  };
}

// the Today line's facts, in the order they are read
function todayFacts(t: NonNullable<View["today"]>): { text: string; alert?: boolean }[] {
  const out: { text: string; alert?: boolean }[] = [];
  if (t.people > 0) {
    out.push({ text: `${t.people} on the job` });
    out.push(t.notTexted > 0 ? { text: `${t.notTexted} not texted`, alert: true } : { text: "all texted" });
  } else out.push({ text: "No one on the schedule today" });
  if (t.held > 0) out.push({ text: t.held === 1 ? "1 text needs a job" : `${t.held} texts need a job`, alert: true });
  if (t.nobody > 0) out.push({ text: `${t.nobody} nobody home`, alert: true });
  return out;
}

// a component, so the hook is not called inside a map
const CountUp = ({ value }: { value: number }) => <>{fmt0(useCountUp(value))}</>;
const Skel = ({ className }: { className: string }) => <span className={`skeleton-dark inline-block align-middle ${className}`} />;
const chipCls = (t: Tone) => t === "alert" ? "bg-alert text-white" : t === "ok" ? "bg-ok text-white" : "bg-paper/10 text-paper";

export default function Home() {
  const { hint, fresh } = useProfile();
  const profile = fresh || hint;
  const role = profile?.role;
  const [view, setView] = useState<View | null>(null);
  const [stale, setStale] = useState(false);     // what is showing came from the last visit, the fetch is still out
  const [now, setNow] = useState<Date | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const viewRef = useRef<View | null>(null);
  const freshRef = useRef(false);                // round 1 has landed on this visit
  const usedRole = useRef<string | null>(null);  // the role the last fetch decided its reads by
  const paint = (v: View) => { viewRef.current = v; setView(v); };

  // the clock, set after hydration (the server renders in UTC) and kept current while
  // the tab is visible: a phone left on Home overnight shows the right day and greeting
  useEffect(() => {
    setNow(new Date());
    let day = localISO();
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      const n = new Date();
      setNow(n);
      const iso = localISO(n);
      if (iso !== day) { day = iso; setReloadTick((t) => t + 1); }
    };
    const id = setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, []);

  // last visit's board paints at once (keyed per user by lib/cache.ts); the fetch replaces it
  useEffect(() => onCacheUser(() => {
    const c = cached<View>(CACHE_KEY);
    if (c && Date.now() - cachedAt(CACHE_KEY) < DAY_MS && !viewRef.current) { paint(c); if (!freshRef.current) setStale(true); }
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  // live: releases / walk sheets / payroll / contracts / the day's schedule refresh the board
  useLive(["releases", "proposals", "timesheet_entries", "contracts", "employees", "schedule_days", "texted_photos"], () => setReloadTick((t) => t + 1), { delay: 500 });

  // the database corrected the role the fetch decided its reads by (rare: a role changed
  // since the last visit): fetch again with the right reads
  useEffect(() => { if (fresh && usedRole.current !== null && fresh.role !== usedRole.current) setReloadTick((t) => t + 1); }, [fresh]);

  useEffect(() => {
    let alive = true;
    (async () => {
      // the role decides which reads are made: the remembered profile answers at once
      const role = (await myProfile())?.role || "";
      if (!alive) return;
      usedRole.current = role;
      const canSchedule = role !== "foreman";                  // schedule_days RLS: admin, office, accountant
      const canPhotos = role === "admin" || role === "office"; // texted_photos RLS: admin, office
      const now = new Date();
      // one round of parallel fetches: serial awaits doubled the board's load
      // time on a phone; only the columns the board actually uses come over
      const fetchReleases = async () => {
        const all: Row[] = [];
        let from = 0;
        for (;;) {
          // ordered, because pages of an unordered scan can overlap between
          // requests, double-counting money in the totals
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
      const none: Promise<{ data: null; error: null }> = Promise.resolve({ data: null, error: null });
      // round 1: everything the band and the first two cards need, all at once
      const [{ data: c }, all, { data: props }, { data: allEmps }, wk, sd, tp] = await Promise.all([
        sb().from("contracts").select("id,number,name").order("number"),
        fetchReleases(),
        sb().from("proposals").select("id,number,job,development,status,total,contract_id,created_at,qty_map").eq("status", "draft").order("created_at"),
        sb().from("employees").select("id,trade"),
        // has anyone entered hours for the current payroll week? One request through
        // the week's foreign key, and it covers every week row for that Friday: with
        // an accidental duplicate week the hours could live on either copy, and
        // reading just one falsely nags
        sb().from("timesheet_entries").select("hours,timesheet_weeks!inner(week_ending)").eq("timesheet_weeks.week_ending", localISO(fri0)),
        canSchedule ? sb().from("schedule_days").select("id,employee_id,pact_job_id,release_id,texted,send_at").eq("day", localISO(now)) : none,
        canPhotos ? sb().from("texted_photos").select("id,status").in("status", ["held", "nobody"]).limit(200) : none,
      ]);
      if (!alive) return;
      // an older PostgREST may refuse the join: then the hours come the old way in round 2
      const wkRows = wk.error ? undefined : ((wk.data || []) as { hours: number[] }[]);
      const photos = tp.error ? [] : ((tp.data || []) as { status: string }[]);
      const raw: Raw = {
        contracts: (c || []) as Contract[], rows: all, props: (props || []) as Prop[],
        // a read this role cannot make (or an older database) just leaves the line out
        days: canSchedule && !sd.error && sd.data ? (sd.data as Day[]) : null,
        held: photos.filter((p) => p.status === "held").length,
        nobody: photos.filter((p) => p.status === "nobody").length,
        weekHours: wkRows && wkRows.length > 0 ? sumHours(wkRows) : null,
      };
      const v1 = build(raw, viewRef.current?.shorts ?? null, now);
      paint(v1);
      freshRef.current = true;
      setStale(false);

      // round 2: the shortfall check (the one slow read), and the week's hours the
      // old way if the join was refused
      let shorts: NonNullable<View["shorts"]> = [];
      let weekHours = raw.weekHours;
      await Promise.all([
        (async () => {
          // payroll shortfalls against release minimums
          const need = all.filter((r) => !r.canceled && !r.received && !r.payroll_done && (Number(r.labor_hours) > 0 || (r.labor_breakdown || []).length > 0));
          if (need.length === 0) return;
          const needIds = need.map((r) => r.id);
          const ents: { release_id: string | null; employee_id: string; hours: number[]; trade?: string | null }[] = [];
          // chunks fetch together, each page-looped and ordered
          await Promise.all(Array.from({ length: Math.ceil(needIds.length / 200) }, (_, x) => x * 200).map(async (i) => {
            for (let f = 0; ; f += 1000) { // paginated: an unranged select stops silently at 1000
              const { data: chunk } = await sb().from("timesheet_entries").select("*").in("release_id", needIds.slice(i, i + 200)).order("id").range(f, f + 999);
              ents.push(...((chunk || []) as typeof ents));
              if (!chunk || chunk.length < 1000) break;
            }
          }));
          const tradeById = new Map(((allEmps || []) as { id: string; trade: string }[]).map((e) => [e.id, canonTrade(e.trade)]));
          const byRel = aggregateLogged(ents, tradeById);
          const cNum = (id: string) => raw.contracts.find((x) => x.id === id)?.number || "";
          shorts = need
            .map((r) => {
              const res = checkLabor(r.labor_breakdown || [], Number(r.labor_hours) || 0, byRel[r.id] || {});
              const missing = Math.max(res.totalRequired - res.totalLogged, res.shorts.reduce((s, x) => s + (x.required - x.logged), 0));
              return { r, missing, ok: res.ok };
            })
            .filter((x) => !x.ok && x.missing > 0)
            .sort((a, b) => b.missing - a.missing)
            .slice(0, 5)
            .map(({ r, missing }) => ({ id: r.id, rel_number: r.rel_number, name: r.location || cNum(r.contract_id), missing }));
        })(),
        (async () => {
          if (wkRows !== undefined) return;
          // all week rows for that Friday, then their entries (see the note on duplicate weeks above)
          const { data: w } = await sb().from("timesheet_weeks").select("id").eq("week_ending", localISO(fri0));
          if (w && w.length > 0) {
            const { data: es } = await sb().from("timesheet_entries").select("hours").in("week_id", (w as { id: string }[]).map((x) => x.id));
            weekHours = sumHours((es || []) as { hours: number[] }[]);
          } else weekHours = null;
        })(),
      ]);
      if (!alive) return;
      const v2: View = { ...v1, shorts, weekHours };
      paint(v2);
      remember(CACHE_KEY, v2);
    })();
    return () => { alive = false; };
  }, [reloadTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // derived from the clock at render, never stored: a cached view's DAYS stamps are right on the day they are shown
  const d = now ?? new Date();
  const days = (iso: string) => daysSince(iso, d);
  const hour = d.getHours(), greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const first = (profile?.name || "").trim().split(/\s+/)[0] || "";
  const dayLong = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const friShort = fridayOf(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  // gentle nudge so nothing slips just because nobody looked: Wed, Thu, Fri with no hours in yet
  const dow = d.getDay(); // Wed=3 Thu=4 Fri=5
  const payrollNudge = !!view && dow >= 3 && dow <= 5 && (view.weekHours === null || view.weekHours === 0);
  const chip = (tone: Tone, text: string) => ({ tone, text });
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const NUMS: Num[] | null = view && [
    { label: "Payment not received", href: "/package", value: view.openSum, chip: view.staleN > 0 ? chip("alert", `${view.staleN} over 45 days`) : view.openN > 0 ? chip("plain", `${view.openN} unpaid`) : chip("plain", "Nothing open") },
    { label: "Not invoiced yet", href: "/package", value: view.notInvSum, chip: view.notInvN > 0 ? chip("plain", plural(view.notInvN, "release")) : chip("plain", "Nothing to invoice") },
    { label: "Payroll to do", href: "/payroll", value: view.prSum, chip: view.shorts === null ? null : view.shorts.length > 0 ? chip("alert", `${view.shorts.length} short on hours`) : view.prN > 0 ? chip("plain", plural(view.prN, "release")) : chip("ok", "All caught up") },
  ];
  const facts = view?.today ? todayFacts(view.today) : [];
  const todayHref = view?.today?.pact ? "/pact/schedule" : "/schedule";
  const agingTotal = view ? view.aging.reduce((s, b) => s + b.sum, 0) : 0;
  const buckets = (view?.aging || []).map((b, i) => ({ ...b, cls: BUCKETS[i][1], pct: agingTotal > 0 ? (b.sum / agingTotal) * 100 : 0 }));

  // one look for every list row, card footer and card heading
  const rowCls = "row-btn flex min-h-[44px] items-center justify-between gap-2 border-t border-rulesoft py-1 text-[14px] first:border-t-0";
  const footCls = "mt-1 border-t border-rulesoft pt-2 text-[12px] text-inksoft";
  const headCls = "mb-0.5 flex items-center justify-between";
  const titleCls = "font-display text-sm font-bold uppercase";

  return (
    <div>
      {stale && <div className="busy-bar" aria-hidden />}

      {/* A: the band. Full bleed on a phone, a block in the container on a desk. The wrapper
          staggers its children in; on a desk it is also the three-column grid */}
      <section aria-label="Today" className="hero-band -mx-4 -mt-5 bg-logo-brown px-4 pb-3 pt-4 text-paper md:mx-0 md:mt-0 md:rounded-sm md:px-5 md:pb-3.5 md:pt-5">
        <div className="anim-stagger md:grid md:grid-cols-3 md:gap-x-5">
          <div style={st(0)} className="flex min-h-[14px] justify-between gap-3 text-[11px] font-semibold uppercase leading-[14px] tracking-[.2em] text-papersoft md:col-span-3">
            {now ? <><span>{dayLong}</span><span className="shrink-0">Week ending {friShort}</span></> : <Skel className="h-[11px] w-40" />}
          </div>
          <h1 style={st(0)} className="mb-2.5 mt-1 font-display text-[clamp(27px,8.7vw,34px)] font-bold uppercase leading-none tracking-[.01em] md:col-span-3 md:mb-3.5 md:text-[40px]">
            {now ? <>{greeting}{first && <>, <span className="text-papersoft">{first}</span></>}</> : <Skel className="h-[34px] w-64" />}
          </h1>
          {(NUMS ?? PLACEHOLDERS).map((n, i) => (
            <Link key={n.label} href={n.href} style={st(i + 1)}
              className={`flex min-h-[60px] items-center justify-between gap-3 py-1 active:bg-paper/10 md:block md:min-h-0 md:border-t-0 md:py-0.5 ${i > 0 ? "border-t border-paper/15 md:border-l md:pl-4" : ""}`}>
              <span className="block min-w-0 flex-1">
                <span className="block text-[11px] font-semibold uppercase leading-[1.3] tracking-[.14em] text-papersoft">{n.label}</span>
                {!n.chip ? <Skel className="mt-1 h-[18px] w-24" />
                  : <span key={n.chip.text} className={`anim-stamp mt-1 inline-block whitespace-nowrap rounded-[2px] px-1.5 font-mono text-[11px] font-semibold leading-[18px] tracking-[.04em] ${chipCls(n.chip.tone)}`}>{n.chip.text}</span>}
              </span>
              {n.value === null ? <span className="skeleton-dark block h-8 w-[8.2ch] shrink-0 font-mono text-[32px] md:mt-2 md:h-10 md:text-[40px]" />
                : <span className="anim-fade min-w-[8.2ch] shrink-0 text-right font-mono text-[32px] font-semibold leading-none tracking-[-.02em] tabular-nums md:mt-2 md:block md:text-left md:text-[40px]"><CountUp value={n.value} /></span>}
              <span aria-hidden className="-ml-1 shrink-0 text-lg text-papersoft max-[359px]:hidden md:hidden">→</span>
            </Link>
          ))}
          <div style={st(4)} className="mt-1.5 flex flex-wrap items-center justify-between gap-x-4 border-t border-paper/15 pt-1 text-[12px] leading-snug text-papersoft md:col-span-3 md:mt-2.5">
            {role !== "foreman" && (view === null || view.today) && (
              <Link href={todayHref} className="inline-flex min-h-[44px] items-center text-paper">
                <b className="mr-2 text-[11px] font-semibold uppercase tracking-[.14em] text-papersoft">Today</b>
                {!view ? <Skel className="h-3 w-[150px]" />
                  : <span>{facts.map((f, i) => <span key={i}>{i > 0 && " · "}<span className={`whitespace-nowrap ${f.alert ? "font-semibold text-[#F0A49E]" : ""}`}>{f.text}</span></span>)} →</span>}
              </Link>
            )}
            <span className="pb-1.5">
              {!view ? <Skel className="h-3 w-[210px]" />
                : <>{plural(view.contractsN, "contract")} · <span className="font-mono text-paper">{fmt0(view.tot)}</span> released · {view.weekHours ? <><span className="font-mono text-paper">{Math.round(view.weekHours)}</span> h logged this week</> : "no hours yet this week"}</>}
            </span>
          </div>
        </div>
      </section>

      {/* B: the nudge, only on the days it applies */}
      {payrollNudge && (
        <Link href="/payroll" className="anim-fade card mt-3 flex min-h-[52px] items-center gap-2.5 border-alert p-3 text-[14px] transition-shadow hover:shadow">
          <span className="text-alert">⚠</span><span><b>No hours entered for this week yet.</b> Tap here, then Make payroll, and enter the hours before Friday. →</span>
        </Link>
      )}

      {/* C: the four everyday jobs: static, never wait on data. Press and hover come from the kit alone */}
      <div className="anim-stagger mt-3 grid grid-cols-2 gap-2.5 md:grid-cols-4">
        {LAUNCHERS.map(([label, href], i) => (
          <Link key={href} href={href} style={st(i)} className={`btn group min-h-[56px] justify-between px-3.5 text-left max-[359px]:px-3 ${i === 0 ? "btn-primary" : ""}`}>
            <span>{label}</span><span aria-hidden className={`text-lg transition-transform duration-[120ms] max-[359px]:hidden md:group-hover:translate-x-0.5 ${i === 0 ? "text-white" : "text-work"}`}>→</span>
          </Link>
        ))}
      </div>

      {/* D: the attention cards */}
      {!view ? (
        /* the cards' shape, shimmering: no text flash, no layout jump */
        <div role="status" aria-busy="true" aria-label="Loading" className="mt-3.5 grid gap-3 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card p-3.5">
              <div className="skeleton mb-3 h-4 w-32" />
              <div className="skeleton mb-2 h-3 w-full" />
              <div className="skeleton mb-2 h-3 w-5/6" />
              <div className="skeleton h-3 w-2/3" />
            </div>
          ))}
        </div>
      ) : (
        <div className="anim-fade anim-stagger mt-3.5 grid gap-3 md:grid-cols-3">
          <div className="card p-3.5" style={st(0)}>
            <div className={headCls}>
              <div className={titleCls}>Chase these first</div>
              <Link href="/package" className="btn-link text-inksoft">Invoice Package →</Link>
            </div>
            {view.staleN > 0 && <div className="text-[12px] text-inksoft">{view.staleN} over 45 days: worth a call.</div>}
            {view.oldest.length > 0 && <>
              <div className="my-1 flex h-2 gap-[2px] overflow-hidden rounded-[2px]">
                {buckets.filter((b) => b.sum > 0).map((b) => <b key={b.k} className={`anim-grow-x block ${b.cls}`} style={{ width: `${b.pct}%` }} />)}
              </div>
              <div className="mb-1 grid grid-cols-4 text-[11px] text-inksoft">
                {buckets.map((b) => <span key={b.k}>{b.k}<br /><span className="font-mono">{fmtShort(b.sum)}</span></span>)}
              </div>
            </>}
            {view.oldest.map((r) => (
              <Link key={r.id} href="/package" className={rowCls}>
                <span className="min-w-0 truncate"><span className="font-mono font-semibold">#{r.rel_number}</span> <span className="text-inksoft">{r.name}</span></span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="font-mono">{fmt(r.amount)}</span>
                  <Stamp label={`${days(r.invoice_sent)} DAYS`} tone={days(r.invoice_sent) > 60 ? "alert" : "work"} />
                </span>
              </Link>
            ))}
            {view.oldest.length === 0 && <div className="empty text-[14px]">Nothing to chase.</div>}
            {view.notInvN > 0 && <div className={footCls}>{view.notInvN} unpaid release{view.notInvN === 1 ? "" : "s"} not invoiced yet · {fmt(view.notInvSum)}</div>}
          </div>

          <div className="card p-3.5" style={st(1)}>
            <div className={headCls}>
              <div className={titleCls}>Walk sheets not delivered</div>
              <Link href="/proposals" className="btn-link text-inksoft">{WALK_LABEL} →</Link>
            </div>
            {view.walks.map((p) => (
              <Link key={p.id} href="/proposals" className={rowCls}>
                <span className="min-w-0 truncate">{p.name}<span className="text-inksoft"> · {prettyDate(p.when)}</span></span>
                <span className="shrink-0 font-mono">{fmt(p.total)}</span>
              </Link>
            ))}
            {view.walks.length === 0 && <div className="empty text-[14px]">Nothing waiting to be delivered.</div>}
            {view.walksN > 5 && <div className={footCls}>+{view.walksN - 5} more drafts</div>}
          </div>

          <div className="card p-3.5" style={st(2)}>
            <div className={headCls}>
              <div className={titleCls}>Payroll short</div>
              <Link href="/payroll" className="btn-link text-inksoft">Payroll →</Link>
            </div>
            {view.shorts === null ? (
              /* round 2 is still out: this card alone waits */
              <><div className="skeleton mb-2 h-3 w-full" /><div className="skeleton mb-2 h-3 w-5/6" /><div className="skeleton h-3 w-2/3" /></>
            ) : <>
              {view.shorts.map((s) => (
                <Link key={s.id} href="/payroll" className={rowCls}>
                  <span className="min-w-0 truncate"><span className="font-mono font-semibold">#{s.rel_number}</span> <span className="text-inksoft">{s.name}</span></span>
                  <Stamp label={`SHORT ${s.missing}H`} tone="alert" />
                </Link>
              ))}
              {view.shorts.length === 0 && <div className="empty text-[14px]">No payroll shortfalls.</div>}
            </>}
          </div>
        </div>
      )}
    </div>
  );
}
