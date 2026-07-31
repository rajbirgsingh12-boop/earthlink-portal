"use client";
// Who am I? Every page needs the signed-in user's name/role, and each one was
// making the same two network calls on every visit. One shared, deduped fetch:
// the first page pays for it, every later page (and every later visit in the
// same session) gets it instantly. Role changes are rare and the database
// enforces them regardless — the cache only affects what the UI shows.
import { sb } from "./supabase";

export interface MyProfile { id: string; name: string; role: string }

let cached: MyProfile | null = null;
let inflight: Promise<MyProfile | null> | null = null;

export function myProfile(): Promise<MyProfile | null> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = (async () => {
      try {
        const { data: { user } } = await sb().auth.getUser();
        if (!user) return null; // truly signed out — callers may redirect to login
        const { data } = await sb().from("profiles").select("id,name,role").eq("id", user.id).single();
        if (data) { cached = data as MyProfile; return cached; }
        // signed in but the profile read failed (bad signal): report a blank
        // role WITHOUT caching it, so the next call can try again — and never
        // null, which would bounce a signed-in user to the login page
        return { id: user.id, name: "", role: "" };
      } catch {
        return { id: "", name: "", role: "" };
      } finally {
        inflight = null;
      }
    })();
  }
  return inflight;
}

// call on sign-out so the next sign-in can't see the previous user's role
export function clearMyProfile() { cached = null; }
