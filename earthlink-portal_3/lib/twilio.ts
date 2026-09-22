// The company texting number, in one place: both /api/text (the office taps
// "Text crew") and /api/text-due (a text that was set up for later) send
// through here, so a message goes out the same way whoever asked for it.
// Server-only — the keys are Vercel's, never the browser's.
const env = (k: string) => process.env[k] || "";
export const twilioConfigured = () =>
  !!(env("TWILIO_ACCOUNT_SID") && env("TWILIO_AUTH_TOKEN") && (env("TWILIO_FROM") || env("TWILIO_MESSAGING_SERVICE_SID")));

export interface TextOut { to: string; body: string; id?: string }
export interface TextReport { sent: number; failed: { to: string; error: string }[] }

// Sends each message, five at a time — a 20-worker crew goes out in ~2s
// instead of ~8s, still gentle enough for Twilio's per-number rate limits.
// `onSent` records the send the moment Twilio takes it, so a lost response
// never leads to double-texting the crew.
export async function sendTexts(messages: TextOut[], onSent?: (m: TextOut) => Promise<void>): Promise<TextReport> {
  const sid = env("TWILIO_ACCOUNT_SID");
  const basic = Buffer.from(`${sid}:${env("TWILIO_AUTH_TOKEN")}`).toString("base64");
  const from = env("TWILIO_FROM");
  const msvc = env("TWILIO_MESSAGING_SERVICE_SID");
  const failed: { to: string; error: string }[] = [];
  let sent = 0;
  const sendOne = async (m: TextOut) => {
    const form = new URLSearchParams({ To: m.to, Body: m.body });
    if (msvc) form.set("MessagingServiceSid", msvc); else form.set("From", from);
    try {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      if (r.ok) {
        sent += 1;
        if (onSent) await onSent(m).catch(() => {});
      } else {
        const j = (await r.json().catch(() => ({}))) as { message?: string };
        failed.push({ to: m.to, error: j.message || `Twilio error ${r.status}` });
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
