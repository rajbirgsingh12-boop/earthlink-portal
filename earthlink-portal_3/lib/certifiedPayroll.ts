// Certified payroll PDF → eComply CSV.
// Reads the text of a certified payroll report (the WH-347-style weekly report
// a payroll company produces) and pulls out the header (payroll #, week ending,
// project) and one row per worker: name, last-4 SSN, classification, day-by-day
// hours, rates, gross, deductions, net. Layouts vary by payroll company, so the
// parser fills what it can confidently find — the page shows everything in an
// editable grid before the CSV is made. NOTHING here is saved to the database:
// wages exist only inside the file the user downloads.

import { COMPANY } from "./company";

// cells hold whatever the user types; numbers are coerced when the CSV is built
export type Cell = number | string;
export interface CpRow {
  name: string;
  ssn4: string; // last 4, or the full 9 digits when known
  address: string;
  classification: string;
  st: Cell[];   // straight-time hours, 7 days (day 1 = six days before week ending)
  ot: Cell[];   // overtime hours, 7 days
  stRate: Cell;
  otRate: Cell;
  grossProject: Cell;  // gross earned on THIS project
  grossTotal: Cell;    // gross all projects (often the same)
  fica: Cell;
  fedTax: Cell;
  stateTax: Cell;
  cityTax: Cell;
  otherDed: Cell;
  net: Cell;
  // worker details the LCM upload wants (defaults are editable in the grid)
  marital: string;    // S or M
  exemption: Cell;    // 0-99
  ethnicity: string;  // 1 Caucasian · 2 African American · 3 Hispanic · 4 Native American/Alaskan · 5 Asian/Pacific Islander · 6 Other
  gender: string;     // M or F (blank allowed)
  city: string;
  state: string;
  zip: string;
  trade: string;      // J journeyman / A apprentice
  // set on per-release rows: this worker's hours on the OTHER releases that week
  otherRt?: Cell;
  otherOt?: Cell;
}

export interface CpReport {
  fileName: string;
  contractor: string;
  payrollNo: string;
  weekEnding: string;    // MM/DD/YYYY
  project: string;
  contractNo: string;
  rows: CpRow[];
  notes: string[];       // anything the reader wasn't sure about
}

export const blankRow = (): CpRow => ({
  name: "", ssn4: "", address: "", classification: "",
  st: ["", "", "", "", "", "", ""], ot: ["", "", "", "", "", "", ""],
  stRate: "", otRate: "", grossProject: "", grossTotal: "",
  fica: "", fedTax: "", stateTax: "", cityTax: "", otherDed: "", net: "",
  marital: "S", exemption: "0", ethnicity: "", gender: "", city: "", state: "", zip: "", trade: "J",
});

const num = (s: string): number => parseFloat(s.replace(/[$,]/g, ""));
const isMoney = (s: string) => /^\$?[\d,]+\.\d{2}$/.test(s);
const isHour = (s: string) => /^\d{1,2}(?:\.\d{1,2})?$/.test(s) && num(s) <= 24;

// finds the date after a "week ending"-ish label anywhere in the text
const findWeekEnding = (t: string): string => {
  const m = t.match(/(?:week\s*end(?:ing)?|w\/?e|payroll\s*period|period\s*end(?:ing)?)[^0-9]{0,20}([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2,4})/i);
  if (!m) return "";
  const [mo, d, y] = m[1].split(/[/-]/).map((x) => parseInt(x, 10));
  const yy = y < 100 ? 2000 + y : y;
  return `${String(mo).padStart(2, "0")}/${String(d).padStart(2, "0")}/${yy}`;
};

// One line of extracted PDF text (tokens ordered left→right). `xs` carries
// where each token sits across the page, which is the only way to tell which
// DAY a lone "6.0" belongs to on a WH-347 grid.
export interface CpLine { tokens: string[]; xs?: number[] }

// ---------- WH-347 (the federal payroll form) ----------
// The form is a grid: the day a worker's hours belong to is decided by where
// the number sits under Sa Su Mo Tu We Th Fr, and the deductions likewise sit
// under their own headings. Read by column, the whole page comes out exact.
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const asDate = (toks: string[]): string => {
  const t = toks.join(" ");
  const slash = t.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (slash) {
    const y = Number(slash[3]) < 100 ? 2000 + Number(slash[3]) : Number(slash[3]);
    return `${slash[1].padStart(2, "0")}/${slash[2].padStart(2, "0")}/${y}`;
  }
  // "AUG 7 2026" — the way the form prints it
  const m = t.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})[,\s]+(\d{4})/);
  if (m) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mi >= 0) return `${String(mi + 1).padStart(2, "0")}/${m[2].padStart(2, "0")}/${m[3]}`;
  }
  return "";
};

const near = (x: number, at: number, slack = 11) => Math.abs(x - at) <= slack;

interface Cols {
  day: number[];      // Sa Su Mo Tu We Th Fr
  hours: number; rate: number; gross: number; cls: number; exemp: number;
  fica: number; fed: number; state: number; city: number; other: number; net: number;
  type: number;       // where ST / OT / VAC sits
  name: number;       // the left edge, where names and SS#/CHECK# lines start
}

const labelX = (l: CpLine, want: RegExp): number => {
  const i = l.tokens.findIndex((t) => want.test(t));
  return i >= 0 && l.xs ? l.xs[i] : -1;
};

// the day headings, and every money heading that follows them
function readCols(lines: CpLine[]): (Cols & { bands: number[] }) | null {
  const days = ["sa", "su", "mo", "tu", "we", "th", "fr"];
  let found: (Cols & { bands: number[] }) | null = null;
  const bands: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.xs) continue;
    const low = l.tokens.map((t) => t.toLowerCase().replace(/\./g, ""));
    let day: number[] | null = null;
    const at = days.map((d) => low.findIndex((t) => t === d));
    if (at.every((x) => x >= 0) && at.every((x, k) => k === 0 || x > at[k - 1])) day = at.map((x) => l.xs![x]);
    if (!day) {
      // some payroll companies print the dates instead — 8/1 8/2 … — or just 1-7
      const run = l.tokens
        .map((t, k) => ({ t, x: l.xs![k] }))
        .filter((w) => /^\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?$/.test(w.t) || /^[1-7]$/.test(w.t));
      if (run.length >= 7) {
        const seven = run.slice(0, 7);
        const gaps = seven.slice(1).map((w, k) => w.x - seven[k].x);
        // evenly spaced, left to right — that's the day grid, not stray numbers
        if (gaps.every((g) => g > 5 && g < 60) && Math.max(...gaps) - Math.min(...gaps) < 14) day = seven.map((w) => w.x);
      }
    }
    if (!day) continue;
    // the money headings are spread over this line and the two under it
    const band = [l, lines[i + 1], lines[i + 2]].filter(Boolean) as CpLine[];
    const find = (re: RegExp) => { for (const b of band) { const x = labelX(b, re); if (x >= 0) return x; } return -1; };
    const cols: Cols = {
      day,
      hours: find(/^hours$/i), rate: find(/^rate$/i), gross: find(/^(?:amt\.?|earned)$/i),
      cls: find(/^classification$/i),
      exemp: find(/^(?:exemp\.?|exemptions?|#\s*of)$/i),
      fica: find(/^fica$/i), fed: find(/^fed\.?$/i), state: find(/^state$/i), city: find(/^(?:nyc|city|local)$/i),
      other: find(/^other$/i), net: find(/^net(?:\s*pay)?$/i),
      type: find(/^(?:st|rt)$/i), name: Math.min(...band.flatMap((b) => b.xs || [9999])),
    };
    // a form that hides half its headings isn't this form
    if (cols.hours < 0 || cols.gross < 0) continue;
    // the three heading rows overlap each other — one band per grid, not three
    if (bands.length === 0 || i - bands[bands.length - 1] > 3) bands.push(i);
    if (!found) found = { ...cols, bands };
  }
  return found;
}

// what the form says above the grid: week ending, project, contract, payroll #
function readWh347Header(lines: CpLine[]): { weekEnding: string; payrollNo: string; project: string; contractNo: string; contractor: string; fedId: string } {
  let weekEnding = "", payrollNo = "", project = "", contractNo = "", contractor = "", fedId = "";
  const flat = lines.map((l) => l.tokens.join(" ")).join("\n");
  fedId = flat.match(/Fed\.?\s*ID\s*#?\s*([\d-]{9,})/i)?.[1] || "";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], next = lines[i + 1];
    if (!l.xs || !next?.xs) continue;
    const text = l.tokens.join(" ");
    if (!/week\s*ending/i.test(text)) continue;
    // each heading owns the strip of page from its own left edge to the next
    const heads: { re: RegExp; set: (v: string) => void }[] = [
      { re: /payroll\s*no/i, set: (v) => { payrollNo = v.replace(/[^\w-]/g, ""); } },
      { re: /week\s*ending/i, set: (v) => { weekEnding = asDate(v.split(" ")); } },
      { re: /project\s*and\s*location/i, set: (v) => { project = v; } },
      { re: /project\s*or\s*contract/i, set: (v) => { contractNo = v; } },
    ];
    // rebuild the heading strips from the whole line's tokens
    const bounds: { from: number; to: number; set: (v: string) => void }[] = [];
    for (const h of heads) {
      // the heading may be one token ("FOR WEEK ENDING:") or a few in a row
      let start = l.tokens.findIndex((t) => h.re.test(t));
      if (start < 0) start = l.tokens.findIndex((_, k) => h.re.test(l.tokens.slice(k, k + 4).join(" ")) && !h.re.test(l.tokens.slice(k + 1, k + 4).join(" ")));
      if (start < 0) continue;
      bounds.push({ from: l.xs![start] - 4, to: Infinity, set: h.set });
    }
    bounds.sort((a, b) => a.from - b.from);
    bounds.forEach((b, k) => { b.to = bounds[k + 1] ? bounds[k + 1].from : Infinity; });
    for (const b of bounds) {
      const got = next.tokens.filter((_, k) => next.xs![k] >= b.from && next.xs![k] < b.to).join(" ").trim();
      if (got) b.set(got);
    }
    break;
  }
  // the contractor's own name sits under its heading
  for (let i = 0; i < lines.length; i++) {
    if (!/name\s*of\s*contractor/i.test(lines[i].tokens.join(" "))) continue;
    const cand = lines[i + 1]?.tokens.find((t) => /[A-Za-z]{4,}/.test(t) && !/^\[/.test(t));
    if (cand) contractor = cand;
    break;
  }
  return { weekEnding, payrollNo, project, contractNo, contractor, fedId };
}

// where a worker's rows stop: the small print, the next section, another page.
// The CHECK# line is NOT one of these — it carries the worker's money.
const BLOCK_END = /department of labor|wage and hour|we estimate|washington|purchase this form|form wh|exceptions|remarks|name of contractor|for week ending|payroll no|omb no|deductions\b.*\bnet pay/i;
const FORM_WORDS = /department|wage and hour|contractor|payroll|social security|classification|deductions|check|estimate|form wh|exceptions|remarks|total|subtotal|name,?\s*address|of employee|#\s*of\b|exemp|w\/h|of pay|earned|project|address\b/i;

export function parseWh347(fileName: string, lines: CpLine[]): CpReport | null {
  const cols = readCols(lines);
  if (!cols) return null;
  const head = readWh347Header(lines);
  const notes: string[] = [];
  const rows: CpRow[] = [];

  // a worker starts where a name sits at the left edge on a line that also
  // carries a rate-type box (ST / RT)
  // the name column ends where the next box begins — the exemptions box comes
  // first on the federal form, then the craft
  const nameEdge = cols.exemp > 0 ? cols.exemp - 8 : cols.cls > 0 ? cols.cls - 10 : cols.type - 40;
  const craftFrom = cols.cls > 0 ? cols.cls - 10 : nameEdge;
  const isStart = (l: CpLine): boolean => {
    if (!l.xs || l.xs.length < 2) return false;
    // the rate-type box says this is the first row of a worker
    if (!l.tokens.some((t, k) => /^(?:ST|RT|REG|R\/T)$/i.test(t) && near(l.xs![k], cols.type, 14))) return false;
    // …and something with letters sits in the name column. Names print every
    // which way — "LOJA, IVAN", "Ivan Loja", two separate words — so the shape
    // of the name is never what decides.
    const left = l.tokens.filter((_, k) => l.xs![k] < nameEdge).join(" ");
    return /[A-Za-z]{2}/.test(left) && !FORM_WORDS.test(left);
  };

  // the three heading rows of every grid on every page belong to the form
  const heading = new Set<number>();
  for (const b of cols.bands) for (let k = -1; k <= 2; k++) heading.add(b + k);
  const blocks: CpLine[][] = [];
  let cur: CpLine[] | null = null;
  lines.forEach((l, i) => {
    if (heading.has(i)) { cur = null; return; }
    if (isStart(l)) { cur = [l]; blocks.push(cur); return; }
    if (!cur) return;
    const text = l.tokens.join(" ");
    // the page-total strip at the foot of the grid: nothing but money, and all
    // of it out to the right of the name and hours columns
    const moneyOnly = l.xs && l.tokens.length >= 4
      && l.tokens.every((t) => /^-?\$?[\d,]+(?:\.\d{2})?$/.test(t.replace(/\s/g, "")))
      && Math.min(...l.xs) >= cols.gross - 12;
    // the footnotes, the page totals and the next section are not this worker
    if (cur.length >= 12 || moneyOnly || BLOCK_END.test(text) || text.length > 90) { cur = null; return; }
    cur.push(l);
  });

  for (const block of blocks) {
    const row = blankRow();
    const first = block[0];
    // everything left of the craft column is the worker's name
    row.name = first.tokens.filter((_, k) => first.xs![k] < nameEdge).join(" ").replace(/\s{2,}/g, " ").trim();
    // and what sits between there and the rate-type box is the craft
    row.classification = (first.tokens.filter((_, k) => first.xs![k] >= craftFrom && first.xs![k] < cols.type - 5).join(" ") || "").trim().slice(0, 40);
    // whatever the payroll printed in the exemptions box
    if (cols.exemp > 0) {
      const ex = first.tokens.find((_, k) => near(first.xs![k], cols.exemp, 12) && /^\d{1,2}$/.test(first.tokens[k]));
      if (ex) row.exemption = ex;
    }

    for (const l of block) {
      if (!l.xs) continue;
      const kind = l.tokens.find((t, k) => near(l.xs![k], cols.type, 14) && /^[A-Za-z]{2,4}$/.test(t))?.toUpperCase() || "";
      const money = (x: number): string => {
        const k = l.tokens.findIndex((t, i2) => near(l.xs![i2], x, 16) && /^-?\$?\s*[\d,]+(?:\.\d{2})?$/.test(t.replace(/\s/g, "")));
        return k >= 0 ? l.tokens[k].replace(/[$,\s]/g, "") : "";
      };
      // the day-by-day boxes
      if (kind === "ST" || kind === "RT" || kind === "OT") {
        const target = kind === "OT" ? row.ot : row.st;
        l.tokens.forEach((t, k) => {
          if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(t)) return;
          const d = cols.day.findIndex((dx) => near(l.xs![k], dx, 9));
          if (d >= 0) target[d] = Number(t);
        });
        const rate = money(cols.rate);
        if (rate) { if (kind === "OT") row.otRate = Number(rate); else row.stRate = Number(rate); }
      }
      // the SSN, however much of it the payroll company prints
      const flatL = l.tokens.join(" ");
      const ss = flatL.match(/SS\s*#?\s*:?\s*([\dXx*-]{7,})/) || flatL.match(/\b(\d{3}-\d{2}-\d{4})\b/);
      if (ss) { const d = ss[1].replace(/\D/g, ""); if (d.length === 9) row.ssn4 = d; else if (d.length >= 4) row.ssn4 = d.slice(-4); }
      // the street address the form prints under the name
      else if (!kind && !/check\s*#/i.test(flatL)) {
        const left = l.tokens.filter((_, k) => l.xs![k] < nameEdge).join(" ").trim();
        const looksLikeAddress = /^\d/.test(left)
          && /\b(?:ave|avenue|st|street|blvd|boulevard|rd|road|dr|drive|ln|lane|pl|place|ct|court|ter|terrace|pkwy|parkway|hwy|way|apt|unit)\b/i.test(left);
        if (looksLikeAddress && left.length <= 60 && !FORM_WORDS.test(left))
          row.address = row.address ? `${row.address} ${left}` : left;
      }
      // the money line: every figure under its own heading
      if (/check\s*#/i.test(l.tokens.join(" ")) || (money(cols.gross) && money(cols.net))) {
        const g = money(cols.gross), fi = money(cols.fica), fe = money(cols.fed), st = money(cols.state),
          ci = money(cols.city), ot = money(cols.other), ne = money(cols.net);
        if (g) { row.grossProject = Number(g); row.grossTotal = Number(g); }
        if (fi) row.fica = Number(fi);
        if (fe) row.fedTax = Number(fe);
        if (st) row.stateTax = Number(st);
        if (ci) row.cityTax = Number(ci);
        if (ot) row.otherDed = Number(ot);
        if (ne) row.net = Number(ne);
      }
    }
    if (!row.ssn4) notes.push(`${row.name || "A worker"}: the payroll hides the Social Security number — type the last 4 in.`);
    if (row.st.every((h) => !Number(h)) && row.ot.every((h) => !Number(h)))
      notes.push(`${row.name || "A worker"}: no day-by-day hours were printed — check the grid.`);
    if (row.name) rows.push(row);
  }
  if (rows.length === 0) return null;

  if (!head.weekEnding) notes.push("Couldn't read the week-ending date — type it in above.");
  if (head.fedId && head.fedId.replace(/\D/g, "") !== COMPANY.fedTaxId.replace(/\D/g, ""))
    notes.push(`This payroll shows Fed ID ${head.fedId}, but the portal has ${COMPANY.fedTaxId} — check which is right before uploading.`);

  return {
    fileName,
    contractor: head.contractor || COMPANY.letterhead.name,
    payrollNo: head.payrollNo,
    weekEnding: head.weekEnding,
    project: head.project,
    contractNo: head.contractNo,
    rows,
    notes,
  };
}

export function parseCertifiedPayroll(fileName: string, lines: CpLine[]): CpReport {
  // the federal form reads exactly when read by column — try that first
  const wh = parseWh347(fileName, lines);
  if (wh) return wh;

  const flat = lines.map((l) => l.tokens.join(" ")).join("\n");
  const one = flat.replace(/\s+/g, " ");
  const notes: string[] = [];

  const weekEnding = findWeekEnding(one);
  if (!weekEnding) notes.push("Couldn't find the week-ending date — type it in above.");
  const payrollNo = one.match(/payroll\s*(?:no\.?|number|#)\s*:?\s*(\d+)/i)?.[1]
    || one.match(/\bcpr\s*#?\s*(\d+)/i)?.[1] || "";
  const contractNo = one.match(/(?:contract|project)\s*(?:no\.?|number|#)\s*:?\s*([A-Za-z0-9-]{4,20})/i)?.[1] || "";
  const project = (one.match(/project(?:\s*(?:name|and location))?\s*:?\s+(.{3,70}?)(?=\s+(?:payroll|week|contract|for week|address|project\s*no|job\s*no)\b|\s*$)/i)?.[1] || "").trim();
  const contractor = (one.match(/(?:contractor|company|employer)(?:\s*(?:name|or subcontractor))?\s*:?\s+(.{3,60}?)(?=\s+(?:address|payroll|week|project)\b|$)/i)?.[1] || "").trim();

  // ---- worker rows ----
  // a worker starts on a line carrying an SSN tail ("XXX-XX-1234", "***-**-1234",
  // "...-1234") or a Last, First name followed by numbers further down the block
  const ssnRe = /(?:x{3}[-\s]?x{2}|\*{3}[-\s]?\*{2}|\d{3}[-\s]?\d{2})[-\s]?(\d{4})/i;
  const nameRe = /^([A-Z][A-Za-z.'-]+,?\s+[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)?)/;
  const classWords = /labor|carpent|paint|plumb|electric|mason|roof|iron|cement|operat|driver|helper|apprentice|foreman|mechanic|glaz|tile|plaster|drywall|demoli|handyman|super/i;

  // group lines into worker blocks
  const blocks: CpLine[][] = [];
  let cur: CpLine[] | null = null;
  for (const line of lines) {
    const text = line.tokens.join(" ");
    // the form's own banner and headings are never a worker
    if (FORM_WORDS.test(text)) { cur = null; continue; }
    const starts = ssnRe.test(text) || (nameRe.test(text) && classWords.test(text));
    if (starts) { cur = [line]; blocks.push(cur); }
    else if (cur) cur.push(line);
  }

  const rows: CpRow[] = [];
  for (const block of blocks) {
    const row = blankRow();
    const blockText = block.map((l) => l.tokens.join(" ")).join(" ");
    row.ssn4 = blockText.match(ssnRe)?.[1] || "";
    // the name: the longest "Last, First"-looking run on the first line, minus the ssn
    const first = block[0].tokens.join(" ").replace(ssnRe, " ");
    // a middle initial only counts when it stands alone ("Smith, John A."),
    // not the first letter of the classification that follows on the line
    row.name = (first.match(/([A-Z][A-Za-z.'-]+,\s*[A-Z][A-Za-z.'-]+(?:\s+[A-Z]\.?(?=\s|$))?)/)?.[1]
      || first.match(nameRe)?.[1] || "").trim().replace(/\s{2,}/g, " ");
    const cls = blockText.match(new RegExp(`\\b([A-Za-z /-]*(?:${classWords.source})[A-Za-z /-]*)`, "i"))?.[1];
    // strip the O/S row markers WH-347 prints next to the grid
    row.classification = (cls || "").trim().replace(/\s{2,}/g, " ").replace(/\s+[OS]$/i, "").slice(0, 40);

    // hour runs: 7 (or up to 7) consecutive small numbers on one line = a day row.
    // First such run = straight time, second = overtime (WH-347 prints O above S,
    // but S carries the bigger totals — we swap later if the O row is bigger).
    const hourRuns: number[][] = [];
    for (const l of block) {
      const toks = l.tokens.join(" ").split(/\s+/);
      let run: number[] = [];
      for (const t of toks) {
        if (isHour(t) && !isMoney(t)) run.push(num(t));
        else { if (run.length >= 4) hourRuns.push(run.slice(0, 7)); run = []; }
      }
      if (run.length >= 4) hourRuns.push(run.slice(0, 7));
    }
    const put = (target: Cell[], src: number[]) => src.forEach((h, i) => { if (i < 7) target[i] = h; });
    if (hourRuns.length >= 2) {
      // the larger-total run is straight time
      const [a, b] = hourRuns;
      const sum = (r: number[]) => r.reduce((s, x) => s + x, 0);
      if (sum(a) >= sum(b)) { put(row.st, a); put(row.ot, b); } else { put(row.st, b); put(row.ot, a); }
    } else if (hourRuns.length === 1) put(row.st, hourRuns[0]);
    else notes.push(`${row.name || "A worker"}: couldn't read the day-by-day hours.`);

    // labeled deductions read directly when the report names them
    const labeled = (re: RegExp) => { const m = blockText.match(re); return m ? num(m[1]) : ""; };
    row.fica = labeled(/(?:fica|ss\/?med|social security)[^0-9]{0,6}([\d,]+\.\d{2})/i);
    row.fedTax = labeled(/fed(?:eral)?(?:\s*(?:w\/?h|tax|withholding))?[^0-9]{0,6}([\d,]+\.\d{2})/i);
    row.stateTax = labeled(/state(?:\s*(?:w\/?h|tax))?[^0-9]{0,6}([\d,]+\.\d{2})/i);
    row.cityTax = labeled(/(?:city|local|nyc)(?:\s*(?:w\/?h|tax))?[^0-9]{0,6}([\d,]+\.\d{2})/i);
    row.otherDed = labeled(/other(?:\s*(?:ded(?:uctions?)?)?)[^0-9]{0,6}([\d,]+\.\d{2})/i);
    const labeledNet = labeled(/net(?:\s*(?:pay|wages?))?[^0-9]{0,6}([\d,]+\.\d{2})/i);
    // money: rates are the smaller values (usually 15–250), the rest map by order
    const money = blockText.split(/\s+/).filter(isMoney).map(num);
    const rates = money.filter((m) => m >= 10 && m <= 250);
    if (rates.length > 0) row.stRate = rates[0];
    if (rates.length > 1 && rates[1] > (row.stRate as number)) row.otRate = rates[1];
    const big = money.filter((m) => m > 250 || (m > 0 && m === Math.max(...money)));
    if (big.length > 0) {
      row.grossProject = Math.max(...big);
      row.grossTotal = row.grossProject;
      row.net = labeledNet !== "" ? labeledNet : money[money.length - 1] !== row.grossProject ? money[money.length - 1] : "";
    } else if (labeledNet !== "") row.net = labeledNet;
    if (row.name || row.ssn4) rows.push(row);
  }
  if (rows.length === 0) notes.push("No worker rows found — the reader may not know this layout yet. Add the rows below (or send the PDF to be supported).");

  return { fileName, contractor, payrollNo, weekEnding, project, contractNo, rows, notes };
}

// ---------- CSV ----------
const esc = (v: Cell) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const dayLabels = (weekEnding: string): string[] => {
  const m = weekEnding.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return ["Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"];
  const end = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(end);
    d.setDate(end.getDate() - (6 - i));
    return `${d.getMonth() + 1}/${d.getDate()}`;
  });
};

// ---- the LCM CPR import format (eComply) ----
// The header below is copied verbatim from their own 2.0_CPR_upload sample \u2014
// 133 columns; a row must line up with it position by position.
const LCM_HEADER =
  "payrollnumber,weekenddate,assignedempid,titlecourtesy,firstname,middleinitial,lastname,suffix,title,birthdate,ssn," +
  "maritalstatus,exemption,ethnicity,gender,address,city,state,zip,country,contactno,officeno,unionname,hiredate," +
  "federalid,alienno,apprenticeshipno,fica,fedwh,stwh,grosspayallprojects,netpay,checknumber," +
  "otherdeduction1,value1,otherdeduction2,value2,otherdeduction3,value3,classification,trade,grosspaythisproject," +
  "otherprojectsrthrs,otherprojectsothrs,benefitspaidtounion,benefitspaidtoemployee,benefitspaidtoother," +
  "benefitspaidto1,benefitspaidto2,benefitspaidto3,isfridaymakeupday,issaturdaymakeupday,issundaymakeupday," +
  "rt1,rt2,rt3,rt4,rt5,rt6,rt7,rtrate,rtbenefit,st1,st2,st3,st4,st5,st6,st7,strate,stbenefit," +
  "ot1,ot2,ot3,ot4,ot5,ot6,ot7,otrate,otbenefit,gt1,gt2,gt3,gt4,gt5,gt6,gt7,gtrate,gtbenefit," +
  "dt1,dt2,dt3,dt4,dt5,dt6,dt7,dtrate,dtbenefit,tt1,tt2,tt3,tt4,tt5,tt6,tt7,ttrate,ttbenefit," +
  "ph1,ph2,ph3,ph4,ph5,ph6,ph7,contractno,schoolcode,taxpayerid,sdi,etax," +
  "otherdeduction4,value4,otherdeduction5,value5," +
  "OtherPayment1,OtherPaymentAmount1,NotInGrossPay1,OtherPayment2,OtherPaymentAmount2,NotInGrossPay2," +
  "OtherPayment3,OtherPaymentAmount3,NotInGrossPay3,Dues";
const LCM_COLS = LCM_HEADER.split(",").length;

// "Last, First M", "First M Last", with an optional Jr/Sr/II/III/IV tail
export function splitName(name: string): { first: string; mi: string; last: string; suffix: string } {
  let s = (name || "").trim().replace(/\s{2,}/g, " ");
  let suffix = "";
  const sufM = s.match(/[,\s]+(JR\.?|SR\.?|II|III|IV)\.?$/i);
  if (sufM) { suffix = sufM[1].replace(/\.$/, ""); s = s.slice(0, sufM.index).trim(); }
  if (!s) return { first: "", mi: "", last: "", suffix };
  if (s.includes(",")) {
    const [last, rest] = [s.slice(0, s.indexOf(",")).trim(), s.slice(s.indexOf(",") + 1).trim()];
    const parts = rest.split(/\s+/);
    const mi = parts[1] && parts[1].replace(/\./g, "").length === 1 ? parts[1].replace(/\./g, "") : "";
    // a multi-letter middle token stays with the given name (never dropped)
    const first = mi ? parts[0] || "" : parts.join(" ");
    return { first, mi, last, suffix };
  }
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], mi: "", last: "", suffix };
  const mi = parts.length >= 3 && parts[1].replace(/\./g, "").length === 1 ? parts[1].replace(/\./g, "") : "";
  const first = parts.length >= 3 && !mi ? parts.slice(0, -1).join(" ") : parts[0];
  return { first, mi, last: parts[parts.length - 1], suffix };
}

// "117-01 Atlantic Ave Richmond Hill NY 11418" -> street / city / state / zip
function splitAddress(addr: string): { street: string; city: string; state: string; zip: string } {
  const s = (addr || "").trim();
  const tail = s.match(/[,\s]+([A-Z]{2})[,\s]+(\d{5}(?:-\d{4})?)$/);
  if (!tail || tail.index === undefined) return { street: s, city: "", state: "", zip: "" };
  const front = s.slice(0, tail.index).trim();
  const state = tail[1], zip = tail[2];
  // commas make it easy: "street, city"
  const cm = front.match(/^(.*?),\s*([A-Za-z .'-]+)$/);
  if (cm) return { street: cm[1].trim(), city: cm[2].trim(), state, zip };
  // otherwise the street usually ends in Ave/St/Blvd/… — the rest is the city
  // (greedy prefix: the LAST suffix word wins, so "117 St Nicholas Ave …" splits after Ave)
  const sm = front.match(/^(.*\b(?:avenue|ave|street|st|boulevard|blvd|road|rd|drive|dr|place|pl|court|ct|lane|ln|way|pkwy|parkway|terrace|ter|broadway|concourse|plaza)\.?)\s+(.+)$/i);
  if (sm) return { street: sm[1].trim(), city: sm[2].trim(), state, zip };
  // last resort: everything is the street
  return { street: front, city: "", state, zip };
}

const lcmSsn = (raw: string): string => {
  const d = (raw || "").replace(/\D/g, "");
  if (d.length === 9) return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
  if (d.length === 4) return `000-00-${d}`; // the spec allows 000-00-1234 when only the tail is known
  return "";
};

export function buildCsv(reports: CpReport[]): string {
  // numbers go out bare \u2014 no $ or thousands separators, per the spec
  const money = (v: Cell | undefined, dflt = ""): string => {
    const s = String(v ?? "").replace(/[$,\s]/g, "");
    if (s === "") return dflt;
    const x = Number(s);
    return Number.isFinite(x) ? String(Math.round(x * 100) / 100) : dflt;
  };
  const lines = [LCM_HEADER];
  for (const rep of reports) {
    for (const r of rep.rows) {
      const f: (string | number)[] = new Array(LCM_COLS).fill("");
      const nm = splitName(r.name);
      const ad = splitAddress(r.address);
      f[0] = rep.payrollNo;              // payrollnumber
      f[1] = rep.weekEnding;             // weekenddate mm/dd/yyyy
      f[4] = nm.first; f[5] = nm.mi; f[6] = nm.last; f[7] = nm.suffix;
      f[8] = r.classification;           // title = craft
      f[10] = lcmSsn(r.ssn4);
      f[11] = r.marital || "S";
      f[12] = money(r.exemption, "0");
      f[13] = r.ethnicity || "";
      f[14] = r.gender || "";
      f[15] = ad.street;
      f[16] = r.city || ad.city;
      f[17] = r.state || ad.state || "NY";
      f[18] = r.zip || ad.zip;
      f[19] = "USA";
      f[27] = money(r.fica, "0");        // fica
      f[28] = money(r.fedTax, "0");      // fedwh
      f[29] = money(r.stateTax, "0");    // stwh
      f[30] = money(r.grossTotal) || money(r.grossProject, "0"); // grosspayallprojects
      f[31] = money(r.net, "0");         // netpay
      // city tax and "other" have no columns of their own \u2014 they ride as named deductions
      // a deduction of nothing isn't a deduction — naming it would only put
      // "Miscellaneous $0.00" on their upload
      const some = (v: Cell) => { const m = money(v); return m && Number(m) !== 0 ? m : ""; };
      const deds: [string, string][] = [];
      if (some(r.cityTax)) deds.push(["City Income Tax", some(r.cityTax)]);
      if (some(r.otherDed)) deds.push(["Miscellaneous", some(r.otherDed)]);
      if (deds[0]) { f[33] = deds[0][0]; f[34] = deds[0][1]; }
      if (deds[1]) { f[35] = deds[1][0]; f[36] = deds[1][1]; }
      f[39] = r.classification;          // classification
      f[40] = (r.trade || "J").toUpperCase(); // trade J/A
      f[41] = money(r.grossProject, "0"); // grosspaythisproject
      f[42] = money(r.otherRt, "0"); f[43] = money(r.otherOt, "0"); // other-project hours
      f[44] = "N"; f[45] = "N"; f[46] = "N"; // benefits paid to union/employee/other
      f[50] = "N"; f[51] = "N"; f[52] = "N"; // make-up days
      r.st.forEach((h, i) => { if (i < 7) f[53 + i] = money(h, "0"); }); // rt1..rt7
      f[60] = money(r.stRate, "0");      // rtrate (required even when 0)
      r.ot.forEach((h, i) => { if (i < 7) f[71 + i] = money(h, "0"); }); // ot1..ot7
      f[78] = money(r.otRate);           // otrate
      f[114] = rep.contractNo;           // contractno
      f[116] = COMPANY.fedTaxId;         // taxpayerid
      f[117] = "0";                      // sdi
      f[118] = "0";                      // etax (KCMO only)
      lines.push(f.map(esc).join(","));
    }
  }
  // no BOM: their sample file starts with the bare header, and a byte-exact
  // header is what the importer matches on
  return lines.join("\r\n") + "\r\n";
}

// ---- NYCHA takes certified payroll per RELEASE: the money stays from the
// payroll report; the hour split per release comes from the portal's own
// timesheets (which hold hours only, never wages) ----
export interface ReleaseHours { rel: string; byWorker: Record<string, number[]> } // 7 day-hours, Sat..Fri

// name matching between the payroll PDF and the portal crew list:
// sorted word-set, "Last, First M" == "First Last"
export const workerKey = (name: string): string => {
  const s = (name || "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  const toks = s.split(" ").filter((w) => w.length > 1);
  return [...new Set(toks)].sort().join(" ");
};

const moneyN = (v: Cell): number => {
  const x = Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(x) ? x : 0;
};

// `offRelease` is the worker's hours that week that belong to no release —
// shop time, yard time, anything not on a NYCHA job. They are not billed to a
// release, but they ARE part of the week the gross was earned in, so they have
// to count in the share and show up as hours on other work.
export function splitReportByRelease(rep: CpReport, releases: ReleaseHours[], offRelease: Record<string, number[]> = {}): { groups: { rel: string; report: CpReport }[]; unmatched: CpReport | null } {
  const daySum = (days: number[], weekend: boolean) =>
    days.reduce((s, h, i) => (i < 2) === weekend ? s + (Number(h) || 0) : s, 0);
  // which releases each payroll worker shows up on, and their total hours.
  // Two payroll rows can share one name (a worker paid under two
  // classifications, or a father & son) — the timesheet can't be attributed
  // twice, so those rows are NOT split; they go out in the unmatched file.
  const keyCount: Record<string, number> = {};
  for (const row of rep.rows) { const k = workerKey(row.name); if (k) keyCount[k] = (keyCount[k] || 0) + 1; }
  const rowsByRel: Record<string, CpRow[]> = {};
  const matched = new Set<string>();
  for (const row of rep.rows) {
    const k = workerKey(row.name);
    if (k && keyCount[k] > 1) continue;
    const mine = releases
      .map((rh) => ({ rel: rh.rel, days: rh.byWorker[k] }))
      .filter((x): x is { rel: string; days: number[] } => !!k && !!x.days && x.days.some((h) => Number(h) > 0));
    if (mine.length === 0) continue;
    matched.add(k);
    const off = offRelease[k] || [];
    const relWkAll = mine.reduce((s, m) => s + daySum(m.days, false), 0);
    const relWeAll = mine.reduce((s, m) => s + daySum(m.days, true), 0);
    // the whole week the pay covers, releases and everything else
    const totWk = relWkAll + daySum(off, false);
    const totWe = relWeAll + daySum(off, true);
    const totAll = totWk + totWe;
    const relAll = relWkAll + relWeAll;
    // what the worker earned on this project is what gets split across its
    // releases; the all-jobs figure stays whole in its own column
    const gross = moneyN(row.grossProject) || moneyN(row.grossTotal);
    // only the part of the pay that the release hours earned is shared out
    const relGross = Math.round(gross * (relAll / (totAll || 1)) * 100) / 100;
    let allocated = 0;
    mine.forEach((m, i) => {
      const relWk = daySum(m.days, false), relWe = daySum(m.days, true);
      // shares add back to that exactly — the last release takes the remainder
      const share = i === mine.length - 1
        ? Math.round((relGross - allocated) * 100) / 100
        : Math.round(gross * ((relWk + relWe) / (totAll || 1)) * 100) / 100;
      allocated = Math.round((allocated + share) * 100) / 100;
      (rowsByRel[m.rel] ||= []).push({
        ...row,
        st: m.days.map((h, di) => (di < 2 ? 0 : Number(h) || 0)),
        ot: m.days.map((h, di) => (di < 2 ? Number(h) || 0 : 0)), // Sat/Sun ride as overtime
        grossProject: gross ? share : row.grossProject,
        // the all-projects gross stays the WHOLE week even when only
        // "Gross (this job)" was filled in on the grid
        grossTotal: moneyN(row.grossTotal) ? row.grossTotal : (gross || row.grossTotal),
        otherRt: Math.round((totWk - relWk) * 100) / 100,
        otherOt: Math.round((totWe - relWe) * 100) / 100,
      });
    });
  }
  const groups = Object.entries(rowsByRel)
    .sort(([a], [b]) => (parseFloat(a) || 0) - (parseFloat(b) || 0))
    .map(([rel, rows]) => ({ rel, report: { ...rep, contractNo: rel, rows } }));
  const un = rep.rows.filter((row) => !matched.has(workerKey(row.name)));
  const dupNames = [...new Set(rep.rows.filter((r) => keyCount[workerKey(r.name)] > 1).map((r) => r.name))];
  const unNotes = dupNames.length
    ? [`${dupNames.join(", ")}: listed more than once on the payroll — the portal can't tell which hours go with which row, so split these by hand.`]
    : [];
  return { groups, unmatched: un.length > 0 ? { ...rep, rows: un, notes: unNotes } : null };
}

// problems worth flagging before the file goes out the door
export function lcmWarnings(reports: CpReport[]): string[] {
  const out: string[] = [];
  for (const rep of reports) {
    const wk = rep.weekEnding || "?";
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(rep.weekEnding || ""))
      out.push(`Week "${wk}": the week-ending date must look like 08/01/2026 (MM/DD/YYYY).`);
    rep.rows.forEach((r, i) => {
      const who = r.name || `worker ${i + 1}`;
      if (r.ssn4.trim() && !lcmSsn(r.ssn4)) out.push(`Week ${wk} \u00B7 ${who}: SSN "${r.ssn4}" isn't 4 or 9 digits \u2014 it would go out blank.`);
      if (!r.ssn4.trim()) out.push(`Week ${wk} \u00B7 ${who}: no SSN \u2014 their upload requires one (last 4 is enough).`);
      if (!r.ethnicity) out.push(`Week ${wk} \u00B7 ${who}: no ethnicity code \u2014 their upload requires one (pick it in the worker's row).`);
      if (!splitName(r.name).last) out.push(`Week ${wk} \u00B7 ${who}: needs a first AND last name.`);
    });
  }
  return out;
}
