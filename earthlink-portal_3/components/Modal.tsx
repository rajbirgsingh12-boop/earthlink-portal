"use client";
import { useEffect } from "react";

// A working dialog: title row with a 44px ✕, body, optional footer toolbar.
// NOT for print previews — those keep their PrintShell/.printable structure.
export default function Modal({ title, onClose, footer, children, wide = false }: {
  title: string;
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-ink/50 px-2 py-5" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`mx-auto ${wide ? "max-w-3xl" : "max-w-xl"} card border-t-4 border-t-ink bg-white`}>
        <div className="flex items-center justify-between gap-3 border-b border-rulesoft py-2 pl-4 pr-2">
          <div className="font-display text-lg font-bold uppercase tracking-wide">{title}</div>
          <button type="button" aria-label="Close" className="btn-icon border-0 shadow-none text-lg text-inksoft hover:text-ink" onClick={onClose}>✕</button>
        </div>
        <div className="p-4">{children}</div>
        {footer && <div className="border-t border-rulesoft px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}
