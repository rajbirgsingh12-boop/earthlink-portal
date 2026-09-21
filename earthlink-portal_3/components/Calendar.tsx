"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { addDays, localISO } from "@/lib/docs";

// The calendar, the way a calendar is supposed to look: Month, Week and Day
// views, a bar with Today and arrows, weekday headings, today marked, every
// job a colored bar on its day — named by its PO number, the way the office
// and the partners talk about a job. Built for a thumb — every cell and bar
// is a button, and a bar moves to another day by dragging it there (hold it
// first on a phone) — and for a desk, where the month fills the screen.
export type CalEvent = {
  id: string;
  day: string;                 // "YYYY-MM-DD"
  title: string;               // "PO 116843" — what the bar says
  short?: string;              // the number alone, for a phone's month cell
  subtitle?: string;           // the street · apartment · partner
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
// "PO 116843" before "PO 116850", the way numbers read — never "PO 9" after "PO 10"
const byNumber = (a: CalEvent, b: CalEvent) => (a.short || a.title).localeCompare(b.short || b.title, undefined, { numeric: true });

export const KIND_LABEL: Record<CalEvent["kind"], string> = { pact: "PACT job", nycha: "NYCHA release" };
// the bar's colors: a left band in the kind's color, muted once the work is done
const barCls = (e: CalEvent) =>
  `${e.kind === "pact" ? "border-l-work" : "border-l-carbon"} ${e.done ? "bg-paper text-inksoft line-through decoration-rulesoft" : e.kind === "pact" ? "bg-work/10 text-ink" : "bg-carbon/10 text-ink"}`;

// a drag in flight: the bar, where the pointer is, the day under it
type Drag = { e: CalEvent; x: number; y: number; over: string | null };
// the day cell under a point on the screen
const dayAt = (x: number, y: number): string | null =>
  (typeof document === "undefined" ? null : document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-day]")?.dataset.day) || null;
const HOLD_MS = 320;       // how long a finger holds a bar before it comes loose
const HOLD_SLOP = 10;      // a finger that moves this far first is scrolling, not holding
const MOUSE_SLOP = 5;      // a mouse that moves this far is dragging, not clicking
const EDGE = 36;           // this close to the week's edge, the week scrolls under the bar
const EDGE_STEP = 7;       // …this many pixels a frame

export default function Calendar({ events, view, onView, anchor, onAnchor, selected, onSelect, onOpen, onMove, renderDay }: {
  events: CalEvent[];
  view: CalView; onView: (v: CalView) => void;
  anchor: string; onAnchor: (iso: string) => void;     // the day the view is centered on
  selected: string; onSelect: (iso: string) => void;  // the day whose agenda is open
  onOpen?: (e: CalEvent) => void;                     // tap a bar
  onMove?: (e: CalEvent, day: string) => void | Promise<void>; // a bar dropped on another day — when set, bars can be dragged
  renderDay?: (iso: string, events: CalEvent[]) => React.ReactNode; // the Day view's body (the cards)
}) {
  const today = localISO(new Date());
  const byDay = useMemo(() => {
    const m: Record<string, CalEvent[]> = {};
    for (const e of events) (m[e.day] ||= []).push(e);
    for (const k of Object.keys(m)) m[k].sort((a, b) => Number(!!a.done) - Number(!!b.done) || a.kind.localeCompare(b.kind) || byNumber(a, b));
    return m;
  }, [events]);

  // ---- dragging a bar to another day ----
  const [drag, setDrag] = useState<Drag | null>(null);
  // the pointer that pressed a bar, until it lets go: which bar, where it
  // started, the hold timer on a phone, whether the bar has come loose, and
  // the window listeners that follow it once it has
  const press = useRef<{ e: CalEvent; id: number; sx: number; sy: number; timer: ReturnType<typeof setTimeout> | null; live: boolean; el: HTMLElement; off: () => void } | null>(null);
  const dragging = useRef(false);      // a bar is loose right now (read by the scroll blocker)
  const edge = useRef(0);              // -1 / 1 while the pointer rides the week's left / right edge
  const weekScroll = useRef<HTMLDivElement | null>(null);
  const swallowClick = useRef(false); // the click that follows a drop is not a tap
  useEffect(() => {
    // registered once, up front: iPhone Safari decides at the first touch
    // whether the page may scroll under a finger, so a blocker added only
    // when the bar comes loose would come too late. It blocks nothing until then.
    const block = (ev: TouchEvent) => { if (dragging.current) ev.preventDefault(); };
    document.addEventListener("touchmove", block, { passive: false });
    return () => { document.removeEventListener("touchmove", block); press.current?.off(); dragging.current = false; };
  }, []);
  const follow = (x: number, y: number) => {
    const p = press.current;
    if (!p || !p.live) return;
    // on a phone the week is wider than the screen: a bar held at its edge
    // scrolls it, so a day off the screen is still a drop away
    const sc = weekScroll.current;
    if (sc && sc.scrollWidth > sc.clientWidth) { const r = sc.getBoundingClientRect(); edge.current = x < r.left + EDGE ? -1 : x > r.right - EDGE ? 1 : 0; }
    else edge.current = 0;
    setDrag({ e: p.e, x, y, over: dayAt(x, y) });
  };
  const loosen = () => {
    const p = press.current;
    if (!p || p.live) return;
    p.live = true;
    dragging.current = true;
    // the window hears the rest of this pointer, so a bar redrawn elsewhere
    // (a job someone else moved, a day that filled up) mid-drag never leaves
    // a ghost pinned to the screen with the page stuck
    const move = (ev: PointerEvent) => { if (press.current?.id === ev.pointerId) follow(ev.clientX, ev.clientY); };
    const up = (ev: PointerEvent) => { if (press.current?.id === ev.pointerId) letGo(true, ev.clientX, ev.clientY); };
    const cancel = (ev: PointerEvent) => { if (press.current?.id === ev.pointerId) letGo(false, ev.clientX, ev.clientY); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    let raf = 0;
    const tick = () => {
      if (!press.current?.live) return;
      const sc = weekScroll.current;
      if (edge.current && sc) {
        sc.scrollLeft += edge.current * EDGE_STEP;
        setDrag((d) => (d ? { ...d, over: dayAt(d.x, d.y) } : d));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    p.off = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", cancel); cancelAnimationFrame(raf); };
    setDrag({ e: p.e, x: p.sx, y: p.sy, over: p.e.day });
  };
  const letGo = (drop: boolean, x: number, y: number) => {
    const p = press.current;
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    press.current = null;
    p.off();
    dragging.current = false;
    edge.current = 0;
    try { p.el.releasePointerCapture(p.id); } catch { /* fine */ }
    if (!p.live) return; // a tap — the click does its usual work
    // the click that follows a drop is not a tap — and when no click follows
    // (a finger's long press ends without one), the next tap must not pay for it
    swallowClick.current = true;
    setTimeout(() => { swallowClick.current = false; }, 150);
    setDrag(null);
    const over = drop ? dayAt(x, y) : null;
    if (over && over !== p.e.day) void onMove?.(p.e, over);
  };
  const onPointerDown = (e: CalEvent) => (ev: React.PointerEvent<HTMLButtonElement>) => {
    if (!onMove || e.done || ev.button !== 0 || press.current) return;
    const p = { e, id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, timer: null as ReturnType<typeof setTimeout> | null, live: false, el: ev.currentTarget as HTMLElement, off: () => {} };
    press.current = p;
    // the bar keeps hearing this pointer wherever it goes from here — a quick
    // mouse leaves a small bar before its first move would otherwise land on it
    try { p.el.setPointerCapture(p.id); } catch { /* an old browser — the moves still arrive while the pointer is on the bar */ }
    // a finger holds the bar for a moment first (a swipe is the page scrolling); a mouse just drags
    if (ev.pointerType !== "mouse") p.timer = setTimeout(loosen, HOLD_MS);
  };
  const onPointerMove = (ev: React.PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || p.id !== ev.pointerId || p.live) return; // loose: the window follows it
    const dist = Math.hypot(ev.clientX - p.sx, ev.clientY - p.sy);
    if (ev.pointerType === "mouse") { if (dist < MOUSE_SLOP) return; loosen(); follow(ev.clientX, ev.clientY); }
    else if (dist > HOLD_SLOP) { if (p.timer) clearTimeout(p.timer); press.current = null; }
  };
  const onPointerUp = (ev: React.PointerEvent<HTMLButtonElement>) => { if (press.current?.id === ev.pointerId) letGo(true, ev.clientX, ev.clientY); };
  const onPointerCancel = (ev: React.PointerEvent<HTMLButtonElement>) => { if (press.current?.id === ev.pointerId) letGo(false, ev.clientX, ev.clientY); };
  const onClick = (e: CalEvent) => (ev: React.MouseEvent) => {
    ev.stopPropagation();
    if (swallowClick.current) { swallowClick.current = false; return; }
    onSelect(e.day); onOpen?.(e);
  };
  const dropCls = (iso: string) => (drag && drag.over === iso && iso !== drag.e.day ? "bg-work/15 outline outline-2 -outline-offset-2 outline-work" : "");

  // ---- navigation ----
  const step = (n: number) => {
    if (view === "month") { const [y, mo] = anchor.split("-").map(Number); const d = new Date(y, mo - 1 + n, 1); onAnchor(localISO(d)); }
    else onAnchor(addDays(anchor, view === "week" ? 7 * n : n));
  };
  const title = view === "month" ? fmt(anchor, { month: "long", year: "numeric" })
    : view === "week" ? `${fmt(weekStart(anchor), { month: "short", day: "numeric" })} – ${fmt(addDays(weekStart(anchor), 6), { month: "short", day: "numeric", year: "numeric" })}`
    : fmt(anchor, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  // size: "bar" on a desk and in the week, "compact" in a desk's month cell, "chip" in a phone's month cell (the number alone).
  // A plain function, not a component: the button stays the same element from
  // render to render, so the pointer it captured on the way down stays captured
  const bar = (e: CalEvent, size: "bar" | "compact" | "chip" = "bar") => {
    const movable = !!onMove && !e.done;
    const lifted = drag?.e.id === e.id;
    return (
      <button key={e.id} type="button" onClick={onClick(e)}
        onPointerDown={onPointerDown(e)} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}
        onContextMenu={(ev) => { if (movable) ev.preventDefault(); }}
        style={movable ? { WebkitUserSelect: "none", userSelect: "none", WebkitTouchCallout: "none" } : undefined}
        title={[e.title, e.subtitle, e.flag, movable ? "drag to another day to move it" : ""].filter(Boolean).join(" · ")}
        data-po-bar={e.id}
        className={`block w-full rounded-[3px] border-l-[3px] text-left ${size === "chip" ? "min-h-[20px] px-[2px] py-[1px] font-mono text-[11px] leading-[18px] tracking-tight" : size === "compact" ? "px-1 py-[1px] text-[11px] leading-[1.25]" : "px-2 py-1 text-[12px] leading-snug"} ${barCls(e)} ${lifted ? "opacity-40" : ""} ${movable ? "cursor-grab active:cursor-grabbing" : ""}`}>
        {/* a phone's chip has no room for the ⚠ — the flag turns the number red
            instead — and a number too long for it keeps its last digits, the ones
            that tell two POs apart (the cut lands at the front: right-to-left flow) */}
        <span className={`block truncate font-semibold ${size === "chip" ? "text-left [direction:rtl]" : ""} ${size === "chip" && e.flag ? "text-alert" : ""}`}>{e.flag && size !== "chip" ? "⚠ " : ""}{size === "chip" ? e.short || e.title : e.title}</span>
        {size === "bar" && e.subtitle && <span className="block truncate text-[11px] text-inksoft">{e.subtitle}</span>}
        {size === "bar" && e.people && e.people.length > 0 && <span className="block truncate text-[11px] text-inksoft">👷 {e.people.join(", ")}</span>}
      </button>
    );
  };

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
        {/* rows size to their content; a phone's day shows the PO numbers as
            chips and the agenda under the grid does the talking, a desk's the bars */}
        <div className="grid grid-cols-7">
          {cells.map((iso, i) => {
            const inMonth = monthOf(iso) === monthOf(anchor);
            const evs = byDay[iso] || [];
            const isToday = iso === today, isSel = iso === selected;
            const show = evs.slice(0, 3);
            const lastRow = i >= cells.length - 7;
            return (
              <div key={iso} role="button" tabIndex={0} data-day={iso} onClick={() => onSelect(iso)} onKeyDown={(ev) => { if (ev.key === "Enter") onSelect(iso); }}
                aria-label={`${fmt(iso, { weekday: "long", month: "long", day: "numeric" })}${evs.length ? `, ${evs.length} job${evs.length === 1 ? "" : "s"}` : ""}`}
                className={`flex min-h-[52px] flex-col gap-[2px] border-r border-rulesoft p-[2px] md:min-h-[96px] md:p-1 ${lastRow ? "" : "border-b"} ${i % 7 === 6 ? "border-r-0" : ""} ${inMonth ? "bg-white" : "bg-paper/60"} ${isSel ? "outline outline-2 -outline-offset-2 outline-ink" : ""} ${dropCls(iso)}`}>
                <div className="flex items-center justify-between">
                  <span className={`grid h-6 w-6 place-items-center rounded-full font-mono text-[12px] ${isToday ? "bg-work font-bold text-white" : inMonth ? "text-ink" : "text-inksoft"}`}>{Number(iso.slice(-2))}</span>
                  {evs.length > 0 && <span className="hidden font-mono text-[11px] text-inksoft md:inline">{evs.length}</span>}
                </div>
                <div className="flex flex-col gap-[2px] md:hidden">
                  {show.map((e) => bar(e, "chip"))}
                  {evs.length > show.length && <span className="px-[2px] text-[11px] leading-none text-inksoft">+{evs.length - show.length}</span>}
                </div>
                <div className="hidden flex-col gap-[2px] md:flex">
                  {show.map((e) => bar(e, "compact"))}
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
      <div ref={weekScroll} data-week-scroll className="overflow-x-auto rounded-sm border border-rule bg-white">
        <div className="grid min-w-[700px] grid-cols-7">
          {days.map((iso, i) => {
            const evs = byDay[iso] || [];
            const isToday = iso === today, isSel = iso === selected;
            return (
              <div key={iso} data-day={iso} className={`flex min-h-[320px] flex-col border-r border-rulesoft ${i === 6 ? "border-r-0" : ""} ${isSel ? "bg-card" : ""} ${dropCls(iso)}`}>
                <button type="button" onClick={() => onSelect(iso)} className={`border-b border-rule px-2 py-1.5 text-left ${isToday ? "bg-work/10" : "bg-paper"}`}>
                  <div className="font-display text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">{WEEKDAYS[i]}</div>
                  <div className={`font-mono text-[15px] ${isToday ? "font-bold text-work" : ""}`}>{Number(iso.slice(-2))}</div>
                </button>
                <div className="flex flex-col gap-1 p-1.5">
                  {evs.map((e) => bar(e))}
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
            {evs.map((e) => bar(e))}
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
        {onMove && view !== "day" && <span className="inline-flex items-center gap-1">→ drag a PO to another day to move it <span className="md:hidden">(hold it first)</span></span>}
      </div>
      {/* the bar in flight, riding just above the finger or the pointer */}
      {drag && (
        <div className="pointer-events-none fixed z-[60] max-w-[calc(100vw-8px)]" data-drag-ghost
          style={{ top: Math.max(4, drag.y - 52), ...(drag.x > window.innerWidth / 2 ? { right: Math.max(4, window.innerWidth - drag.x - 40) } : { left: Math.max(4, drag.x - 40) }) }} aria-hidden>
          <div className={`whitespace-nowrap rounded-sm border-[1.5px] border-ink bg-white px-2.5 py-1.5 text-[13px] font-semibold shadow-lg ${drag.over && drag.over !== drag.e.day ? "" : "text-inksoft"}`}>
            {drag.e.title} → {drag.over && drag.over !== drag.e.day ? fmt(drag.over, { weekday: "short", month: "short", day: "numeric" }) : "drop it on a day"}
          </div>
        </div>
      )}
    </div>
  );
}
