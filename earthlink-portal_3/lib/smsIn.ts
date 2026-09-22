// Photos the crew texts back to the company number. Twilio hands every text
// that comes in to /api/sms-in; this file is the thinking behind that page —
// is the text really from Twilio, which pictures came with it, which job they
// belong on, and what to say back. No database and no network in here, so
// every case can be tried on its own. Server-only (it signs with node:crypto).
import { createHmac, timingSafeEqual } from "crypto";
import { normPo } from "./po";
import { langOf, type Lang } from "./crewText";

export type Params = [string, string][];

// Twilio signs each request: the full address it called, then every form
// field sorted by name with its value run on, HMAC-SHA1 with the account's
// auth token, in base64. Nobody without the token can make one that fits.
export function twilioSignature(token: string, url: string, params: Params): string {
  const sorted = [...params].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return createHmac("sha1", token).update(Buffer.from(url + sorted.map(([k, v]) => k + v).join(""), "utf-8")).digest("base64");
}
// the address can reach us more than one way (a port, a proxy) — any of the
// ones this request could have been sent to will do
export function validTwilio(token: string, urls: string[], params: Params, signature: string): boolean {
  if (!token || !signature) return false;
  const got = Buffer.from(signature);
  return urls.some((u) => {
    const want = Buffer.from(twilioSignature(token, u, params));
    return want.length === got.length && timingSafeEqual(want, got);
  });
}

// the last ten digits: "+1 (917) 555-0123", "9175550123" and "19175550123" are one phone
export const phoneKey = (s?: string | null): string => (s || "").replace(/\D/g, "").slice(-10);

// ---- the pictures that came with the text ----
const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/pjpeg": "jpg", "image/png": "png", "image/gif": "gif",
  "image/webp": "webp", "image/heic": "heic", "image/heif": "heif",
};
export const MAX_MEDIA = 10;
export interface MediaIn { url: string; type: string; ext: string }
// Twilio lists them as MediaUrl0…, MediaContentType0…; a phone sends ten at
// most. Pictures only — a video or a contact card is counted, not kept.
export function mediaIn(get: (k: string) => string | null): { photos: MediaIn[]; other: number } {
  const n = Math.min(MAX_MEDIA, Math.max(0, parseInt(get("NumMedia") || "0", 10) || 0));
  const photos: MediaIn[] = [];
  let other = 0;
  for (let i = 0; i < n; i++) {
    const url = (get(`MediaUrl${i}`) || "").trim();
    const type = (get(`MediaContentType${i}`) || "").trim().toLowerCase().split(";")[0];
    if (url && EXT[type]) photos.push({ url, type, ext: EXT[type] });
    else if (url) other += 1;
  }
  return { photos, other };
}

// ---- which job ----
// A number counts as a job's number when the worker says so ("PO 116843",
// "release 12", "rel#12"), when it is long enough to be a PO (5+ digits), or
// when it is the whole text ("116843", "#12"). "Apt 4B" or "3 photos" never
// sends pictures to release 3 or 4.
export interface Ref { n: string; said: boolean }
export function refsIn(body: string): Ref[] {
  const text = (body || "").replace(/\s+/g, " ").trim();
  const out: Ref[] = [];
  const add = (raw: string, said: boolean) => {
    const n = normPo(raw);
    if (n && !out.some((r) => r.n === n)) out.push({ n, said });
  };
  // the whole text is the number
  const only = text.match(/^(?:(?:p\.?\s*o\.?|release|rel\.?)\s*)?[#:\s-]*(\d{1,12})[.!\s]*$/i);
  if (only) { add(only[1], true); return out; }
  // said out loud: "PO 116843", "po#116843", "release 12", "rel. 12"
  const said = /\b(?:p\.?\s*o\.?|release|rel\.?)\s*(?:number|no\.?|num|#)?\s*[#:\-]?\s*(\d{1,12})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = said.exec(text))) add(m[1], true);
  // long enough to be a PO on its own (one that fits no job is passed over,
  // not asked about — it may be a phone number or a unit)
  const long = /\d{5,12}/g;
  while ((m = long.exec(text))) add(m[0], false);
  return out;
}

export interface MineRow { day: string; pact_job_id?: string | null; release_id?: string | null }
export interface JobKey { kind: "pact" | "rel"; id: string; label: string; keys: string[] }
export type Pick =
  | { kind: "pact" | "rel"; id: string; label: string; why: "number" | "today" | "recent" }
  | { kind: "ask"; why: "none" | "many" | "unknown"; number?: string };

// A PACT job's numbers (PO, job number) and a release's number, stripped the
// way the portal strips a PO — "PO# 09001" is "9001"
// "PO# 220011" is said "PO 220011" — the label is put on here, once
const bare = (s: string, label: RegExp) => s.trim().replace(label, "").trim();
export const pactKey = (j: { id: string; po_number?: string | null; job_number?: string | null }): JobKey => {
  const po = (j.po_number || "").trim(), job = (j.job_number || "").trim();
  return { kind: "pact", id: j.id, label: `PO ${bare(po || job, /^(p\.?\s*o\.?\s*#?|#)\s*/i)}`.trim(), keys: [normPo(po), normPo(job)].filter(Boolean) };
};
export const relKey = (r: { id: string; rel_number?: string | null }): JobKey =>
  ({ kind: "rel", id: r.id, label: `release ${bare(r.rel_number || "", /^(release\s*#?|rel\.?\s*#?|#)\s*/i)}`.trim(), keys: [normPo(r.rel_number)].filter(Boolean) });

// "2026-09-22" minus n days, by the calendar (no clock, no time zone)
export const dayMinus = (iso: string, n: number): string => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
export const RECENT_DAYS = 3;

// Which job the pictures go on:
//  1. a number in the text — one of the jobs this worker is on (a release
//     number means nothing on its own: every contract has a release 12), or
//     any PO in the portal when the number is a PO's (`anyPo`, found by the caller);
//  2. no number: the one job the worker is on today;
//  3. none today: the one job on their last day, if that was in the last three
//     days — photos sent the evening after, or the next morning.
// Two jobs that day, or no job at all, and the office decides.
export function pickJob(body: string, rows: MineRow[], mine: JobKey[], today: string, anyPo: JobKey[] = []): Pick {
  const byId = new Map(mine.map((j) => [j.id, j]));
  const refs = refsIn(body);
  if (refs.length) {
    const hits = new Map<string, JobKey>();
    for (const r of refs) {
      for (const j of mine) if (j.keys.includes(r.n)) hits.set(j.id, j);
      // a PO is one job across the whole portal; a release number is not
      for (const j of anyPo) if (j.kind === "pact" && j.keys.includes(r.n)) hits.set(j.id, j);
    }
    if (hits.size === 1) { const j = [...hits.values()][0]; return { kind: j.kind, id: j.id, label: j.label, why: "number" }; }
    if (hits.size > 1) return { kind: "ask", why: "many" };
    // a number was given out loud and fits nothing: never guess past it
    const told = refs.find((r) => r.said);
    if (told) return { kind: "ask", why: "unknown", number: told.n };
  }
  const jobsOn = (day: string) => {
    const ids = new Set<string>();
    for (const r of rows) {
      if (r.day !== day) continue;
      const id = r.pact_job_id || r.release_id || "";
      if (id && byId.has(id)) ids.add(id);
    }
    return [...ids].map((id) => byId.get(id)!);
  };
  for (let back = 0; back <= RECENT_DAYS; back++) {
    const js = jobsOn(dayMinus(today, back));
    if (js.length === 1) return { kind: js[0].kind, id: js[0].id, label: js[0].label, why: back === 0 ? "today" : "recent" };
    if (js.length > 1) return { kind: "ask", why: "many" };
  }
  return { kind: "ask", why: "none" };
}

// "before" / "antes" in the text puts them with the before pictures; anything
// else is the work done
export const photoKind = (body: string): "before" | "after" => (/\b(before|antes)\b/i.test(body || "") ? "before" : "after");

// after_2026-09-22_183012_jose_x7k2_1.jpg — the kind first (so the job's
// Documents sort them into Before / After), the time, who sent it, and a bit
// of Twilio's message id so two texts in the same second never collide
export function photoName(kind: string, at: Date, first: string, sid: string, i: number, n: number, ext: string): string {
  const stamp = at.toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "");
  const who = (first || "").toLowerCase().normalize("NFD").replace(/[^a-z]/g, "").slice(0, 12) || "crew";
  const tail = (sid || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(-4) || "sms";
  return `${kind}_${stamp}_${who}_${tail}${n > 1 ? `_${i + 1}` : ""}.${ext}`;
}

// ---- what to say back ----
export type Reply =
  | { k: "filed"; n: number; label: string }
  | { k: "held"; n: number }
  | { k: "moved"; n: number; label: string }
  | { k: "unknown"; number: string }
  | { k: "notphoto" }
  | { k: "failed" }
  | { k: "resend" }
  | { k: "stranger"; n: number };
const photos = (n: number, lang: Lang) => (lang === "es" ? (n === 1 ? "1 foto" : `${n} fotos`) : (n === 1 ? "1 photo" : `${n} photos`));
export function replyText(r: Reply, lang0?: string | null): string {
  const lang = langOf(lang0);
  const es = lang === "es";
  switch (r.k) {
    case "filed":
      return es
        ? `Recibido — ${photos(r.n, lang)} ${r.n === 1 ? "quedó" : "quedaron"} en el ${r.label}. ¡Gracias! Si es otro trabajo, responda con el número de PO correcto.`
        : `Got it — ${photos(r.n, lang)} on ${r.label}. Thanks! If that's the wrong job, reply with the right PO number.`;
    case "held":
      return es
        ? `Recibimos ${r.n === 1 ? "su foto" : `sus ${photos(r.n, lang)}`}. ¿De qué trabajo ${r.n === 1 ? "es" : "son"}? Responda con el número de PO o de release.`
        : `Got your ${photos(r.n, lang)}. Which job ${r.n === 1 ? "is it" : "are they"} for? Reply with the PO or release number.`;
    case "moved":
      return es
        ? `Listo — ${r.n === 1 ? "su foto" : `sus ${photos(r.n, lang)}`} ahora ${r.n === 1 ? "está" : "están"} en el ${r.label}.`
        : `Done — your ${photos(r.n, lang)} ${r.n === 1 ? "is" : "are"} on ${r.label} now.`;
    case "unknown":
      return es
        ? `No encontramos el número ${r.number} en sus trabajos. La oficina pondrá sus fotos en el trabajo correcto.`
        : `Couldn't find ${r.number} on your jobs. The office will put your photos on the right job.`;
    case "notphoto":
      return es ? "Solo se guardan fotos en el trabajo — eso no era una foto." : "Only photos go on the job — that wasn't a photo.";
    case "resend":
      return es ? "No supimos de qué trabajo son sus fotos. Por favor envíelas otra vez con el número de PO en el mensaje." : "We couldn't tell which job your photos are for. Please send them again with the PO number in the text.";
    case "failed":
      return es ? "Sus fotos no llegaron bien. Por favor envíelas otra vez." : "Your photos didn't come through. Please send them again.";
    case "stranger":
      // nobody knows this phone's language yet: both
      return r.n > 0
        ? "Earth Link: got your photos. This phone isn't on the crew list yet, so the office will put them on the job. / Recibimos sus fotos. Este teléfono aún no está en la lista del equipo; la oficina las pondrá en el trabajo."
        : "Earth Link: this number takes job photos from the crew. This phone isn't on the crew list — ask the office to add it. / Este número recibe fotos de trabajo del equipo. Este teléfono no está en la lista; pida a la oficina que lo agregue.";
  }
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
// what Twilio sends back to the phone: the reply, or nothing at all
export const twiml = (msg?: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Response>${msg ? `<Message>${xml(msg)}</Message>` : ""}</Response>`;
