// Reads a PACT partner purchase order out of its extracted text — one parser
// used by BOTH the server route (/api/parse-po) and the in-browser fallback,
// so the two can never disagree.
//
// Partners lay their POs out every which way, so the reading works line by
// line and only believes a work row when its own numbers agree: quantity times
// unit price has to equal the line total. A row invented out of an address, a
// phone number or a tax line can't survive that test, which is what makes it
// safe to read a layout nobody has seen before.
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
const near = (a: number, b: number) => Math.abs(a - b) <= 0.02;

// Rebuild the page's own lines from the PDF's words: same y = same line, left
// to right. Both readers use this, so a row can never run into the line under
// it — which is what let an address block turn into a work description.
export function textFromItems(items: { str?: string; transform?: number[] }[]): string {
  const words = items
    .filter((i) => (i.str || "").trim())
    .map((i) => ({ x: i.transform?.[4] ?? 0, y: i.transform?.[5] ?? 0, s: (i.str || "").trim() }));
  words.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: string[] = [];
  let cur: { y: number; ws: { x: number; s: string }[] } | null = null;
  for (const w of words) {
    if (!cur || Math.abs(cur.y - w.y) > 3) { cur = { y: w.y, ws: [] }; lines.push(""); }
    cur.ws.push(w);
    lines[lines.length - 1] = cur.ws.sort((a, b) => a.x - b.x).map((v) => v.s).join(" ");
  }
  return lines.join("\n");
}

// paperwork that is never a line of work
const TOTALISH = /^\s*(?:(?:sub)?\s*total|sales\s*tax|tax\b|amount\s*(?:due|paid)|grand\s*total|balance|shipping|freight|discount|deposit\s*paid|less\b|page\s*\d)/i;
// leading item numbering and heading text, trimmed only where it really is that
const tidy = (d: string) => d
  .replace(/^\s*(?:item|line)\s*(?:no\.?|#)?\s*\d+\s*[.):-]?\s+/i, "")   // "Item 3. …"
  .replace(/^\s*\d{1,3}\s*[.)]\s+/, "")                                  // "3) …"
  .replace(/^\s*(?:scope\s+of\s+work|description\s+of\s+work|description|scope)\s*:\s*/i, "")
  .replace(/^[\s.,:;|-]+/, "").replace(/[\s.,:;|\-]+$/, "")
  .replace(/\s{2,}/g, " ").trim();

// One line of a PO's table, read by its own arithmetic: the last number is the
// line total, the one before it the unit price, and somewhere before that the
// quantity that multiplies out to the total.
export function readRow(line: string, opts: { allowTotalish?: boolean } = {}): PactPoFields["rows"][number] | null {
  const l = (line || "").replace(/\s+/g, " ").trim();
  // On a partner's PO a line that opens "Total"/"Sales tax" is the paperwork.
  // In our own letters it can be real work ("Total station survey"), and the
  // totals there are recognised by their own shape instead.
  if (!l || (!opts.allowTotalish && TOTALISH.test(l)) || !/[A-Za-z]/.test(l)) return null;
  const nums = [...l.matchAll(/-?\$?\s?(\d[\d,]*(?:\.\d{1,2})?)/g)]
    .map((m) => ({ v: cash(m[1]) * (m[0].trim().startsWith("-") ? -1 : 1), at: m.index as number, len: m[0].length }));
  if (nums.length < 2) return null;
  // a bare number in front of the work is the table's line number, but only
  // when it isn't the quantity the row was read from
  const dropLineNo = (d: string, used: boolean) => (used ? d : d.replace(/^\d{1,3}\s+(?=[A-Za-z])/, ""));
  const take = (qi: number, ui: number, ti: number) => {
    const desc = dropLineNo(tidy(l.slice(0, nums[qi].at)), qi === 0);
    if (!desc || desc.length < 3 || (!opts.allowTotalish && TOTALISH.test(desc))) return null;
    const tail = l.slice(nums[ti].at + nums[ti].len).trim().split(/\s+/).filter((w) => /^[\w-]+$/.test(w));
    // the unit of measure, when the table prints one between quantity and price
    const between = l.slice(nums[qi].at + nums[qi].len, nums[ui].at).replace(/[^A-Za-z ]/g, " ").trim();
    return {
      description: desc,
      qty: nums[qi].v,
      unit_price: nums[ui].v,
      property: tail[0] || "",
      unit: tail[1] || "",
      ...(between && between.length <= 12 ? { uom: between.toUpperCase() } : {}),
    };
  };
  // walk the candidates from the right: the rightmost total that adds up wins
  for (let ti = nums.length - 1; ti >= 2; ti--) {
    for (let ui = ti - 1; ui >= 1; ui--) {
      for (let qi = ui - 1; qi >= 0; qi--) {
        // a line priced at nothing (a primer they don't charge for yet) is
        // still a line, as long as the total is nothing too
        const priced = nums[ui].v > 0 || (nums[ui].v === 0 && nums[ti].v === 0);
        if (nums[qi].v > 0 && priced && near(nums[qi].v * nums[ui].v, nums[ti].v)) {
          const r = take(qi, ui, ti);
          if (r) return r;
        }
      }
    }
  }
  // "Dumpster removal $650.00 $650.00" — one of a thing, priced and totalled
  for (let ti = nums.length - 1; ti >= 1; ti--) {
    const ui = ti - 1;
    if (nums[ui].v > 0 && near(nums[ui].v, nums[ti].v)) {
      const desc = dropLineNo(tidy(l.slice(0, nums[ui].at)), false);
      if (desc && desc.length >= 3 && (opts.allowTotalish || !TOTALISH.test(desc))) {
        const tail = l.slice(nums[ti].at + nums[ti].len).trim().split(/\s+/).filter((w) => /^[\w-]+$/.test(w));
        return { description: desc, qty: 1, unit_price: nums[ui].v, property: tail[0] || "", unit: tail[1] || "" };
      }
    }
  }
  return null;
}

export function readRows(raw: string): PactPoFields["rows"] {
  const out: PactPoFields["rows"] = [];
  const seen = new Set<string>();
  for (const line of (raw || "").split(/\n+/)) {
    const r = readRow(line);
    if (!r) continue;
    const k = `${r.description.toLowerCase()}|${r.qty}|${r.unit_price}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

// a labelled number, never a date and never a page number
const labelled = (t: string, label: string): string => {
  const m = t.match(new RegExp(`${label}\\s*(?:No\\.?|Number|#)\\s*:?\\s*([A-Za-z]?\\d[\\w-]*)`, "i"))
    || t.match(new RegExp(`${label}\\s*:\\s*([A-Za-z]?\\d[\\w-]*)`, "i"));
  const v = m?.[1] || "";
  return /^\d{1,2}$/.test(v) ? "" : v;   // "08" out of a date is not a PO number
};

export function parsePactPoText(raw: string): PactPoFields {
  const lines = (raw || "").split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const t = lines.join(" ");
  const po = labelled(t, "Purchase\\s*Order") || labelled(t, "\\bP\\.?\\s*O\\.?")
    || labelled(t, "Work\\s*Order") || labelled(t, "\\bOrder")
    || t.match(/Purchase Order\s+([A-Za-z]?\d[\w-]{2,})/i)?.[1] || "";
  const poDate = t.match(/Date Ordered\s*:?\s*([\d/]+)/i)?.[1] || t.match(/\bDate\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1] || "";
  // the description field, bounded to its own line so it can't run into the table
  const descLine = lines.find((l) => /^description\b\s*:?/i.test(l) && l.replace(/^description\b\s*:?\s*/i, "").length > 2);
  const desc = (descLine ? descLine.replace(/^description\b\s*:?\s*/i, "") : t.match(/Description\s*:?\s*(.*?)\s+(?:Contact info|Scheduled|Date Payment|PO Closed|Bill To)/i)?.[1] || "")
    .replace(/\s+(?:Qty|Quantity)\s+Unit\s*Price.*$/i, "").trim();
  // WHO IS BILLED and WHERE THE WORK IS are two different blocks, and partners
  // label them a dozen ways. The work address is the one that matters on the
  // invoice; the bill-to is the partner's office and the person there.
  const SITE_LABEL = /^(?:ship\s*to|service\s*(?:address|location)|job\s*(?:site|address|location)|property\s*address|work\s*(?:site|location|address)|site\s*address|premises|location)\b\s*:?\s*/i;
  const BILL_LABEL = /^(?:bill\s*to|billing|invoice\s*to|sold\s*to|remit\s*to)\b\s*:?\s*/i;
  const STOP_LABEL = /^(?:description|scope|qty|quantity|terms|contact|phone|date|purchase|work\s*order|vendor|approved|signature|total|sales\s*tax|p\.?o\.?\s*(?:no|#))/i;
  // the lines under a heading, up to the next heading
  const blockUnder = (label: RegExp): string[] => {
    const at = lines.findIndex((l) => label.test(l));
    if (at < 0) return [];
    const out: string[] = [];
    const own = lines[at].replace(label, "").trim();
    if (own) out.push(own);
    for (let i = at + 1; i < lines.length && out.length < 6; i++) {
      const l = lines[i];
      if (!l || SITE_LABEL.test(l) || BILL_LABEL.test(l) || STOP_LABEL.test(l)) break;
      out.push(l);
    }
    return out;
  };
  const billLinesRaw = blockUnder(BILL_LABEL);
  // some POs put the whole bill-to on one line, commas between
  const billLines = billLinesRaw.length === 1 && (billLinesRaw[0].match(/,/g) || []).length >= 2
    ? billLinesRaw[0].split(/,\s*/).map((x) => x.trim()).filter(Boolean)
    : billLinesRaw;
  const siteLines = blockUnder(SITE_LABEL);
  const billBlock = billLinesRaw.join(", ");
  const shipBlock = siteLines.join(", ");
  const contacts = [...t.matchAll(/([A-Z][a-z]+(?: [A-Z][a-z]+)?)\s*:?\s+((?:\d{3}[-.\s]?){2}\d{4})/g)].map((m) => `${m[1]} ${m[2]}`);

  const COMPANYISH = /\b(?:LLC|L\.L\.C|INC|CORP|CO\.|COMPANY|MANAGEMENT|MGMT|PROPERT(?:Y|IES)|HOUSING|REALTY|GROUP|PARTNERS|LP|ASSOCIATES|DEVELOPMENT|RESIDENTIAL|CAPITAL)\b/i;
  const TITLEISH = /\b(?:manager|director|supervisor|coordinator|purchasing|superintendent|administrator|agent|officer|assistant|president)\b/i;
  const PERSONISH = /^[A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){1,3}$/;
  // the company that's paying: named in the bill-to if it's there, otherwise
  // the letterhead at the top of the PO
  const partner = (billLines.find((l) => COMPANYISH.test(l))
    || lines.slice(0, 6).find((l) => COMPANYISH.test(l) && l.length < 60)
    || billLines.find((l) => !PERSONISH.test(l) && !TITLEISH.test(l) && !/\d/.test(l))
    // last resort: the name at the top of the PO
    || lines.slice(0, 3).find((l) => l.length > 2 && l.length < 40 && !/\d/.test(l) && !/purchase|order|bill|ship/i.test(l))
    || "").replace(/\s{2,}/g, " ").trim();
  // the person the PO names, and what they do there
  const person = billLines.find((l) => PERSONISH.test(l) && !COMPANYISH.test(l) && !TITLEISH.test(l)) || "";
  const personTitle = billLines.find((l) => TITLEISH.test(l) && !/\d/.test(l) && l.length < 40) || "";
  // where the work is — never the office being billed
  const address = (partner && shipBlock.startsWith(partner) ? shipBlock.slice(partner.length) : shipBlock)
    .replace(/^[,\s]+/, "").trim();

  const rows = readRows(raw);
  const grand = [...t.matchAll(/(?:Total|Amount Due|Grand Total)\s*:?\s*\$\s*([\d,]+\.\d{2})/gi)].map((m) => cash(m[1]));
  const rowSum = rows.reduce((s, r) => s + r.qty * r.unit_price, 0);
  const amount = grand.length > 0 ? grand[grand.length - 1] : rowSum;
  const aptIn = (a: string) => a.match(/\b(?:apartment|apt\.?|unit|#)\s*([\dA-Za-z][\dA-Za-z -]{0,8}?)(?=\s*(?:,|Brooklyn|Bronx|Queens|Manhattan|Staten|New York|NY\b|$))/i)?.[1]?.trim() || "";
  const punit = aptIn(address) || (rows[0]?.property
    ? `${rows[0].property}${rows[0].unit ? ` ${rows[0].unit}` : ""}`
    : t.match(/\$\s*[\d.,]+\s+([0-9]+-[0-9]+)/)?.[1] || "");
  const phone = contacts[0] || t.match(/([A-Z][a-z]+ [A-Z][a-z]+)\s+(\d{3}[-.]?\d{3}[-.]?\d{4})/)?.slice(1, 3).join(" ") || "";
  // the person on the PO comes first — that's who the letter is addressed to
  const contact = [person, personTitle, phone && !person ? phone : ""].filter(Boolean).join(" · ")
    || contacts.join(" · ") || phone;

  // the work in the PO's own words — its own lines only, never trailing terms
  const scopeAt = lines.findIndex((l) => /^(?:scope of work|description of work|work to be performed|services?)\b\s*:?/i.test(l));
  const scopeLines: string[] = [];
  if (scopeAt >= 0) {
    for (let i = scopeAt; i < lines.length && scopeLines.join(" ").length < 400; i++) {
      const l = i === scopeAt ? lines[i].replace(/^(?:scope of work|description of work|work to be performed|services?)\b\s*:?\s*/i, "") : lines[i];
      if (!l) continue;
      if (TOTALISH.test(l) || /^(?:terms|insurance|vendor|approved|contact info|bill to|ship to|signature|not to exceed)\b/i.test(l)) break;
      scopeLines.push(l);
    }
  }
  const scope = (scopeLines.join(". ") || "").replace(/\s{2,}/g, " ").trim().slice(0, 400);

  return {
    po, poDate, desc, scope, partner, address, billBlock, contact, punit, amount, rows,
    readable: t.trim().length > 20,
  };
}
