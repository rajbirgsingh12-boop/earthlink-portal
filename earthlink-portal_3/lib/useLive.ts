"use client";
// Subscribes to database changes and calls back (debounced) — the whole app
// stays current without anyone refreshing.
import { useEffect, useRef } from "react";
import { sb } from "./supabase";

// "typing" means a keystroke happened recently — a phone parked with a field
// focused (very common with an on-screen keyboard) still gets fresh data
let lastTyped = 0;
let typingHooked = false;
const hookTyping = () => {
  if (typingHooked || typeof document === "undefined") return;
  typingHooked = true;
  document.addEventListener("input", () => { lastTyped = Date.now(); }, true);
};

export function useLive(
  tables: string[],
  onChange: () => void,
  opts?: { enabled?: boolean; delay?: number; skipWhileTyping?: boolean }
) {
  const cb = useRef(onChange);
  cb.current = onChange;
  const enabled = opts?.enabled !== false;
  const delay = opts?.delay ?? 400;
  const skipWhileTyping = opts?.skipWhileTyping ?? false;
  const key = tables.join(",");
  useEffect(() => {
    if (!enabled) return;
    hookTyping();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // don't clobber a field someone is mid-keystroke in — the next change
        // event (or their own save) brings the data back in sync. Once typing
        // has paused a few seconds, refresh even with the field still focused.
        if (skipWhileTyping && typeof document !== "undefined") {
          const el = document.activeElement;
          if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && Date.now() - lastTyped < 5000) { fire(); return; }
        }
        cb.current();
      }, delay);
    };
    const chan = sb().channel(`live-${key}`);
    tables.forEach((t) => chan.on("postgres_changes", { event: "*", schema: "public", table: t }, fire));
    chan.subscribe();
    return () => { if (timer) clearTimeout(timer); sb().removeChannel(chan); };
  }, [key, enabled, delay, skipWhileTyping]);
}
