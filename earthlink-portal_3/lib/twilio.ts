// The company texting number, in one place: both /api/text (the office taps
// "Text crew") and /api/text-due (a text that was set up for later) send
// through here, so a message goes out the same way whoever asked for it.
// Server-only — the keys are Vercel's, never the browser's. (TWILIO_API_BASE
// is for trying it all against a stand-in; leave it unset.)
const env = (k: string) => process.env[k] || "";
export const twilioConfigured = () =>
  !!(env("TWILIO_ACCOUNT_SID") && env("TWILIO_AUTH_TOKEN") && (env("TWILIO_FROM") || env("TWILIO_MESSAGING_SERVICE_SID")));
// A key that is there but can't be right — the number typed as "(917) 555-0123"
// instead of +19175550123, say. Twilio would refuse every text, and the
// portal would blame the workers' numbers; Settings → System check says this instead.
export function twilioProblem(): string {
  if (!twilioConfigured()) return "";
  if (!/^AC[0-9a-f]{32}$/i.test(env("TWILIO_ACCOUNT_SID").trim())) return "TWILIO_ACCOUNT_SID should be the Account SID from the Twilio console (starts with AC, 34 characters)";
  const msvc = env("TWILIO_MESSAGING_SERVICE_SID").trim();
  if (msvc && !/^MG[0-9a-f]{32}$/i.test(msvc)) return "TWILIO_MESSAGING_SERVICE_SID should start with MG (34 characters)";
  const from = env("TWILIO_FROM").trim();
  if (!msvc && !/^\+[1-9]\d{9,14}$/.test(from)) return `TWILIO_FROM must be the company number with +1 in front and nothing else, like +19175550123 (it is "${from}")`;
  if (env("TWILIO_API_BASE")) return "TWILIO_API_BASE is set in Vercel — that is only for testing; remove it so texts really go to Twilio";
  return "";
}

// The owner's own phone, when TEXT_COPY_TO is set: a copy of every text the
// portal sends a worker ("Sent to Jose: …"), so the office has the whole
// thread in one place and can follow up. Never a copy of a text to that
// phone itself.
const cleanPhone = (s: string): string => {
  const d = (s || "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d.length > 11 && d.length <= 15 && (s || "").trim().startsWith("+") ? `+${d}` : "";
};
export const copyTo = (): string => cleanPhone(env("TEXT_COPY_TO"));
export const copyProblem = (): string => (env("TEXT_COPY_TO") && !copyTo() ? `TEXT_COPY_TO must be a phone number with +1 in front, like +19175550123 (it is "${env("TEXT_COPY_TO")}")` : "");
// a line to the owner's phone, on its own (a worker's text coming in, the portal's answer)
export async function sendCopy(body: string): Promise<void> {
  const to = copyTo();
  if (!to || !twilioConfigured()) return;
  await sendTexts([{ to, body }]).catch(() => {});
}

export interface TextOut { to: string; body: string; id?: string; who?: string }   // `who`: the worker's name, for the owner's copy
export interface TextReport { sent: number; failed: { to: string; error: string; id?: string }[] }

// Sends each message, five at a time — a 20-worker crew goes out in ~2s
// instead of ~8s, still gentle enough for Twilio's per-number rate limits.
// `onSent` records the send the moment Twilio takes it, so a lost response
// never leads to double-texting the crew.
export async function sendTexts(messages: TextOut[], onSent?: (m: TextOut) => Promise<void>): Promise<TextReport> {
  const sid = env("TWILIO_ACCOUNT_SID");
  const basic = Buffer.from(`${sid}:${env("TWILIO_AUTH_TOKEN")}`).toString("base64");
  const from = env("TWILIO_FROM").trim();
  const msvc = env("TWILIO_MESSAGING_SERVICE_SID").trim();
  const failed: TextReport["failed"] = [];
  let sent = 0;
  const post = (to: string, body: string) => {
    const form = new URLSearchParams({ To: to, Body: body });
    if (msvc) form.set("MessagingServiceSid", msvc); else form.set("From", from);
    return fetch(`${(env("TWILIO_API_BASE") || "https://api.twilio.com").replace(/\/+$/, "")}/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  };
  const sendOne = async (m: TextOut) => {
    try {
      const r = await post(m.to, m.body);
      if (r.ok) {
        sent += 1;
        if (onSent) await onSent(m).catch(() => {});
        const copy = copyTo();
        if (copy && m.to !== copy) await post(copy, `Sent to ${m.who || m.to}:\n${m.body}`).catch(() => {});
      } else {
        // Twilio's own words and its error code — 21608 (trial account), 30034
        // (number not registered), 21610 (they texted STOP) are what the
        // office needs to see, not "check the number"
        const j = (await r.json().catch(() => ({}))) as { message?: string; code?: number };
        failed.push({ to: m.to, id: m.id, error: `${j.message || `Twilio error ${r.status}`}${j.code ? ` (Twilio ${j.code})` : ""}` });
      }
    } catch (e) {
      failed.push({ to: m.to, id: m.id, error: e instanceof Error ? e.message : "network error" });
    }
  };
  for (let i = 0; i < messages.length; i += 5) {
    await Promise.all(messages.slice(i, i + 5).map(sendOne));
  }
  return { sent, failed };
}

// ---- pictures from Twilio's own storage ----
// A text's MediaUrl (api.twilio.com) or a group thread's media (the Media
// Content Service): fetched with the account's key, and only from that
// host; the picture itself sits behind a redirect on a storage host that
// gets no key. (The *_BASE overrides are for trying it against a stand-in.)
export const messageMediaBase = () => (env("TWILIO_API_BASE") || "https://api.twilio.com").replace(/\/+$/, "");
export const groupMediaBase = () => (env("TWILIO_MCS_BASE") || "https://mcs.us1.twilio.com").replace(/\/+$/, "");
export function fetchMediaFrom(base: string): (url: string) => Promise<{ bytes: ArrayBuffer; type: string } | null> {
  return async (url: string) => {
    if (!url.startsWith(`${base}/`)) return null;
    const auth = `Basic ${Buffer.from(`${env("TWILIO_ACCOUNT_SID")}:${env("TWILIO_AUTH_TOKEN")}`).toString("base64")}`;
    const signal = AbortSignal.timeout(11_000);
    try {
      let at = url;
      let r = await fetch(at, { headers: { Authorization: auth }, redirect: "manual", signal, cache: "no-store" });
      for (let hop = 0; hop < 4 && r.status >= 300 && r.status < 400; hop++) {
        const loc = r.headers.get("location");
        if (!loc) return null;
        const next = new URL(loc, at);
        if (next.protocol !== "https:" && !base.startsWith("http://")) return null;
        at = next.toString();
        r = await fetch(at, { headers: next.origin === new URL(base).origin ? { Authorization: auth } : {}, redirect: "manual", signal, cache: "no-store" });
      }
      if (!r.ok) return null;
      const bytes = await r.arrayBuffer();
      if (bytes.byteLength === 0 || bytes.byteLength > 25 * 1024 * 1024) return null;
      return { bytes, type: (r.headers.get("content-type") || "").split(";")[0].trim() };
    } catch { return null; }
  };
}

// every address Twilio may have signed for this request
export function addressesOf(req: Request): string[] {
  const u = new URL(req.url);
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || u.host).split(",")[0].trim();
  const proto = (req.headers.get("x-forwarded-proto") || u.protocol.replace(":", "")).split(",")[0].trim();
  const path = u.pathname + u.search;
  const bare = host.replace(/:(443|80)$/, "");
  return [...new Set([env("TWILIO_WEBHOOK_URL"), `${proto}://${host}${path}`, `${proto}://${bare}${path}`, `${proto}://${bare}:${proto === "https" ? 443 : 80}${path}`, req.url].filter(Boolean))];
}
