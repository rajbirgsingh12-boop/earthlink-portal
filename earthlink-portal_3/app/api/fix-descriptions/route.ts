// A PO's description, read again from the PDF already on the job, for the
// jobs whose description the first intake cut at 120 characters. Admin or
// office; a few jobs per call (each read can take seconds), the caller
// comes back with what it has done until nothing is left. Only a
// description the fresh read plainly continues is replaced (lib/descFix);
// the job's lines and money are never touched.
import { NextResponse } from "next/server";
import { serviceDb } from "@/lib/photoStore";
import { readPoBytes } from "@/lib/poReadServer";
import { betterDescription, looksCut } from "@/lib/descFix";

export const runtime = "nodejs";
export const maxDuration = 60;
const env = (k: string) => process.env[k] || "";
const seg = (p: string) => p.split("/").map(encodeURIComponent).join("/");
interface Job { id: string; po_number?: string | null; job_number?: string | null; description?: string | null; attachments?: { name?: string; path?: string }[] | null }

async function officeUser(req: Request): Promise<boolean> {
  const supaUrl = env("NEXT_PUBLIC_SUPABASE_URL"), anon = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!supaUrl || !anon || !token) return false;
  const u = await fetch(`${supaUrl}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${token}` }, cache: "no-store" }).catch(() => null);
  if (!u || !u.ok) return false;
  const id = ((await u.json().catch(() => ({}))) as { id?: string }).id;
  if (!id) return false;
  const p = await fetch(`${supaUrl}/rest/v1/profiles?id=eq.${id}&select=role`, { headers: { apikey: anon, Authorization: `Bearer ${token}` }, cache: "no-store" }).catch(() => null);
  const role = p && p.ok ? ((await p.json().catch(() => [])) as { role?: string }[])[0]?.role : "";
  return role === "admin" || role === "office";
}

export async function POST(req: Request) {
  if (!(await officeUser(req))) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  const db = serviceDb();
  if (!db) return NextResponse.json({ error: "Add SUPABASE_SERVICE_ROLE_KEY in Vercel so the portal can read the jobs' PDFs" }, { status: 501 });
  let body: { done?: string[]; limit?: number } = {};
  try { body = await req.json(); } catch { /* no body: from the top */ }
  const done = new Set(Array.isArray(body.done) ? body.done.map(String) : []);
  const limit = Math.max(1, Math.min(10, Number(body.limit) || 4));
  const jobs = (await db.get<Job>("pact_jobs?canceled=not.is.true&select=id,po_number,job_number,description,attachments&order=created_at.desc&limit=1000")).rows;
  const pdfOf = (j: Job) => (j.attachments || []).find((a) => /\.pdf$/i.test(a?.name || "") && (a?.path || "").startsWith("pact/"))?.path || "";
  const todo = jobs.filter((j) => !done.has(j.id) && looksCut(j.description || "") && pdfOf(j));
  const batch = todo.slice(0, limit);
  const label = (j: Job) => `PO ${(j.po_number || j.job_number || "").replace(/^PO#?\s*/i, "").trim() || j.id.slice(0, 8)}`;
  const fixed: { po: string; before: string; after: string }[] = [];
  const kept: { po: string; why: string }[] = [];
  const url = env("NEXT_PUBLIC_SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY");
  const started = Date.now();
  for (const j of batch) {
    done.add(j.id);
    if (Date.now() - started > 40_000) { done.delete(j.id); break; } // the rest next call
    const r = await fetch(`${url}/storage/v1/object/docs/${seg(pdfOf(j))}`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" }).catch(() => null);
    if (!r || !r.ok) { kept.push({ po: label(j), why: "the PDF couldn't be opened" }); continue; }
    let fresh = "";
    try {
      const read = await readPoBytes(await r.arrayBuffer(), 25_000);
      fresh = read.fields.desc || read.fields.scope || "";
    } catch { kept.push({ po: label(j), why: "the PDF couldn't be read" }); continue; }
    const better = betterDescription(j.description || "", fresh);
    if (!better) { kept.push({ po: label(j), why: fresh ? "the PO reads differently from what's on the job — left as it is" : "nothing readable on the PDF" }); continue; }
    if (!(await db.patch(`pact_jobs?id=eq.${j.id}`, { description: better }))) { kept.push({ po: label(j), why: "the save didn't take" }); continue; }
    // a crew row that carried the cut copy follows
    await db.patch(`schedule_days?pact_job_id=eq.${j.id}&description=eq.${encodeURIComponent(j.description || "")}`, { description: better });
    fixed.push({ po: label(j), before: j.description || "", after: better });
  }
  const remaining = jobs.filter((j) => !done.has(j.id) && looksCut(j.description || "") && pdfOf(j)).length;
  return NextResponse.json({ ok: true, checked: batch.length, fixed, kept, remaining, done: [...done] });
}
