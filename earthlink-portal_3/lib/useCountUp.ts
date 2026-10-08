"use client";
import { useEffect, useRef, useState } from "react";

// a figure that counts to its target: from 0 on mount, from whatever is showing
// when the target changes (a live refresh glides, it never restarts at $0).
// Ease-out cubic, whole numbers, lands exactly. A person who turned motion off,
// or a tab that is hidden, gets the target at once.
export function useCountUp(target: number, ms = 600): number {
  const [v, setV] = useState(0);
  const shown = useRef(0);
  const raf = useRef(0);
  useEffect(() => {
    const t = Math.round(target);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || document.hidden || shown.current === t) {
      shown.current = t;
      setV(t);
      return;
    }
    const from = shown.current, t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms), e = 1 - (1 - p) ** 3;
      shown.current = Math.round(from + (t - from) * e);
      setV(shown.current);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, ms]);
  return v;
}
