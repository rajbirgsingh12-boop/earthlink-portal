// Server-only: the database and the photo storage as the portal itself, with
// SUPABASE_SERVICE_ROLE_KEY — for the photos the crew texts in, when nobody is
// signed in (Twilio is calling), and for the office's "put them on this job".
// Every caller checks who is asking before it gets here.
import type { JobKey } from "./smsIn";
import { twilioConfigured } from "./twilio";

const env = (k: string) => process.env[k] || "";
export interface Photo { name: string; path: string }
export interface Batch {
  id: string; employee_id?: string | null; from_phone?: string | null; body?: string | null; photos?: Photo[] | null;
  status?: string | null; pact_job_id?: string | null; release_id?: string | null; created_at?: string | null;
}
export type Target = Pick<JobKey, "kind" | "id" | "label">;

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
      const r = await fetch(`${url}/rest/v1/${table}`, { method: "POST", headers: { ...J, Prefer: "return=minimal" }, body: JSON.stringify(row) }).catch(() => null);
      return !!r && r.ok;
    },
    async patch(path: string, row: Record<string, unknown>): Promise<boolean> {
      const r = await fetch(`${url}/rest/v1/${path}`, { method: "PATCH", headers: { ...J, Prefer: "return=minimal" }, body: JSON.stringify(row) }).catch(() => null);
      return !!r && r.ok;
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

// where a job's pictures live: PACT jobs under pact/<job>/, releases under <release>/
export const folderOf = (t: { kind: "pact" | "rel"; id: string }) => (t.kind === "pact" ? `pact/${t.id}/` : `${t.id}/`);
export const inboxOf = (batchId: string) => `inbox/${batchId}/`;

// A batch onto a job: the pictures move into that job's folder and onto its
// documents, and off the job they were on before (if they were). Returns how
// many made it. A picture already taken off the old job by hand stays gone.
export async function fileBatch(db: Db, b: Batch, t: Target): Promise<number> {
  const photos = Array.isArray(b.photos) ? b.photos.filter((p) => p && p.name && p.path) : [];
  const dir = folderOf(t);
  const was = b.status === "filed" ? (b.pact_job_id ? { kind: "pact" as const, id: b.pact_job_id } : b.release_id ? { kind: "rel" as const, id: b.release_id } : null) : null;
  const same = !!was && was.kind === t.kind && was.id === t.id;
  const placed: Photo[] = [];
  const left: string[] = [];
  for (const p of photos) {
    const dest = dir + p.name;
    if (p.path === dest) { placed.push(p); continue; }
    if (await db.move(p.path, dest)) { placed.push({ name: p.name, path: dest }); left.push(p.path); }
  }
  if (!placed.length) return 0;
  if (!(same && left.length === 0)) {
    if (!(await db.attach(t, placed, []))) return 0;
    if (was && !same && left.length) await db.attach(was, [], left);
  }
  await db.patch(`texted_photos?id=eq.${b.id}`, {
    status: "filed", photos: placed,
    pact_job_id: t.kind === "pact" ? t.id : null, release_id: t.kind === "rel" ? t.id : null,
  });
  return placed.length;
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
// crew text doesn't ask for photos. A yes is remembered for ten minutes, a
// no for twenty seconds — so the first text in switches it on right away.
let onCache: { at: number; on: boolean } | null = null;
export async function photosBackOn(): Promise<boolean> {
  if (onCache && Date.now() - onCache.at < (onCache.on ? 10 * 60_000 : 20_000)) return onCache.on;
  const db = serviceDb();
  let on = false;
  if (db && twilioConfigured() && env("TWILIO_AUTH_TOKEN")) {
    on = (await db.get<{ id: string }>("texted_photos?select=id&limit=1")).rows.length > 0;
  }
  onCache = { at: Date.now(), on };
  return on;
}
export const photosBackReady = () => !!(serviceDb() && env("TWILIO_AUTH_TOKEN"));
