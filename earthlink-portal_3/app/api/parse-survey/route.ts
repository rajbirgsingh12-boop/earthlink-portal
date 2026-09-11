// Server-side survey reader: the phone sends the survey PDF and gets back the
// survey as items off the move-out list (what each line is, and its count —
// the page bills them). Same gate, same PDF engine and the same
// smart-reader-then-rules shape as the PO reader.
import { NextResponse } from "next/server";
import { readSurveySmart } from "@/lib/smartSurvey";
import { readSurveyForm } from "@/lib/surveyForm";
import { smartConfigured } from "@/lib/smartPo";

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

  // the PDF travels as a form
  let file: File | null = null;
  try {
    const form = await req.formData();
    file = form.get("file") as File | null;
  } catch {
    return NextResponse.json({ error: "Send the survey PDF as a form" }, { status: 400 });
  }
  if (!file || file.size === 0 || file.size > 8 * 1024 * 1024) return NextResponse.json({ error: "Send the survey PDF itself (max 8 MB)" }, { status: 400 });
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // our own survey form, filled in: read straight off its boxes — no guessing at the wording
    const formText = await readSurveyForm(bytes.slice()).catch(() => null);
    if (formText !== null) {
      const out = await readSurveySmart(bytes, formText, undefined, undefined, formText);
      return NextResponse.json({ ok: true, survey: out.survey, readBy: out.readBy, form: true, ...(out.note ? { note: out.note } : {}), text: formText });
    }
    const { getResolvedPDFJS } = await import("unpdf");
    const pdfjs = await getResolvedPDFJS();
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
    const out = await readSurveySmart(bytes, text);
    return NextResponse.json({ ok: true, survey: out.survey, readBy: out.readBy, ...(out.note ? { note: out.note } : {}), text });
  } catch (e) {
    return NextResponse.json({ error: `Couldn't open the PDF: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}` }, { status: 422 });
  }
}
