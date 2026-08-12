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
  const money = (v: Cell, dflt = ""): string => {
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
      const deds: [string, string][] = [];
      if (money(r.cityTax)) deds.push(["City Income Tax", money(r.cityTax)]);
      if (money(r.otherDed)) deds.push(["Miscellaneous", money(r.otherDed)]);
      if (deds[0]) { f[33] = deds[0][0]; f[34] = deds[0][1]; }
      if (deds[1]) { f[35] = deds[1][0]; f[36] = deds[1][1]; }
      f[39] = r.classification;          // classification
      f[40] = (r.trade || "J").toUpperCase(); // trade J/A
      f[41] = money(r.grossProject, "0"); // grosspaythisproject
      f[42] = "0"; f[43] = "0";          // other-project hours
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
