"use client";
import { useEffect, useId, useRef, useState } from "react";

// One dropdown for every cluster of related actions. Opens on tap (never
// hover — phones), closes on a tap outside, Escape, or picking an item.
// Role gating goes through `hidden` per item; if only one item survives, the
// menu collapses to a plain button so nobody ever opens an empty panel.
export type ActionItem = {
  label: string; // the visible words — also what the tests find it by
  glyph?: string; // one leading glyph from the app's small approved set
  onSelect?: () => void;
  href?: string; // renders a real <a> — sms: links and downloads stay anchors
  destructive?: boolean; // red, pushed to the bottom, separated
  disabled?: boolean;
  hidden?: boolean;
  confirm?: string; // window.confirm(text) before onSelect
  title?: string; // hover/long-press hint
};

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
  const id = useId();
  const visible = items.filter((i) => !i.hidden);
  const shown = [...visible.filter((i) => !i.destructive), ...visible.filter((i) => i.destructive)];

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); };
  }, [open]);

  if (visible.length === 0) return null;

  const fire = (it: ActionItem) => {
    if (it.disabled) return;
    setOpen(false);
    if (it.confirm && !window.confirm(it.confirm)) return;
    it.onSelect?.();
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

  return (
    <div ref={wrap} className={`relative inline-block ${className}`}>
      <button ref={trigger} type="button" className={triggerCls}
        aria-haspopup="menu" aria-expanded={open} aria-controls={id}
        onClick={() => setOpen(!open)}>
        {label}
        {variant !== "bare" && <span className={`text-[10px] transition-transform duration-150 ${open ? "rotate-180" : ""}`}>▾</span>}
      </button>
      {open && (
        <div id={id} role="menu"
          className={`menu absolute top-full z-40 mt-1 ${align === "right" ? "right-0" : "left-0"}`}>
          {shown.map((it, i) => {
            const cls = `menu-item ${it.destructive ? "menu-item-danger" : ""} ${it.disabled ? "cursor-not-allowed opacity-50" : ""} ${it.destructive && i > 0 && !shown[i - 1].destructive ? "border-t-[1.5px] border-rule" : ""}`;
            const inner = <>{it.glyph ? <span className="mr-2">{it.glyph}</span> : null}{it.label}</>;
            return it.href && !it.disabled ? (
              <a key={it.label} role="menuitem" href={it.href} title={it.title} className={cls} onClick={() => setOpen(false)}>{inner}</a>
            ) : (
              <button key={it.label} role="menuitem" type="button" title={it.title} className={cls} onClick={() => fire(it)}>{inner}</button>
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
