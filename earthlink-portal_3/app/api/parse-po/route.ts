// Server-side PO reader: the phone sends the PDF here and gets the fields back.
// Reading happens in Node with pdfjs's legacy build — identical results on
// every device, no reliance on the phone browser's PDF support.
import { NextResponse } from "next/server";
import { parsePactPoText } from "@/lib/parsePactPo";

export const runtime = "nodejs";
const env = (k: string) => process.env[k] || "";

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
  if (buf.byteLength === 0 || buf.byteLength > 15 * 1024 * 1024) {
    return NextResponse.json({ error: "Send the PDF file itself (max 15 MB)" }, { status: 400 });
  }
  try {
    // unpdf bundles its own pdf engine specifically for serverless — no worker
    // files to resolve, so it can't break in deployment the way raw pdfjs can
    const { extractText, getDocumentProxy } = await import("unpdf");
    const doc = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(doc, { mergePages: true });
    return NextResponse.json({ ok: true, fields: parsePactPoText(String(text || "")) });
  } catch (e) {
    return NextResponse.json({ error: `Couldn't open the PDF: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}` }, { status: 422 });
  }
}
