// Server-side survey reader: the phone sends the survey PDF and the contract's
// price book, and gets back the survey as the book's own lines. Same gate,
// same PDF engine and the same smart-reader-then-rules shape as the PO reader.
import { NextResponse } from "next/server";
import { readSurveySmart } from "@/lib/smartSurvey";
import { smartConfigured } from "@/lib/smartPo";
import type { CatalogLine } from "@/lib/surveyTemplate";

export const runtime = "nodejs";
export const maxDuration = 60;
const env = (k: string) => process.env[k] || "";

export async function GET() {
  return NextResponse.json({ smart: smartConfigured() });
}

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

  // the PDF and the price book travel together as a form
  let file: File | null = null;
  let catalog: CatalogLine[] = [];
  try {
    const form = await req.formData();
    file = form.get("file") as File | null;
    const raw = form.get("catalog");
    catalog = typeof raw === "string" ? (JSON.parse(raw) as CatalogLine[]) : [];
  } catch {
    return NextResponse.json({ error: "Send the survey PDF and the price book as a form" }, { status: 400 });
  }
  if (!file || file.size === 0 || file.size > 8 * 1024 * 1024) return NextResponse.json({ error: "Send the survey PDF itself (max 8 MB)" }, { status: 400 });
  if (!Array.isArray(catalog) || catalog.length === 0) return NextResponse.json({ error: "No price book for this contract — upload it on the Price Book tab first" }, { status: 400 });
  // only what the reader needs — never a stray column
  catalog = catalog.map((c) => ({ code: String(c.code || ""), line: Number(c.line) || 0, category: String(c.category || ""), description: String(c.description || ""), uom: String(c.uom || ""), unit_price: Number(c.unit_price) || 0 })).filter((c) => c.code);
  try {
    const { getResolvedPDFJS } = await import("unpdf");
    const pdfjs = await getResolvedPDFJS();
    const bytes = new Uint8Array(await file.arrayBuffer());
    // pdfjs detaches the buffer it is handed — it gets a copy
    const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    const lines: string[] = [];
    for (let pg = 1; pg <= doc.numPages; pg++) {
      const tc = await (await doc.getPage(pg)).getTextContent();
      // the page's own lines, rebuilt from where the words sit (a survey is one item per line)
      const items = (tc.items as { str?: string; transform?: number[] }[]).filter((x) => (x.str || "").trim());
      const rows: { y: number; parts: { x: number; s: string }[] }[] = [];
      for (const it of items) {
        const y = Math.round((it.transform?.[5] ?? 0) / 3), x = it.transform?.[4] ?? 0;
        const row = rows.find((r) => Math.abs(r.y - y) <= 1);
        if (row) row.parts.push({ x, s: it.str || "" }); else rows.push({ y, parts: [{ x, s: it.str || "" }] });
      }
      rows.sort((a, b) => b.y - a.y).forEach((r) => lines.push(r.parts.sort((a, b) => a.x - b.x).map((p) => p.s).join(" ").replace(/\s{2,}/g, " ").trim()));
    }
    await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => null);
    const text = lines.filter(Boolean).join("\n");
    const out = await readSurveySmart(bytes, text, catalog);
    return NextResponse.json({ ok: true, survey: out.survey, readBy: out.readBy, ...(out.note ? { note: out.note } : {}), text });
  } catch (e) {
    return NextResponse.json({ error: `Couldn't open the PDF: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}` }, { status: 422 });
  }
}
