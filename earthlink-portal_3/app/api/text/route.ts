// The "text machine": sends crew texts from the company's Twilio number so
// nothing goes out from anyone's personal phone. Configured entirely by env
// vars in Vercel — until they're set, POST answers 501 and the Schedule tab
// falls back to opening the phone's own Messages app.
//
// Vercel → Project → Settings → Environment Variables:
//   TWILIO_ACCOUNT_SID   — from the Twilio console dashboard
//   TWILIO_AUTH_TOKEN    — same place
//   TWILIO_FROM          — the purchased number, e.g. +18885551234
//   (or TWILIO_MESSAGING_SERVICE_SID instead of TWILIO_FROM)
import { NextResponse } from "next/server";

const env = (k: string) => process.env[k] || "";
const configured = () =>
  !!(env("TWILIO_ACCOUNT_SID") && env("TWILIO_AUTH_TOKEN") && (env("TWILIO_FROM") || env("TWILIO_MESSAGING_SERVICE_SID")));

export async function GET() {
  return NextResponse.json({ configured: configured() });
}

export async function POST(req: Request) {
  if (!configured()) {
    return NextResponse.json({ configured: false, error: "The company texting number isn't set up yet" }, { status: 501 });
  }
  // only signed-in admin/office users may send — the token is the caller's
  // own Supabase session, checked against Supabase before anything goes out
  const supaUrl = env("NEXT_PUBLIC_SUPABASE_URL");
  const anon = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || !supaUrl || !anon) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const uRes = await fetch(`${supaUrl}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!uRes.ok) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const user = (await uRes.json()) as { id?: string };
  if (!user.id) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const pRes = await fetch(`${supaUrl}/rest/v1/profiles?id=eq.${user.id}&select=role`, {
    headers: { apikey: anon, Authorization: `Bearer ${token}` }, cache: "no-store",
  });
  const profs = pRes.ok ? ((await pRes.json()) as { role?: string }[]) : [];
  const role = profs[0]?.role || "";
  if (role !== "admin" && role !== "office") return NextResponse.json({ error: "Not allowed" }, { status: 403 });

  let body: { messages?: { to?: string; body?: string }[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Bad request" }, { status: 400 }); }
  const messages = (body.messages || [])
    .map((m) => ({ to: String(m.to || "").trim(), body: String(m.body || "").trim().slice(0, 1000) }))
    .filter((m) => /^\+\d{10,15}$/.test(m.to) && m.body);
  if (messages.length === 0 || messages.length > 100) {
    return NextResponse.json({ error: "Nothing to send (check the phone numbers)" }, { status: 400 });
  }

  const sid = env("TWILIO_ACCOUNT_SID");
  const basic = Buffer.from(`${sid}:${env("TWILIO_AUTH_TOKEN")}`).toString("base64");
  const from = env("TWILIO_FROM");
  const msvc = env("TWILIO_MESSAGING_SERVICE_SID");
  const failed: { to: string; error: string }[] = [];
  let sent = 0;
  for (const m of messages) {
    const form = new URLSearchParams({ To: m.to, Body: m.body });
    if (msvc) form.set("MessagingServiceSid", msvc); else form.set("From", from);
    try {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      if (r.ok) sent += 1;
      else {
        const j = (await r.json().catch(() => ({}))) as { message?: string };
        failed.push({ to: m.to, error: j.message || `Twilio error ${r.status}` });
      }
    } catch (e) {
      failed.push({ to: m.to, error: e instanceof Error ? e.message : "network error" });
    }
  }
  return NextResponse.json({ configured: true, sent, failed });
}
