// Server-only: a crew's group thread — the owner, the workers on a job and
// the company number in one text thread on everyone's phone (Twilio
// Conversations, "group texting"). The portal sits in it as the company
// number (a projected address): it posts the crew text and its answers
// there, and hears every message in it through app/api/chat-in. One thread
// per set of people: two jobs with the same crew share it, as the phones
// themselves would. Twilio's rules: +1 local (10-digit) numbers only — no
// toll-free — and ten people at most. Where a thread can't be made, the
// callers text one to one, with a copy to the owner (lib/twilio copyTo).
import { copyTo, twilioConfigured } from "./twilio";

const env = (k: string) => process.env[k] || "";
export const PORTAL_IDENTITY = "portal";
const convBase = () => (env("TWILIO_CONV_BASE") || "https://conversations.twilio.com").replace(/\/+$/, "");
const TOLL_FREE = /^\+1(800|833|844|855|866|877|888)\d{7}$/;

// why group threads can't be used, or "" when they can
export function groupProblem(): string {
  if (!copyTo()) return "TEXT_COPY_TO (your own cell) isn't set";
  if (!twilioConfigured()) return "the company number isn't set up";
  const from = env("TWILIO_FROM").trim();
  if (!from) return "TWILIO_FROM (the company number itself) is needed for a group thread, even with a Messaging Service";
  if (TOLL_FREE.test(from)) return "a group thread needs a local (10-digit) company number — Twilio can't group-text from a toll-free number";
  return "";
}
export const groupsOn = (): boolean => !groupProblem();

interface Api { ok: boolean; status: number; json: Record<string, unknown> }
async function api(method: "GET" | "POST" | "DELETE", path: string, form?: Record<string, string | string[]>): Promise<Api> {
  const basic = `Basic ${Buffer.from(`${env("TWILIO_ACCOUNT_SID")}:${env("TWILIO_AUTH_TOKEN")}`).toString("base64")}`;
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form || {})) (Array.isArray(v) ? v : [v]).forEach((x) => body.append(k, x));
  try {
    const r = await fetch(`${convBase()}${path}`, {
      method, headers: { Authorization: basic, ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      body: form ? body.toString() : undefined, cache: "no-store", signal: AbortSignal.timeout(8_000),
    });
    const json = ((await r.json().catch(() => ({}))) || {}) as Record<string, unknown>;
    return { ok: r.ok, status: r.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: { message: e instanceof Error ? e.message : "network error" } };
  }
}
// Twilio's own words for what went wrong, with its code — what Settings shows
const twilioWords = (r: Api) => `${(r.json.message as string) || `Twilio error ${r.status}`}${r.json.code ? ` (Twilio ${r.json.code})` : ""}`;

export interface Group { sid: string; key: string; members: string[] }
// the thread's name is its people, so the same crew always lands in the same one
export const groupKey = (members: string[]): string => `crew:${[...new Set(members)].sort().join(",")}`;
const known = new Map<string, Group>();
// the last reason a thread couldn't be made, for Settings
let lastError = "";
export const groupLastError = () => lastError;

// The thread for these people — the owner is always one of them — made when
// there isn't one yet. Phones as +1 and ten digits.
export async function groupFor(phones: string[]): Promise<{ group: Group } | { error: string }> {
  const problem = groupProblem();
  if (problem) return { error: problem };
  const members = [...new Set([copyTo(), ...phones.filter(Boolean)])];
  if (members.length < 2) return { error: "nobody to text" };
  if (members.length > 9) return { error: "more than nine people on one job — Twilio allows ten in a thread, counting the company number" };
  const key = groupKey(members);
  const had = known.get(key);
  if (had) return { group: had };
  let r = await api("GET", `/v1/Conversations/${encodeURIComponent(key)}`);
  let sid = r.ok ? String(r.json.sid || "") : "";
  if (!sid) {
    const form: Record<string, string> = { UniqueName: key, FriendlyName: "Earth Link crew", Attributes: JSON.stringify({ members }) };
    const msvc = env("TWILIO_MESSAGING_SERVICE_SID").trim();
    if (msvc) form.MessagingServiceSid = msvc;
    r = await api("POST", "/v1/Conversations", form);
    if (!r.ok && r.status === 409) r = await api("GET", `/v1/Conversations/${encodeURIComponent(key)}`); // made a moment ago by another send
    if (!r.ok) { lastError = twilioWords(r); return { error: lastError }; }
    sid = String(r.json.sid || "");
    if (!sid) { lastError = "Twilio gave the thread no id"; return { error: lastError }; }
    // the people, then the company number as the portal's face in the thread.
    // A thread that can't take everyone is thrown away, so nobody is texted
    // into a thread missing half the crew.
    const adds: Record<string, string>[] = [
      ...members.map((phone) => ({ "MessagingBinding.Address": phone })),
      { Identity: PORTAL_IDENTITY, "MessagingBinding.ProjectedAddress": env("TWILIO_FROM").trim() },
    ];
    for (const add of adds) {
      const p = await api("POST", `/v1/Conversations/${sid}/Participants`, add);
      if (!p.ok && p.status !== 409) {
        await api("DELETE", `/v1/Conversations/${sid}`);
        lastError = twilioWords(p);
        return { error: lastError };
      }
    }
  }
  const group = { sid, key, members };
  known.set(key, group);
  lastError = "";
  return { group };
}

// a thread that is gone on Twilio's side (deleted in the console, say) is forgotten, so the next send remakes it
export const forgetGroup = (key: string) => { known.delete(key); };
// a message into the thread, from the company number
export async function postToGroup(sid: string, body: string): Promise<boolean> {
  const r = await api("POST", `/v1/Conversations/${sid}/Messages`, { Author: PORTAL_IDENTITY, Body: body });
  if (!r.ok) lastError = twilioWords(r);
  return r.ok;
}
// the people in a thread a message came in on
export async function groupMembers(sid: string): Promise<string[]> {
  const r = await api("GET", `/v1/Conversations/${encodeURIComponent(sid)}`);
  if (!r.ok) return [];
  try {
    const a = JSON.parse(String(r.json.attributes || "{}")) as { members?: unknown };
    return Array.isArray(a.members) ? a.members.map(String) : [];
  } catch { return []; }
}
// where a thread's media is fetched from (lib/twilio fetchMediaFrom(groupMediaBase()))
export const groupMediaUrl = (base: string, chatServiceSid: string, mediaSid: string) => `${base}/v1/Services/${chatServiceSid}/Media/${mediaSid}/Content`;

// Twilio is told, once per server, where to send what the threads hear: the
// default Conversation Service's post-event webhook. Set the first time a
// thread is used, from the portal's own address — no console step.
let webhookAt = "";
export async function ensureGroupWebhook(origin: string): Promise<boolean> {
  if (!origin) return false;
  if (webhookAt === origin) return true;
  const r = await api("POST", "/v1/Configuration/Webhooks", { Method: "POST", PostWebhookUrl: `${origin}/api/chat-in`, Filters: ["onMessageAdded"] });
  if (r.ok) webhookAt = origin; else lastError = twilioWords(r);
  return r.ok;
}
// the portal's public address, for the webhook: what the office's browser or
// Twilio itself reached it by (TWILIO_WEBHOOK_URL when a custom domain sits in front)
export function publicOrigin(req: Request): string {
  const set = env("TWILIO_WEBHOOK_URL").trim();
  if (set) { try { return new URL(set).origin; } catch { /* a bad value: fall through */ } }
  const u = new URL(req.url);
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || u.host).split(",")[0].trim();
  const proto = (req.headers.get("x-forwarded-proto") || u.protocol.replace(":", "")).split(",")[0].trim();
  return `${proto}://${host}`;
}
