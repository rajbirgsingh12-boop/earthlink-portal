// lib/parseRelease.ts
// Parses a NYCHA Blanket Release PDF (text extracted via pdfjs) into
// header info + line items. Validated against release 2442583-1
// (sum of parsed items matches PDF total to the penny).

export type ReleaseItem = {
  line: number;
  code: string;
  description: string;
  qty: number;
  uom: string;
  unit_price: number;
  amount: number;
};

export type ParsedRelease = {
  contract: string;
  rel: string;
  orderDate: string; // M/D/YYYY
  development: string; // first line of Ship To, e.g. "DANIEL WEBSTER"
  shipTo: string; // full ship-to blob for reference
  workOrders: string[];
  total: number;
  laborHours: number;
  items: ReleaseItem[];
};

const num = (s: string) => parseFloat(s.replace(/,/g, "")) || 0;

const cleanUom = (u: string) => {
  const x = u.replace(/\s+/g, "").toUpperCase();
  if (x.startsWith("SQUAR")) return "SQ FT";
  if (x.startsWith("LINEAR")) return "LIN FT";
  if (x.startsWith("DOLLA")) return "DOLLAR";
  return x; // EACH, HOUR
};

export function parseReleasePdfText(rawText: string): ParsedRelease | null {
  // normalize whitespace, strip repeating page furniture
  let t = rawText.replace(/\s+/g, " ");
  t = t.replace(
    /NYCHA Blanket Release\s*[\d,\- ]+ Line Part Number \/ Description Quantity UOM Unit Price \(USD\) Amount \(USD\)/g,
    " "
  );
  t = t.replace(/Page \d+ of \d+/g, " ");

  const hdr = t.match(/Contract\/PO Number\s*(\d+)-(\d+)/);
  const totalM = t.match(/Total:\s*\$?\s*([\d,]+\.\d{2})/);
  if (!hdr && !totalM) return null;

  const od = t.match(/Order Date\s*(\d{1,2})-([A-Z]{3})-(\d{4})/i);
  const months: Record<string, number> = {
    JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
    JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
  };
  const orderDate = od
    ? `${months[od[2].toUpperCase()] || "?"}/${Number(od[1])}/${od[3]}`
    : "";

  const shipM = t.match(/Ship To:\s*(.*?)\s*Bill To:/);
  const shipTo = shipM ? shipM[1].trim() : "";
  // development = ship-to name before the "-0231" style dev code
  const devM = shipTo.match(/^([A-Z0-9 .,'&-]+?)\s*-\s*\d{3,4}\b/);
  const development = (devM ? devM[1] : shipTo.split(" 4")[0] || shipTo)
    .trim()
    .replace(/\s{2,}/g, " ");

  const workOrders = [
    ...new Set(
      Array.from(t.matchAll(/Work [Oo]rder [Nn]umber\s*=\s*(\d+)/g)).map(
        (m) => m[1]
      )
    ),
  ];

  const UOM = "(EACH|HOUR|LINEAR\\s*FOOT|SQUARE?\\s*E?\\s*FOOT|DOLLAR?\\s*R?)";
  const NUM = "[\\d,]+(?:\\.\\d+)?";
  const items: Record<string, ReleaseItem> = {};

  // Case 1: normal lines — "1 062001351 15 EACH 2177.3 32,659.50 <description> 1-7 Ship To:"
  const re1 = new RegExp(
    `(?<![\\d-])(\\d{1,3}) (0\\d{8}) (${NUM}) ${UOM} (${NUM}) ([\\d,]+\\.\\d{2}) (.*?)(?= \\d{1,3}-\\d{1,2} Ship To:)`,
    "g"
  );
  for (const m of t.matchAll(re1)) {
    const [, ln, code, qty, uom, price, amt, desc] = m;
    items[ln] = {
      line: Number(ln),
      code,
      description: desc.trim(),
      qty: num(qty),
      uom: cleanUom(uom),
      unit_price: num(price),
      amount: num(amt),
    };
  }

  // Case 2: split lines — parent has qty+UOM but no price (e.g. Demolition split
  // across multiple ship-to sub-blocks). Sum the sub-block amounts.
  const re2 = new RegExp(
    `(?<![\\d-])(\\d{1,3}) (0\\d{8}) (${NUM}) ${UOM} (?!${NUM} [\\d,]+\\.\\d{2})(.*?)(?= \\1-\\d{1,2} Ship To:)`,
    "g"
  );
  for (const m of t.matchAll(re2)) {
    const [, ln, code, qty, uom, desc] = m;
    if (items[ln]) continue;
    const subRe = new RegExp(
      // (?<![\d-]) so split line "2" never swallows sub-blocks of line "12"
      `(?<![\\d-])${ln}-\\d{1,2} Ship To: Use the ship-to address at the top of page ?1 (${NUM}) ${UOM} (${NUM}) ([\\d,]+\\.\\d{2})`,
      "g"
    );
    let amount = 0;
    let unit_price = 0;
    for (const s of t.matchAll(subRe)) {
      amount += num(s[4]);
      unit_price = num(s[3]);
    }
    items[ln] = {
      line: Number(ln),
      code,
      description: desc.trim(),
      qty: num(qty),
      uom: cleanUom(uom),
      unit_price,
      amount,
    };
  }

  const list = Object.values(items).sort((a, b) => a.line - b.line);
  const laborHours = list
    .filter((i) => i.uom === "HOUR")
    .reduce((s, i) => s + i.qty, 0);
  const itemSum = list.reduce((s, i) => s + i.amount, 0);
  const total = totalM ? num(totalM[1]) : itemSum;

  return {
    contract: hdr ? hdr[1] : "",
    rel: hdr ? hdr[2] : "",
    orderDate,
    development,
    shipTo,
    workOrders,
    total,
    laborHours,
    items: list,
  };
}
