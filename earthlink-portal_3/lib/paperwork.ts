// Sales tax and the totals are the paperwork under a bill, never a line of
// work. Our invoice and proposal add the tax once, below the subtotal, at the
// job's own rate, so a "Sales Tax" row carried in from a partner's PO (or read
// back off one of our own letters) would be billed twice: once as a line, and
// again on top of everything, itself included. These tests decide what such a
// row is, wherever rows arrive: the PO readers, the price list, the letter
// reader, the job's lines on screen and on paper, and the crew's texts.
// Pure, with no imports: shared by the phones, the server and the tests.
// (No lookbehind anywhere: the phones that run this include old Safaris.)

export interface MoneyLine { description: string; qty?: number | string; unit_price?: number | string }

const cents = (v: number) => Math.round((Number(v) || 0) * 100) / 100;
const amountOf = (r: MoneyLine) => cents((Number(r.qty) || 0) * (Number(r.unit_price) || 0));
const sumOf = (rows: MoneyLine[]) => cents(rows.reduce((s, r) => s + amountOf(r), 0));

// The lines' total exactly the way the database works it out (RUN_ME section
// 15: round(sum(qty * price), 2), in exact decimals, half away from zero):
// whole numbers scaled by a million, so no float ever decides a cent.
const SCALE = 6;
const scaled = (v: unknown): bigint => {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return BigInt(0);
  let s = String(n);
  if (/e/i.test(s)) s = n.toFixed(SCALE);
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  const [i, f = ""] = s.split(".");
  const v2 = BigInt(i + (f + "000000").slice(0, SCALE));
  return neg ? -v2 : v2;
};
export const exactTotal = (rows: MoneyLine[] | null | undefined): number => {
  let sum = BigInt(0);
  for (const r of rows || []) sum += scaled(r.qty) * scaled(r.unit_price); // scaled by 10^12
  const unit = BigInt(10000000000);                                          // 10^12 down to cents
  const neg = sum < BigInt(0);
  const c = ((neg ? -sum : sum) + unit / BigInt(2)) / unit;
  return Number(neg ? -c : c) / 100;
};

// A line's words with its figures taken off: money, rates, the item number,
// and the unit or property code a partner's table prints in front of the
// description ("0884-03A Sales Tax (8.875%) $245.05" reads "sales tax").
// Words in brackets stay words.
export function labelOf(d: string): string {
  let s = String(d || "").toLowerCase()
    .replace(/\$\s*-?[\d,]*\.?\d+/g, " ")
    .replace(/-?\d[\d,]*(?:\.\d+)?\s*%/g, " ")
    .replace(/\s*[&/+]\s*/g, " and ")
    .replace(/^\s*(?:item|line)\s*(?:no\.?|#)?\s*(?=\d)/, "");
  for (let m = s.match(/^\s*\S*\d\S*\s+/); m; m = s.match(/^\s*\S*\d\S*\s+/)) s = s.slice(m[0].length);
  return s.replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
}

// A tax line OPENS with the tax: "Sales Tax", "NYS Sales Tax 8.875%", "Tax",
// "Sales & Use Tax", "Total Tax", "MTA Tax", "Kings County Sales Tax",
// "SALESTAX", "Sales Tax (materials only)", "Sales Tax (incl. MCTD)", the
// codes of a New York tax's pieces on their own ("NYS 4%", "MCTD 0.375%") and
// the transit surcharge ("MCTD Surcharge 0.375%"). Work that only mentions tax
// ("Plaster incl. tax", "Taxi stand repaint", "Prepare county tax filing") is
// still work, and so is a line whose tax word is straight away qualified out
// of being a charge ("Tax exempt paint", "Sales tax included", "Tax lot 12
// survey", "Tax ID"). ("Sales Tax (not included in unit prices)" is the
// tax, charged on top.)
const COUNTY = "(?:kings|queens|bronx|new york|richmond|nassau|suffolk|westchester|rockland|orange|putnam|dutchess|albany|erie|monroe|onondaga) county";
const TAX_HEAD = new RegExp(`^(?:(?:est|estimated|total|combined|applicable|plus|add|nyc|nys|ny|new york|state|city|local|county|mctd|mta|and|${COUNTY})\\s+)*(?:salestax|(?:(?:sales and use|sales|sale|sls|use)\\s+)?tax)(?:es)?(?:\\s|$)`);
const TAX_CODES = /^(?:nys|nyc|mctd|mta)(?: and (?:nys|nyc|mctd|mta))*$/;
const SURCHARGE = /^(?:mctd|mta|metropolitan commuter transportation district)(?: and (?:mctd|mta))? surcharge(?:\s|$)/;
// right after the tax word: not a charge ("exempt", "included"), unless what
// is included is a piece of the tax itself ("incl. MCTD")
const NOT_A_CHARGE = /^(?:exempt|exemption|id|lot|free|inclusive|incl(?:uded|udes|uding)?(?! (?:mctd|mta|surcharge|county|city|state|nys|nyc)\b))\b/;
const taxHead = (l: string): RegExpMatchArray | null => {
  if (TAX_CODES.test(l)) return l.match(/^.*$/);
  return l.match(SURCHARGE) || l.match(TAX_HEAD);
};
export const isTaxLine = (d: string): boolean => {
  const l = labelOf(d);
  const m = taxHead(l);
  return !!m && !NOT_A_CHARGE.test(l.slice(m[0].length).trim());
};

// A totals line is ALL label: "Subtotal", "Grand Total", "Total Cost (labor
// and materials)", "Amount Due", "Total before tax". "Total gut renovation of
// the kitchen" and "Subtotal of plaster work 130 SF" are work.
const TOTAL_LABEL = /^(?:sub ?total|grand total|total|net total|order total|po total|invoice total|job total|total amount|total due|amount due|balance|balance due|balance remaining|total cost(?: labou?r and materials?)?|total labou?r and materials?|(?:non )?taxable (?:sub ?total|amount|total)|(?:sub ?total|total) (?:before|excl|excluding|without|incl|including|with|plus|after) (?:sales )?tax(?:es)?)(?: amount| due)?$/;
export const isTotalLabel = (d: string): boolean => TOTAL_LABEL.test(labelOf(d));

// Nothing but the paperwork's own label: "Sales Tax", "Tax (8.875%)", "NYS
// Sales Tax", "Subtotal", "Grand Total". Not a line with more words after it
// ("tax and delivery", or "balance" of "pressure balance"), which can be the
// end of a work description wrapped onto its own line.
const TAX_TAIL = /^(?:(?:total|amount|due|charged?|rate|on|of|the|above|materials?|labou?r|only|sub ?total|incl|mctd|mta|surcharge|if|applicable|nys|nyc)\s*)*$/;
export const isPurePaperLabel = (d: string): boolean => {
  const l = labelOf(d);
  if (!l) return false;
  if (l !== "balance" && TOTAL_LABEL.test(l)) return true;
  const m = taxHead(l);
  return !!m && TAX_TAIL.test(l.slice(m[0].length).trim());
};

// The rows of a document split into the work and its paperwork. A tax line is
// known by its name alone. A totals line also has to carry the totals' figure
// (the work above it, with or without the tax) or nothing at all: a PO whose
// one priced row is called "Total" is billing that work, and it stays.
export function splitPaperwork<T extends MoneyLine>(rows: T[]): { work: T[]; tax: T[]; totals: T[]; workSum: number; taxSum: number } {
  const list = Array.isArray(rows) ? rows : [];
  const tax = list.filter((r) => isTaxLine(r.description));
  const rest = list.filter((r) => !tax.includes(r));
  const work0 = rest.filter((r) => !isTotalLabel(r.description));
  const W = sumOf(work0), T = taxFigure(tax);
  const totals = rest.filter((r) => {
    if (!isTotalLabel(r.description)) return false;
    const a = amountOf(r);
    return a === 0 || (W > 0 && a >= W - 0.02 && a <= cents((W + T) * 1.1) + 0.02);
  });
  const work = list.filter((r) => !tax.includes(r) && !totals.includes(r));
  return { work, tax, totals, workSum: sumOf(work), taxSum: T };
}
// the lines that are billed: everything but the paperwork
export const workLines = <T extends MoneyLine>(rows: T[] | null | undefined): T[] => splitPaperwork(rows || []).work;
export const hasPaperwork = (rows: MoneyLine[] | null | undefined): boolean => {
  const s = splitPaperwork(rows || []);
  return s.tax.length + s.totals.length > 0;
};

// The rate a document's own tax charges.
//  - A line printed twice in the same words and figure is one tax (a table
//    row "Sales Tax 8.875%" and the footer's "Sales Tax" under it). Lines in
//    different words are different taxes: a state 4% and a county 4% are 8%.
//  - The state, city and transit pieces of a New York tax ("NYS 4%", "NYC
//    4.5%", "MCTD 0.375%") add up to one rate; a "Total Sales Tax 8.875%"
//    printed beside its own pieces is their sum, not one more piece.
//  - The candidates, in order: the printed percentage, the tax figure (all of
//    it, or one line of it) matched to a New York rate to the cent, and
//    (unless strict) the figure over the work.
//  - With the document's printed total: the first candidate that reproduces
//    it. If none does (freight, a discount on the total), the printed
//    percentage still stands, unless strict.
//  - Strict, with no total: only a rate that reproduces one of the tax
//    figures on the work to the cent (a saved job is never re-rated on a guess).
// Nothing when nothing fits: the job keeps its own rate. (A $0.00 or 0% line
// is not taken as "no tax" here: that is a person's call.)
const NY_RATES = [8.875, 8.625, 8.5, 8.375, 8.25, 8.125, 8, 7.375, 7, 4.5, 4];
const pctOf = (d: string): number | undefined => {
  const m = String(d || "").match(/(\d+(?:\.\d+)?)\s*%/);
  const v = m ? parseFloat(m[1]) : NaN;
  return v > 0 && v <= 20 ? v : undefined;
};
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const onceEach = (taxRows: MoneyLine[]) => {
  const seen = new Set<string>();
  return (taxRows || []).filter((r) => {
    const k = `${labelOf(r.description)}|${Math.round(amountOf(r) * 100)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
// the tax a document charges, counted once (a line that is the others' sum is not added to them)
export const taxFigure = (taxRows: MoneyLine[]): number => {
  const rows = onceEach(taxRows);
  const all = sumOf(rows);
  const whole = rows.length > 2 ? rows.find((r) => Math.abs(amountOf(r) * 2 - all) <= 0.02) : undefined;
  return whole ? amountOf(whole) : all;
};
// the work taxed at this rate comes to the printed total (to the cent, five at most)
export const fitsTotal = (workSum: number, rate: number, total: number): boolean =>
  Math.abs(Math.round(workSum * (100 + rate)) / 100 - total) <= 0.05;
const snap = (workSum: number, fig: number) => NY_RATES.find((k) => Math.abs(Math.round(workSum * k) - Math.round(fig * 100)) <= 1);
export function taxRateOf(taxRows: MoneyLine[], workSum: number, opts: { total?: number; strict?: boolean } = {}): number | undefined {
  if (!(workSum > 1)) return undefined;
  const rows = onceEach(taxRows);
  const pcts = rows.map((r) => pctOf(r.description)).filter((v): v is number => v !== undefined);
  let printed: number | undefined;
  if (pcts.length) {
    const sum = r3(pcts.reduce((a, b) => a + b, 0));
    printed = (pcts.length > 2 ? pcts.find((p) => Math.abs(p * 2 - sum) < 0.0005) : undefined) ?? sum;
  }
  const T = taxFigure(rows);
  const figs = [T, ...rows.map(amountOf)].filter((v) => v > 0);
  const snaps = figs.map((v) => snap(workSum, v)).filter((v): v is number => v !== undefined);
  const lr = T > 0 ? r3((T / workSum) * 100) : 0;
  const loose = lr > 0 && lr <= 20 ? lr : undefined;
  const total = Number(opts.total) || 0;
  if (total > 1) {
    const cands = [printed, ...snaps, opts.strict ? undefined : loose].filter((v): v is number => v !== undefined);
    return cands.find((k) => fitsTotal(workSum, k, total)) ?? (opts.strict ? undefined : printed);
  }
  if (opts.strict) {
    // borne out by the figures: the printed rate when one of them reproduces it, else a New York rate one reproduces
    if (printed !== undefined) return figs.length === 0 ? (NY_RATES.includes(printed) ? printed : undefined) : snaps.includes(printed) ? printed : undefined;
    return snaps[0];
  }
  return printed ?? snaps[0] ?? loose;
}

// Does a document's work add up to the total it printed? With no tax, with its
// own tax figure, or taxed at its rate (the job's default when it names none).
export function addsUp(workSum: number, taxSum: number, total: number, rate?: number): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.05;
  if (near(workSum, total)) return true;
  if (taxSum > 0 && near(cents(workSum + taxSum), total)) return true;
  return near(cents(workSum * (1 + (rate ?? 8.875) / 100)), total);
}

// A job already in the portal that carries paperwork lines: what to write so
// it bills its tax once. Nothing for a job that is clean, canceled, or already
// invoiced or paid (what went out is what was billed: those are a person's to
// look at). The work lines themselves are never touched: no price, quantity,
// unit or key changes. Money moves only where it was worked out from the
// lines; a total the PO printed stays. The auto-price baseline moves only when
// the job was still exactly at it, so taking a tax line off never prices a
// job (and never hands it an invoice number). The rate is set only when the
// job holds none of its own choosing and the tax line names one that its
// figures (or the PO's printed total) bear out.
export interface RepairJob {
  items?: MoneyLine[] | null; amount?: number | string | null; tax_pct?: number | string | null;
  list_subtotal?: number | string | null; invoice_sent?: string | null; received?: boolean | null;
  paid_date?: string | null; canceled?: boolean | null;
}
export const isBilled = (j: RepairJob): boolean => !!(j.invoice_sent || j.received || j.paid_date);
export function paperworkRepair<T extends MoneyLine>(j: RepairJob & { items?: T[] | null }):
  { patch: { items: T[]; amount?: number; tax_pct?: number; list_subtotal?: number } | null; billed: boolean; removed: number; taxLines: number } {
  const items = (Array.isArray(j.items) ? j.items : []) as T[];
  const s = splitPaperwork(items);
  const removed = s.tax.length + s.totals.length;
  const billed = isBilled(j);
  if (removed === 0 || j.canceled || billed) return { patch: null, billed: billed && removed > 0, removed, taxLines: s.tax.length };
  const oldTotal = sumOf(items), newTotal = s.workSum;
  // the column's own default (8.875) is not a rate anyone chose: the jobs this
  // repairs came in before the readers carried a PO's rate, and they all hold it
  const hadRate = j.tax_pct !== null && j.tax_pct !== undefined && String(j.tax_pct).trim() !== "";
  const was = hadRate ? Number(j.tax_pct) : 8.875;
  const amt = Number(j.amount) || 0;
  const fromLines = Math.abs(amt - cents(oldTotal * (1 + was / 100))) <= 0.02 || Math.abs(amt - cents(oldTotal * 1.08875)) <= 0.02;
  // only a rate the tax line names and its figures (or the PO's printed
  // total, when that is what the job holds) bear out: never a guess
  const own = !hadRate || was === 8.875 ? taxRateOf(s.tax, newTotal, { strict: true, total: !fromLines && amt > 1 ? amt : undefined }) : undefined;
  const rate = own ?? was;
  const patch: { items: T[]; amount?: number; tax_pct?: number; list_subtotal?: number } = { items: s.work };
  if (own !== undefined && own !== was) patch.tax_pct = own;
  if (fromLines && newTotal > 0) patch.amount = cents(newTotal * (1 + rate / 100));
  const base = j.list_subtotal === null || j.list_subtotal === undefined || String(j.list_subtotal).trim() === "" ? NaN : Number(j.list_subtotal);
  // still exactly at the baseline, to the cent the way the database rounds it
  if (Number.isFinite(base) && Math.abs(base - exactTotal(items)) < 0.005) patch.list_subtotal = exactTotal(s.work);
  return { patch, billed: false, removed, taxLines: s.tax.length };
}
