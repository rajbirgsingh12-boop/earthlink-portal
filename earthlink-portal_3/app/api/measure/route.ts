// Square feet from photos: the phone sends the pictures (already shrunk)
// and what the owner knows about the room; Claude measures them here with
// the same key the PO reader uses. The answer comes back as the form —
// cleaned — or a plain note why not.
import { NextResponse } from "next/server";
import { smartConfigured } from "@/lib/smartPo";
import { measureSmart, type MeasureImage } from "@/lib/smartMeasure";
import { MAX_PHOTOS, type BoxMark, type MeasureHints, type RulerMark } from "@/lib/measure";

export const runtime = "nodejs";
export const maxDuration = 60;
const env = (k: string) => process.env[k] || "";
const MEDIA = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_ONE = 2 * 1024 * 1024;     // one photo, base64 — a shrunk phone photo is a few hundred KB
const MAX_ALL = 4 * 1024 * 1024;     // the whole request — Vercel stops bodies around 4.5 MB

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

  let body: { images?: unknown; hints?: unknown } = {};
  try { body = (await req.json()) as typeof body; } catch { return NextResponse.json({ error: "Send the photos as JSON" }, { status: 400 }); }
  const raw = Array.isArray(body.images) ? (body.images as { media_type?: unknown; data?: unknown; width?: unknown; height?: unknown; ruler?: unknown; box?: unknown }[]) : [];
  if (raw.length === 0) return NextResponse.json({ error: "No photos to measure" }, { status: 400 });
  if (raw.length > MAX_PHOTOS) return NextResponse.json({ error: `Up to ${MAX_PHOTOS} photos at a time` }, { status: 400 });
  const images: MeasureImage[] = [];
  let total = 0;
  for (const im of raw) {
    const data = typeof im.data === "string" ? im.data.replace(/^data:[^,]*,/, "").replace(/\s+/g, "") : "";
    const media = String(im.media_type || "image/jpeg").toLowerCase();
    if (!data || !MEDIA.includes(media)) return NextResponse.json({ error: "One of the photos isn't a picture the reader can take (JPEG, PNG, WebP, GIF)" }, { status: 400 });
    if (data.length > MAX_ONE) return NextResponse.json({ error: "One of the photos is too big — the phone should have shrunk it; try picking it again" }, { status: 413 });
    total += data.length;
    if (total > MAX_ALL) return NextResponse.json({ error: "Too many big photos at once — try fewer" }, { status: 413 });
    // the photo's size and the owner's marks, in its pixels — checked, never trusted
    const width = Math.max(0, Math.min(10000, Math.round(Number(im.width) || 0))), height = Math.max(0, Math.min(10000, Math.round(Number(im.height) || 0)));
    const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
    const rr = (im.ruler || null) as Record<string, unknown> | null;
    const ruler: RulerMark | null = rr && [rr.x1, rr.y1, rr.x2, rr.y2, rr.inches].every((v) => !Number.isNaN(num(v))) && num(rr.inches) > 0 && num(rr.inches) <= 600
      ? { x1: num(rr.x1), y1: num(rr.y1), x2: num(rr.x2), y2: num(rr.y2), inches: num(rr.inches) } : null;
    const bb = (im.box || null) as Record<string, unknown> | null;
    const box: BoxMark | null = bb && [bb.x1, bb.y1, bb.x2, bb.y2].every((v) => !Number.isNaN(num(v)))
      ? { x1: Math.min(num(bb.x1), num(bb.x2)), y1: Math.min(num(bb.y1), num(bb.y2)), x2: Math.max(num(bb.x1), num(bb.x2)), y2: Math.max(num(bb.y1), num(bb.y2)) } : null;
    images.push({ media_type: media as MeasureImage["media_type"], data, width, height, ruler, box });
  }
  const h = (body.hints || {}) as Partial<MeasureHints>;
  const hints: MeasureHints = {
    scope: h.scope === "whole" ? "whole" : "spots",
    ceilingFt: Math.min(20, Math.max(6, Number(h.ceilingFt) || 8)),
    note: String(h.note || "").replace(/\s+/g, " ").trim().slice(0, 500),
  };
  if (!smartConfigured()) return NextResponse.json({ ok: false, note: "Claude isn't set up — add ANTHROPIC_API_KEY in Vercel" });
  const out = await measureSmart(images, hints);
  if ("note" in out) return NextResponse.json({ ok: false, note: out.note });
  return NextResponse.json({ ok: true, result: out.result });
}
