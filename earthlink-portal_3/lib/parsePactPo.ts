// Reads a PACT partner purchase order out of its extracted text — one parser
// used by BOTH the server route (/api/parse-po) and the in-browser fallback,
// so the two can never disagree.
export interface PactPoFields {
  po: string;
  poDate: string;
  desc: string;
  scope: string;        // what the PO says the work is, in its own words
  partner: string;
  address: string;      // the ship-to block: the job site
  billBlock: string;    // the partner's billing/office block
  contact: string;
  punit: string;
  amount: number;
  rows: { description: string; qty: number; unit_price: number; property: string; unit: string; uom?: string }[];
  readable: boolean;    // false = no text in the PDF at all (a scan)
}

const cash = (v: string) => parseFloat(String(v).replace(/[$,\s]/g, "")) || 0;
const tidy = (d: string) => d
  // a loose scan can start mid-header, so anything up to the last "PO 123 /
  // Scope of work / Description" marker is the paperwork, not the work
  .replace(/^.*\b(?:p\.?\s*o\.?|purchase\s*order|work\s*order|order)\s*(?:no\.?|number|#)?\s*:?\s*[\w-]*\s+/i, "")
  .replace(/^.*\b(?:scope(?:\s+of\s+work)?|description(?:\s+of\s+work)?)\s*:?\s*/i, "")
  .replace(/^[\s.,:;|-]+/, "").replace(/[\s.,:;|-]+$/, "")
  .replace(/^(?:item|line|no\.?|#)\s*\d*[.):]?\s*/i, "")
  .replace(/\s{2,}/g, " ").trim();

// Partners lay their POs out every which way, so when the column template
// doesn't fit, look anywhere in the text for "<work> <qty> <price> <total>"
// and keep only the ones whose arithmetic actually works. A row invented out
// of stray numbers can't survive that test, which is what makes it safe to
// scan loosely.
export function looseRows(t: string): PactPoFields["rows"] {
  const out: PactPoFields["rows"] = [];
  const seen = new Set<string>();
  const push = (desc: string, qty: number, up: number, amt: number) => {
    const d = tidy(desc);
    if (!d || d.length < 3 || qty <= 0 || up <= 0) return;
    if (Math.abs(qty * up - amt) > 0.02) return;      // the numbers must agree
    if (/^(?:total|subtotal|sub total|sales tax|tax|amount due|grand total|balance)\b/i.test(d)) return;
    const k = `${d.toLowerCase()}|${qty}|${up}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ description: d, qty, unit_price: up, property: "", unit: "" });
  };
  // "Plaster bedroom 250 5.00 1,250.00" and "… 250 $5.00 $1,250.00"
  for (const m of t.matchAll(/([A-Za-z][^$\n]{2,90}?)\s+(\d{1,5}(?:\.\d{1,2})?)\s+\$?\s*([\d,]+\.\d{2})\s+\$?\s*([\d,]+\.\d{2})/g))
    push(m[1], parseFloat(m[2]), cash(m[3]), cash(m[4]));
  // "Plaster bedroom 250 x $5.00 $1,250.00" — the way our own letters read
  for (const m of t.matchAll(/([A-Za-z][^$\n]{2,90}?)\s+(\d{1,5}(?:\.\d{1,2})?)\s*[x@]\s*\$?\s*([\d,]+\.\d{2})\s+\$?\s*([\d,]+\.\d{2})/gi))
    push(m[1], parseFloat(m[2]), cash(m[3]), cash(m[4]));
  return out;
}

export function parsePactPoText(raw: string): PactPoFields {
  const t = (raw || "").replace(/\s+/g, " ");
  const po = t.match(/Purchase Order\s*(?:No\.?|Number|#)?\s*:?\s*([A-Za-z]?\d[\w-]*)/i)?.[1]
    || t.match(/\bP\.?\s*O\.?\s*(?:No\.?|Number|#)?\s*:?\s*(\d[\w-]*)/i)?.[1]
    || t.match(/\bWork\s*Order\s*(?:No\.?|Number|#)?\s*:?\s*([A-Za-z]?\d[\w-]*)/i)?.[1]
    || t.match(/\bOrder\s*(?:No\.?|Number|#)\s*:?\s*([A-Za-z]?\d[\w-]*)/i)?.[1] || "";
  const poDate = t.match(/Date Ordered\s*:?\s*([\d/]+)/i)?.[1] || "";
  const desc = t.match(/Description\s*:?\s*(.*?)\s+(?:Contact info|Scheduled|Date Payment|PO Closed|Bill To)/i)?.[1]?.trim() || "";
  const billBlock = t.match(/Bill To\s+(.*?)\s+Ship To/i)?.[1] || "";
  const shipBlock = t.match(/Ship To\s+(.*?)\s+Description\s/i)?.[1] || "";
  const partner = billBlock.match(/^(.*?)(?=\s+\d)/)?.[1]?.trim() || billBlock.trim();
  // the ship-to block is the job site (the bill-to is the partner's office)
  const address = (partner && shipBlock.startsWith(partner) ? shipBlock.slice(partner.length) : shipBlock).trim();
  const contacts = [...t.matchAll(/([A-Z][a-z]+(?: [A-Z][a-z]+)?)\s*:?\s+((?:\d{3}[-.\s]?){2}\d{4})/g)].map((m) => `${m[1]} ${m[2]}`);
  // the Property/Unit columns are optional on these POs — only capture them when
  // the header actually has them, so a two-line PO without them can't get its
  // second row's description eaten by a greedy trailing capture
  const segM = t.match(/Description\s+Qty\s+Unit Price\s+Total Cost((?:\s+Property)?(?:\s+Unit)?)\s+(.*?)\s+Total\s+\$/i);
  const hasProp = /Property/i.test(segM?.[1] || "");
  const hasUnit = /Unit/i.test(segM?.[1] || "");
  const seg = segM?.[2] || "";
  const rowRe = hasProp
    ? /(.+?)\s+([\d,]+(?:\.\d+)?)\s+\$\s*([\d,]+(?:\.\d+)?)\s+\$\s*([\d,]+(?:\.\d+)?)(?:\s+((?!\d+\.\d)[\w-]+))?(?:\s+((?!\$)[\w-]+))?(?=\s|$)/g
    : /(.+?)\s+([\d,]+(?:\.\d+)?)\s+\$\s*([\d,]+(?:\.\d+)?)\s+\$\s*([\d,]+(?:\.\d+)?)(?=\s|$)/g;
  const rows = [...seg.matchAll(rowRe)]
    .map((m) => ({
      description: m[1].trim(),
      qty: parseFloat(m[2].replace(/,/g, "")) || 1,
      unit_price: parseFloat(m[3].replace(/,/g, "")) || 0,
      property: hasProp ? m[5] || "" : "",
      unit: hasUnit ? m[6] || "" : "",
    }));
  // the template's own row shape found nothing — read the text as it comes
  if (rows.length === 0) rows.push(...looseRows(t));
  const grand = [...t.matchAll(/Total\s+\$\s*([\d,]+\.\d{2})/g)].map((m) => parseFloat(m[1].replace(/,/g, "")));
  const amount = grand.length > 0 ? grand[grand.length - 1] : rows.reduce((s, r) => s + r.qty * r.unit_price, 0);
  const punit = rows[0]?.property
    ? `${rows[0].property}${rows[0].unit ? ` ${rows[0].unit}` : ""}`
    : t.match(/\$\s*[\d.,]+\s+([0-9]+-[0-9]+)/)?.[1] || "";
  const contact = contacts.length > 0
    ? contacts.join(" · ")
    : (t.match(/([A-Z][a-z]+ [A-Z][a-z]+)\s+(\d{3}[-.]?\d{3}[-.]?\d{4})/)?.slice(1, 3).join(" ") || "");
  // everything the PO says about the work, for matching against the price
  // list when it never priced anything itself
  const after = t.match(/(?:Description|Scope of Work|Work to be performed|Services?)\s*:?\s*(.+)/i)?.[1] || "";
  const scope = (desc || after)
    .replace(/\s*(?:Total\s*Cost|Sub\s*-?total|Sales\s*Tax|Grand\s*Total|Amount\s*Due|Contact info|Scheduled|Date Payment|PO Closed|Bill To|Ship To)\b.*$/i, "")
    .replace(/\s{2,}/g, " ").trim().slice(0, 600);
  return { po, poDate, desc, scope, partner, address, billBlock, contact, punit, amount, rows, readable: t.trim().length > 20 };
}
