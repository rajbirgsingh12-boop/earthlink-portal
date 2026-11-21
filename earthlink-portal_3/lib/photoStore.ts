// Server-only: the database and the photo storage as the portal itself, with
// SUPABASE_SERVICE_ROLE_KEY — for the photos the crew texts in, when nobody is
// signed in (Twilio is calling), and for the office's "put them on this job".
// Every caller checks who is asking before it gets here.
import type { JobKey } from "./smsIn";
import { pileFolder, pileOf } from "./media";
import { twilioConfigured } from "./twilio";

const env = (k: string) => process.env[k] || "";
export interface Photo { name: string; path: string }
export interface Batch {
  id: string; employee_id?: string | null; from_phone?: string | null; body?: string | null; photos?: Photo[] | null;
  status?: string | null; pact_job_id?: string | null; release_id?: string | null; created_at?: string | null;
  how?: string | null; // how it got to its job: number (named in a text), burst (sent with one that did), day (the one job that day), office
}
export type Target = Pick<JobKey, "kind" | "id" | "label" | "street" | "apt">;

export function serviceDb() {
  const url = env("NEXT_PUBLIC_SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  const H = { apikey: key, Authorization: `Bearer ${key}` };
  const J = { ...H, "Content-Type": "application/json" };
  const seg = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  const db = {
    async get<T>(path: string): Promise<{ ok: boolean; rows: T[] }> {
      const r = await fetch(`${url}/rest/v1/${path}`, { headers: H, cache: "no-store" }).catch(() => null);
      return r && r.ok ? { ok: true, rows: ((await r.json().catch(() => [])) as T[]) || [] } : { ok: false, rows: [] };
    },
    async insert(table: string, row: Record<string, unknown>): Promise<boolean> {
      const st = await db.insertStatus(table, row);
      return st >= 200 && st < 300;
    },
    // the same, saying how it went: 201 in, 409 a twin already there, 400 a column this database doesn't have yet, 0 unreachable
    async insertStatus(table: string, row: Record<string, unknown>): Promise<number> {
      const r = await fetch(`${url}/rest/v1/${table}`, { method: "POST", headers: { ...J, Prefer: "return=minimal" }, body: JSON.stringify(row) }).catch(() => null);
      return r ? r.status : 0;
    },
    async patch(path: string, row: Record<string, unknown>): Promise<boolean> {
      const r = await fetch(`${url}/rest/v1/${path}`, { method: "PATCH", headers: { ...J, Prefer: "return=minimal" }, body: JSON.stringify(row) }).catch(() => null);
      return !!r && r.ok;
    },
    // the same, handing back the rows it changed: none with ok means the
    // filter matched nothing (the row moved on since it was read), which a
    // plain patch answers 204 to and can't tell from a save that took
    async patchRows<T>(path: string, row: Record<string, unknown>): Promise<{ ok: boolean; rows: T[] }> {
      const r = await fetch(`${url}/rest/v1/${path}`, { method: "PATCH", headers: { ...J, Prefer: "return=representation" }, body: JSON.stringify(row) }).catch(() => null);
      return r && r.ok ? { ok: true, rows: ((await r.json().catch(() => [])) as T[]) || [] } : { ok: false, rows: [] };
    },
    async upload(path: string, bytes: ArrayBuffer, type: string): Promise<boolean> {
      const r = await fetch(`${url}/storage/v1/object/docs/${seg(path)}`, {
        method: "POST", headers: { ...H, "Content-Type": type || "application/octet-stream", "x-upsert": "true", "cache-control": "3600" }, body: bytes,
      }).catch(() => null);
      return !!r && r.ok;
    },
    async move(from: string, to: string): Promise<boolean> {
      const r = await fetch(`${url}/storage/v1/object/move`, { method: "POST", headers: J, body: JSON.stringify({ bucketId: "docs", sourceKey: from, destinationKey: to }) }).catch(() => null);
      return !!r && r.ok;
    },
    async remove(paths: string[]): Promise<boolean> {
      if (!paths.length) return true;
      const r = await fetch(`${url}/storage/v1/object/docs`, { method: "DELETE", headers: J, body: JSON.stringify({ prefixes: paths }) }).catch(() => null);
      return !!r && r.ok;
    },
    // pictures onto one job and off another, in one step in the database
    // (RUN_ME section 20); before that section, read-and-write like the pages do
    async attach(t: { kind: "pact" | "rel"; id: string }, add: Photo[], drop: string[]): Promise<boolean> {
      const r = await fetch(`${url}/rest/v1/rpc/texted_photos_put`, {
        method: "POST", headers: J,
        body: JSON.stringify({ p_pact: t.kind === "pact" ? t.id : null, p_rel: t.kind === "rel" ? t.id : null, p_add: add, p_drop: drop }),
      }).catch(() => null);
      if (r && r.ok) return (await r.json().catch(() => false)) === true;
      const table = t.kind === "pact" ? "pact_jobs" : "releases";
      const cur = await db.get<{ attachments?: Photo[] | null }>(`${table}?id=eq.${t.id}&select=attachments`);
      if (!cur.ok || !cur.rows.length) return false;
      const gone = new Set([...drop, ...add.map((a) => a.path)]);
      const list = [...(Array.isArray(cur.rows[0].attachments) ? cur.rows[0].attachments : []).filter((a) => !gone.has(a?.path)), ...add];
      return db.patch(`${table}?id=eq.${t.id}`, { attachments: list });
    },
  };
  return db;
}
export type Db = NonNullable<ReturnType<typeof serviceDb>>;

// where a job's pictures live: PACT jobs under pact/<job>/, releases under
// <release>/, each pile in its own folder: before/, after/, noaccess/ (lib/media)
export const folderOf = (t: { kind: "pact" | "rel"; id: string }) => (t.kind === "pact" ? `pact/${t.id}/` : `${t.id}/`);
export const pileDir = (t: { kind: "pact" | "rel"; id: string }, pile: "before" | "after" | "noaccess") => pileFolder(folderOf(t), pile);
export const inboxOf = (batchId: string) => `inbox/${batchId}/`;

// One move of a batch at a time. The row is claimed first: its `how` becomes
// "moving" while its status and `how` are still what the caller read. Two
// requests moving the same pictures at once (AFTER texted while the pictures
// were still coming in, and both saw them) would otherwise each take the
// other's files off the job's list. A batch another request is moving is
// waited for and read again: what it holds then is what moves (often
// nothing: it's where it should be already). Null: the batch is gone.
const MOVING = "moving";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function claimBatch(db: Db, b: Batch): Promise<{ row: Batch; had: string | null | undefined } | null> {
  let cur: Batch = b;
  for (let i = 0; i < 30; i++) {
    if (cur.how !== MOVING) {
      const howIs = cur.how === null || cur.how === undefined ? "how=is.null" : `how=eq.${encodeURIComponent(cur.how)}`;
      const got = await db.patchRows<Batch>(`texted_photos?id=eq.${cur.id}&status=eq.${encodeURIComponent(cur.status || "")}&${howIs}`, { how: MOVING });
      // (a database that can't say what it changed: moved as before, unclaimed)
      if (!got.ok) return { row: cur, had: cur.how ?? null };
      if (got.rows.length) return { row: { ...got.rows[0], how: cur.how }, had: cur.how ?? null };
    }
    if (i) await pause(200);
    const fresh = (await db.get<Batch>(`texted_photos?id=eq.${cur.id}&select=*`)).rows[0];
    if (!fresh || (fresh.status !== "held" && fresh.status !== "filed")) return null;
    cur = fresh;
  }
  // still "moving" after six seconds: the request that was moving it went away
  return { row: cur, had: undefined };
}

// A batch onto a job: the pictures move into that job's folder and onto its
// documents, and off the job they were on before (if they were). Returns how
// many made it. The new job lists them first, so a failure there leaves
// everything where it was; a picture that won't move (taken off the old job by
// hand since) comes back off the new job's list.
// `kind`: onto a PACT job, the pile the job's thread puts them on now
// (before / after) — not the one guessed when they were held with no job.
// `out.already`: nothing had to move (another request had just put them
// there); `out.changed`: the batch went somewhere else since the caller read
// it (the office's Wrong job?, or another text of the worker's at the same
// moment), so nothing moved here: the caller reads it again and decides again;
// `out.from`: the job it was taken off.
export type FileOut = { already?: boolean; changed?: boolean; from?: { kind: "pact" | "rel"; id: string } | null };
export async function fileBatch(db: Db, b0: Batch, t: Target, how = "office", kind?: "before" | "after" | "noaccess", out?: FileOut): Promise<number> {
  if (!(Array.isArray(b0.photos) ? b0.photos : []).some((p) => p && p.name && p.path)) return 0;
  const claim = await claimBatch(db, b0);
  if (!claim) { if (out) out.changed = true; return 0; }
  const b = claim.row;
  // (the `how` it ends with is never the claim's own mark)
  const real = (h?: string | null) => (h === MOVING ? null : h ?? null);
  const finalHow = how === MOVING ? real(claim.had) ?? "day" : how;
  // (put back as it was when nothing could move)
  const letGo = () => db.patch(`texted_photos?id=eq.${b.id}&how=eq.${MOVING}`, { how: claim.had === undefined ? finalHow : real(claim.had) });
  const photos = Array.isArray(b.photos) ? b.photos.filter((p) => p && p.name && p.path) : [];
  if (!photos.length) { await letGo(); return 0; }
  // each one into its pile's folder on the job: the pile given, else the one its name says
  const dirOf = (name: string) => { const pile = kind || pileOf({ name }); return pile === "other" ? folderOf(t) : pileDir(t, pile); };
  const was = b.status === "filed" ? (b.pact_job_id ? { kind: "pact" as const, id: b.pact_job_id } : b.release_id ? { kind: "rel" as const, id: b.release_id } : null) : null;
  const same = !!was && was.kind === t.kind && was.id === t.id;
  const named = (n: string) => (kind ? n.replace(/^(before|after|noaccess)_/i, `${kind}_`) : n);
  const want = photos.map((p) => ({ from: p.path, name: named(p.name), to: dirOf(named(p.name)) + named(p.name) }));
  const moving = want.filter((w) => w.from !== w.to);
  if (same && moving.length === 0) {
    if (out) out.already = true;
  } else {
    // moved since the caller read it (to another job, out of the inbox, onto the other pile): not this caller's to move
    const paths = (x: Batch) => (Array.isArray(x.photos) ? x.photos : []).map((p) => p?.path || "").sort().join("|");
    const jobOf = (x: Batch) => (x.status === "filed" ? x.pact_job_id || x.release_id || "" : "");
    if (b.status !== b0.status || jobOf(b) !== jobOf(b0) || paths(b) !== paths(b0)) { await letGo(); if (out) out.changed = true; return 0; }
    if (!(await db.attach(t, want.map((w) => ({ name: w.name, path: w.to })), []))) { await letGo(); return 0; }
  }
  if (out) out.from = was && !same ? was : null;
  const stuck: string[] = [];
  const left: string[] = [];
  for (const w of moving) {
    if (await db.move(w.from, w.to)) left.push(w.from); else stuck.push(w.to);
  }
  if (stuck.length) await db.attach(t, [], stuck);
  const placed = want.filter((w) => !stuck.includes(w.to)).map((w) => ({ name: w.name, path: w.to }));
  if (!placed.length) { await letGo(); return 0; }
  const row = { status: "filed", photos: placed, how: finalHow, pact_job_id: t.kind === "pact" ? t.id : null, release_id: t.kind === "rel" ? t.id : null };
  // (tried twice: the pictures are on the job now, and the row is how the next move finds them)
  if (!(await db.patch(`texted_photos?id=eq.${b.id}`, row))) await db.patch(`texted_photos?id=eq.${b.id}`, row);
  // a picture that wouldn't move out of the inbox waits on a row of its own
  // for the office, so it's never left on no list
  const stuckFrom = new Set(moving.filter((w) => stuck.includes(w.to)).map((w) => w.from));
  if (stuckFrom.size && b.status === "held") {
    await db.insert("texted_photos", { employee_id: b.employee_id ?? null, from_phone: b.from_phone ?? null, body: b.body ?? "", status: "held", how: real(claim.had), photos: photos.filter((p) => stuckFrom.has(p.path)) });
  }
  // off the job they were on (tried twice: a stale entry there would point at
  // nothing). The same job too, when they were renamed onto the other pile:
  // the old names are the files that moved
  if (was && left.length && !(await db.attach(was, [], left))) await db.attach(was, [], left);
  return placed.length;
}

// A batch off its job, back in the inbox to wait (a door's picture: which
// door, the worker is asked). The job's list loses them; one that won't move
// stays on the job on a row of its own. Returns how many wait.
export async function holdBatch(db: Db, b0: Batch, how: string): Promise<number> {
  const claim = await claimBatch(db, b0);
  if (!claim) return 0;
  const b = claim.row;
  const real = (h?: string | null) => (h === MOVING ? null : h ?? null);
  const photos = (Array.isArray(b.photos) ? b.photos : []).filter((p) => p && p.name && p.path);
  if (b.status === "held") return (await db.patch(`texted_photos?id=eq.${b.id}`, { how })) ? photos.length : 0;
  const letGo = () => db.patch(`texted_photos?id=eq.${b.id}&how=eq.${MOVING}`, { how: claim.had === undefined ? "day" : real(claim.had) });
  const was = b.pact_job_id ? { kind: "pact" as const, id: b.pact_job_id } : b.release_id ? { kind: "rel" as const, id: b.release_id } : null;
  if (!was || !photos.length) { await letGo(); return 0; }
  const inbox = inboxOf(b.id);
  const kept: Photo[] = [], left: string[] = [], stuck: Photo[] = [];
  for (const p of photos) {
    if (await db.move(p.path, inbox + p.name)) { kept.push({ name: p.name, path: inbox + p.name }); left.push(p.path); } else stuck.push(p);
  }
  if (!kept.length) { await letGo(); return 0; }
  const row = { status: "held", how, photos: kept, pact_job_id: null, release_id: null };
  if (!(await db.patch(`texted_photos?id=eq.${b.id}`, row))) await db.patch(`texted_photos?id=eq.${b.id}`, row);
  if (stuck.length) await db.insert("texted_photos", { employee_id: b.employee_id ?? null, from_phone: b.from_phone ?? null, body: b.body ?? "", status: "filed", how: real(claim.had) ?? "day", photos: stuck, pact_job_id: b.pact_job_id ?? null, release_id: b.release_id ?? null });
  if (!(await db.attach(was, [], left))) await db.attach(was, [], left);
  return kept.length;
}

// Throw away a batch nobody could place. A batch already on a job is the
// job's now — its pictures are taken off from the job's own Documents, never here.
export async function dropBatch(db: Db, b: Batch): Promise<boolean> {
  if (b.status !== "held") return false;
  const paths = (Array.isArray(b.photos) ? b.photos : []).map((p) => p?.path).filter((p): p is string => !!p && p.startsWith("inbox/"));
  await db.remove(paths);
  return db.patch(`texted_photos?id=eq.${b.id}`, { status: "gone" });
}

// Is a photo texted back going anywhere? The company number sends texts, the
// portal can write without anyone signed in, and a text has come in through
// Twilio at least once (so the number is pointed here). Until all three, a
// crew text doesn't ask for photos. A yes is remembered for ten minutes; a
// no is looked up again every time, so the first text in switches it on
// for the very next send.
let onCache: { at: number; on: boolean } | null = null;
export async function photosBackOn(): Promise<boolean> {
  if (onCache && onCache.on && Date.now() - onCache.at < 10 * 60_000) return true;
  const db = serviceDb();
  let on = false;
  if (db && twilioConfigured() && env("TWILIO_AUTH_TOKEN")) {
    const r = await db.get<{ id: string }>("texted_photos?select=id&limit=1");
    // a read that failed just now says nothing: the last answer stands (and a
    // first-ever failure leans to asking, which costs nothing if nobody answers)
    if (!r.ok) return onCache ? onCache.on : true;
    on = r.rows.length > 0;
  }
  onCache = { at: Date.now(), on };
  return on;
}
export const photosBackReady = () => !!(serviceDb() && env("TWILIO_AUTH_TOKEN"));
