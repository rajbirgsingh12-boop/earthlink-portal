// The office's side of the photos the crew texts in: put a batch on a job
// (one the portal couldn't place, or one that landed on the wrong job),
// throw away a batch nobody could place, or clear a "nobody home" notice. The sign-in is checked first —
// admin or office only — and then the portal moves the pictures itself,
// since they sit in a folder no one's own sign-in can move out of.
import { NextResponse } from "next/server";
import { pactKey, relKey } from "@/lib/smsIn";
import { dropBatch, fileBatch, serviceDb, type Batch, type FileOut } from "@/lib/photoStore";
import { allDoneSaid, crewEndedText, kindOfName, mixedCaption, notDone, photoKindFor, type PhotoKind } from "@/lib/jobFlow";
import { clearDoneIfNoAfter, closeQuestion, endEarly, firstName, markDone, nyDay, onLastDay, threadJob, type Emp, type ThreadJob } from "@/lib/jobThread";
import { currentWorkDay } from "@/lib/workDays";
import { jobName } from "@/lib/crewText";

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
  let body: { id?: string; action?: string; pact_job_id?: string; release_id?: string; paths?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Bad request" }, { status: 400 }); }
  // a crew picture the office deleted from a job's Documents: off the texted
  // batch that brought it too, so its card counts what's there (a batch with
  // nothing left goes off the list), and off a "nobody home" notice that
  // shows it (the notice itself stays up)
  if (body.action === "gone") {
    const jobId = body.pact_job_id || body.release_id || "";
    const paths = (Array.isArray(body.paths) ? body.paths : []).filter((x): x is string => typeof x === "string" && !!x && x.length < 500).slice(0, 50);
    if (!uuid.test(jobId) || !paths.length) return NextResponse.json({ error: "Bad request" }, { status: 400 });
    const col = body.pact_job_id ? "pact_job_id" : "release_id";
    const rows = (await db.get<Batch>(`texted_photos?${col}=eq.${jobId}&status=in.(filed,nobody,opened,seen)&select=id,status,photos&limit=200`)).rows;
    for (const r of rows) {
      const had = r.photos || [];
      const left = had.filter((x) => !paths.includes(x?.path || ""));
      if (left.length === had.length) continue;
      const st = encodeURIComponent(r.status || "");
      await db.patch(`texted_photos?id=eq.${r.id}&status=eq.${st}`, left.length || r.status !== "filed" ? { photos: left } : { photos: left, status: "gone" });
    }
    return NextResponse.json({ ok: true });
  }
  if (!body.id || !uuid.test(body.id)) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const b = (await db.get<Batch>(`texted_photos?id=eq.${body.id}&select=*`)).rows[0];
  if (!b) return NextResponse.json({ error: "Those photos aren't there any more" }, { status: 404 });

  // a "nobody home" notice, a crew reply, or a texted measurement the office has seen
  if (body.action === "seen") {
    if (!["nobody", "reply", "measure", "done"].includes(b.status || "")) return NextResponse.json({ error: "Nothing to clear there" }, { status: 409 });
    return (await db.patch(`texted_photos?id=eq.${b.id}`, { status: "seen" })) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Couldn't clear it, try again" }, { status: 500 });
  }
  if (body.action === "throw") {
    if (b.status !== "held") return NextResponse.json({ error: "These are on a job already: take them off from the job's Documents" }, { status: 409 });
    return (await dropBatch(db, b)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Couldn't throw them away, try again" }, { status: 500 });
  }
  if (body.action !== "file") return NextResponse.json({ error: "Bad request" }, { status: 400 });
  if (b.status !== "held" && b.status !== "filed") return NextResponse.json({ error: "Those photos were thrown away" }, { status: 409 });
  let target;
  // onto a PACT job: a batch already on a job keeps its pile; one waiting is
  // BEFORE unless the worker said AFTER (lib/jobFlow photoKindFor); a door's
  // picture ("nobody home") stays the door's, in Nobody home
  let kind: PhotoKind | "noaccess" | undefined;
  const door = b.how === "noaccess" || (b.photos || []).some((p) => /^noaccess/i.test(p?.name || ""));
  let thread: ThreadJob | null = null;
  const now = new Date();
  const today = nyDay(now);
  if (body.pact_job_id && uuid.test(body.pact_job_id)) {
    thread = await threadJob(db, body.pact_job_id);
    if (thread) target = pactKey(thread);
  } else if (body.release_id && uuid.test(body.release_id)) {
    const r = (await db.get<{ id: string; rel_number?: string }>(`releases?id=eq.${body.release_id}&select=id,rel_number`)).rows[0];
    if (r) target = relKey(r);
  }
  if (!target) return NextResponse.json({ error: "That job isn't in the portal" }, { status: 404 });
  // a batch already on a job (Wrong job?) keeps its own pile: it was sorted when it came in
  const own = b.status === "filed" ? kindOfName((b.photos || [])[0]?.name || "") : null;
  // one waiting goes where its words (or an AFTER or DONE texted with it) put it: BEFORE unless they said AFTER
  kind = door ? "noaccess" : own || (b.how === "after" || b.how === "afterall" ? "after" : photoKindFor(b.body || ""));
  // (a door's picture keeps its mark wherever it goes: the crew's next texts know it for one)
  const st: FileOut = {};
  const n = await fileBatch(db, b, target, door ? "noaccess" : "office", kind, st);
  // (the worker's own text moved them a moment ago: the card shows where they are now)
  if (st.changed) return NextResponse.json({ error: "Those photos just moved. Look again before moving them" }, { status: 409 });
  if (!n) return NextResponse.json({ error: "Couldn't move the photos, try again" }, { status: 500 });
  // the job they left: marked done by these, it isn't any more
  const was = st.from?.kind === "pact" ? st.from.id : "";
  if (was) await clearDoneIfNoAfter(db, was, jobName(target, "en"), now, today, (b.photos || []).some((p) => /^after/i.test(p?.name || "")));
  // after pictures on the job's last day: the job is work done, as when the worker texts them
  let marked = false;
  // ("not done yet" or "kitchen done, starting the bath" with them: not marked; the office sees the words)
  if (thread && kind === "after" && b.employee_id && !notDone(b.body || "") && !mixedCaption(b.body || "")) {
    await closeQuestion(db, thread.id);
    const emp = (await db.get<Emp>(`employees?id=eq.${b.employee_id}&select=id,name,phone,lang,active`)).rows[0];
    // the day they were texted, not the day the office moved them: that day's job, finished on its work day
    const sent = b.created_at ? nyDay(new Date(b.created_at)) : today;
    const day = sent < today ? sent : today;
    const before = onLastDay(thread, day).before;
    // ALL DONE said about them (a job of several days, before its last): the
    // days after that day come off and its crew hears it, as when the number places them
    if (emp && before && (b.how === "afterall" || allDoneSaid(b.body || ""))) {
      const emps = (await db.get<Emp>("employees?select=id,name,phone,lang,active")).rows;
      const key = pactKey(thread);
      await endEarly(db, thread, { emp, emps, now, today: day, tell: true, words: (e, d) => crewEndedText(firstName(e), jobName(key, e.lang), d, e.lang) });
      marked = await markDone(db, thread, emp, { from: b.from_phone || "", now, finish: day });
    } else if (emp && !before) marked = await markDone(db, thread, emp, { from: b.from_phone || "", now, finish: currentWorkDay(thread.start_date, thread.work_days, day) });
  }
  return NextResponse.json({ ok: true, n, label: target.label, marked });

}
