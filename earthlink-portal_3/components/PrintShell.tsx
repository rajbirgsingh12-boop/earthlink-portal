"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

// Hosts a print preview at the document root. While mounted, body gets the
// `printing` class so @media print can hide the app entirely — the printed
// PDF contains exactly the document, at its natural height, nothing else.
let openCount = 0;
export default function PrintShell({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    openCount++;
    document.body.classList.add("printing");
    return () => {
      openCount--;
      if (openCount <= 0) document.body.classList.remove("printing");
    };
  }, []);
  if (!mounted) return null;
  return createPortal(<div className="print-portal">{children}</div>, document.body);
}
