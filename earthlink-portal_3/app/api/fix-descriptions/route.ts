// A PO's description, read again from the PDF already on the job, for the
// jobs whose description the first intake cut at 120 characters. Admin only
// (a read may go to Claude); a few jobs per call, each read at most once while
// this copy of the portal is up, the caller comes back with what it has done
// until nothing is left. Only a description the fresh read plainly continues
// is replaced (lib/descFix), and only while the job still says what was read:
// an office edit in between wins. Jobs already invoiced, received or paid are
// never rewritten; the job's lines and money are never touched.
import { NextResponse } from "next/server";
import { serviceDb } from "@/lib/photoStore";
import { readPoBytes } from "@/lib/poReadServer";
import { betterDescription, keptWhy, looksCut, squash } from "@/lib/descFix";

export const runtime = "nodejs";
export const maxDuration = 60;
// the call's own clock, well under maxDuration, so the round's report always gets back
const BUDGET_MS = 52_000;
const READ_MS = 25_000;
// a read under this gets the rules only (lib/smartPo); better to leave the job for the next call
const MIN_READ_MS = 8_000;
const PAGE = 1000;
const env = (k: string) => process.env[k] || "";
const seg = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface Job { id: string; po_number?: string | null; job_number?: string | null; description?: string | null }
interface Att { name?: string; path?: string }

// who is asking: the admin's own user id, "" for anyone else
async function adminUser(req: Request): Promise<string> {
  const supaUrl = env("NEXT_PUBLIC_SUPABASE_URL"), anon = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!supaUrl || !anon || !token) return "";
  const u = await fetch(`${supaUrl}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${token}` }, cache: "no-store" }).catch(() => null);
  if (!u || !u.ok) return "";
  const id = ((await u.json().catch(() => ({}))) as { id?: string }).id;
  if (!id) return "";
  const p = await fetch(`${supaUrl}/rest/v1/profiles?id=eq.${id}&select=role`, { headers: { apikey: anon, Authorization: `Bearer ${token}` }, cache: "no-store" }).catch(() => null);
  const role = p && p.ok ? ((await p.json().catch(() => [])) as { role?: string }[])[0]?.role : "";
  return role === "admin" ? id : "";
}

// spend guard, the way /api/text has one: an account sends at most 60 PDFs an
// hour to the reader (every cut job on the books is a few dozen; this only
// stops runaways and stolen sessions)
const READS_AN_HOUR = 60;
const readLog = new Map<string, number[]>();
const readsThisHour = (userId: string): number[] => {
  const now = Date.now();
  const kept = (readLog.get(userId) || []).filter((t) => now - t < 3600_000);
  readLog.set(userId, kept);
  return kept;
};
// a job's PDF goes to the reader once while this copy of the portal is up,
// whatever `done` list a caller sends
const readOnce = new Set<string>();

// the PO's own PDF, and only out of this job's own folder: pact/<job id>/<file>.pdf,
// so never a paper the portal made (pact/<id>/made/…) and never a path that
// climbs somewhere else; by name when it says so
const pdfOf = (id: string, atts: unknown): string => {
  if (!UUID.test(id)) return "";
  const own = new RegExp(`^pact/${id}/[^/]+\\.pdf$`, "i");
  const pdfs = (Array.isArray(atts) ? (atts as Att[]) : []).filter((a) => a && /\.pdf$/i.test(a.name || "") && own.test(a.path || "") && !(a.path || "").includes(".."));
  return (pdfs.find((a) => /\b(?:po|purchase)\b/i.test(a.name || "")) || pdfs[0])?.path || "";
};

export async function POST(req: Request) {
  const uid = await adminUser(req);
  if (!uid) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  const db = serviceDb();
  if (!db) return NextResponse.json({ error: "Add SUPABASE_SERVICE_ROLE_KEY in Vercel so the portal can read the jobs' PDFs" }, { status: 501 });
  let body: { done?: string[]; limit?: number } = {};
  try { body = await req.json(); } catch { /* no body: from the top */ }
  const done = new Set(Array.isArray(body.done) ? body.done.map(String) : []);
  const limit = Math.max(1, Math.min(10, Number(body.limit) || 4));
  // every open, unbilled job, oldest first (the cut lived in the oldest ones),
  // page by page; a job invoiced, received or paid is never rewritten
  const open = "pact_jobs?canceled=not.is.true&invoice_sent=is.null&received=not.is.true&paid_date=is.null";
  const jobs: Job[] = [];
  for (let page = 0; page < 10; page++) {
    const got = await db.get<Job>(`${open}&select=id,po_number,job_number,description&order=created_at.asc&limit=${PAGE}&offset=${page * PAGE}`);
    if (!got.ok) return NextResponse.json({ error: "The jobs couldn't be read, try again in a moment" }, { status: 502 });
    jobs.push(...got.rows);
    if (got.rows.length < PAGE) break;
  }
  const cut = jobs.filter((j) => UUID.test(j.id) && looksCut(j.description || ""));
  const readBefore = cut.filter((j) => !done.has(j.id) && readOnce.has(j.id)).length;
  const todo = cut.filter((j) => !done.has(j.id) && !readOnce.has(j.id));
  // the first call only: how many cut descriptions sit on billed jobs, which are left alone
  let billed = 0;
  if (done.size === 0) {
    const b = await db.get<{ description?: string | null }>(`pact_jobs?canceled=not.is.true&or=(invoice_sent.not.is.null,received.is.true,paid_date.not.is.null)&select=description&limit=${PAGE}`);
    billed = b.rows.filter((r) => looksCut(r.description || "")).length;
  }
  if (todo.length && readsThisHour(uid).length >= READS_AN_HOUR) {
    return NextResponse.json({ error: "Reading limit reached for this hour (60 PDFs), try again later" }, { status: 429 });
  }
  const batch = todo.slice(0, limit);
  // the PDFs of this batch only: the attachments lists are the heavy part of a job row
  const pdfPath = new Map<string, string>();
  if (batch.length) {
    const atts = await db.get<{ id: string; attachments?: unknown }>(`pact_jobs?id=in.(${batch.map((j) => j.id).join(",")})&select=id,attachments`);
    for (const a of atts.rows) pdfPath.set(a.id, pdfOf(a.id, a.attachments));
  }
  const label = (j: Job) => `PO ${(j.po_number || j.job_number || "").replace(/^PO#?\s*/i, "").trim() || j.id.slice(0, 8)}`;
  const fixed: { id: string; po: string; before: string; after: string; crewRows: number }[] = [];
  const kept: { id: string; po: string; why: string }[] = [];
  const keep = (j: Job, why: string) => kept.push({ id: j.id, po: label(j), why });
  const url = env("NEXT_PUBLIC_SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY");
  const started = Date.now();
  const left = () => BUDGET_MS - (Date.now() - started);
  let checked = 0;
  for (const j of batch) {
    // the rest next call: a job not reached is neither checked nor done
    if (left() < MIN_READ_MS + 5_000) break;
    if (readsThisHour(uid).length >= READS_AN_HOUR) break; // the next call answers 429
    done.add(j.id); checked++;
    const path = pdfPath.get(j.id) || "";
    if (!path) { keep(j, "no PO PDF on the job"); continue; }
    let target: URL | null = null;
    try { target = new URL(`${url}/storage/v1/object/docs/${seg(path)}`); } catch { target = null; }
    if (!target || !target.pathname.startsWith("/storage/v1/object/docs/pact/")) { keep(j, "the PDF couldn't be opened"); continue; }
    const r = await fetch(target, { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" }).catch(() => null);
    const bytes = r && r.ok ? await r.arrayBuffer().catch(() => null) : null;
    if (!bytes) { keep(j, "the PDF couldn't be opened"); continue; }
    // the read gets what is left of the budget; too little for a proper read, and the job waits for the next call
    const ms = Math.min(READ_MS, left() - 4_000);
    if (ms < MIN_READ_MS) { done.delete(j.id); checked--; break; }
    readOnce.add(j.id); readsThisHour(uid).push(Date.now());
    let fresh = "", byRules = "";
    try {
      const read = await readPoBytes(bytes, ms);
      fresh = read.fields.desc || read.fields.scope || "";
      if (read.readBy === "rules") byRules = ` (read by the rules${read.note ? `: ${read.note.replace(/\s*[\u2014\u2013]\s*/g, ", ")}` : ", Claude isn't switched on"})`;
    } catch { keep(j, "the PDF couldn't be read"); continue; }
    const old = j.description || "";
    const better = betterDescription(old, fresh);
    if (!better) { keep(j, keptWhy(old, fresh) + byRules); continue; }
    // onto the job, only while it still says what was read: an office edit in between wins
    const saved = await db.patchRows<{ id: string }>(`pact_jobs?id=eq.${j.id}&description=eq.${encodeURIComponent(old)}`, { description: better });
    if (!saved.ok) { keep(j, "the save didn't take"); continue; }
    if (!saved.rows.length) { keep(j, "changed since it was read, left alone"); continue; }
    // the crew rows that carried the cut copy follow, matched on the words
    // and not the spacing (a crew row holds lib/pactCrew's squashed form, a
    // trailing or doubled space on the job never reaches it); a work line the
    // office wrote in the crew panel is its own and stays
    const rows = (await db.get<{ id: string; description?: string | null }>(`schedule_days?pact_job_id=eq.${j.id}&select=id,description`)).rows;
    const ids = rows.filter((row) => squash(row.description || "") === squash(old)).map((row) => encodeURIComponent(row.id));
    const crewRows = ids.length ? (await db.patchRows<{ id: string }>(`schedule_days?id=in.(${ids.join(",")})`, { description: better })).rows.length : 0;
    fixed.push({ id: j.id, po: label(j), before: old, after: better, crewRows });
  }
  const remaining = todo.filter((j) => !done.has(j.id)).length;
  return NextResponse.json({ ok: true, checked, fixed, kept, remaining, skipped: { billed, readBefore }, done: [...done] });
}
