"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// One dropdown for every cluster of related actions. Opens on tap (never
// hover: phones), closes on a tap outside, Escape, or picking an item.
// Role gating goes through `hidden` per item; if only one item survives, the
// menu collapses to a plain button so nobody ever opens an empty panel.
export type ActionItem = {
  label: string; // the visible words, also what the tests find it by
  glyph?: string; // one leading glyph from the app's small approved set
  onSelect?: () => void;
  href?: string; // renders a real <a>: sms: links and downloads stay anchors
  destructive?: boolean; // red, pushed to the bottom, separated
  disabled?: boolean;
  hidden?: boolean;
  confirm?: string; // window.confirm(text) before onSelect
  title?: string; // a quieter second line under the label (never repeats it; one line, so keep it short)
  data?: Record<string, string>; // data-* attributes on the rendered item (what the tests find it by)
};

// "testPos" -> data-test-pos: the item's own hooks, for the tests and nothing else
const dataAttrs = (it: ActionItem): Record<string, string> =>
  Object.fromEntries(Object.entries(it.data || {}).map(([k, v]) => [`data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/^data-/, "")}`, v]));

// where the trigger sits on the screen, read when the panel opens and again on
// every resize or scroll while it is open (a scroll inside a card or a sheet
// moves the trigger too)
type Box = { top: number; bottom: number; left: number; right: number; vw: number; vh: number };
const boxOf = (el: HTMLElement): Box => {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vw: window.innerWidth, vh: window.innerHeight };
};

export default function ActionMenu({ label, items, variant = "ghost", align = "right", className = "", busy = false }: {
  label: string;
  items: ActionItem[];
  variant?: "ghost" | "primary" | "bare";
  align?: "left" | "right";
  className?: string;
  busy?: boolean; // the trigger shows the kit's spinner over its unchanged label (the width never moves)
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  // opened from the keyboard: the first item takes focus so the arrows work at once
  const byKey = useRef(false);
  // which way the panel hangs: the way asked for, unless that runs it off the
  // screen. A button that wrapped to the left of a phone opens rightward, and
  // one near the bottom of the screen opens upward.
  const [side, setSide] = useState<"left" | "right">(align);
  const [up, setUp] = useState(false);
  // the panel is drawn at the top of the document (a portal) and pinned to the
  // trigger's place on the screen, so a row's menu inside a scrolling card is
  // never cut at the card's edge
  const [box, setBox] = useState<Box | null>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!open) { setBox(null); setSide(align); setUp(false); return; }
    const measure = (e?: Event) => {
      // the panel's own scroll (a long menu) moves nothing on the page
      if (e && menu.current && e.target instanceof Node && menu.current.contains(e.target)) return;
      if (trigger.current) setBox(boxOf(trigger.current));
    };
    measure();
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    return () => { window.removeEventListener("resize", measure); document.removeEventListener("scroll", measure, true); };
  }, [open, align]);
  useLayoutEffect(() => {
    if (!open || !box || !menu.current) return;
    const h = menu.current.offsetHeight, w = menu.current.offsetWidth;
    setUp(box.bottom + 4 + h > box.vh - 4 && box.top - 4 - h > 56);
    if (align === "right") setSide(box.right - w < 4 ? "left" : "right");
    else setSide(box.left + w > box.vw - 4 ? "right" : "left");
  }, [open, align, box]);
  const visible = items.filter((i) => !i.hidden);
  const shown = [...visible.filter((i) => !i.destructive), ...visible.filter((i) => i.destructive)];

  const itemEls = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') || []);
  useEffect(() => {
    if (!open) return;
    if (byKey.current) { byKey.current = false; itemEls()[0]?.focus(); }
    // Escape while focus is elsewhere (the wrap's own handler covers the usual case)
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open]);

  if (visible.length === 0) return null;

  const fire = (it: ActionItem) => {
    if (it.disabled) return;
    setOpen(false);
    trigger.current?.focus();
    if (it.confirm && !window.confirm(it.confirm)) return;
    it.onSelect?.();
  };

  // the keyboard: arrows walk the items, Home/End jump, Escape closes this menu
  // only (marked handled, so a dialog around it stays open), Tab lets go
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); byKey.current = true; setOpen(true); }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus(); return; }
    if (e.key === "Tab") { setOpen(false); return; }
    const els = itemEls();
    if (!els.length) return;
    const at = els.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { e.preventDefault(); els[(i + els.length) % els.length]?.focus(); };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? els.length - 1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(els.length - 1);
  };

  const busyCls = busy ? " btn-busy" : "";
  // a one-item menu is just that item's button
  if (visible.length === 1 && variant !== "bare") {
    const it = visible[0];
    return (
      <button type="button" className={`btn ${variant === "primary" ? "btn-primary" : "btn-ghost"} min-h-[44px]${busyCls} ${className}`}
        disabled={it.disabled} aria-busy={busy || undefined} title={it.title} onClick={() => fire(it)}>
        {it.glyph ? `${it.glyph} ` : ""}{it.label}
      </button>
    );
  }

  // the page-level "⋯" is an icon button (the sign already says "more"; a caret would add nothing)
  const dots = label === "⋯";
  const triggerCls = variant === "bare"
    ? "btn-icon btn-icon-quiet text-lg leading-none"
    : variant === "ghost" && dots
      ? "btn btn-ghost h-11 w-11 min-h-[44px] px-0 text-lg leading-none"
      : `btn ${variant === "primary" ? "btn-primary" : "btn-ghost"} min-h-[44px] inline-flex items-center gap-1.5`;
  // when any item carries a glyph, every label starts in the same column
  const anyGlyph = shown.some((x) => x.glyph);
  const panelStyle: React.CSSProperties = box
    ? { position: "fixed", zIndex: 60, ...(up ? { bottom: box.vh - box.top + 4 } : { top: box.bottom + 4 }), ...(side === "right" ? { right: box.vw - box.right } : { left: box.left }) }
    : { position: "fixed", zIndex: 60, visibility: "hidden" };

  return (
    <div ref={wrap} className={`relative inline-block ${className}`} onKeyDown={onKeyDown}>
      <button ref={trigger} type="button" className={triggerCls + busyCls}
        aria-haspopup="menu" aria-expanded={open} aria-controls={id} aria-busy={busy || undefined}
        onClick={(e) => { byKey.current = !open && e.detail === 0; setOpen(!open); }}>
        {label}
        {variant === "bare" && dots && <span className="sr-only"> more actions</span>}
        {variant !== "bare" && !dots && <span aria-hidden className={`text-[11px] leading-none transition-transform duration-150 ${open ? "rotate-180" : ""}`}>▾</span>}
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <>
          {/* the tap that closes the menu lands here and nowhere else: nothing under it fires, the keyboard stays down */}
          <div aria-hidden className="fixed inset-0 z-[59] cursor-default" onPointerDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div id={id} role="menu" ref={menu} style={panelStyle}
            className={`menu anim-menu ${up ? (side === "right" ? "origin-bottom-right" : "origin-bottom-left") : (side === "right" ? "origin-top-right" : "origin-top-left")}`}>
            {shown.map((it, i) => {
              const cls = `menu-item ${it.destructive ? "menu-item-danger" : ""} ${it.destructive && i > 0 && !shown[i - 1].destructive ? "border-t-[1.5px] border-rule" : ""}`;
              // the hint is a visible second line; hidden from the name (the label stays the name) but still read as the description
              const hintId = it.title ? `${id}-h${i}` : undefined;
              const inner = (
                <>
                  <span className="block">{anyGlyph && <span aria-hidden className="inline-block w-6 shrink-0">{it.glyph || ""}</span>}{it.label}</span>
                  {it.title && <span id={hintId} aria-hidden="true" className="block truncate text-[11px] leading-snug normal-case text-inksoft">{it.title}</span>}
                </>
              );
              const key = `${i}-${it.label}`;
              return it.href && !it.disabled ? (
                <a key={key} role="menuitem" href={it.href} aria-describedby={hintId} className={cls} {...dataAttrs(it)} onClick={() => { setOpen(false); trigger.current?.focus(); }}>{inner}</a>
              ) : (
                <button key={key} role="menuitem" type="button" aria-disabled={it.disabled || undefined} aria-describedby={hintId} className={cls} {...dataAttrs(it)} onClick={() => fire(it)}>{inner}</button>
              );
            })}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

// The single per-row control on list rows: a 44px "⋯" opening that row's menu.
export function RowActions({ items, label = "⋯" }: { items: ActionItem[]; label?: string }) {
  return <ActionMenu label={label} items={items} variant="bare" className="shrink-0" align="right" />;
}
