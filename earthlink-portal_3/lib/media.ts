// A job's pictures and videos: what they are and which pile they're on, read
// off their names and folders. Pure, for the browser and the server alike.
//
// Since the crew's photos started going into folders, a job's media lives at
//   pact/<job>/before/before_2026-11-20_143012_jose_x7k2_1.jpg
//   pact/<job>/after/after_2026-11-20_201544_jose_q9r1.mp4
//   pact/<job>/noaccess/noaccess_…  (a closed door, with "nobody home")
// (a release's at <release>/before/… the same way). Older ones sit loose in
// the job's folder; their name's front says the pile all the same.

export const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|gif)$/i;
export const VIDEO_EXT = /\.(mp4|mov|m4v|3gp|3g2|webm|mpe?g|avi)$/i;
export const isImageName = (n: string): boolean => IMAGE_EXT.test(n || "");
export const isVideoName = (n: string): boolean => VIDEO_EXT.test(n || "");
export const isMediaName = (n: string): boolean => isImageName(n) || isVideoName(n);

// what a phone or Twilio calls a picture or a video, and the ending the file gets
const TYPE_EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/pjpeg": "jpg", "image/png": "png", "image/gif": "gif",
  "image/webp": "webp", "image/heic": "heic", "image/heif": "heif",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/x-m4v": "m4v", "video/3gpp": "3gp", "video/3gpp2": "3g2",
  "video/webm": "webm", "video/mpeg": "mpeg", "video/mpeg4": "mp4", "video/h264": "mp4", "video/x-msvideo": "avi",
};
export const extOfType = (type: string): string => TYPE_EXT[(type || "").trim().toLowerCase().split(";")[0]] || "";
export const isVideoType = (type: string): boolean => /^video\//i.test((type || "").trim());
// the type a file is served with, from its ending (an upload from the office carries its own)
export const typeOfName = (n: string): string => {
  const e = ((n || "").match(/\.(\w+)$/) || ["", ""])[1].toLowerCase();
  const found = Object.entries(TYPE_EXT).find(([, x]) => x === e);
  return found ? found[0] : e === "jpeg" ? "image/jpeg" : "application/octet-stream";
};

export type Pile = "before" | "after" | "noaccess" | "other";
// the pile: the folder it's in, else the front of its name
export const pileOf = (a: { name?: string | null; path?: string | null }): Pile => {
  const parts = (a.path || "").split("/");
  const folder = (parts.length > 1 ? parts[parts.length - 2] : "").toLowerCase();
  if (folder === "before" || folder === "after" || folder === "noaccess") return folder;
  const m = (a.name || "").toLowerCase().match(/^(before|after|noaccess)_/);
  return m ? (m[1] as Pile) : "other";
};
export const PILE_LABEL: Record<Pile, string> = { before: "Before", after: "After", noaccess: "Nobody home", other: "Other photos" };
// the folder a pile's files go in, under a job's own folder ("pact/<job>/")
export const pileFolder = (jobFolder: string, pile: Exclude<Pile, "other">): string => `${jobFolder}${pile}/`;

// "3 photos", "1 video", "2 photos and 1 video" (and in Spanish)
export interface MediaCount { n: number; v: number }   // n: all of them, v: how many are videos
export const countOf = (names: string[]): MediaCount => ({ n: names.length, v: names.filter(isVideoName).length });
export const asCount = (c: number | MediaCount): MediaCount => (typeof c === "number" ? { n: c, v: 0 } : c);
export function mediaWords(c0: number | MediaCount, lang: "en" | "es", pile = ""): string {
  const c = asCount(c0);
  const v = Math.max(0, Math.min(c.v, c.n)), p = c.n - v;
  const es = lang === "es";
  const ph = (k: number) => (es ? (k === 1 ? "1 foto" : `${k} fotos`) : k === 1 ? "1 photo" : `${k} photos`);
  const vi = (k: number) => (k === 1 ? "1 video" : `${k} videos`);
  const of = pile ? (es ? ` de ${pile}` : "") : "";
  const pre = pile && !es ? `${pile} ` : "";
  if (!v) return es ? `${ph(p)}${of}` : `${p === 1 ? `1 ${pre}photo` : `${p} ${pre}photos`}`;
  if (!p) return es ? `${vi(v)}${of}` : `${v === 1 ? `1 ${pre}video` : `${v} ${pre}videos`}`;
  return es ? `${ph(p)} y ${vi(v)}${of}` : `${p === 1 ? `1 ${pre}photo` : `${p} ${pre}photos`} and ${vi(v)}`;
}
