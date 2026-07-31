// Certified payroll PDF → eComply CSV.
// Reads the text of a certified payroll report (the WH-347-style weekly report
// a payroll company produces) and pulls out the header (payroll #, week ending,
// project) and one row per worker: name, last-4 SSN, classification, day-by-day
// hours, rates, gross, deductions, net. Layouts vary by payroll company, so the
// parser fills what it can confidently find — the page shows everything in an
// editable grid before the CSV is made. NOTHING here is saved to the database:
// wages exist only inside the file the user downloads.

// cells hold whatever the user types; numbers are coerced when the CSV is built
export type Cell = number | string;
export interface CpRow {
  name: string;
  ssn4: string;
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

// One line of extracted PDF text (tokens ordered left→right).
export interface CpLine { tokens: string[] }

export function parseCertifiedPayroll(fileName: string, lines: CpLine[]): CpReport {
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

export function buildCsv(reports: CpReport[]): string {
  const head = [
    "Payroll No", "Week Ending", "Contractor", "Project", "Contract No",
    "Employee Name", "SSN Last 4", "Address", "Work Classification",
    "ST Hours Day 1", "ST Hours Day 2", "ST Hours Day 3", "ST Hours Day 4", "ST Hours Day 5", "ST Hours Day 6", "ST Hours Day 7",
    "OT Hours Day 1", "OT Hours Day 2", "OT Hours Day 3", "OT Hours Day 4", "OT Hours Day 5", "OT Hours Day 6", "OT Hours Day 7",
    "Total ST Hours", "Total OT Hours", "ST Rate", "OT Rate",
    "Gross This Project", "Gross All Projects",
    "FICA", "Federal Tax", "State Tax", "City Tax", "Other Deductions", "Total Deductions", "Net Pay",
  ];
  const lines = [head.map(esc).join(",")];
  for (const rep of reports) {
    for (const r of rep.rows) {
      const stT = r.st.reduce<number>((s, h) => s + (Number(h) || 0), 0);
      const otT = r.ot.reduce<number>((s, h) => s + (Number(h) || 0), 0);
      const dedT = [r.fica, r.fedTax, r.stateTax, r.cityTax, r.otherDed].reduce<number>((s, d) => s + (Number(d) || 0), 0);
      lines.push([
        rep.payrollNo, rep.weekEnding, rep.contractor, rep.project, rep.contractNo,
        r.name, r.ssn4, r.address, r.classification,
        ...r.st, ...r.ot,
        stT || "", otT || "", r.stRate, r.otRate,
        r.grossProject, r.grossTotal || r.grossProject,
        r.fica, r.fedTax, r.stateTax, r.cityTax, r.otherDed, dedT || "", r.net,
      ].map(esc).join(","));
    }
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n"; // BOM so Excel opens it clean
}
