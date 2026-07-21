"use client";
import { useState } from "react";
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
  const all: Option[] = [...contracts.map((c) => ({ id: c.id, label: contractLabel(c) })), ...(extra || [])];
  const sel = all.find((a) => a.id === value);
  const matches = q ? all.filter((a) => a.label.toLowerCase().includes(q.toLowerCase())) : all;
  return (
    <div className="relative">
      {open && <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />}
      <button type="button" className="field flex items-center justify-between gap-2 text-left" onClick={() => { setOpen(!open); setQ(""); }}>
        <span className="truncate">{sel?.label || placeholder || "Pick a contract…"}</span>
        <span className="shrink-0 text-xs text-inksoft">▾</span>
      </button>
      {open && (
        <div className="card absolute inset-x-0 top-full z-20 mt-1 overflow-hidden shadow-lg">
          {all.length > 5 && (
            <input autoFocus className="w-full border-b border-rulesoft bg-white px-3 py-2.5 text-base outline-none"
              placeholder="Search contracts…" value={q} onChange={(e) => setQ(e.target.value)} />
          )}
          <div className="max-h-56 overflow-y-auto">
            {matches.map((a) => (
              <button key={a.id || "none"} type="button"
                className={`block w-full border-b border-rulesoft p-2.5 text-left text-sm last:border-b-0 hover:bg-paper ${a.id === value ? "font-semibold text-work" : ""}`}
                onClick={() => { onChange(a.id); setOpen(false); }}>
                {a.label}
              </button>
            ))}
            {matches.length === 0 && <div className="p-2.5 text-sm text-inksoft">Nothing matches “{q}”.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
