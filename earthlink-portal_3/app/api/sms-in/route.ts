// The company number's inbox. Twilio sends every text the number gets to this
// page. A worker who answers the crew text with pictures gets them put on the
// job they're on (or the PO they name in the text); pictures the portal can't
// place wait for the office on the Schedule tabs. The worker gets a short
// answer saying where the pictures went, in their own language. A worker who
// texts "no" (nobody home, the tenant can't do it today) gets their next job
// back, and the missed one is flagged for a new day (lib/nobodyFlow.ts).
//
// To switch it on:
//   • Vercel → Settings → Environment Variables: SUPABASE_SERVICE_ROLE_KEY
//     (Supabase → Settings → API → service_role) — nobody is signed in when
//     Twilio calls — next to the TWILIO keys that already send the texts.
//   • Twilio console → Phone Numbers → the company number → Messaging →
//     "A message comes in": Webhook, HTTP POST,
//     https://<the portal's address>/api/sms-in (no slash at the end). A
//     number inside a Messaging Service is governed by the service instead:
//     Messaging → Services → the service → Integration → "Send a webhook"
//     to the same address, or "Defer to sender's webhook".
//   • Text the number once from any phone. From then on the crew texts end
//     with "Reply to this text with photos of the work."
// Every request is checked against TWILIO_AUTH_TOKEN, so nobody but Twilio
// can put pictures on a job through here. If Twilio signs a different address
// than this page sees (a custom domain in front, say), set TWILIO_WEBHOOK_URL
// to exactly what is typed in the Twilio console.
import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { addressesOf, copyTo, fetchMediaFrom, messageMediaBase, sendCopy, sendTexts } from "@/lib/twilio";
import { mediaIn, twiml, validTwilio, type Params } from "@/lib/smsIn";
import { photosBackReady, serviceDb } from "@/lib/photoStore";
import { handleInbound, type Seen } from "@/lib/inbound";

export const runtime = "nodejs";
export const maxDuration = 60;
const env = (k: string) => process.env[k] || "";
const answer = (msg?: string) => new NextResponse(twiml(msg), { status: 200, headers: { "Content-Type": "text/xml; charset=utf-8" } });
const cleanPhone = (s?: string | null): string => {
  const d = (s || "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d.length > 11 && d.length <= 15 && (s || "").trim().startsWith("+") ? `+${d}` : ""; // as lib/notify's
};

export async function GET() {
  // Settings reads this: can the portal take pictures in, has a text come in
  // yet — and when not, which piece is missing
  const db = serviceDb();
  const ready = photosBackReady();
  const first = db ? await db.get<{ id: string }>("texted_photos?select=id&limit=1") : null;
  const on = !!db && ready && !!first && first.rows.length > 0;
  const why = on ? "" : !db ? "SUPABASE_SERVICE_ROLE_KEY isn't in Vercel yet (then Redeploy)"
    : !env("TWILIO_AUTH_TOKEN") ? "TWILIO_AUTH_TOKEN isn't in Vercel yet (then Redeploy)"
    : first && !first.ok ? "the texted_photos table isn't there yet: paste RUN_ME.sql (section 20) in Supabase"
    : "no text has reached the portal yet: check the webhook in Twilio, then text the company number once";
  return NextResponse.json({ ready, on, why });
}

export async function POST(req: Request) {
  const raw = await req.text().catch(() => "");
  const form = new URLSearchParams(raw);
  const params: Params = [...form.entries()];
  if (!validTwilio(env("TWILIO_AUTH_TOKEN"), addressesOf(req), params, req.headers.get("x-twilio-signature") || "")) {
    return new NextResponse("Not from Twilio", { status: 403 });
  }
  const db = serviceDb();
  if (!db) return answer(); // nowhere to put anything yet — say nothing
  const seen: Seen = { from: "", who: "", body: "", photos: 0, other: 0 };
  const reply = await handleInbound(db, {
    from: (form.get("From") || "").trim(),
    body: (form.get("Body") || "").slice(0, 1000),
    sid: (form.get("MessageSid") || form.get("SmsMessageSid") || "").trim(),
    ...mediaIn((k) => form.get(k)),
    fetchMedia: fetchMediaFrom(messageMediaBase()),
    deliver: async (to, body, who) => (await sendTexts([{ to, body, who }])).sent > 0,
  }, seen);
  // the owner's copy (lib/twilio copyTo): the text in and the answer, in two short texts
  const copy = copyTo();
  if (copy && seen.from && cleanPhone(seen.from) !== copy) {
    const what = `${seen.body.trim()}${seen.photos ? `${seen.body.trim() ? " " : ""}(${seen.photos} photo${seen.photos === 1 ? "" : "s"})` : ""}${seen.other ? ` (${seen.other} file${seen.other === 1 ? "" : "s"})` : ""}`.trim();
    const who = seen.who || seen.from;
    waitUntil((async () => {
      if (what) await sendCopy(`From ${who}: ${what}`);
      if (reply) await sendCopy(`Reply to ${who}: ${reply}`);
    })());
  }
  return answer(reply);
}
