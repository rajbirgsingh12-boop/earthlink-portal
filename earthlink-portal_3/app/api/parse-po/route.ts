// Server-side PO reader: the phone sends the PDF here and gets the fields back.
// Reading happens in Node with pdfjs's legacy build — identical results on
// every device, no reliance on the phone browser's PDF support.
import { NextResponse } from "next/server";
import { smartConfigured } from "@/lib/smartPo";
import { readPoBytes } from "@/lib/poReadServer";

export const runtime = "nodejs";
export const maxDuration = 60;
const env = (k: string) => process.env[k] || "";

// the Settings health check asks whether the smart reader is switched on
export async function GET() {
  return NextResponse.json({ smart: smartConfigured() });
}

export async function POST(req: Request) {
  // signed-in admin/office users only — same gate as the texting route
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

  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0 || buf.byteLength > 4 * 1024 * 1024) {
    return NextResponse.json({ error: "Send the PDF file itself (max 4 MB; bigger files are read on the phone)" }, { status: 400 });
  }
  try {
    // the page's own lines are rebuilt from where the words sit, exactly like
    // the browser fallback, so both paths read the same table (lib/poReadServer)
    const smart = await readPoBytes(buf);
    return NextResponse.json({ ok: true, fields: smart.fields, readBy: smart.readBy, ...(smart.note ? { note: smart.note } : {}) });
  } catch (e) {
    return NextResponse.json({ error: `Couldn't open the PDF: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}` }, { status: 422 });
  }
}
