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

export interface TextOut { to: string; body: string; id?: string }
export interface TextReport { sent: number; failed: { to: string; error: string }[] }

// Sends each message, five at a time — a 20-worker crew goes out in ~2s
// instead of ~8s, still gentle enough for Twilio's per-number rate limits.
// `onSent` records the send the moment Twilio takes it, so a lost response
// never leads to double-texting the crew.
export async function sendTexts(messages: TextOut[], onSent?: (m: TextOut) => Promise<void>): Promise<TextReport> {
  const sid = env("TWILIO_ACCOUNT_SID");
  const basic = Buffer.from(`${sid}:${env("TWILIO_AUTH_TOKEN")}`).toString("base64");
  const from = env("TWILIO_FROM").trim();
  const msvc = env("TWILIO_MESSAGING_SERVICE_SID").trim();
  const failed: { to: string; error: string }[] = [];
  let sent = 0;
  const sendOne = async (m: TextOut) => {
    const form = new URLSearchParams({ To: m.to, Body: m.body });
    if (msvc) form.set("MessagingServiceSid", msvc); else form.set("From", from);
    try {
      const r = await fetch(`${(env("TWILIO_API_BASE") || "https://api.twilio.com").replace(/\/+$/, "")}/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      if (r.ok) {
        sent += 1;
        if (onSent) await onSent(m).catch(() => {});
      } else {
        // Twilio's own words and its error code — 21608 (trial account), 30034
        // (number not registered), 21610 (they texted STOP) are what the
        // office needs to see, not "check the number"
        const j = (await r.json().catch(() => ({}))) as { message?: string; code?: number };
        failed.push({ to: m.to, error: `${j.message || `Twilio error ${r.status}`}${j.code ? ` (Twilio ${j.code})` : ""}` });
      }
    } catch (e) {
      failed.push({ to: m.to, error: e instanceof Error ? e.message : "network error" });
    }
  };
  for (let i = 0; i < messages.length; i += 5) {
    await Promise.all(messages.slice(i, i + 5).map(sendOne));
  }
  return { sent, failed };
}
