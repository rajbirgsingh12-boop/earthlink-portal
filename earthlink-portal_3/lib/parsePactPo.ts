// Reads a PACT partner purchase order out of its extracted text — one parser
// used by BOTH the server route (/api/parse-po) and the in-browser fallback,
// so the two can never disagree.
export interface PactPoFields {
  po: string;
  poDate: string;
  desc: string;
  partner: string;
  address: string;      // the ship-to block: the job site
  billBlock: string;    // the partner's billing/office block
  contact: string;
  punit: string;
  amount: number;
  rows: { description: string; qty: number; unit_price: number; property: string; unit: string }[];
  readable: boolean;    // false = no text in the PDF at all (a scan)
}

export function parsePactPoText(raw: string): PactPoFields {
  const t = (raw || "").replace(/\s+/g, " ");
  const po = t.match(/Purchase Order No\.?\s*:?\s*(\w+)/i)?.[1] || "";
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
  const grand = [...t.matchAll(/Total\s+\$\s*([\d,]+\.\d{2})/g)].map((m) => parseFloat(m[1].replace(/,/g, "")));
  const amount = grand.length > 0 ? grand[grand.length - 1] : rows.reduce((s, r) => s + r.qty * r.unit_price, 0);
  const punit = rows[0]?.property
    ? `${rows[0].property}${rows[0].unit ? ` ${rows[0].unit}` : ""}`
    : t.match(/\$\s*[\d.,]+\s+([0-9]+-[0-9]+)/)?.[1] || "";
  const contact = contacts.length > 0
    ? contacts.join(" · ")
    : (t.match(/([A-Z][a-z]+ [A-Z][a-z]+)\s+(\d{3}[-.]?\d{3}[-.]?\d{4})/)?.slice(1, 3).join(" ") || "");
  return { po, poDate, desc, partner, address, billBlock, contact, punit, amount, rows, readable: t.trim().length > 20 };
}
