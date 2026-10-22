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

// A line's words with its figures taken off: money, rates, the item number,
// and the unit or property code a partner's table prints in front of the
// description ("0884-03A Sales Tax (8.875%) $245.05" reads "sales tax").
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
// "Sales & Use Tax", "Total Tax", "Sales Tax (materials only)". Work that only
// mentions tax ("Plaster incl. tax", "Tax exempt paint", "Tax lot 12 survey",
// "Taxi stand repaint") is still work.
const TAX_HEAD = /^(?:(?:est|estimated|total|combined|applicable|plus|add|nyc|nys|ny|new york|state|city|local|county|mctd|and)\s+)*(?:(?:sales and use|sales|sale|sls|use)\s+)?tax(?:es)?(?:\s|$)/;
const NOT_A_CHARGE = /\b(?:incl|included|includes|including|inclusive|exempt|exemption|id|lot|free|not|no)\b/;
export const isTaxLine = (d: string): boolean => {
  const l = labelOf(d);
  return TAX_HEAD.test(l) && !NOT_A_CHARGE.test(l);
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
  const W = sumOf(work0), T = sumOf(tax);
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

// The rate a PO's own tax line charges: the percentage it prints, or else its
// figure over the work, matched to a New York rate when that rate gives the
// same figure to the cent. Nothing when the line names no rate and carries no
// figure (a $0.00 line is not taken as "no tax" here: that is a person's call).
const NY_RATES = [8.875, 8.625, 8.5, 8.375, 8.25, 8.125, 8, 7.375, 7, 4.5, 4];
export function taxRateOf(taxRows: MoneyLine[], workSum: number): number | undefined {
  for (const r of taxRows || []) {
    const m = String(r.description || "").match(/(\d+(?:\.\d+)?)\s*%/);
    if (m) { const v = parseFloat(m[1]); if (v >= 0 && v <= 20) return v; }
  }
  const T = sumOf(taxRows || []);
  if (!(workSum > 1) || !(T > 0)) return undefined;
  // in whole cents: 780 x 8.875% is 69.225 exactly, which floats to 69.2249999 and would round down
  const hit = NY_RATES.find((k) => Math.abs(Math.round(workSum * k) - Math.round(T * 100)) <= 1);
  if (hit !== undefined) return hit;
  const r = Math.round((T / workSum) * 100 * 1000) / 1000;
  return r > 0 && r <= 20 ? r : undefined;
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
export function paperworkRepair<T extends MoneyLine>(j: RepairJob & { items?: T[] | null }):
  { patch: { items: T[]; amount?: number; tax_pct?: number; list_subtotal?: number } | null; billed: boolean; removed: number } {
  const items = (Array.isArray(j.items) ? j.items : []) as T[];
  const s = splitPaperwork(items);
  const removed = s.tax.length + s.totals.length;
  const billed = !!(j.invoice_sent || j.received || j.paid_date);
  if (removed === 0 || j.canceled || billed) return { patch: null, billed: billed && removed > 0, removed };
  const oldTotal = sumOf(items), newTotal = s.workSum;
  const hadRate = j.tax_pct !== null && j.tax_pct !== undefined && String(j.tax_pct).trim() !== "";
  const was = hadRate ? Number(j.tax_pct) : 8.875;
  const own = hadRate ? undefined : taxRateOf(s.tax, newTotal);
  const rate = own ?? was;
  const patch: { items: T[]; amount?: number; tax_pct?: number; list_subtotal?: number } = { items: s.work };
  if (own !== undefined && own !== was) patch.tax_pct = own;
  const amt = Number(j.amount) || 0;
  const fromLines = Math.abs(amt - cents(oldTotal * (1 + was / 100))) <= 0.02 || Math.abs(amt - cents(oldTotal * 1.08875)) <= 0.02;
  if (fromLines && newTotal > 0) patch.amount = cents(newTotal * (1 + rate / 100));
  const base = j.list_subtotal === null || j.list_subtotal === undefined || String(j.list_subtotal).trim() === "" ? NaN : Number(j.list_subtotal);
  if (Number.isFinite(base) && Math.abs(base - oldTotal) < 0.005) patch.list_subtotal = newTotal;
  return { patch, billed: false, removed };
}
