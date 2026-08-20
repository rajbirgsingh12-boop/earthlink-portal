"use client";
import { useState } from "react";

// A full-width tappable section header with a caret — replaces every tiny
// text-scrap toggle. Controlled (open/onToggle) or self-managed (defaultOpen).
export default function Disclosure({ label, sublabel, defaultOpen = false, open, onToggle, children, className = "" }: {
  label: string;
  sublabel?: string;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const [own, setOwn] = useState(defaultOpen);
  const isOpen = open ?? own;
  const toggle = onToggle ?? (() => setOwn(!own));
  return (
    <div className={className}>
      <button type="button" aria-expanded={isOpen} onClick={toggle}
        className="flex min-h-[44px] w-full items-center gap-2.5 text-left">
        <span className={`text-[11px] text-inksoft transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`}>▸</span>
        <span className="font-display text-[13px] font-semibold uppercase tracking-[.12em]">{label}</span>
        {sublabel && <span className="truncate text-[12px] text-inksoft">{sublabel}</span>}
      </button>
      {isOpen && children}
    </div>
  );
}
