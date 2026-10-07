"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import CardToolbar from "./CardToolbar";

// Hosts a print preview at the document root. While mounted, body gets the
// `printing` class so @media print can hide the app entirely: the printed
// PDF contains exactly the document, at its natural height, nothing else.
//
// Given `onClose`, the shell also draws the chrome: the dark overlay, the
// white sheet (.printable) and one bar under it with "Print or save as PDF",
// anything passed as `toolbar` (an extra download, as a ghost button) and
// "Close". Escape and a tap on the backdrop close it. Without `onClose` it
// renders only what it is given, as before.
let openCount = 0;
export default function PrintShell({ children, title, onClose, wide = false, toolbar, sheetClass = "" }: {
  children: React.ReactNode;
  title?: string; // the browser names a printed/saved PDF after the page title
  onClose?: () => void;
  wide?: boolean; // a wider sheet (max-w-4xl) for landscape-ish documents
  toolbar?: React.ReactNode; // extra ghost button(s) in the bar, e.g. "⬇ Statement (Excel)"
  sheetClass?: string; // extra classes on the sheet, e.g. the document's text color
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    openCount++;
    document.body.classList.add("printing");
    const prevTitle = document.title;
    if (title) document.title = title;
    return () => {
      openCount--;
      if (openCount <= 0) document.body.classList.remove("printing");
      if (title) document.title = prevTitle;
    };
  }, [title]);
  useEffect(() => {
    if (!onClose) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) onClose(); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  if (!mounted) return null;
  const width = wide ? "max-w-4xl" : "max-w-3xl";
  // the literal `fixed` class stays: the print rules key on it to flatten the overlay
  const body = onClose ? (
    <div className="overlay fixed" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`printable panel mx-auto ${width} rounded-sm bg-white p-8 ${sheetClass}`}>{children}</div>
      <div className={`no-print mx-auto mt-3 ${width}`}>
        <CardToolbar align="end"
          primary={<button type="button" className="btn btn-primary" onClick={() => window.print()}>Print or save as PDF</button>}
          secondary={<>{toolbar}<button type="button" className="btn btn-ghost" onClick={onClose}>Close</button></>} />
      </div>
    </div>
  ) : children;
  return createPortal(<div className="print-portal">{body}</div>, document.body);
}
