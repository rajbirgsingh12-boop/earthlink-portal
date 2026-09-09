"use client";
import { useMemo } from "react";
import { addDays, localISO } from "@/lib/docs";

// The calendar, the way a calendar is supposed to look: Month, Week and Day
// views, a bar with Today and arrows, weekday headings, today marked, every
// job a colored bar on its day. Built for a thumb — every cell and bar is a
// button — and for a desk, where the month fills the screen.
export type CalEvent = {
  id: string;
  day: string;                 // "YYYY-MM-DD"
  title: string;               // the street — what the crew says on the phone
  subtitle?: string;           // apartment · partner · PO
  kind: "pact" | "nycha";      // color: PACT orange, NYCHA blue
  done?: boolean;
  flag?: string;               // a short warning, e.g. "crew not told of the new day"
  people?: string[];           // who is going
};
export type CalView = "month" | "week" | "day";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const monthOf = (iso: string) => iso.slice(0, 7);
const weekStart = (iso: string) => { const d = new Date(iso + "T00:00:00"); return addDays(iso, -d.getDay()); };
const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(iso + "T00:00:00").toLocaleDateString("en-US", opts);

export const KIND_LABEL: Record<CalEvent["kind"], string> = { pact: "PACT job", nycha: "NYCHA release" };
// the bar's colors: a left band in the kind's color, muted once the work is done
const barCls = (e: CalEvent) =>
  `${e.kind === "pact" ? "border-l-work" : "border-l-carbon"} ${e.done ? "bg-paper text-inksoft line-through decoration-rulesoft" : e.kind === "pact" ? "bg-work/10 text-ink" : "bg-carbon/10 text-ink"}`;

export default function Calendar({ events, view, onView, anchor, onAnchor, selected, onSelect, onOpen, renderDay }: {
  events: CalEvent[];
  view: CalView; onView: (v: CalView) => void;
  anchor: string; onAnchor: (iso: string) => void;     // the day the view is centered on
  selected: string; onSelect: (iso: string) => void;  // the day whose agenda is open
  onOpen?: (e: CalEvent) => void;                     // tap a bar
  renderDay?: (iso: string, events: CalEvent[]) => React.ReactNode; // the Day view's body (the cards)
}) {
  const today = localISO(new Date());
  const byDay = useMemo(() => {
    const m: Record<string, CalEvent[]> = {};
    for (const e of events) (m[e.day] ||= []).push(e);
    for (const k of Object.keys(m)) m[k].sort((a, b) => Number(!!a.done) - Number(!!b.done) || a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
    return m;
  }, [events]);

  // ---- navigation ----
  const step = (n: number) => {
    if (view === "month") { const [y, mo] = anchor.split("-").map(Number); const d = new Date(y, mo - 1 + n, 1); onAnchor(localISO(d)); }
    else onAnchor(addDays(anchor, view === "week" ? 7 * n : n));
  };
  const title = view === "month" ? fmt(anchor, { month: "long", year: "numeric" })
    : view === "week" ? `${fmt(weekStart(anchor), { month: "short", day: "numeric" })} – ${fmt(addDays(weekStart(anchor), 6), { month: "short", day: "numeric", year: "numeric" })}`
    : fmt(anchor, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  const Bar = ({ e, compact = false }: { e: CalEvent; compact?: boolean }) => (
    <button type="button" onClick={(ev) => { ev.stopPropagation(); onSelect(e.day); onOpen?.(e); }}
      title={[e.title, e.subtitle, e.flag].filter(Boolean).join(" · ")}
      className={`block w-full rounded-[3px] border-l-[3px] text-left ${compact ? "px-1 py-[1px] text-[11px] leading-[1.25]" : "px-2 py-1 text-[12px] leading-snug"} ${barCls(e)}`}>
      <span className="block truncate font-semibold">{e.flag ? "⚠ " : ""}{e.title}</span>
      {!compact && e.subtitle && <span className="block truncate text-[11px] text-inksoft">{e.subtitle}</span>}
      {!compact && e.people && e.people.length > 0 && <span className="block truncate text-[11px] text-inksoft">👷 {e.people.join(", ")}</span>}
    </button>
  );

  // ---- month ----
  const month = () => {
    const [y, mo] = anchor.split("-").map(Number);
    const first = new Date(y, mo - 1, 1);
    const start = addDays(localISO(first), -first.getDay());
    // five rows when the month fits in five, six when it needs them
    const need = Math.ceil((first.getDay() + new Date(y, mo, 0).getDate()) / 7) * 7;
    const cells = Array.from({ length: need }, (_, i) => addDays(start, i));
    return (
      <div className="overflow-hidden rounded-sm border border-rule bg-white">
        <div className="grid grid-cols-7 border-b border-rule bg-paper">
          {WEEKDAYS.map((d) => <div key={d} className="py-1.5 text-center font-display text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">{d}</div>)}
        </div>
        {/* rows size to their content; on a phone a day shows dots and the
            agenda under the grid does the talking, on a desk the bars do */}
        <div className="grid grid-cols-7">
          {cells.map((iso, i) => {
            const inMonth = monthOf(iso) === monthOf(anchor);
            const evs = byDay[iso] || [];
            const isToday = iso === today, isSel = iso === selected;
            const show = evs.slice(0, 3);
            const lastRow = i >= cells.length - 7;
            return (
              <div key={iso} role="button" tabIndex={0} onClick={() => onSelect(iso)} onKeyDown={(ev) => { if (ev.key === "Enter") onSelect(iso); }}
                aria-label={`${fmt(iso, { weekday: "long", month: "long", day: "numeric" })}${evs.length ? `, ${evs.length} job${evs.length === 1 ? "" : "s"}` : ""}`}
                className={`flex min-h-[52px] flex-col gap-[2px] border-r border-rulesoft p-1 md:min-h-[96px] ${lastRow ? "" : "border-b"} ${i % 7 === 6 ? "border-r-0" : ""} ${inMonth ? "bg-white" : "bg-paper/60"} ${isSel ? "outline outline-2 -outline-offset-2 outline-ink" : ""}`}>
                <div className="flex items-center justify-between">
                  <span className={`grid h-6 w-6 place-items-center rounded-full font-mono text-[12px] ${isToday ? "bg-work font-bold text-white" : inMonth ? "text-ink" : "text-inksoft"}`}>{Number(iso.slice(-2))}</span>
                  {evs.length > 0 && <span className="hidden font-mono text-[11px] text-inksoft md:inline">{evs.length}</span>}
                </div>
                <div className="flex flex-wrap gap-[3px] px-[2px] md:hidden">
                  {evs.slice(0, 4).map((e) => <span key={e.id} className={`inline-block h-[7px] w-[7px] rounded-full ${e.done ? "bg-rule" : e.kind === "pact" ? "bg-work" : "bg-carbon"}`} />)}
                  {evs.length > 4 && <span className="text-[11px] leading-[8px] text-inksoft">+{evs.length - 4}</span>}
                </div>
                <div className="hidden flex-col gap-[2px] md:flex">
                  {show.map((e) => <Bar key={e.id} e={e} compact />)}
                  {evs.length > show.length && <span className="px-1 text-[11px] text-inksoft">+{evs.length - show.length} more</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ---- week ----
  const week = () => {
    const start = weekStart(anchor);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    return (
      <div className="overflow-x-auto rounded-sm border border-rule bg-white">
        <div className="grid min-w-[700px] grid-cols-7">
          {days.map((iso, i) => {
            const evs = byDay[iso] || [];
            const isToday = iso === today, isSel = iso === selected;
            return (
              <div key={iso} className={`flex min-h-[320px] flex-col border-r border-rulesoft ${i === 6 ? "border-r-0" : ""} ${isSel ? "bg-card" : ""}`}>
                <button type="button" onClick={() => onSelect(iso)} className={`border-b border-rule px-2 py-1.5 text-left ${isToday ? "bg-work/10" : "bg-paper"}`}>
                  <div className="font-display text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">{WEEKDAYS[i]}</div>
                  <div className={`font-mono text-[15px] ${isToday ? "font-bold text-work" : ""}`}>{Number(iso.slice(-2))}</div>
                </button>
                <div className="flex flex-col gap-1 p-1.5">
                  {evs.map((e) => <Bar key={e.id} e={e} />)}
                  {evs.length === 0 && <div className="py-2 text-center text-[11px] text-rulesoft">—</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ---- day ----
  const day = () => {
    const evs = byDay[anchor] || [];
    return (
      <div className="rounded-sm border border-rule bg-white">
        {renderDay ? renderDay(anchor, evs) : (
          <div className="flex flex-col gap-1.5 p-2">
            {evs.map((e) => <Bar key={e.id} e={e} />)}
            {evs.length === 0 && <div className="p-4 text-[13px] text-inksoft">Nothing on this day.</div>}
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      {/* the bar: Today ‹ › · title · Month | Week | Day */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-ghost min-h-[44px] px-3 py-1.5 text-[13px]" onClick={() => { onAnchor(today); onSelect(today); }}>Today</button>
        <div className="flex">
          <button type="button" className="btn-icon rounded-r-none" aria-label={`Previous ${view}`} onClick={() => step(-1)}>‹</button>
          <button type="button" className="btn-icon -ml-[1.5px] rounded-l-none" aria-label={`Next ${view}`} onClick={() => step(1)}>›</button>
        </div>
        <div className="font-display text-[16px] font-bold uppercase tracking-wide md:text-[18px]">{title}</div>
        <div className="ml-auto flex rounded-sm border-[1.5px] border-ink" role="tablist" aria-label="Calendar view">
          {(["month", "week", "day"] as CalView[]).map((v, i) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => onView(v)}
              className={`min-h-[40px] px-3 font-display text-[13px] font-semibold uppercase tracking-wider ${i > 0 ? "border-l-[1.5px] border-ink" : ""} ${view === v ? "bg-ink text-white" : "bg-white text-ink"}`}>{v}</button>
          ))}
        </div>
      </div>
      {view === "month" ? month() : view === "week" ? week() : day()}
      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-inksoft">
        {(!events.length || events.some((e) => e.kind === "pact")) && <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-[2px] border-l-[3px] border-l-work bg-work/10" /> PACT job</span>}
        {events.some((e) => e.kind === "nycha") && <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-[2px] border-l-[3px] border-l-carbon bg-carbon/10" /> NYCHA release</span>}
        <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-[2px] border-l-[3px] border-l-rule bg-paper" /> done</span>
        <span className="inline-flex items-center gap-1">⚠ crew not told</span>
      </div>
    </div>
  );
}
