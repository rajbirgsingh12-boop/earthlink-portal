// The work line of a crew text, put into Spanish by Claude — the same key
// the PO reader uses. A short line in, a short line out; the phone falls
// back to its own glossary when this can't answer.
import { NextResponse } from "next/server";
import { smartClient, smartConfigured, smartErrorNote } from "@/lib/smartPo";

export const runtime = "nodejs";
export const maxDuration = 30;
const env = (k: string) => process.env[k] || "";

const SYSTEM = `You translate short work descriptions from partner purchase orders into Spanish for construction laborers in New York City (plaster, paint, doors, floors, kitchens, bathrooms). Write plain, natural Spanish the way a foreman in Brooklyn would say it — usted, no slang, no explanations. Keep the same order and every detail: rooms, counts, apartment or unit labels (like 11A, 2nd floor), measurements, product names and anything in parentheses. Keep "move-out" as it is. Do not add anything. Answer with the translation only.`;

export async function POST(req: Request) {
  // signed-in admin/office users only — same gate as the PO reader
  const supaUrl = env("NEXT_PUBLIC_SUPABASE_URL");
  const anon = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || !supaUrl || !anon) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const uRes = await fetch(`${supaUrl}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!uRes.ok) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const user = (await uRes.json()) as { id?: string };
  const pRes = await fetch(`${supaUrl}/rest/v1/profiles?id=eq.${user.id}&select=role`, {
    headers: { apikey: anon, Authorization: `Bearer ${token}` }, cache: "no-store",
  });
  const role = (pRes.ok ? ((await pRes.json()) as { role?: string }[]) : [])[0]?.role || "";
  if (role !== "admin" && role !== "office") return NextResponse.json({ error: "Not allowed" }, { status: 403 });

  let text = "";
  try { text = String(((await req.json()) as { text?: unknown }).text || "").replace(/\s+/g, " ").trim(); } catch { text = ""; }
  if (!text) return NextResponse.json({ error: "Nothing to translate" }, { status: 400 });
  if (text.length > 1500) return NextResponse.json({ error: "Too long to translate" }, { status: 400 });
  if (!smartConfigured()) return NextResponse.json({ ok: false, note: "Claude isn't set up — add ANTHROPIC_API_KEY in Vercel" });
  try {
    const client = await smartClient(20_000);
    const res = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 600,
      system: SYSTEM,
      messages: [{ role: "user", content: text }],
    });
    const out = res.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
    if (!out) return NextResponse.json({ ok: false, note: "Claude answered with nothing" });
    return NextResponse.json({ ok: true, text: out });
  } catch (e) {
    return NextResponse.json({ ok: false, note: smartErrorNote(e) });
  }
}
