"use client";
// What a page showed last time, kept on the phone so the next open paints it at
// once and the fresh answer replaces it one round trip later (stale while
// revalidate). The owner reopens the same Home, calendar and Billing list many
// times a day; yesterday's answer is right nearly every time and the refresh
// corrects the rest.
//
// How a page uses it, in four steps (no hook needed):
//   1. paint cached:  const c = cached<Row[]>("pact:jobs"); if (c) setRows(c);
//                     (the user must be named first: call it after myProfile()
//                     has resolved, or let useCached below wait for that)
//   2. fetch:         const rows = await load();
//   3. remember:      remember("pact:jobs", rows);
//   4. re-render:     setRows(rows);
// A write the page makes itself: forget("pact:jobs") right before the save and
// reload right after (the optimistic setState stays as it is). A useLive event
// already calls load(), whose fresh answer overwrites the entry. The skeleton
// shows only while the state is still null.
//
// Nothing is served until cacheUser(uid) has named the signed-in user
// (myProfile() calls it the moment it has read the session), every key carries
// the user id, and a different sign-in clears everything: one person's rows
// never paint for another. Never cache signed URLs (they expire) and never the
// admin page.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const VERSION = 1;            // bump when the shape of anything cached changes
const PREFIX = "elgc-cache:";
const USER_KEY = "elgc-cache-user";
const MAX_CHARS = 1_000_000;  // an entry bigger than this is not worth the storage
const DAY = 24 * 3600_000;    // an entry older than this is painted, then refreshed at once

let uid = "";
const waiting = new Set<() => void>(); // who wants to know when the user is named

const store = (): Storage | null => { try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; } };
const keyOf = (name: string) => `${PREFIX}${VERSION}:${uid}:${name}`;
const keysOf = (ls: Storage) => { const out: string[] = []; for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k) out.push(k); } return out; };

// forget everything cached, for every user (sign-out, or a different sign-in)
export function clearCache() {
  const ls = store();
  if (!ls) return;
  try { for (const k of keysOf(ls)) if (k.startsWith(PREFIX)) ls.removeItem(k); ls.removeItem(USER_KEY); } catch { /* storage off: nothing to clear */ }
  uid = "";
}

// name the signed-in user: from here on reads and writes are theirs. Returns
// true when this is a different person than last time (everything was cleared).
export function cacheUser(id: string): boolean {
  const ls = store();
  let last = "";
  try { last = ls?.getItem(USER_KEY) || ""; } catch { /* storage off */ }
  const changed = !!last && last !== id;
  if (changed) clearCache();
  uid = id;
  try { ls?.setItem(USER_KEY, id); } catch { /* storage off or full: the cache simply stays empty */ }
  for (const f of Array.from(waiting)) f();
  waiting.clear();
  return changed;
}

// run f as soon as the user is named (at once if they already are); returns an unsubscribe
export function onCacheUser(f: () => void): () => void {
  if (uid) { f(); return () => {}; }
  waiting.add(f);
  return () => { waiting.delete(f); };
}

type Entry<T> = { v: number; u: string; t: number; d: T };
const read = <T,>(name: string): Entry<T> | null => {
  if (!uid) return null;
  const ls = store();
  if (!ls) return null;
  try {
    const raw = ls.getItem(keyOf(name));
    if (!raw) return null;
    const e = JSON.parse(raw) as Entry<T>;
    return e && e.v === VERSION && e.u === uid ? e : null;
  } catch { return null; }
};

// what was remembered under this name for this user, or null
export function cached<T>(name: string): T | null {
  const e = read<T>(name);
  return e ? e.d : null;
}
// when it was remembered (ms since the epoch), or 0
export function cachedAt(name: string): number {
  const e = read<unknown>(name);
  return e ? e.t : 0;
}
// keep this for the next open (quietly skipped when storage is off, full, or the value is huge)
export function remember(name: string, value: unknown) {
  if (!uid) return;
  const ls = store();
  if (!ls) return;
  try {
    const s = JSON.stringify({ v: VERSION, u: uid, t: Date.now(), d: value } as Entry<unknown>);
    if (s.length > MAX_CHARS) return;
    ls.setItem(keyOf(name), s);
  } catch { /* quota or private mode: the next open simply fetches */ }
}
// drop this user's entries whose name starts with prefix ("pact:" drops every PACT entry)
export function forget(prefix: string) {
  if (!uid) return;
  const ls = store();
  if (!ls) return;
  try { const head = keyOf(prefix); for (const k of keysOf(ls)) if (k.startsWith(head)) ls.removeItem(k); } catch { /* storage off */ }
}

// one page's data: the remembered rows first (as soon as the user is named,
// before the first paint when they already are), then the fetch, remembered
// for next time. `reload` is what useLive callbacks and post-write code call.
// `fresh` says whether what is showing came from the database on this visit.
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;
export function useCached<T>(name: string, fetcher: () => Promise<T | null | undefined>, deps: unknown[] = []): { data: T | null; fresh: boolean; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [fresh, setFresh] = useState(false);
  const at = useRef(0);        // when the last fresh answer landed
  const alive = useRef(true);
  const reload = useCallback(async () => {
    try {
      const v = await fetcher();
      if (!alive.current || v == null) return;
      at.current = Date.now();
      remember(name, v);
      setData(v);
      setFresh(true);
    } catch { /* the page keeps what it has; the next reload tries again */ }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useBeforePaint(() => {
    alive.current = true;
    setFresh(false);
    const paint = () => { const c = cached<T>(name); if (c != null) setData((d) => (d == null ? c : d)); };
    const off = onCacheUser(paint);
    void reload();
    return () => { alive.current = false; off(); };
  }, [name, reload]);
  useEffect(() => {
    // a tab that slept for a day shows what it has and refreshes at once
    const f = () => { if (document.visibilityState === "visible" && at.current && Date.now() - at.current > DAY) void reload(); };
    document.addEventListener("visibilitychange", f);
    return () => document.removeEventListener("visibilitychange", f);
  }, [reload]);
  return { data, fresh, reload };
}
