// The office's side of the photos the crew texts in: put a batch on a job
// (one the portal couldn't place, or one that landed on the wrong job), or
// throw away a batch nobody could place. The sign-in is checked first —
// admin or office only — and then the portal moves the pictures itself,
// since they sit in a folder no one's own sign-in can move out of.
import { NextResponse } from "next/server";
import { pactKey, relKey } from "@/lib/smsIn";
import { dropBatch, fileBatch, serviceDb, type Batch } from "@/lib/photoStore";

export const runtime = "nodejs";
export const maxDuration = 60;
const env = (k: string) => process.env[k] || "";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!db) return NextResponse.json({ error: "Add SUPABASE_SERVICE_ROLE_KEY in Vercel so texted photos can be moved" }, { status: 501 });
  let body: { id?: string; action?: string; pact_job_id?: string; release_id?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Bad request" }, { status: 400 }); }
  if (!body.id || !uuid.test(body.id)) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const b = (await db.get<Batch>(`texted_photos?id=eq.${body.id}&select=*`)).rows[0];
  if (!b) return NextResponse.json({ error: "Those photos aren't there any more" }, { status: 404 });

  if (body.action === "throw") {
    if (b.status !== "held") return NextResponse.json({ error: "These are on a job already — take them off from the job's Documents" }, { status: 409 });
    return (await dropBatch(db, b)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Couldn't throw them away — try again" }, { status: 500 });
  }
  if (body.action !== "file") return NextResponse.json({ error: "Bad request" }, { status: 400 });
  if (b.status !== "held" && b.status !== "filed") return NextResponse.json({ error: "Those photos were thrown away" }, { status: 409 });
  let target;
  if (body.pact_job_id && uuid.test(body.pact_job_id)) {
    const j = (await db.get<{ id: string; po_number?: string; job_number?: string }>(`pact_jobs?id=eq.${body.pact_job_id}&select=id,po_number,job_number`)).rows[0];
    if (j) target = pactKey(j);
  } else if (body.release_id && uuid.test(body.release_id)) {
    const r = (await db.get<{ id: string; rel_number?: string }>(`releases?id=eq.${body.release_id}&select=id,rel_number`)).rows[0];
    if (r) target = relKey(r);
  }
  if (!target) return NextResponse.json({ error: "That job isn't in the portal" }, { status: 404 });
  const n = await fileBatch(db, b, target);
  if (!n) return NextResponse.json({ error: "Couldn't move the photos — try again" }, { status: 500 });
  return NextResponse.json({ ok: true, n, label: target.label });
}
