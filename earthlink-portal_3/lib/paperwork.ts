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
// the lines' total the way the database works it out (RUN_ME section 15:
// round(sum(qty * price), 2)): one exact sum, rounded once
export const exactTotal = (rows: MoneyLine[] | null | undefined): number =>
  Math.round((rows || []).reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.unit_price) || 0), 0) * 100) / 100;

// A line's words with its figures taken off: money, rates, the item number,
// the unit or property code a partner's table prints in front of the
// description, and anything in brackets ("0884-03A Sales Tax (8.875%, incl.
// MCTD) $245.05" reads "sales tax").
export function labelOf(d: string): string {
  let s = String(d || "").toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\$\s*-?[\d,]*\.?\d+/g, " ")
    .replace(/-?\d[\d,]*(?:\.\d+)?\s*%/g, " ")
    .replace(/\s*[&/+]\s*/g, " and ")
    .replace(/^\s*(?:item|line)\s*(?:no\.?|#)?\s*(?=\d)/, "");
  for (let m = s.match(/^\s*\S*\d\S*\s+/); m; m = s.match(/^\s*\S*\d\S*\s+/)) s = s.slice(m[0].length);
  return s.replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
}

// A tax line OPENS with the tax: "Sales Tax", "NYS Sales Tax 8.875%", "Tax",
// "Sales & Use Tax", "Total Tax", "MTA Tax", "Kings County Sales Tax",
// "SALESTAX", "Sales Tax (materials only)". Work that only mentions tax
// ("Plaster incl. tax", "Taxi stand repaint") is still work, and so is a line
// whose tax word is straight away qualified out of being a charge ("Tax
// exempt paint", "Sales tax included", "Tax lot 12 survey", "Tax ID").
const TAX_HEAD = /^(?:(?:est|estimated|total|combined|applicable|plus|add|nyc|nys|ny|new york|state|city|local|county|mctd|mta|and|[a-z]+ county)\s+)*(?:salestax|(?:(?:sales and use|sales|sale|sls|use)\s+)?tax)(?:es)?(?:\s|$)/;
const NOT_A_CHARGE = /^(?:incl|included|includes|including|inclusive|exempt|exemption|id|lot|free)\b/;
// the pieces of a New York tax printed by their codes alone ("NYS 4%", "MCTD 0.375%")
const TAX_CODES = /^(?:nys|nyc|mctd|mta)(?: and (?:nys|nyc|mctd|mta))*$/;
export const isTaxLine = (d: string): boolean => {
  const l = labelOf(d);
  if (TAX_CODES.test(l)) return true;
  const m = l.match(TAX_HEAD);
  return !!m && !NOT_A_CHARGE.test(l.slice(m[0].length));
};

// A totals line is ALL label: "Subtotal", "Grand Total", "Total Cost (labor
// and materials)", "Amount Due", "Total before tax". "Total gut renovation of
// the kitchen" and "Subtotal of plaster work 130 SF" are work.
const TOTAL_LABEL = /^(?:sub ?total|grand total|total|net total|order total|po total|invoice total|job total|total amount|total due|amount due|balance|balance due|balance remaining|total cost(?: labou?r and materials?)?|total labou?r and materials?|(?:non )?taxable (?:sub ?total|amount|total)|(?:sub ?total|total) (?:before|excl|excluding|without|incl|including|with|plus|after) (?:sales )?tax(?:es)?)(?: amount| due)?$/;
export const isTotalLabel = (d: string): boolean => TOTAL_LABEL.test(labelOf(d));

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

// The rate a document's own tax charges. A tax printed twice (a row in the
// table and again in the footer) is one tax; the state, city and transit
// pieces of a New York tax ("NYS 4%", "NYC 4.5%", "MCTD 0.375%") add up to
// one rate. The candidates, in order: the percentages printed, the figure
// matched to a New York rate to the cent, and (unless strict) the figure over
// the work. When the document prints its total, the rate has to reproduce it.
// Nothing when nothing fits: the job keeps its own rate (a $0.00 or 0% line is
// not taken as "no tax" here: that is a person's call).
const NY_RATES = [8.875, 8.625, 8.5, 8.375, 8.25, 8.125, 8, 7.375, 7, 4.5, 4];
const pctOf = (d: string): number | undefined => {
  const m = String(d || "").match(/(\d+(?:\.\d+)?)\s*%/);
  const v = m ? parseFloat(m[1]) : NaN;
  return v > 0 && v <= 20 ? v : undefined;
};
// the tax lines with a repeat of the same tax taken out
const onceEach = (taxRows: MoneyLine[]) => {
  const seen = new Set<string>();
  return (taxRows || []).filter((r) => {
    const k = `${pctOf(r.description) ?? ""}|${Math.round(amountOf(r) * 100)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
// the tax a document charges, counted once
export const taxFigure = (taxRows: MoneyLine[]): number => sumOf(onceEach(taxRows));
// the work taxed at this rate comes to the printed total (to the cent, five at most)
export const fitsTotal = (workSum: number, rate: number, total: number): boolean =>
  Math.abs(Math.round(workSum * (100 + rate)) / 100 - total) <= 0.05;
const snap = (workSum: number, fig: number) => NY_RATES.find((k) => Math.abs(Math.round(workSum * k) - Math.round(fig * 100)) <= 1);
export function taxRateOf(taxRows: MoneyLine[], workSum: number, opts: { total?: number; strict?: boolean } = {}): number | undefined {
  if (!(workSum > 1)) return undefined;
  const rows = onceEach(taxRows);
  const cands: number[] = [];
  const pcts = rows.map((r) => pctOf(r.description)).filter((v): v is number => v !== undefined);
  if (pcts.length) cands.push(Math.round(pcts.reduce((a, b) => a + b, 0) * 1000) / 1000);
  const T = sumOf(rows);
  if (T > 0) {
    const all = snap(workSum, T);
    if (all !== undefined) cands.push(all);
    for (const r of rows) { const one = snap(workSum, amountOf(r)); if (one !== undefined) cands.push(one); }
    const r = Math.round((T / workSum) * 100 * 1000) / 1000;
    if (!opts.strict && r > 0 && r <= 20) cands.push(r);
  }
  const total = Number(opts.total) || 0;
  return cands.find((k) => !(total > 1) || fitsTotal(workSum, k, total));
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
// the job was still at it, so taking a tax line off never prices a job (and
// never hands it an invoice number). The rate is set only when the job never
// had one chosen and the tax line names (or reproduces) its own.
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
  // only a rate the tax line prints, or one it reproduces to the cent on the
  // work as it stands: never a figure divided by work that has changed since
  const own = !hadRate || was === 8.875 ? taxRateOf(s.tax, newTotal, { strict: true }) : undefined;
  const rate = own ?? was;
  const patch: { items: T[]; amount?: number; tax_pct?: number; list_subtotal?: number } = { items: s.work };
  if (own !== undefined && own !== was) patch.tax_pct = own;
  const amt = Number(j.amount) || 0;
  const fromLines = Math.abs(amt - cents(oldTotal * (1 + was / 100))) <= 0.02 || Math.abs(amt - cents(oldTotal * 1.08875)) <= 0.02;
  if (fromLines && newTotal > 0) patch.amount = cents(newTotal * (1 + rate / 100));
  const base = j.list_subtotal === null || j.list_subtotal === undefined || String(j.list_subtotal).trim() === "" ? NaN : Number(j.list_subtotal);
  // still at the baseline, judged the way the database rounds it (to the cent)
  if (Number.isFinite(base) && Math.abs(base - exactTotal(items)) <= 0.011) patch.list_subtotal = exactTotal(s.work);
  return { patch, billed: false, removed, taxLines: s.tax.length };
}
