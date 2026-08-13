"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

// Hosts a print preview at the document root. While mounted, body gets the
// `printing` class so @media print can hide the app entirely — the printed
// PDF contains exactly the document, at its natural height, nothing else.
let openCount = 0;
export default function PrintShell({ children, title }: { children: React.ReactNode; title?: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    openCount++;
    document.body.classList.add("printing");
    // the browser names a printed/saved PDF after the page title
    const prevTitle = document.title;
    if (title) document.title = title;
    return () => {
      openCount--;
      if (openCount <= 0) document.body.classList.remove("printing");
      if (title) document.title = prevTitle;
    };
  }, [title]);
  if (!mounted) return null;
  return createPortal(<div className="print-portal">{children}</div>, document.body);
}
