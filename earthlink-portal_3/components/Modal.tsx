"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import CardToolbar from "./CardToolbar";
import type { ActionItem } from "./ActionMenu";

// A working dialog: title row with a 44px ✕, body, optional footer toolbar.
// On a phone it rises from the bottom as a sheet. NOT for print previews:
// those go through PrintShell, which has its own chrome.
// the dialogs open right now, bottom to top
const OPEN: symbol[] = [];

export default function Modal({ title, onClose, footer, children, wide = false, dismissOnBackdrop = true, dirty = false, primary, secondary, menu }: {
  title: string;
  onClose: () => void;
  footer?: React.ReactNode; // a hand-built footer; without one, primary/secondary/menu draw the standard toolbar
  children: React.ReactNode;
  wide?: boolean;
  dismissOnBackdrop?: boolean; // a tap on the dark backdrop closes (the default); off for a dialog mid-work
  dirty?: boolean; // unsaved changes: backdrop, Escape and ✕ ask "Close without saving?" first
  primary?: React.ReactNode;
  secondary?: React.ReactNode;
  menu?: ActionItem[];
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  // where focus was before the dialog opened, read on the first render (an
  // autoFocus field inside takes focus during the commit, before any effect)
  const [before] = useState<HTMLElement | null>(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)));
  const tryClose = useCallback(() => {
    if (dirty && !window.confirm("Close without saving?")) return;
    onClose();
  }, [dirty, onClose]);
  useEffect(() => {
    // an Escape a menu inside has already used (defaultPrevented) is not ours,
    // and with one dialog over another (a photo over the Documents list) only
    // the one on top answers it
    const me = Symbol("modal");
    OPEN.push(me);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented && OPEN[OPEN.length - 1] === me) { e.preventDefault(); tryClose(); } };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); const at = OPEN.indexOf(me); if (at >= 0) OPEN.splice(at, 1); };
  }, [tryClose]);
  useEffect(() => {
    // focus moves in (an autoFocus field if the page gave one, else the first
    // field, else the panel) and goes back where it was on close; the page
    // behind stops scrolling while the dialog is up
    if (!panel.current?.contains(document.activeElement)) {
      const first = body.current?.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea, button")
        || panel.current?.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea, button:not([aria-label='Close'])");
      (first || panel.current)?.focus({ preventScroll: true });
    }
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      before?.focus?.({ preventScroll: true });
    };
  }, []);
  const toolbar = !footer && (primary || secondary || (menu && menu.length > 0));
  return (
    <div className="overlay sheet" onClick={(e) => { if (e.target === e.currentTarget && dismissOnBackdrop) tryClose(); }}>
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className={`panel mx-auto ${wide ? "max-w-3xl" : "max-w-xl"} card border-t-4 border-t-ink bg-white outline-none`}>
        <div className="flex items-center justify-between gap-3 border-b border-rulesoft py-2 pl-4 pr-2">
          <h2 id={titleId} className="font-display text-lg font-bold uppercase tracking-wide">{title}</h2>
          <button type="button" aria-label="Close" className="btn-icon border-0 shadow-none text-lg text-inksoft hover:text-ink" onClick={tryClose}>✕</button>
        </div>
        <div ref={body} className="p-4">{children}</div>
        {footer && <div className="border-t border-rulesoft px-4 py-3">{footer}</div>}
        {toolbar && <div className="border-t border-rulesoft px-4 py-3"><CardToolbar align="end" primary={primary} secondary={secondary} menu={menu} /></div>}
      </div>
    </div>
  );
}
