// Tap-to-text helpers: build a prefilled SMS to a worker's saved number.
// No texting service or fees — the link opens the phone's own Messages app
// with everything typed, so sending is one tap.

// Accepts anything the user types ("(917) 555-0123", "917.555.0123") and
// returns a dialable +1XXXXXXXXXX, or "" when there aren't enough digits.
export const cleanPhone = (s: string): string => {
  const d = (s || "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d.length > 11 ? `+${d}` : "";
};

// "?&body=" instead of "?body=" — the odd form is the one both iPhones and
// Android phones accept for a prefilled message.
export const smsHref = (phone: string, body: string): string =>
  `sms:${cleanPhone(phone)}?&body=${encodeURIComponent(body)}`;

export const prettyPhone = (s: string): string => {
  const p = cleanPhone(s);
  const m = p.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p || s;
};

// The company "text machine" (Twilio behind /api/text). Returns configured=false
// with status 501 when the keys aren't in Vercel yet — callers fall back to sms: links.
export async function sendServerTexts(
  messages: { to: string; body: string; id?: string }[],
  token: string | null,
  opts?: { skipTexted?: boolean }
): Promise<{ ok: boolean; status: number; configured?: boolean; sent?: number; skipped?: number; failed?: { to: string; error: string }[]; error?: string }> {
  try {
    const res = await fetch("/api/text", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ messages, skipTexted: opts?.skipTexted }),
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, ...j };
  } catch {
    return { ok: false, status: 0, error: "network error" };
  }
}

export async function textMachineReady(): Promise<boolean> {
  try {
    const res = await fetch("/api/text");
    const j = (await res.json()) as { configured?: boolean };
    return !!j.configured;
  } catch { return false; }
}

// ---- the one way a crew gets texted ----
// Rows already stamped TEXTED are skipped by the server; rows that go out are
// stamped by the server the moment Twilio takes them, so a dead spot mid-send
// never leads to a double text. With no company number the phone's own group
// text opens instead — and the stamp waits for the person to confirm it sent.
import { sb } from "./supabase";
export interface TextTarget { rowId: string; to: string; body: string; first: string }
export type TextOutcome =
  | { status: "sent"; sent: number; skipped: number; failed: { to: string; error: string }[]; message: string }
  | { status: "fallback"; message: string; rowIds: string[] }
  | { status: "error"; message: string };
export async function textRows(targets: TextTarget[], opts: { skipTexted?: boolean } = {}): Promise<TextOutcome> {
  const good = targets.filter((t) => cleanPhone(t.to));
  if (good.length === 0) return { status: "error", message: "No saved numbers on this crew — add them in Payroll → Crew first" };
  const token = (await sb().auth.getSession()).data.session?.access_token || null;
  const res = await sendServerTexts(good.map((t) => ({ to: cleanPhone(t.to), body: t.body, id: t.rowId })), token, { skipTexted: opts.skipTexted ?? true });
  if (res.ok) {
    const fails = res.failed || [];
    const sent = res.sent || 0, skipped = res.skipped || 0;
    const message = fails.length > 0
      ? `Sent ${sent}, but ${fails.length} didn't go through — check those numbers in Payroll → Crew`
      // never a ✓ when nothing went out — that is how a crew ends up never told
      : sent === 0 ? "Everyone here was already texted — nothing new went out"
      : `Sent ${sent} text${sent === 1 ? "" : "s"} from the company number ✓${skipped ? ` (${skipped} already texted — skipped)` : ""}`;
    return { status: "sent", sent, skipped, failed: fails, message };
  }
  if (res.status === 501) {
    // group text from this phone; the caller confirms before anything is stamped
    window.location.href = `sms:${good.map((t) => cleanPhone(t.to)).join(",")}?&body=${encodeURIComponent(good[0].body.replace(`${good[0].first}, `, ""))}`;
    return { status: "fallback", message: "Company number isn't set up — a group text opened on this phone", rowIds: good.map((t) => t.rowId) };
  }
  return { status: "error", message: res.error || "Couldn't send — try again" };
}
export async function stampRows(ids: string[], texted = true): Promise<void> {
  if (ids.length) await sb().from("schedule_days").update({ texted }).in("id", ids);
}
