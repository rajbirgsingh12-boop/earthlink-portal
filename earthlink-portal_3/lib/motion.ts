import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

// Smooth scrolling through one door, so a person who turned motion off on
// their phone gets a plain jump instead of a glide.
export const scrollTo = (el: Element | null, block: ScrollLogicalPosition = "center") =>
  el?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block });

export const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// rows and cards arrive one after another: className="anim-up" style={stagger(i)}.
// Capped at 8 steps so a long list never crawls: row 9 onward lands with row 8.
export const stagger = (i: number): CSSProperties => ({ ["--i" as string]: Math.min(i, 8) });

// the layout effect runs before paint in the browser; on the server it is a plain effect (nothing to measure)
const useIso = typeof window === "undefined" ? useEffect : useLayoutEffect;

// where the lit tab is: one offsetLeft/offsetWidth read whenever `deps` change (the route, the profile), when
// the strip resizes (a rotation) and once the fonts land; the .tab-ind span glides there by transform.
// The tabs carry data-tab and the lit one keeps text-work.
export function useTabIndicator(strip: RefObject<HTMLElement>, deps: unknown[]) {
  const [ind, setInd] = useState({ x: 0, w: 0, on: false });
  const measure = useCallback(() => {
    const el = strip.current?.querySelector<HTMLElement>("[data-tab].text-work");
    setInd((was) => {
      const next = el ? { x: el.offsetLeft, w: el.offsetWidth, on: true } : { x: 0, w: 0, on: false };
      return was.x === next.x && was.w === next.w && was.on === next.on ? was : next;
    });
  }, [strip]);
  useIso(measure, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const node = strip.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, [strip, measure]);
  useEffect(() => { document.fonts?.ready.then(measure); }, [measure]);
  return ind;
}
