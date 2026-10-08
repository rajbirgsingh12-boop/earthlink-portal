"use client";
// Who am I? Every page needs the signed-in user's name/role. One shared,
// deduped read: the session comes from the cookie (no network, so the page's
// own data requests start the moment hydration ends instead of waiting behind
// an auth round trip), the profile row from the database, protected by RLS.
//
// The last confirmed profile is remembered on this device under the user's id
// and handed back at once on the next open (the nav and the role-gated pages
// paint without waiting), while the database answer arrives in the background
// and corrects it. A stale copy can only be wrong about a role that changed
// since the last visit: pages that show money derive it from `fresh` only (see
// useProfile), so a stale copy can hide dollars, never show them. The
// database enforces every role regardless; the copy only affects what paints.
import { useEffect, useState } from "react";
import { sb } from "./supabase";
import { cacheUser, clearCache } from "./cache";

export interface MyProfile { id: string; name: string; role: string }

const KEY = "elgc-profile:"; // + user id: another sign-in's copy never matches

let current: MyProfile | null = null;   // the best known right now: the remembered copy until the database answers
let fresh: MyProfile | null = null;     // confirmed by the database on this page load
let inflight: Promise<MyProfile | null> | null = null;
let confirming: Promise<MyProfile | null> | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const f of Array.from(listeners)) f(); };

const recall = (uid: string): MyProfile | null => {
  try {
    const p = JSON.parse(localStorage.getItem(KEY + uid) || "null") as MyProfile | null;
    return p && p.id === uid && typeof p.role === "string" && typeof p.name === "string" ? p : null;
  } catch { return null; }
};
const remember = (p: MyProfile) => { try { localStorage.setItem(KEY + p.id, JSON.stringify(p)); } catch { /* private mode */ } };
const forgetProfiles = () => {
  try { for (const k of Object.keys(localStorage)) if (k.startsWith("elgc-profile")) localStorage.removeItem(k); } catch { /* private mode */ }
};

// the database's answer for this user, once per page load (retried on failure)
function confirmRow(uid: string): Promise<MyProfile | null> {
  if (fresh) return Promise.resolve(fresh);
  if (!confirming) {
    confirming = (async () => {
      try {
        const { data } = await sb().from("profiles").select("id,name,role").eq("id", uid).single();
        if (!data) return null;
        fresh = current = { id: data.id, name: data.name ?? "", role: data.role ?? "" };
        remember(fresh);
        notify();
        return fresh;
      } catch {
        return null;
      } finally {
        confirming = null;
      }
    })();
  }
  return confirming;
}

// the profile to paint with: remembered at once when there is a copy for this
// session's user (the database refreshes it in the background), otherwise the
// database's answer; null means truly signed out (callers may go to /login)
export function myProfile(): Promise<MyProfile | null> {
  if (fresh) return Promise.resolve(fresh);
  if (current && current.role) return Promise.resolve(current);
  if (!inflight) {
    inflight = (async () => {
      try {
        const { data: { session } } = await sb().auth.getSession();
        const user = session?.user;
        if (!user) return null;
        // a different person than last time: nothing of theirs may paint
        if (cacheUser(user.id)) forgetProfiles();
        const saved = recall(user.id);
        if (saved) { current = saved; notify(); void confirmRow(user.id); return saved; }
        const row = await confirmRow(user.id);
        if (row) return row;
        // signed in but the profile read failed (bad signal): report a blank
        // role WITHOUT remembering it, so the next call can try again, and never
        // null, which would bounce a signed-in user to the login page
        current = { id: user.id, name: "", role: "" };
        notify();
        return current;
      } catch {
        return { id: "", name: "", role: "" };
      } finally {
        inflight = null;
      }
    })();
  }
  return inflight;
}

// the database's own answer, never the remembered copy: for anything that
// shows money or decides what a role may do; null until confirmed
export async function freshProfile(): Promise<MyProfile | null> {
  const p = await myProfile();
  if (!p) return null;
  return fresh || (await confirmRow(p.id));
}

// `hint` is the best known right now (remembered or confirmed), `fresh` only
// what the database said on this page load. Paint lists from hint || fresh;
// gate dollars and edit rights on fresh alone.
export function useProfile(): { hint: MyProfile | null; fresh: MyProfile | null } {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    listeners.add(f);
    void myProfile().then(f);
    return () => { listeners.delete(f); };
  }, []);
  return { hint: current, fresh };
}

// call on sign-out so the next sign-in can't see the previous user's role, the
// remembered copy, or anything cached for them
export function clearMyProfile() {
  current = null;
  fresh = null;
  forgetProfiles();
  clearCache();
}
