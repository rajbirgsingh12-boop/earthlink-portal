"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

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
  title?: string; // a quieter second line under the label (never repeats it)
  data?: Record<string, string>; // data-* attributes on the rendered item (what the tests find it by)
};

// "testPos" -> data-test-pos: the item's own hooks, for the tests and nothing else
const dataAttrs = (it: ActionItem): Record<string, string> =>
  Object.fromEntries(Object.entries(it.data || {}).map(([k, v]) => [`data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/^data-/, "")}`, v]));

export default function ActionMenu({ label, items, variant = "ghost", align = "right", className = "" }: {
  label: string;
  items: ActionItem[];
  variant?: "ghost" | "primary" | "bare";
  align?: "left" | "right";
  className?: string;
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
  const id = useId();
  useLayoutEffect(() => {
    if (!open) { setSide(align); setUp(false); return; }
    const r = menu.current?.getBoundingClientRect();
    if (!r) return;
    if (align === "right" && r.left < 4) setSide("left");
    else if (align === "left" && r.right > window.innerWidth - 4) setSide("right");
    if (r.bottom > window.innerHeight - 4 && r.top - r.height > 56) setUp(true);
  }, [open, align]);
  const visible = items.filter((i) => !i.hidden);
  const shown = [...visible.filter((i) => !i.destructive), ...visible.filter((i) => i.destructive)];

  const itemEls = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') || []);
  useEffect(() => {
    if (!open) return;
    if (byKey.current) { byKey.current = false; itemEls()[0]?.focus(); }
    const away = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    // Escape while focus is elsewhere (the wrap's own handler covers the usual case)
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); };
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

  // a one-item menu is just that item's button
  if (visible.length === 1 && variant !== "bare") {
    const it = visible[0];
    return (
      <button type="button" className={`btn ${variant === "primary" ? "btn-primary" : "btn-ghost"} min-h-[44px] ${className}`}
        disabled={it.disabled} title={it.title} onClick={() => fire(it)}>
        {it.glyph ? `${it.glyph} ` : ""}{it.label}
      </button>
    );
  }

  const triggerCls = variant === "bare"
    ? "btn-icon border-0 bg-transparent shadow-none text-lg leading-none text-inksoft hover:text-ink"
    : `btn ${variant === "primary" ? "btn-primary" : "btn-ghost"} min-h-[44px] inline-flex items-center gap-1.5`;
  // when any item carries a glyph, every label starts in the same column
  const anyGlyph = shown.some((x) => x.glyph);

  return (
    <div ref={wrap} className={`relative inline-block ${className}`} onKeyDown={onKeyDown}>
      <button ref={trigger} type="button" className={triggerCls}
        aria-haspopup="menu" aria-expanded={open} aria-controls={id}
        onClick={(e) => { byKey.current = !open && e.detail === 0; setOpen(!open); }}>
        {label}
        {variant === "bare" && label === "⋯" && <span className="sr-only"> more actions</span>}
        {variant !== "bare" && <span aria-hidden className={`text-[11px] leading-none transition-transform duration-150 ${open ? "rotate-180" : ""}`}>▾</span>}
      </button>
      {open && (
        <div id={id} role="menu" ref={menu}
          className={`menu anim-menu absolute z-40 ${up ? "bottom-full mb-1" : "top-full mt-1"} ${side === "right" ? "right-0 origin-top-right" : "left-0 origin-top-left"}`}>
          {shown.map((it, i) => {
            const cls = `menu-item ${it.destructive ? "menu-item-danger" : ""} ${it.disabled ? "cursor-not-allowed opacity-50" : ""} ${it.destructive && i > 0 && !shown[i - 1].destructive ? "border-t-[1.5px] border-rule" : ""}`;
            // the hint is a visible second line; hidden from the name (the label stays the name) but still read as the description
            const hintId = it.title ? `${id}-h${i}` : undefined;
            const inner = (
              <>
                <span className="block">{anyGlyph && <span aria-hidden className="inline-block w-6 shrink-0">{it.glyph || ""}</span>}{it.label}</span>
                {it.title && <span id={hintId} aria-hidden="true" className="block text-[11px] leading-snug normal-case text-inksoft">{it.title}</span>}
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
      )}
    </div>
  );
}

// The single per-row control on list rows: a 44px "⋯" opening that row's menu.
export function RowActions({ items, label = "⋯" }: { items: ActionItem[]; label?: string }) {
  return <ActionMenu label={label} items={items} variant="bare" className="shrink-0" align="right" />;
}
