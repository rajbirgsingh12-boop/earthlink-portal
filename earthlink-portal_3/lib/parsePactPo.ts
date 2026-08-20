// Reads a PACT partner purchase order out of its extracted text — one parser
// used by BOTH the server route (/api/parse-po) and the in-browser fallback,
// so the two can never disagree.
//
// Partners lay their POs out every which way, so the reading works line by
// line and only believes a work row when its own numbers agree: quantity times
// unit price has to equal the line total. A row invented out of an address, a
// phone number or a tax line can't survive that test, which is what makes it
// safe to read a layout nobody has seen before.
// One run of words on a line, and where it sits across the page. The plain
// text of a line is still built word by word exactly as it always was — the
// segments ride alongside it, so nothing that reads the text can be changed by
// them. That is what makes it safe to read columns off a PO.
export interface PoSeg { x: number; w: number; text: string }
export interface PoLine { page: number; y: number; size: number; text: string; segs: PoSeg[] }
export type PoItem = { str?: string; transform?: number[]; width?: number; height?: number };

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
  // the work rows add up to the total the PO printed. False means a priced line
  // was missed — the PDF engine ran two figures together, say — and the read is
  // worth trying again another way before anyone bills off it.
  rowsAddUp: boolean;
  rows: { description: string; qty: number; unit_price: number; property: string; unit: string; uom?: string; base?: string }[];
  readable: boolean;    // false = no text in the PDF at all (a scan)
}

const cash = (v: string) => parseFloat(String(v).replace(/[$,\s]/g, "")) || 0;
const near = (a: number, b: number) => Math.abs(a - b) <= 0.02;

// Rebuild the page's own lines from the PDF's words: same y = same line, left
// to right. Both readers use this, so a row can never run into the line under
// it — which is what let an address block turn into a work description.
export function linesFromItems(items: PoItem[], page = 1): PoLine[] {
  const words = items
    .filter((i) => (i.str || "").trim())
    .map((i) => {
      const s = (i.str || "").trim();
      const size = Math.abs(i.height ?? i.transform?.[3] ?? 10) || 10;
      // a word's width is what tells one column from the next; where the engine
      // doesn't give it, half the type size per character is close enough
      const w = typeof i.width === "number" && i.width > 0 ? i.width : s.length * 0.5 * size;
      // text set at an angle has no meaningful left edge — a stamp or a
      // watermark must never be read as a column
      const skew = Math.abs(i.transform?.[1] ?? 0) + Math.abs(i.transform?.[2] ?? 0);
      return { x: i.transform?.[4] ?? 0, y: i.transform?.[5] ?? 0, size, w, s, skew };
    });
  words.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: { y: number; ws: typeof words }[] = [];
  let cur: { y: number; ws: typeof words } | null = null;
  for (const w of words) {
    if (!cur || Math.abs(cur.y - w.y) > 3) { cur = { y: w.y, ws: [] }; rows.push(cur); }
    cur.ws.push(w);
  }
  return rows.map((r) => {
    const ws = r.ws.sort((a, b) => a.x - b.x);
    const segs: PoSeg[] = [];
    // words belong to the same cell while they nearly touch — measured edge to
    // edge, so "Boulevard Together" stays one cell and a column gap does not.
    // A word set at an angle (a stamp, a watermark) has no honest left edge, so
    // it takes no part in the columns — it stays in the line's text all the same
    for (const w of ws) {
      if (w.skew > 0.2) continue;
      const last = segs[segs.length - 1];
      const gap = last ? w.x - (last.x + last.w) : Infinity;
      if (last && gap <= Math.max(3, 1.6 * w.size)) { last.text += ` ${w.s}`; last.w = w.x + w.w - last.x; }
      else segs.push({ x: w.x, w: w.w, text: w.s });
    }
    return { page, y: r.y, size: ws[0].size, text: ws.map((v) => v.s).join(" "), segs };
  });
}

// the page as one string, exactly as before — the segments are not part of it
export function textFromItems(items: PoItem[]): string {
  return linesFromItems(items).map((l) => l.text).join("\n");
}

// WHO IS BILLED and WHERE THE WORK IS are two different blocks, and partners
// label them a dozen ways. The work address is the one that matters on the
// invoice; the bill-to is the partner's office and the person there.
const SITE_LABEL = /^(?:ship\s*to|service\s*(?:address|location)|job\s*(?:site|address|location)|property\s*address|work\s*(?:site|location|address)|site\s*address|premises|location)\b\s*:?\s*/i;
const BILL_LABEL = /^(?:bill\s*to|billing|invoice\s*to|sold\s*to|remit\s*to)\b\s*:?\s*/i;
const STOP_LABEL = /^(?:description|scope|qty|quantity|terms|contact|phone|date|purchase|work\s*order|vendor|approved|signature|total|sales\s*tax|p\.?o\.?\s*(?:no|#))/i;
// only these open a COLUMN. A bare "Location" or "Premises" is a table heading
// on half the POs in the world, and one of those opening a phantom second
// column would quietly move an address.
const PEER_LABEL = /^(?:ship\s*to|bill\s*to|billing|invoice\s*to|sold\s*to|remit\s*to|mail\s*to|deliver(?:y)?\s*to|send\s*to|service\s*(?:address|location)|job\s*(?:site|address|location)|work\s*(?:site|location|address)|property\s*address|site\s*address)\b\s*:?\s*/i;
// money on a line says it belongs to the table, not to an address block
const MONEYISH = /\$|\b\d[\d,]*\.\d{2}\b/;
// a PO's description box is often followed on the same row by the form's own
// fields — "Contact info", "Scheduled", "PO Closed: No". The description is
// the WORK; everything the form adds after it gets cut.
const FORM_TAIL = /\s*(?:contact\s*info|scheduled|date\s*payment|po\s*closed|closed\s*\?|status|terms|vendor|approved\s*by|requested\s*by|bill\s*to|ship\s*to|service\s*(?:address|location)|job\s*site|qty\b|quantity\b|unit\s*price|total\s*cost|sales\s*tax|grand\s*total|amount\s*due|signature|page\s*\d)\b[\s\S]*$/i;
const FORM_HEAD = /^(?:contact\s*info|scheduled|date\s*payment|po\s*closed|status|terms|vendor|approved\s*by|requested\s*by|signature)\b/i;
const cleanWork = (v: string) => (v || "")
  .replace(FORM_TAIL, "")
  .replace(/\bpo\s*closed\s*:?\s*(?:no|yes|n|y)\b/gi, "")
  .replace(/\s*[-\u2013:;,]\s*$/, "")
  .replace(/\s{2,}/g, " ").trim();
// the column headings of a work table — three of them together is the table
const HEADBITS = [/\bdescription\b/i, /\bqty\b|\bquantity\b/i, /\bunit\s*price\b|\brate\b/i, /\btotal\b/i, /\bamount\b/i, /\bproperty\b/i, /\bunit\b/i, /\buom\b/i];
const headScore = (t: string) => HEADBITS.reduce((n, re) => n + (re.test(t) ? 1 : 0), 0);

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
  return readRowsFrom((raw || "").split(/\n+/).map((text) => ({ page: 1, y: 0, size: 10, text, segs: [] as PoSeg[] })), 14);
}

// The work rows, each carrying the lines its description wrapped onto. A wrap
// is only believed when it sits directly under the description column, close
// behind, and carries no money of its own — so a second priced row can never
// be swallowed into the one above it.
export function readRowsFrom(src: PoLine[], pitch: number): PactPoFields["rows"] {
  const rows: (PactPoFields["rows"][number] & { seed: string; base: string })[] = [];
  let at = -1, descX = 0, nextX = Infinity, lastY = 0, rowPage = 0, merges = 0;
  for (const L of src) {
    const r = readRow(L.text);
    if (r) {
      rows.push({ ...r, base: r.description, seed: `${r.description.toLowerCase()}|${r.qty}|${r.unit_price}` });
      at = rows.length - 1; merges = 0; rowPage = L.page;
      if (L.segs.length >= 2) { descX = L.segs[0].x; nextX = L.segs[1].x; lastY = L.y; } else nextX = Infinity;
      continue;
    }
    if (at < 0 || nextX === Infinity || merges >= 2 || L.segs.length === 0) continue;
    // a row's wrap is on the same page as the row — the top of the next page is
    // a fresh letterhead, not the rest of the sentence
    if (L.page !== rowPage) { at = -1; continue; }
    if (TOTALISH.test(L.text) || SITE_LABEL.test(L.text) || BILL_LABEL.test(L.text) || STOP_LABEL.test(L.text)) continue;
    if (MONEYISH.test(L.text)) continue;
    if (lastY - L.y > 1.6 * pitch) { at = -1; continue; }
    // every word of it has to sit inside the description column
    if (!L.segs.every((sg) => sg.x >= descX - 2 && sg.x + sg.w <= nextX - 2)) continue;
    rows[at].description = tidy(`${rows[at].description} ${L.text}`);
    lastY = L.y; merges += 1;
  }
  // the same row printed twice is one row — decided on how it read BEFORE its
  // wrap was added, or two copies of one line would both survive and the
  // invoice would double
  const seen = new Set<string>();
  const out: PactPoFields["rows"] = [];
  for (const r of rows) {
    if (seen.has(r.seed)) continue;
    seen.add(r.seed);
    const { seed: _s, base, ...row } = r;
    // the wording BEFORE its wrapped line was added, kept so the price list can
    // still tell what a row stands for when the wrap named a second trade
    out.push(base && base !== row.description ? { ...row, base } : row);
  }
  return out;
}

// A labelled number — never a date, never a page number. Partners write the
// label every way there is: "PO # 8300", "Purchase Order No: 8300", "PO: 8300"
// and plain "P.O. 8300".
const labelled = (t: string, label: string): string => {
  const pats = [
    new RegExp(`${label}\\s*(?:No\\.?|Number|#)\\s*:?\\s*([A-Za-z]?\\d[\\w-]*)`, "i"),
    new RegExp(`${label}\\s*:\\s*([A-Za-z]?\\d[\\w-]*)`, "i"),
    new RegExp(`${label}\\s+([A-Za-z]?\\d[\\w-]*)`, "i"),   // no marker at all
  ];
  for (const re of pats) {
    const m = t.match(re);
    if (!m) continue;
    const v = m[1];
    // "08" or "12" out of 08/12/2026 is a date, not a PO number — and neither
    // is a number with a slash on either side of it
    if (/^\d{1,2}$/.test(v)) continue;
    const at = (m.index ?? 0) + m[0].length;
    if (t[at] === "/" || t[at] === "-" && /^\d{4}$/.test(v)) continue;
    return v;
  }
  return "";
};

// Every reader goes through here: the pages' words in, the fields out. One
// entry point is what keeps the server and the phone reading a PO the same way.
export function parsePactPoPages(pages: PoItem[][]): PactPoFields {
  const lines: PoLine[] = [];
  pages.forEach((items, i) => lines.push(...linesFromItems(items, i + 1)));
  return parsePactPoText(lines.map((l) => l.text).join("\n"), lines);
}

export function parsePactPoText(raw: string, structured?: PoLine[]): PactPoFields {
  // where the words sit is used to read COLUMNS; the text of every line is the
  // same either way, so a PO pasted in as plain text still reads as it always did
  const src: PoLine[] = structured?.length
    ? structured.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() })).filter((l) => l.text)
    : (raw || "").split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean)
      .map((text) => ({ page: 1, y: 0, size: 10, text, segs: [] as PoSeg[] }));
  const lines = src.map((l) => l.text);
  const geom = src.some((l) => l.segs.length > 0);
  const t = lines.join(" ");
  // how far apart the lines are, so "the next line down" can be told from
  // "a new block further down the page"
  const steps: number[] = [];
  for (let i = 0; i + 1 < src.length; i++) {
    if (src[i].page !== src[i + 1].page) continue;
    const d = src[i].y - src[i + 1].y;
    if (d > 2 && d < 60) steps.push(d);
  }
  steps.sort((a, b) => a - b);
  const pitch = steps.length ? steps[steps.length >> 1] : 14;
  // the work table starts at its own heading row, or at the first priced line
  let tableAt = src.length;
  for (let i = 0; i < src.length; i++) {
    if (headScore(src[i].text) >= 3 || readRow(src[i].text)) { tableAt = i; break; }
  }
  const po = labelled(t, "Purchase\\s*Order") || labelled(t, "\\bP\\.?\\s*O\\.?")
    || labelled(t, "Work\\s*Order") || labelled(t, "\\bOrder")
    || t.match(/Purchase Order\s+([A-Za-z]?\d[\w-]{2,})/i)?.[1] || "";
  const poDate = t.match(/Date Ordered\s*:?\s*([\d/]+)/i)?.[1] || t.match(/\bDate\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1] || "";
  // the cell a line holds at a given left edge: the run of words that starts
  // there, and everything butted up against it
  const cellFrom = (L: PoLine, x0: number): string => {
    const fi = L.segs.findIndex((sg) => Math.abs(sg.x - x0) <= 3);
    if (fi < 0) return "";
    const parts = [L.segs[fi].text];
    let right = L.segs[fi].x + L.segs[fi].w;
    for (let k = fi + 1; k < L.segs.length; k++) {
      if (L.segs[k].x - right > Math.max(12, 2.2 * L.size)) break;
      parts.push(L.segs[k].text);
      right = L.segs[k].x + L.segs[k].w;
    }
    return parts.join(" ");
  };

  // the description box, read as its own column so the form's fields printed
  // beside it stay out, and carried on down its own continuation lines
  const descParts: string[] = [];
  // the box is looked for on the whole page, the way it always was; only
  // reading it as a COLUMN is confined to what sits above the work table
  const di = src.findIndex((l) => /^description\b\s*:?/i.test(l.text)
    && l.text.replace(/^description\b\s*:?\s*/i, "").length > 2);
  const dseg = di >= 0 && di < tableAt ? src[di].segs.findIndex((sg) => /^description\b/i.test(sg.text)) : -1;
  if (geom && di >= 0 && dseg >= 0) {
    const L = src[di];
    const x0 = L.segs[dseg].x;
    descParts.push(cellFrom(L, x0).replace(/^description\b\s*:?\s*/i, ""));
    let lastY = L.y;
    for (let j = di + 1, took = 0; j < tableAt && took < 3 && descParts.join(" ").length < 220; j++) {
      const N = src[j];
      if (N.page !== L.page || lastY - N.y > 1.6 * pitch) break;
      if (SITE_LABEL.test(N.text) || BILL_LABEL.test(N.text) || STOP_LABEL.test(N.text)
        || TOTALISH.test(N.text) || FORM_HEAD.test(N.text) || readRow(N.text)) break;
      const cell = cellFrom(N, x0);
      if (!cell) break;
      descParts.push(cell); lastY = N.y; took += 1;
    }
  } else if (di >= 0) descParts.push(lines[di].replace(/^description\b\s*:?\s*/i, ""));
  else {
    // the description isn't at the start of its line — read it out of the run
    const m = t.match(/Description\s*:?\s*(.*?)\s+(?:Contact info|Scheduled|Date Payment|PO Closed|Bill To)/i);
    if (m) descParts.push(m[1]);
  }
  // each line is cleaned on its own: cleaning the joined run would let the
  // "PO Closed" printed beside line one swallow line two
  const desc = descParts.map(cleanWork).filter(Boolean).join(" ").replace(/\s{2,}/g, " ").trim();

  // the lines under a heading, up to the next heading. Where the PO prints two
  // blocks SIDE BY SIDE, each heading owns a column and only its own column is
  // read — otherwise the office address and the job site come out interleaved.
  const colOf = (x: number, cs: number[]) => { let i = 0; while (i + 1 < cs.length && x >= cs[i + 1] - 12) i += 1; return i; };
  const legacyBlock = (at: number, label: RegExp): string[] => {
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
  const blockUnder = (label: RegExp): string[] => {
    // where a line OPENS with the heading — the only thing the reader ever used
    // to go on, and still what it falls back to
    const lineAt = lines.findIndex((l) => label.test(l));
    // and the heading on its own cell, which is how it is found on a row that
    // carries two blocks side by side. PEER_LABEL only: a header-grid field
    // reading "Location:" or "Billing period:" is not a block heading, and
    // letting one open a column moves the job site off the invoice.
    let at = -1;
    let lab: PoSeg | null = null;
    if (geom) {
      for (let i = 0; i < tableAt && at < 0; i++) {
        for (const sg of src[i].segs) if (label.test(sg.text) && PEER_LABEL.test(sg.text)) { at = i; lab = sg; break; }
      }
    }
    if (at < 0 || !lab) return lineAt >= 0 ? legacyBlock(lineAt, label) : [];
    // the other headings printed level with this one mark the other columns
    const cols = new Set<number>([lab.x]);
    for (let j = 0; j < tableAt; j++) {
      const L = src[j];
      if (L.page !== src[at].page || Math.abs(L.y - src[at].y) > 1.2 * pitch) continue;
      for (const sg of L.segs) if (PEER_LABEL.test(sg.text) && sg.x !== lab.x) cols.add(sg.x);
    }
    const cs = [...cols].sort((a, b) => a - b);
    let sep = Infinity;
    for (let i = 1; i < cs.length; i++) sep = Math.min(sep, cs[i] - cs[i - 1]);
    // and the columns have to be far enough apart AND actually both used —
    // one heading standing alone is a stacked PO, which reads the old way
    const touched = new Set<number>();
    if (cs.length >= 2 && sep >= 60) {
      for (let j = at + 1; j < Math.min(at + 9, tableAt); j++) for (const sg of src[j].segs) touched.add(colOf(sg.x, cs));
    }
    // not two columns after all — read it the old way, from a line that opens
    // with the heading rather than from wherever the cell happened to sit
    if (!(cs.length >= 2 && sep >= 60 && touched.size >= 2)) return lineAt >= 0 ? legacyBlock(lineAt, label) : [];
    const k = cs.indexOf(lab.x);
    const cell = (L: PoLine) => L.segs.filter((sg) => colOf(sg.x, cs) === k).map((sg) => sg.text).join(" ").trim();
    const out: string[] = [];
    const own = cell(src[at]).replace(label, "").trim();
    if (own) out.push(own);
    let lastY = src[at].y;
    for (let j = at + 1; j < tableAt && out.length < 6; j++) {
      const L = src[j];
      if (L.page !== src[at].page) break;
      if (readRow(L.text)) break; // the work table has started
      const c = cell(L);
      if (!c) continue;
      // what the OTHER column prints is none of this block's business — judging
      // the whole printed row here cuts the address short at the neighbour's
      // headings and money
      if (STOP_LABEL.test(c) || TOTALISH.test(c) || MONEYISH.test(c)) break;
      if (SITE_LABEL.test(c) || BILL_LABEL.test(c)) break;
      if (lastY - L.y > 1.8 * pitch) break;
      out.push(c); lastY = L.y;
    }
    return out;
  };
  const billLinesRaw = blockUnder(BILL_LABEL);
  // some POs put the whole bill-to on one line, commas between — but
  // "White Plains, NY 10606" is one place, and cutting it in two turns the
  // city into a person's name on the letter
  const splitBlock = (one: string) => {
    const parts = one.split(/,\s*/).map((x) => x.trim()).filter(Boolean);
    const out: string[] = [];
    for (const part of parts) {
      if (out.length > 0 && /^[A-Z]{2}\b\s*\d{5}(?:-\d{4})?$/.test(part)) out[out.length - 1] += `, ${part}`;
      else out.push(part);
    }
    return out;
  };
  const oneLiner = (b: string[]) => (b.length === 1 && (b[0].match(/,/g) || []).length >= 2 ? splitBlock(b[0]) : b);
  const billLines = oneLiner(billLinesRaw);
  const siteLines = oneLiner(blockUnder(SITE_LABEL));
  const billBlock = billLines.join(", ");
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
  // the person the PO names, and what they do there — printed on the office
  // block on most POs and on the delivery block on others, so both are read
  const nameIn = (b: string[]) => b.find((l) => PERSONISH.test(l) && !COMPANYISH.test(l) && !TITLEISH.test(l)) || "";
  const titleIn = (b: string[]) => b.find((l) => TITLEISH.test(l) && !/\d/.test(l) && l.length < 40) || "";
  const ATTN = /^(?:attn\.?|attention|c\/o|care\s*of)\b\s*:?\s*/i;
  // "Boulevard Houses" and "Laundry Room" are places, not people. A name on the
  // DELIVERY block only counts as a person where the block says so — marked for
  // their attention, or printed with what they do there.
  const markedIn = (b: string[]) => (b.find((l) => ATTN.test(l)) || "").replace(ATTN, "").trim();
  const shipPerson = markedIn(siteLines) || (titleIn(siteLines) ? nameIn(siteLines) : "");
  const person = nameIn(billLines) || shipPerson;
  const personTitle = titleIn(billLines) || (shipPerson ? titleIn(siteLines) : "");
  // where the work is — never the office being billed, and never the person the
  // delivery is marked for. Only the lines that ARE that person come off, and
  // only from the front, before the address itself starts.
  const siteAddr = (() => {
    const b = [...siteLines];
    while (b.length > 1 && !/\d/.test(b[0]) && (ATTN.test(b[0]) || b[0] === person || b[0] === personTitle)) b.shift();
    return b.map((l) => l.replace(ATTN, "").trim()).filter(Boolean);
  })();
  const shipBlock = siteAddr.join(", ");
  const address = (partner && shipBlock.startsWith(partner) ? shipBlock.slice(partner.length) : shipBlock)
    .replace(/^[,\s]+/, "").trim();

  const rows = readRowsFrom(src, pitch);
  const grand = [...t.matchAll(/(?:Total|Amount Due|Grand Total)\s*:?\s*\$\s*([\d,]+\.\d{2})/gi)].map((m) => cash(m[1]));
  const rowSum = rows.reduce((s, r) => s + r.qty * r.unit_price, 0);
  const amount = grand.length > 0 ? grand[grand.length - 1] : rowSum;
  const rowsAddUp = grand.length === 0 || rows.length === 0 || Math.abs(rowSum - amount) < 0.02;
  const aptIn = (a: string) => a.match(/\b(?:apartment|apt\.?|unit|#)\s*([\dA-Za-z][\dA-Za-z -]{0,8}?)(?=\s*(?:,|Brooklyn|Bronx|Queens|Manhattan|Staten|New York|NY\b|$))/i)?.[1]?.trim() || "";
  const punit = aptIn(address) || (rows[0]?.property
    ? `${rows[0].property}${rows[0].unit ? ` ${rows[0].unit}` : ""}`
    : t.match(/\$\s*[\d.,]+\s+([0-9]+-[0-9]+)/)?.[1] || "");
  const phone = contacts[0] || t.match(/([A-Z][a-z]+ [A-Z][a-z]+)\s+(\d{3}[-.]?\d{3}[-.]?\d{4})/)?.slice(1, 3).join(" ") || "";
  // the person on the PO comes first — that's who the letter is addressed to
  const contact = [person, personTitle, phone && !person ? phone : ""].filter(Boolean).join(" · ")
    || contacts.join(" · ") || phone;

  // the work in the PO's own words — its own lines only, never trailing terms
  const SCOPE_LABEL = /^(?:scope\s*(?:of\s*work)?|description\s*of\s*work|work\s*(?:to\s*be\s*performed|description|requested)|services?\s*(?:performed|rendered|required|requested))\b\s*:?/i;
  const scopeAt = lines.findIndex((l) => SCOPE_LABEL.test(l));
  const scopeLines: string[] = [];
  if (scopeAt >= 0) {
    for (let i = scopeAt; i < lines.length && scopeLines.join(" ").length < 400; i++) {
      const l = i === scopeAt ? lines[i].replace(SCOPE_LABEL, "").replace(/^\s*:?\s*/, "") : lines[i];
      if (!l) continue;
      if (TOTALISH.test(l) || SITE_LABEL.test(l) || BILL_LABEL.test(l)
        || /^(?:terms|insurance|vendor|approved|contact info|signature|not to exceed|po\s*closed|scheduled|date\s*payment)\b/i.test(l)) break;
      scopeLines.push(l);
    }
  }
  const scope = cleanWork(scopeLines.join(". ")).slice(0, 400);

  return {
    po, poDate, desc, scope, partner, address, billBlock, contact, punit, amount, rows, rowsAddUp,
    readable: t.trim().length > 20,
  };
}
