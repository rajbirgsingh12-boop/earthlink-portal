"use client";
// Subscribes to database changes and calls back (debounced) — the whole app
// stays current without anyone refreshing.
import { useEffect, useRef } from "react";
import { sb } from "./supabase";

// "typing" means a keystroke happened within the last minute — a phone parked
// with a field focused still gets fresh data eventually, but a mid-thought
// pause can never let a refresh wipe a half-typed box
let lastTyped = 0;
let typingHooked = false;
const hookTyping = () => {
  if (typingHooked || typeof document === "undefined") return;
  typingHooked = true;
  document.addEventListener("input", () => { lastTyped = Date.now(); }, true);
};

export function useLive(
  tables: string[],
  // the callback learns WHICH tables changed, so pages can refetch just those
  // (existing callers that ignore the argument keep working unchanged)
  onChange: (changed?: string[]) => void,
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
    const pending = new Set<string>();
    const fire = (table?: string) => {
      if (table) pending.add(table);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // don't clobber a field someone is mid-keystroke in — the next change
        // event (or their own save) brings the data back in sync. Once typing
        // has paused a few seconds, refresh even with the field still focused.
        if (skipWhileTyping && typeof document !== "undefined") {
          const el = document.activeElement;
          if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && Date.now() - lastTyped < 60000) { fire(); return; }
        }
        const changed = [...pending];
        pending.clear();
        cb.current(changed.length > 0 ? changed : undefined);
      }, delay);
    };
    const chan = sb().channel(`live-${key}`);
    tables.forEach((t) => chan.on("postgres_changes", { event: "*", schema: "public", table: t }, () => fire(t)));
    chan.subscribe();
    return () => { if (timer) clearTimeout(timer); sb().removeChannel(chan); };
  }, [key, enabled, delay, skipWhileTyping]);
}
