"use client";
import { useEffect, useState } from "react";

// What was typed, a beat later. A price book runs to a couple of thousand
// lines; filtering and redrawing them on every letter is what makes a search
// box feel stuck on a phone. The box itself stays instant — only the list
// waits for the typing to pause.
export function useDebounced<T>(value: T, ms = 140): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}
