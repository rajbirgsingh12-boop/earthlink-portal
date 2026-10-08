"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Contract } from "@/lib/types";

// Friendly label: renamed contracts show their name with the number tucked after it.
export const contractLabel = (c: Contract) =>
  c.name && c.name !== c.number ? `${c.name} · ${c.number}` : `Contract ${c.number}`;

interface Option { id: string; label: string; }
interface Props {
  contracts: Contract[];
  value: string;
  onChange: (id: string) => void;
  extra?: Option[]; // e.g. a "General (no contract)" choice
  placeholder?: string;
}

// where the box sits on the screen: the list hangs from it, as wide as it
type Box = { top: number; bottom: number; left: number; width: number; vh: number };

export default function ContractPicker({ contracts, value, onChange, extra, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const wrap = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  // the list opens downward unless that runs it off the screen (a picker low in
  // a phone sheet), then it opens upward
  const [up, setUp] = useState(false);
  // while the list is open: a tap anywhere outside closes it, and so does
  // Escape (marked handled, so a dialog around the picker stays open)
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!wrap.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); setOpen(false); } };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); };
  }, [open]);
  // the list is drawn at the top of the document (a portal) and pinned to the
  // box's place on the screen, so a sheet's scroller or a card's edge never
  // clips it; re-measured on resize and on any scroll while open
  useLayoutEffect(() => {
    if (!open) { setBox(null); setUp(false); return; }
    const measure = (e?: Event) => {
      if (e && list.current && e.target instanceof Node && list.current.contains(e.target)) return; // the list's own scroll
      const r = trigger.current?.getBoundingClientRect();
      if (r) setBox({ top: r.top, bottom: r.bottom, left: r.left, width: r.width, vh: window.innerHeight });
    };
    measure();
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    return () => { window.removeEventListener("resize", measure); document.removeEventListener("scroll", measure, true); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !box || !list.current) return;
    const h = list.current.offsetHeight;
    setUp(box.bottom + 4 + h > box.vh - 8 && box.top - 4 - h > 60);
  }, [open, box]);
  const all: Option[] = [...contracts.map((c) => ({ id: c.id, label: contractLabel(c) })), ...(extra || [])];
  const sel = all.find((a) => a.id === value);
  const found = q ? all.filter((a) => a.label.toLowerCase().includes(q.toLowerCase())) : all;
  // a pick hands focus back to the box, so a keyboard user keeps their place
  const pick = (id: string) => { onChange(id); setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  const listStyle: React.CSSProperties = box
    ? { position: "fixed", zIndex: 60, left: box.left, right: "auto", width: box.width, margin: 0, ...(up ? { top: "auto", bottom: box.vh - box.top + 4 } : { top: box.bottom + 4 }) }
    : { position: "fixed", zIndex: 60, visibility: "hidden" };
  return (
    <div ref={wrap} className="relative">
      {/* the focus ring is for the keyboard: a tap opens the list without dressing the box as a text field */}
      <button ref={trigger} type="button" className="field flex items-center justify-between gap-2 text-left focus:border-rule focus:ring-0 focus-visible:border-ink focus-visible:ring-2" aria-haspopup="listbox" aria-expanded={open}
        onClick={() => { setOpen(!open); setQ(""); }}>
        <span className="truncate">{sel?.label || placeholder || "Pick a contract…"}</span>
        <span aria-hidden className={`shrink-0 text-xs text-inksoft transition-transform duration-150 ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div role="listbox" ref={list} style={listStyle} className={`popover anim-menu ${up ? "origin-bottom" : "origin-top"}`}>
          {all.length > 5 && (
            <input autoFocus type="search" enterKeyHint="search" autoComplete="off"
              className="min-h-[44px] w-full border-b border-rulesoft bg-white px-3 py-2.5 text-base outline-none"
              placeholder="Search contracts…" value={q} onChange={(e) => setQ(e.target.value)} />
          )}
          <div className="max-h-56 overflow-y-auto">
            {found.map((a) => (
              <button key={a.id || "none"} type="button" role="option" aria-selected={a.id === value}
                className={`row-btn border-b border-rulesoft px-3 py-2.5 text-[15px] last:border-b-0 ${a.id === value ? "font-semibold text-work" : ""}`}
                onClick={() => pick(a.id)}>
                {a.label}
              </button>
            ))}
            {found.length === 0 && <div className="p-2.5 text-sm text-inksoft">Nothing matches “{q}”.</div>}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
