// Works out which release a dropped file belongs to, from its name and the
// folders above it — so a whole contract folder can be attached in one go.
//
// Typical shapes this understands:
//   6693/before.jpg                    → release 6693 (folder is the number)
//   Release 6693 signed.pdf            → release 6693
//   REL-6693 Sedgwick/scan001.pdf      → release 6693
//   2442583/6693/walk sheet.pdf        → release 6693 (contract folder ignored)
//   IMG_6693.jpg                       → low confidence (camera numbering)

export interface RelLite {
  id: string;
  rel_number: string;
  location?: string | null;
  ticket?: string | null;
}

export interface FileMatch {
  path: string;               // folder path as shown to the user
  name: string;               // file name on its own
  relId: string | null;       // best guess, null when nothing fit
  confidence: "high" | "low" | "none";
  why: string;                // plain-language reason, shown in the preview
}

// camera/scanner prefixes whose digits are just a counter, never a release
const COUNTER_PREFIX = /(img|dsc|dscn|pxl|mvimg|scan|photo|pic|dji|gopr|vid|movie|screenshot)$/i;

const norm = (s: string) => s.replace(/^0+(?=\d)/, ""); // 006693 → 6693

// digit runs in one path segment, with the few characters before each run so
// counter prefixes (IMG_0042) can be told apart from real numbers
const tokensOf = (segment: string): { digits: string; before: string }[] => {
  const out: { digits: string; before: string }[] = [];
  const re = /\d+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment))) {
    out.push({ digits: m[0], before: segment.slice(0, m.index) });
  }
  return out;
};

const isDateLike = (d: string) =>
  (d.length === 8 && /^(19|20)\d{6}$/.test(d)) || (d.length === 6 && /^(19|20)\d{4}$/.test(d)) || d.length > 8;

// A file's own name is weaker evidence than the folder it sits in: folders are
// deliberately named, file names often come off a camera.
export function matchFile(relativePath: string, releases: RelLite[]): FileMatch {
  const parts = relativePath.split("/").filter(Boolean);
  const name = parts[parts.length - 1] || relativePath;
  const folders = parts.slice(0, -1);
  const stem = name.replace(/\.[^.]+$/, "");

  const byNum = new Map<string, RelLite[]>();
  releases.forEach((r) => {
    const k = norm(String(r.rel_number || "").trim());
    if (!k) return;
    if (!byNum.has(k)) byNum.set(k, []);
    byNum.get(k)!.push(r);
  });

  type Hit = { rel: RelLite; strong: boolean; counter: boolean; why: string };
  const hits: Hit[] = [];

  const scan = (segment: string, source: "folder" | "file") => {
    const hasKeyword = /(^|[^a-z])(rel|release|rl)([^a-z]|$)/i.test(segment);
    // a segment that is only the number (maybe with words after) is deliberate naming
    const bareNumber = /^\s*#?\d+\s*($|[-_. ])/.test(segment);
    tokensOf(segment).forEach(({ digits, before }) => {
      if (isDateLike(digits)) return;
      const counter = COUNTER_PREFIX.test(before.replace(/[^a-z]+$/i, "").slice(-12));
      const found = byNum.get(norm(digits));
      if (!found) return;
      found.forEach((rel) => {
        // strong when the naming shows intent, or the number is distinctive (3+ digits)
        const strong = hasKeyword || bareNumber || source === "folder" || digits.replace(/^0+/, "").length >= 3;
        const where = source === "folder" ? `folder “${segment}”` : `file name`;
        hits.push({ rel, strong, counter, why: `#${rel.rel_number} from ${where}` });
      });
    });
  };

  // deepest folder first — it's the most specific one
  [...folders].reverse().forEach((f) => scan(f, "folder"));
  scan(stem, "file");

  // a work-order / ticket number written on the file also identifies the release
  if (hits.length === 0) {
    const all = `${folders.join(" ")} ${stem}`;
    releases.forEach((rel) => {
      const t = String(rel.ticket || "").trim();
      if (t.length >= 4 && new RegExp(`(^|\\D)${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\D|$)`).test(all)) {
        hits.push({ rel, strong: true, counter: false, why: `#${rel.rel_number} from work order ${t}` });
      }
    });
  }

  if (hits.length === 0) return { path: relativePath, name, relId: null, confidence: "none", why: "no release number found" };

  // digits that came off a camera counter (IMG_0012, DSC_0001) are never a
  // release on their own — left for the office to assign by hand
  const real = hits.filter((h) => !h.counter);
  if (real.length === 0) {
    return { path: relativePath, name, relId: null, confidence: "none", why: "looks like a camera number, not a release" };
  }

  const strong = real.filter((h) => h.strong);
  const pool = strong.length > 0 ? strong : real;
  const distinct = [...new Set(pool.map((h) => h.rel.id))];
  if (distinct.length > 1) {
    const nums = [...new Set(pool.map((h) => `#${h.rel.rel_number}`))].slice(0, 3).join(", ");
    return { path: relativePath, name, relId: null, confidence: "none", why: `could be ${nums} — pick one` };
  }
  const best = pool[0];
  return {
    path: relativePath,
    name,
    relId: best.rel.id,
    confidence: strong.length > 0 ? "high" : "low",
    why: best.why,
  };
}

export function planFolder(files: { relativePath: string }[], releases: RelLite[]): FileMatch[] {
  return files.map((f) => matchFile(f.relativePath, releases));
}
