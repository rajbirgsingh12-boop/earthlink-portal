// Photos the crew texts back to the company number. Twilio hands every text
// that comes in to /api/sms-in; this file is the thinking behind that page —
// is the text really from Twilio, which pictures came with it, which job they
// belong on, and what to say back. No database and no network in here, so
// every case can be tried on its own. Server-only (it signs with node:crypto).
import { createHmac, timingSafeEqual } from "crypto";
import { normPo } from "./po";
import { AFTER_HOW, atJob, langOf, plainDash, streetOf, type Lang } from "./crewText";
import { extOfType, mediaWords } from "./media";

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

// the whole number with its country code: "+1 (917) 555-0123", "9175550123"
// and "19175550123" are one US phone — but +91 91755 50123 is someone else
export const phoneKey = (s?: string | null): string => {
  const d = (s || "").replace(/\D/g, "");
  if (d.length === 10) return `1${d}`;
  return d.length >= 11 ? d : "";
};
// A text with no pictures that is just a job's number ("220011", "PO 220011",
// "wrong job, it's PO 220011", "220011 thanks"): the worker answering "which
// job?" or fixing one. The whole text has to be that. A text that names a PO
// on the way to saying something else ("On my way to PO 116843", "PO 220011
// done") is talk, and moves nothing that was already placed.
const FIX_LEAD = String.raw`(?:wrong(?: job| one| po)?|it'?s|it is|its|is|that'?s|that is|the right one is|right one is|the right po is|correct (?:po|one|job) is|should be|job|number|es el|es|era el|el correcto es|el|el numero|numero|trabajo|trabajo equivocado|equivocado|equivocada)`;
// (a PO with a dash or a letter, the way the texts print it, "220011-2", "A220011", is one too)
const FIX_ONLY = new RegExp(String.raw`^(?:${FIX_LEAD}[\s,:.\-]*)*(?:(?:p\.?\s*o\.?|release|rel\.?)\s*(?:number|no\.?|num|#)?\s*[#:\-]?\s*|#\s*)?(?:\d{1,12}|[a-z]?\d{4,12}-[\da-z]{1,3}|[a-z]\d{4,11})[\s.!]*(?:(?:thanks|thank you|thx|ty|gracias)[\s.!]*)?$`);
// the job's place in brackets after its number, the way the portal's own
// question lists it ("116843 (2205 Linden Blvd, Apt 4B)", "12 (392 Blake
// Avenue)"): an answer copied from it is the number
export const noPlace = (body: string): string => (body || "").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
export const justANumber = (body: string): boolean =>
  refsIn(noPlace(body)).length > 0 && FIX_ONLY.test(noPlace(body).toLowerCase().replace(/[\u2018\u2019`]/g, "'").trim());

// ---- the pictures (and videos) that came with the text ----
export const MAX_MEDIA = 10;
export interface MediaIn { url: string; type: string; ext: string }
// Twilio lists them as MediaUrl0…, MediaContentType0…; a phone sends ten at
// most. Pictures and videos are kept; anything else (a contact card, a voice
// note) is counted, not kept.
// the file ending for a picture's or a video's type, or "" for anything else
export const imageExt = (type: string): string => extOfType(type);
export function mediaIn(get: (k: string) => string | null): { photos: MediaIn[]; other: number } {
  const n = Math.min(MAX_MEDIA, Math.max(0, parseInt(get("NumMedia") || "0", 10) || 0));
  const photos: MediaIn[] = [];
  let other = 0;
  for (let i = 0; i < n; i++) {
    const url = (get(`MediaUrl${i}`) || "").trim();
    const type = (get(`MediaContentType${i}`) || "").trim().toLowerCase().split(";")[0];
    const ext = extOfType(type);
    if (url && ext) photos.push({ url, type, ext });
    else if (url) other += 1;
  }
  return { photos, other };
}

// ---- which job ----
// A number counts as a job's number when the worker says so ("PO 116843",
// "release 12", "rel#12"), when it is long enough to be a PO (5+ digits), or
// when it is the whole text ("116843", "#12"). "Apt 4B" or "3 photos" never
// sends pictures to release 3 or 4.
export interface Ref { n: string; said: boolean; bare?: boolean }   // bare: the whole text is a number with no PO/release/# in front
export function refsIn(body: string): Ref[] {
  const text = (body || "").replace(/\s+/g, " ").trim();
  const out: Ref[] = [];
  const add = (raw: string, said: boolean, bare = false) => {
    const n = normPo(raw);
    if (n && !out.some((r) => r.n === n)) out.push(bare ? { n, said, bare } : { n, said });
  };
  // the whole text is the number (a PO with a dash or a letter in it too, "220011-2", "A220011")
  const only = text.match(/^((?:p\.?\s*o\.?|release|rel\.?)\s*)?([#:\s-]*)([A-Za-z]?\d{4,12}-[\dA-Za-z]{1,3}|[A-Za-z]\d{4,11}|\d{1,12})[.!\s]*$/i);
  if (only) { add(only[3], true, !only[1] && !only[2].includes("#")); return out; }
  // said out loud: "PO 116843", "po#116843", "release 12", "rel. 12", "PO220011-2", "release 12-A"
  const said = /\b(?:p\.?\s*o\.?|release|rel\.?)\s*(?:number|no\.?|num|#)?\s*[#:\-]?\s*([a-z]?\d{1,12}(?:-[\da-z]{1,3})?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = said.exec(text))) add(m[1], true);
  // long enough to be a PO on its own (one that fits no job is passed over,
  // not asked about — it may be a phone number or a unit)
  // (not the digits of a PO with a letter in front, A220011, or a dash and its release number or letter
  // after it, 220011-2: those are read whole, below; a word or an apartment after the dash, 116843-after,
  // 116843-4B, leaves the PO)
  const long = /(?:^|[^A-Za-z\d]|[A-Za-z]{2})(\d{5,12})(?!\d|-(?:\d{1,3}|[A-Za-z])\b)/g;
  while ((m = long.exec(text))) add(m[1], false);
  // a PO with a letter or a dash in it ("A220011", "220011-2"), the way its key reads
  // (four digits at least: "coats 1-2" is never release 12)
  const whole = /\b[A-Za-z]?\d{4,12}(?:-[\dA-Za-z]+)+\b|\b[A-Za-z]\d{4,11}\b/g;
  while ((m = whole.exec(text))) add(m[0], false);
  return out;
}

export interface MineRow { day: string; pact_job_id?: string | null; release_id?: string | null; texted_at?: string | null; address?: string | null }
// street and apt: where the job is, so a reply names it the way the crew knows it (lib/crewText jobName)
export interface JobKey { kind: "pact" | "rel"; id: string; label: string; keys: string[]; street?: string; apt?: string }
export type Pick =
  | { kind: "pact" | "rel"; id: string; label: string; street?: string; apt?: string; why: "number" | "today" | "recent" | "told" }
  | { kind: "ask"; why: "none" | "many" | "unknown"; number?: string };

// A PACT job's numbers (PO, job number) and a release's number, stripped the
// way the portal strips a PO — "PO# 09001" is "9001"
// "PO# 220011" is said "PO 220011" — the label is put on here, once
const bare = (s: string, label: RegExp) => s.trim().replace(label, "").trim();
export const pactKey = (j: { id: string; po_number?: string | null; job_number?: string | null; address?: string | null; development?: string | null; property_unit?: string | null }): JobKey => {
  const po = (j.po_number || "").trim(), job = (j.job_number || "").trim();
  return {
    kind: "pact", id: j.id, label: `PO ${bare(plainDash(po || job), /^(p\.?\s*o\.?\s*#?|#)\s*[-:]?\s*/i)}`.trim(), keys: [normPo(po), normPo(job)].filter(Boolean),
    street: streetOf(j.address) || (j.development || "").trim(), apt: (j.property_unit || "").trim(),
  };
};
export const relKey = (r: { id: string; rel_number?: string | null; address?: string | null; location?: string | null }): JobKey =>
  ({ kind: "rel", id: r.id, label: `release ${bare(plainDash(r.rel_number), /^(release\s*#?|rel\.?\s*#?|#)\s*[-:]?\s*/i)}`.trim(), keys: [normPo(r.rel_number)].filter(Boolean), street: streetOf(r.address) || (r.location || "").trim() });
// a job picked, with what names it
const picked = (j: JobKey, why: "number" | "today" | "recent" | "told"): Pick => ({ kind: j.kind, id: j.id, label: j.label, street: j.street, apt: j.apt, why });

// "2026-09-22" minus n days, by the calendar (no clock, no time zone)
export const dayMinus = (iso: string, n: number): string => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
export const RECENT_DAYS = 3;
const nyDayOf = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
// how far apart two crew texts must be before the later one says which job pictures are for
export const TOLD_APART_MS = 10 * 60_000;

// Which job the pictures go on:
//  1. a number in the text — one of the jobs this worker is on (a release
//     number means nothing on its own: every contract has a release 12), or
//     any PO in the portal when the number is a PO's (`anyPo`, found by the caller);
//  2. no number: the one job the worker is on today;
//  3. none today: the one job on their last day, if that was in the last three
//     days — photos sent the evening after, or the next morning.
// Two jobs that day, or no job at all, and the office decides.
// `photos`: the text came with pictures. Then a small bare number that fits
// none of their jobs ("12", "3": the apartment, how many pictures) is not a
// job number, and the pictures go where they would with no number at all.
export function pickJob(body: string, rows: MineRow[], mine: JobKey[], today: string, anyPo: JobKey[] = [], opts: { photos?: boolean } = {}): Pick {
  const byId = new Map(mine.map((j) => [j.id, j]));
  const refs = refsIn(body);
  if (refs.length) {
    const hits = new Map<string, JobKey>();
    for (const r of refs) {
      for (const j of mine) if (j.keys.includes(r.n)) hits.set(j.id, j);
      // a PO is one job across the whole portal; a release number is not
      for (const j of anyPo) if (j.kind === "pact" && j.keys.includes(r.n)) hits.set(j.id, j);
    }
    if (hits.size === 1) return picked([...hits.values()][0], "number");
    if (hits.size > 1) return { kind: "ask", why: "many" };
    // a number was given out loud and fits nothing: never guess past it
    const told = refs.find((r) => r.said && !(opts.photos && r.bare && r.n.length <= 4));
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
    const day = dayMinus(today, back);
    const js = jobsOn(day);
    if (js.length === 1) return picked(js[0], back === 0 ? "today" : "recent");
    if (js.length > 1) {
      // two jobs that day: the one they were texted about last — a PO that came
      // in during the day is texted later than the morning's, and the pictures
      // after that text are its. Texts that went out together say nothing.
      const toldAt = (j: JobKey) => Math.max(0, ...rows.filter((r) => r.day === day && (r.pact_job_id || r.release_id) === j.id).map((r) => Date.parse(r.texted_at || "") || 0));
      const told = js.map((j) => ({ j, at: toldAt(j) })).sort((a, b) => b.at - a.at);
      // (the later text has to be today's: last night's text about one of them says nothing about today)
      if (back === 0 && told[0].at > 0 && nyDayOf(told[0].at) === today && told[0].at - told[1].at >= TOLD_APART_MS) return picked(told[0].j, "told");
      return { kind: "ask", why: "many" };
    }
  }
  return { kind: "ask", why: "none" };
}

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
// `label` here is the job's whole name, address first (lib/crewText jobName)
export type Reply =
  | { k: "filed"; n: number; v?: number; label: string; kind?: "before" | "after" }   // v: how many of the n are videos
  | { k: "held"; n: number; v?: number }
  | { k: "which"; n: number; v?: number; options: string[] }   // held, with the jobs it could be: "116843 (2205 Linden Blvd, Apt 4B)"
  | { k: "moved"; n: number; v?: number; label: string }
  | { k: "unknown"; number: string; n?: number; v?: number }   // n, v: the pictures that came with it (none: "your photos")
  | { k: "notphoto" }
  | { k: "failed" }
  | { k: "resend" }
  | { k: "stranger"; n: number; v?: number }
  | { k: "connected" }
  | { k: "inall"; n: number; v?: number; label: string; kind?: "before" | "after" | null }   // the phone split one send: the whole count, once it has settled
  | { k: "lost"; n: number };                                                                // pictures in the text that didn't come through
// "3 photos", "1 video", "2 photos and 1 video"
const photos = (n: number, lang: Lang, v = 0) => mediaWords({ n, v }, lang);
const one = (n: number, v = 0) => n === 1 && v <= 1;
// "su foto", "sus 3 fotos", "sus 2 fotos y 1 video"; one photo with videos
// takes no article: "1 foto y 2 videos"
const susEs = (n: number, v = 0) => (one(n, v) ? (v ? "su video" : "su foto") : v && n - v === 1 ? photos(n, "es", v) : `sus ${photos(n, "es", v)}`);
export function replyText(r: Reply, lang0?: string | null): string {
  const lang = langOf(lang0);
  const es = lang === "es";
  switch (r.k) {
    case "filed": {
      // a release's pictures: on their pile, BEFORE unless they said AFTER
      const pile = r.kind === "after" ? (es ? "DESPUES" : "AFTER") : r.kind === "before" ? (es ? "ANTES" : "BEFORE") : "";
      const got = pile ? mediaWords({ n: r.n, v: r.v || 0 }, lang, pile) : photos(r.n, lang, r.v);
      const next = r.kind === "before" ? ` ${AFTER_HOW[lang]}` : es ? " ¡Gracias!" : " Thanks!";
      return es
        ? `Recibido: ${got} ${atJob(r.label, lang)}.${next} Si es otro trabajo, responda con el número correcto.`
        : `Got ${got} ${atJob(r.label, lang)}.${next} If that's the wrong job, reply with the right number.`;
    }
    case "held":
      return es
        ? `Recibimos ${susEs(r.n, r.v)}. ¿De qué trabajo ${one(r.n, r.v) ? "es" : "son"}? Responda con el número de PO o de release.`
        : `Got your ${photos(r.n, lang, r.v)}. Which job ${r.n === 1 ? "is it" : "are they"} for? Reply with the PO or release number.`;
    case "which": {
      const list = r.options.length === 2 ? `${r.options[0]} ${es ? "o" : "or"} ${r.options[1]}` : r.options.join(", ");
      return es
        ? `Recibimos ${susEs(r.n, r.v)}. ¿De qué trabajo ${one(r.n, r.v) ? "es" : "son"}? Responda con el número: ${list}.`
        : `Got your ${photos(r.n, lang, r.v)}. Which job ${r.n === 1 ? "is it" : "are they"} for? Reply with the number: ${list}.`;
    }
    case "moved":
      return es
        ? `Listo: ${susEs(r.n, r.v)} ahora ${r.n === 1 ? "está" : "están"} ${atJob(r.label, lang)}.`
        : `Done: your ${photos(r.n, lang, r.v)} ${r.n === 1 ? "is" : "are"} ${atJob(r.label, lang)} now.`;
    case "unknown": {
      // "your photos", "your video", "your 2 photos and 1 video"
      const n = r.n || 0, v = r.v || 0;
      const yours = !n ? (es ? "sus fotos" : "your photos") : es ? susEs(n, v) : one(n, v) ? (v ? "your video" : "your photo") : `your ${photos(n, lang, v)}`;
      return es
        ? `No encontramos el número ${r.number} en sus trabajos. La oficina pondrá ${yours} en el trabajo correcto.`
        : `Couldn't find ${r.number} on your jobs. The office will put ${yours} on the right job.`;
    }
    case "notphoto":
      return es ? "Solo se guardan fotos y videos en el trabajo; eso no era ninguno de los dos." : "Only photos and videos go on the job; that wasn't either.";
    case "resend":
      return es ? "No supimos de qué trabajo son sus fotos. Por favor envíelas otra vez con el número de PO en el mensaje." : "We couldn't tell which job your photos are for. Please send them again with the PO number in the text.";
    case "failed":
      return es ? "Sus fotos no llegaron bien. Por favor envíelas otra vez." : "Your photos didn't come through. Please send them again.";
    case "inall": {
      const pile = r.kind === "before" ? (es ? "ANTES" : "BEFORE") : r.kind === "after" ? (es ? "DESPUES" : "AFTER") : "";
      const all = mediaWords({ n: r.n, v: r.v || 0 }, lang, pile);
      return es ? `En total, ${all} ${atJob(r.label, lang)}.` : `${all} ${atJob(r.label, lang)} in all.`;
    }
    case "lost":
      return es
        ? `${r.n === 1 ? "1 foto o video no llegó" : `${r.n} fotos o videos no llegaron`}; por favor ${r.n === 1 ? "mándelo" : "mándelos"} otra vez.`
        : `${r.n === 1 ? "1 photo or video" : `${r.n} photos or videos`} didn't come through; please send ${r.n === 1 ? "it" : "them"} again.`;
    case "connected":
      // the very first text the number ever gets, from a phone on the crew
      // list (the owner trying it). Silence would look like it didn't work.
      return es
        ? "Earth Link: este número está conectado. Responda a un mensaje del equipo con fotos del trabajo, o NO si no hay nadie en casa."
        : "Earth Link: this number is connected. Reply to a crew text with photos of the work, or NO when nobody is home.";
    case "stranger": {
      // nobody knows this phone's language yet: both
      if (!(r.n > 0)) return "Earth Link: this number takes job photos from the crew. This phone isn't on the crew list; ask the office to add it. / Este número recibe fotos de trabajo del equipo. Este teléfono no está en la lista; pida a la oficina que lo agregue.";
      const v = r.v || 0, single = one(r.n, v);
      const en = single ? (v ? "your video" : "your photo") : `your ${photos(r.n, "en", v)}`;
      const es1 = susEs(r.n, v);
      // (la foto: la; el video: lo; las fotos: las; videos, or photos with videos: los)
      const it = single ? (v ? "lo" : "la") : v ? "los" : "las";
      return `Earth Link: got ${en}. This phone isn't on the crew list yet, so the office will put ${single ? "it" : "them"} on the job. / Recibimos ${es1}. Este teléfono aún no está en la lista del equipo; la oficina ${it} pondrá en el trabajo.`;
    }
  }
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
// what Twilio sends back to the phone: the reply, or nothing at all
export const twiml = (msg?: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Response>${msg ? `<Message>${xml(msg)}</Message>` : ""}</Response>`;
