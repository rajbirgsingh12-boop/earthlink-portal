// A crew's group thread, heard. Twilio's Conversations sends every message
// posted in a thread here (lib/groupText sets that up the first time a
// thread is used). A worker's pictures, square feet, "done" and "no" are
// handled exactly as a text to the company number is (lib/inbound), and the
// answer goes back into the thread, where the owner reads it too. The
// portal's own messages and the owner's are heard but not acted on.
// Every request is checked against TWILIO_AUTH_TOKEN, like /api/sms-in.
import { NextResponse } from "next/server";
import { addressesOf, copyTo, fetchMediaFrom, groupMediaBase, sendTexts } from "@/lib/twilio";
import { imageExt, phoneKey, validTwilio, type MediaIn, type Params } from "@/lib/smsIn";
import { serviceDb } from "@/lib/photoStore";
import { handleInbound, type Seen } from "@/lib/inbound";
import { PORTAL_IDENTITY, groupInfo, groupMediaUrl, postToGroup, rememberGroupJob } from "@/lib/groupText";
import { langOf } from "@/lib/crewText";

export const runtime = "nodejs";
export const maxDuration = 60;
const env = (k: string) => process.env[k] || "";
const heard = () => new NextResponse("", { status: 200 });

export async function POST(req: Request) {
  const raw = await req.text().catch(() => "");
  const form = new URLSearchParams(raw);
  const params: Params = [...form.entries()];
  if (!validTwilio(env("TWILIO_AUTH_TOKEN"), addressesOf(req), params, req.headers.get("x-twilio-signature") || "")) {
    return new NextResponse("Not from Twilio", { status: 403 });
  }
  if (form.get("EventType") !== "onMessageAdded") return heard();
  const author = (form.get("Author") || "").trim();
  const thread = (form.get("ConversationSid") || "").trim();
  // the portal's own words, or something that isn't a phone: nothing to do
  if (!author || !thread || author === PORTAL_IDENTITY || !/^\+\d{10,15}$/.test(author)) return heard();
  const db = serviceDb();
  if (!db) return heard();
  // the owner talking to the crew is not a worker's report — unless the
  // owner's phone is on the crew list too (trying it out as a worker)
  type E = { name?: string | null; phone?: string | null; active?: boolean | null; lang?: string | null };
  let got = await db.get<E>("employees?select=name,phone,active,lang");
  if (!got.ok) got = await db.get<E>("employees?select=name,phone,active"); // before the language column
  const emps = got.rows;
  const me = emps.find((e) => phoneKey(e.phone) === phoneKey(author) && e.active !== false);
  if (phoneKey(author) === phoneKey(copyTo()) && !me) return heard();
  // what the thread is about: its people (so an answer says who it is for
  // when more than one worker reads it) and the job its last crew text was for
  const info = await groupInfo(thread);
  const workers = info.members.filter((m) => phoneKey(m) !== phoneKey(copyTo()));
  const first = (me?.name || "").trim().replace(/\s*[\u2014\u2013]\s*/g, "-").split(/\s+/)[0] || "";
  // "Jose: …" when more than one worker reads the thread — the one it is for
  const forWho = (body: string, who?: string) => { const name = (who || first).trim().replace(/\s*[\u2014\u2013]\s*/g, "-").split(/\s+/)[0]; return workers.length > 1 && name ? `${name}: ${body}` : body; };
  // the pictures: Twilio lists them as JSON, kept on its media host by the thread's service
  const svc = (form.get("ChatServiceSid") || "").trim();
  const photos: MediaIn[] = [];
  let other = 0;
  try {
    const list = JSON.parse(form.get("Media") || "[]") as Record<string, unknown>[];
    for (const m of Array.isArray(list) ? list : []) {
      const sid = String(m.Sid || m.sid || "").trim();
      const type = String(m.ContentType || m.content_type || "").trim().toLowerCase();
      if (!sid || !svc) continue;
      const ext = imageExt(type);
      if (ext) photos.push({ url: groupMediaUrl(groupMediaBase(), svc, sid), type, ext }); else other += 1;
    }
  } catch { /* no media */ }
  const seen: Seen = { from: "", who: "", body: "", photos: 0, other: 0 };
  // (the poster's own answer went into the thread in this request)
  let posted = false;
  const reply = await handleInbound(db, {
    from: author,
    body: (form.get("Body") || "").slice(0, 1000),
    sid: (form.get("MessageSid") || "").trim(),
    photos: photos.slice(0, 10), other,
    fetchMedia: fetchMediaFrom(groupMediaBase()),
    // a later text: the one who posted gets it in the thread (and a text that
    // sends the crew on to another job makes the thread that job's); a
    // co-worker who reads this thread has it there already (the answer just
    // posted names the next job for both), so it isn't posted twice, unless
    // they read the other language: then theirs is posted too. When the post
    // didn't go, they're texted one to one, as anyone else is
    deliver: async (to, body, who, job) => {
      const k = phoneKey(to);
      if (!k || k === phoneKey(author)) {
        const ok = await postToGroup(thread, forWho(body, who));
        if (ok) posted = true;
        if (ok && job) await rememberGroupJob(thread, info.members, job).catch(() => {});
        return ok;
      }
      if (workers.some((m) => phoneKey(m) === k) && posted) {
        const them = emps.find((e) => phoneKey(e.phone) === k && e.active !== false);
        return langOf(them?.lang) === langOf(me?.lang) ? true : postToGroup(thread, forWho(body, who));
      }
      return (await sendTexts([{ to, body, who }])).sent > 0;
    },
    jobHint: info.job,
  }, seen);
  if (reply) await postToGroup(thread, forWho(reply));
  return heard();
}
