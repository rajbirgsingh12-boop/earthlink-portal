"use client";
import { useState } from "react";

// A full-width tappable section header with a caret, replacing every tiny
// text-scrap toggle. Controlled (open/onToggle) or self-managed (defaultOpen).
// Anything else given (data-* attributes, an id) lands on the header button.
export default function Disclosure({ label, sublabel, count, right, defaultOpen = false, open, onToggle, children, className = "", ...rest }: {
  label: string;
  sublabel?: string;
  count?: number; // shown after the label as " (n)"
  right?: React.ReactNode; // a quiet figure at the far right of the header
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
  className?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onToggle" | "children" | "className" | "type" | "onClick">) {
  const [own, setOwn] = useState(defaultOpen);
  const isOpen = open ?? own;
  const toggle = onToggle ?? (() => setOwn(!own));
  return (
    <div className={className}>
      <button type="button" {...rest} aria-expanded={isOpen} onClick={toggle}
        className="-mx-1 flex min-h-[44px] w-[calc(100%+0.5rem)] items-center gap-2.5 rounded-sm px-1 text-left transition-colors hover:bg-paper active:bg-rulesoft">
        <span aria-hidden className={`text-[11px] text-inksoft transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`}>▸</span>
        <span className="font-display text-[13px] font-semibold uppercase tracking-[.12em]">{label}{count !== undefined ? ` (${count})` : ""}</span>
        {sublabel && <span className="truncate text-[12px] text-inksoft">{sublabel}</span>}
        {right !== undefined && right !== null && <span className="ml-auto shrink-0 font-mono text-xs text-inksoft">{right}</span>}
      </button>
      {isOpen && <div className="anim-open">{children}</div>}
    </div>
  );
}
