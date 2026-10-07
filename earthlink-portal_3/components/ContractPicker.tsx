"use client";
import { useEffect, useRef, useState } from "react";
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

export default function ContractPicker({ contracts, value, onChange, extra, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const wrap = useRef<HTMLDivElement | null>(null);
  // while the list is open: a tap anywhere outside closes it, and so does
  // Escape (marked handled, so a dialog around the picker stays open)
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); setOpen(false); } };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); };
  }, [open]);
  const all: Option[] = [...contracts.map((c) => ({ id: c.id, label: contractLabel(c) })), ...(extra || [])];
  const sel = all.find((a) => a.id === value);
  const found = q ? all.filter((a) => a.label.toLowerCase().includes(q.toLowerCase())) : all;
  return (
    <div ref={wrap} className="relative">
      <button type="button" className="field flex items-center justify-between gap-2 text-left" aria-haspopup="listbox" aria-expanded={open}
        onClick={() => { setOpen(!open); setQ(""); }}>
        <span className="truncate">{sel?.label || placeholder || "Pick a contract…"}</span>
        <span aria-hidden className={`shrink-0 text-xs text-inksoft transition-transform duration-150 ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {open && (
        <div role="listbox" className="popover">
          {all.length > 5 && (
            <input autoFocus type="search" enterKeyHint="search" autoComplete="off"
              className="min-h-[44px] w-full border-b border-rulesoft bg-white px-3 py-2.5 text-base outline-none"
              placeholder="Search contracts…" value={q} onChange={(e) => setQ(e.target.value)} />
          )}
          <div className="max-h-56 overflow-y-auto">
            {found.map((a) => (
              <button key={a.id || "none"} type="button" role="option" aria-selected={a.id === value}
                className={`row-btn border-b border-rulesoft px-3 py-2.5 text-[15px] last:border-b-0 ${a.id === value ? "font-semibold text-work" : ""}`}
                onClick={() => { onChange(a.id); setOpen(false); }}>
                {a.label}
              </button>
            ))}
            {found.length === 0 && <div className="p-2.5 text-sm text-inksoft">Nothing matches “{q}”.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
