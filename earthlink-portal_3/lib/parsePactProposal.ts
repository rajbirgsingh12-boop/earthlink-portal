// Reads one of the company's own PACT proposal letters (a .docx) — the
// "Dear …, Service Address …, PO …, Scope of Work" letter — into the same
// fields the PO reader produces, so uploading either kind of file makes a job.
import { unzipSync, strFromU8 } from "fflate";
import { readRow, parsePactPoPages, linesFromItems, type PactPoFields, type PoItem } from "./parsePactPo";
import { isTaxLine, isTotalLabel, isPurePaperLabel, labelOf, taxRateOf } from "./paperwork";

// document.xml → plain text, one line per paragraph. Table rows become one
// line each with tab-separated cells, so "description | price" tables read
// as "description<TAB>$780.00".
export function docxToText(buf: ArrayBuffer): string {
  const files = unzipSync(new Uint8Array(buf));
  let xml = strFromU8(files["word/document.xml"]);
  const unescape = (s: string) =>
    s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
  xml = xml.replace(/<w:tr[ >][\s\S]*?<\/w:tr>/g, (row) =>
    row.replace(/<\/w:p>/g, " ").replace(/<\/w:tc>/g, "\t") + "\n");
  return unescape(
    xml
      .replace(/<w:tab[^>]*\/>/g, " ")
      .replace(/<w:(?:br|cr)[^>]*\/>/g, "\n") // manual line breaks split lines too
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, "")
  );
}

const money = (s: string) => parseFloat(s.replace(/[$,\s]/g, "")) || 0;

export interface PactProposalExtra { taxPct?: number }

// is this letter-style text one of our proposals? (vs a partner PO pdf) — the
// ones the portal writes carry a Scope of Work heading; the ones the owner
// types by hand just run the work under "pleased to submit"
export const looksLikeProposal = (t: string) =>
  /service address/i.test(t) && (/scope of work/i.test(t) || /pleased to submit/i.test(t));

export function parsePactProposalText(raw: string): PactPoFields & PactProposalExtra {
  const lines = raw.split("\n").map((l) => l.replace(/\s+/g, " ").trim());
  const t = lines.join("\n");

  const po = t.match(/\bP\.?\s*O\.?\s*#?\s*:?\s*(\d[\w-]*)/i)?.[1] || "";
  const poDate = t.match(/\bDate\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1] || "";

  // ATTN block: the person, their title, and the office address lines under it
  const attnIdx = lines.findIndex((l) => /^ATTN\b/i.test(l));
  const attnLine = attnIdx >= 0 ? lines[attnIdx].replace(/^ATTN\s*:?\s*/i, "").trim() : "";
  // a letter that keeps its heading in a table hands the whole block over on
  // one line — the name ends where their job title or their street number begins
  const TITLE_WORD = /\b(?:manager|director|supervisor|coordinator|purchasing|superintendent|administrator|agent|officer|assistant|president|owner)\b/i;
  const cutAt = (() => {
    const ends = [attnLine.search(TITLE_WORD), attnLine.search(/\d/)].filter((x) => x > 0);
    return ends.length ? Math.min(...ends) : -1;
  })();
  const contactName = (cutAt > 0 ? attnLine.slice(0, cutAt) : attnLine).replace(/[\s,]+$/, "").trim();
  const billLines: string[] = [];
  if (cutAt > 0) { const rest = attnLine.slice(cutAt).trim(); if (rest) billLines.push(rest); }
  const HEADINGISH = /^dear\b|service address|^po\s*#|pleased to submit|scope of work|^proposal\b|^date\b/i;
  if (attnIdx >= 0) {
    // the office block sits under the ATTN line
    for (let i = attnIdx + 1; i < lines.length && billLines.length < 3; i++) {
      const l = lines[i];
      if (!l || HEADINGISH.test(l)) break;
      billLines.push(l);
    }
  } else {
    // a letter that names nobody: the block is the run of lines sitting
    // directly above the greeting, read upwards from it
    const dearAt = lines.findIndex((l) => /^dear\b/i.test(l));
    for (let i = dearAt - 1; i >= 0 && billLines.length < 3; i--) {
      const l = lines[i];
      if (!l) { if (billLines.length > 0) break; continue; }
      if (HEADINGISH.test(l)) break;
      billLines.unshift(l);
    }
  }
  const billBlock = [contactName, ...billLines].filter(Boolean).join(", ");

  // "Service Address: Building 2156 LINDEN BOULEVARD, Apartment 8 A Brooklyn ,NY 11207"
  // — and when a long address wraps in the letter, the lines after it belong
  // to the address until the letter moves on to the work
  let svc = t.match(/Service Address[ \t]*:?[ \t]*([^\n]*)/i)?.[1]?.trim() || "";
  {
    // a finished address ends with a zip or an apartment; anything else (a
    // trailing comma, a cut-off street name) means the band wrapped and the
    // next line is still address — but ONLY then, because in a letter with no
    // ATTN block the line right under the band is the billing address
    const finished = (a: string) => !/,\s*$/.test(a) && (/\d{5}(?:-\d{4})?\s*$/.test(a) || /(?:Apartment|Apt\.?|Unit)\s*#?\s*[\dA-Za-z-]+\s*$/i.test(a));
    const at = lines.findIndex((l) => /service address/i.test(l));
    for (let k = at + 1; at >= 0 && k < Math.min(at + 3, lines.length) && !finished(svc); k++) {
      const cont = lines[k].trim();
      if (!cont || cont.includes("$") || HEADINGISH.test(cont) || /^attn\b/i.test(cont) || /scope of work/i.test(cont)) break;
      svc = `${svc} ${cont}`.trim();
    }
  }
  const punit = svc.match(/\b(?:Apartment|Apt\.?|Unit)\s*#?\s*([\dA-Za-z][\dA-Za-z -]{0,8}?)(?=\s*(?:,|Brooklyn|Bronx|Queens|Manhattan|Staten|New York|NY\b|$))/i)?.[1]?.trim() || "";
  const address = svc
    .replace(/\bBuilding\s+/i, "")
    .replace(/,?\s*(?:Apartment|Apt\.?|Unit)\s*#?\s*[\dA-Za-z][\dA-Za-z -]{0,8}?(?=\s*(?:,|Brooklyn|Bronx|Queens|Manhattan|Staten|New York|NY\b|$))/i, "")
    .replace(/\s*,\s*/g, ", ").replace(/\s{2,}/g, " ").replace(/,\s*,/g, ",").trim();

  // scope lines: every "description … $ amount" pair until the totals.
  // Handles one item per line, several items fused on one line, tables
  // (description<TAB>$amount), a bare amount on the line AFTER its
  // description, and "2 x $350" / "2 @ $350" quantity pricing.
  const rows: PactPoFields["rows"] = [];
  let start = lines.findIndex((l) => /scope of work/i.test(l));
  if (start < 0) start = lines.findIndex((l) => /pleased to submit/i.test(l));
  // (a sales tax line stops the work on its own words, below: "price
  // includes / sales tax and delivery" wrapped in a work line does not)
  const stopRe = /total\s*cost|labor and materials|grand\s*total|amount\s*due|best regards|sincerely/i;
  const amtRe = /\$\s*([\d,]+(?:\.\d{1,2})?)/g;
  // A Sales Tax, Subtotal or Total line that a letter printed INSIDE its work
  // table (one made before the portal kept those off its lines) is paperwork:
  // skipped, never a row, and never where the reading stops (the work below
  // it is still work). What it added is remembered, so the letter's own
  // totals can be taken back down to the work it really bills.
  // (a skipped tax line is what the letter taxed on top of its work; a skipped
  // Total line is only the sum of the rows, and is never added back in)
  let skipped = 0, skippedTax = 0;
  const paper = (d: string) => isTaxLine(d) || isTotalLabel(d);
  // A line is paperwork only on its own words. Words carried over from the
  // line above can only make it work ("materials plus" + "tax and delivery
  // $4,500.00" is work); they never make a work line paperwork.
  //  - all label ("Sales Tax", "Subtotal"): paperwork, whatever is above it
  //  - opens like one ("tax and delivery", "balance"): paperwork unless the
  //    words above it finish it into work
  const paperOn = (own: string, joined: string) => isPurePaperLabel(own) || (paper(own) && paper(joined));
  const skip = (d: string, amount: number) => { skipped += amount; if (isTaxLine(d)) skippedTax += amount; };
  // the words before a row's money, or (when it has none of its own) the words carried in from above
  const wordsOf = (own: string, joined: string) => (labelOf(own) ? own : joined);
  // set per line: its paperwork-looking words were finished into work by the words above
  let finished = false;
  const pushItem = (descRaw: string, amount: number, ownRaw?: string) => {
    const description = descRaw.replace(/[\t:;,\s-]+$/g, "").replace(/^[\s:;,-]+/, "").replace(/\s{2,}/g, " ").trim();
    if (!description || description.length < 3 || amount <= 0) return;
    if (!finished && paperOn(wordsOf(ownRaw ?? description, description), description)) { skip(description, amount); return; }
    // "2 x $350" or "2 @ $350" inside the text = real qty and unit price
    const qm = description.match(/(\d+(?:\.\d+)?)\s*(?:x|@)\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
    const qty = qm ? parseFloat(qm[1]) : 1;
    const up = qm ? money(qm[2]) : amount;
    const consistent = qm && Math.abs(qty * up - amount) < 0.02;
    rows.push({ description, qty: consistent ? qty : 1, unit_price: consistent ? up : amount, property: "", unit: punit });
  };
  let pending = "";
  let stopAt = -1; // where the work stops and the totals begin
  for (let i = start + 1; start >= 0 && i < lines.length; i++) {
    const l = lines[i].replace(/\t/g, " ").trim();
    if (!l) continue;
    finished = false;
    // A work line is a line whose own numbers agree: quantity times price is
    // the line total. That holds for our own letters and for most partners',
    // and nothing else on the page can fake it.
    //
    // Two wrap layouts exist. Some letters put the description on its own
    // line with the money on the NEXT line — that is what `pending` gluing is
    // for. Our own PDF prints the money beside the FIRST fragment and wraps
    // the rest BELOW it, so when a line is a complete row all by itself, the
    // text waiting in `pending` belonged to the row before it.
    // A line with no dollar sign cannot be a work row on one of our letters —
    // every money column prints a $. Without this, a wrapped description
    // fragment like "and wall, 30 inch microwave cabinet" reads as a $30 row.
    const bare = l.includes("$") ? readRow(l, { allowTotalish: true }) : null;
    // the words waiting from the line above (a description with no money yet)
    const above = pending && !pending.includes("$") ? pending : "";
    // what waits there is only a paperwork label ("Subtotal", "NYS Tax
    // 8.875%"): the totals block printing its labels on their own lines.
    // It is never glued onto a work row.
    const aboveIsLabel = !!above && isPurePaperLabel(above);
    // Words above that finish a paperwork-looking line into work. A tax
    // word that is more than a label ("tax and delivery") is finished by
    // them. A totals word ("pressure" + "balance $650.00") only on a figure
    // that cannot be the total of the rows read so far. An all-label line
    // never is, but for a tax label ("materials plus" + "tax 1 $4,500.00
    // $4,500.00") on a figure far more than any tax on the work above it.
    const sumSoFar = Math.round(rows.reduce((a, r) => a + r.qty * r.unit_price, 0) * 100) / 100;
    const finishes = (own: string, figure: number) => {
      if (!above || paper(`${above} ${own}`)) return false;
      const couldBeTotal = sumSoFar > 0 && figure >= sumSoFar - 0.02;
      const couldBeTax = sumSoFar > 0 && figure <= sumSoFar * 0.2 + 0.02;
      if (isTaxLine(own)) return !isPurePaperLabel(own) || !couldBeTax;
      return !isPurePaperLabel(own) && !couldBeTotal;
    };
    const tailToLastRow = () => {
      if (above && rows.length > 0 && !aboveIsLabel) rows[rows.length - 1].description = `${rows[rows.length - 1].description} ${above}`.replace(/\s{2,}/g, " ").trim();
      pending = "";
    };
    if (bare && paper(bare.description)) {
      // "tax and delivery 1 $4,500.00 $4,500.00" under "materials plus" is
      // the end of that work's description, and the row is work
      const joined = `${above} ${bare.description}`;
      if (finishes(bare.description, Math.round(bare.qty * bare.unit_price * 100) / 100)) {
        pending = "";
        rows.push({ description: joined.replace(/\s{2,}/g, " ").trim(), qty: bare.qty, unit_price: bare.unit_price, property: "", unit: punit, ...(bare.uom ? { uom: bare.uom } : {}) });
        continue;
      }
      // the wrapped tail waiting in pending is the row above's, as with any complete row
      tailToLastRow();
      skip(bare.description, Math.round(bare.qty * bare.unit_price * 100) / 100);
      continue;
    }
    // The totals end the work, but only when the line is NOT itself a
    // complete work row ("Total station survey 1 $500.00 $500.00" is work
    // that happens to start with Total). A real totals line never carries
    // row arithmetic, fails that read, and stops the table here, BEFORE the
    // pending-glue below can weld "Total Cost … $9,565.00" onto a wrapped
    // fragment and mint a phantom row out of the pair.
    // A tax or totals line stops the work when it carries a figure and its
    // own words are paperwork: all label ("Subtotal $2,980.00", whatever note
    // or wrapped words wait above it), or a label the words above do not
    // finish into work ("plus tax" or "balance" wrapped under a work line is
    // the end of that line's words). A figure alone under a label waiting
    // above it ("Subtotal" / "$2,980.00") is the totals block too.
    const ownPaper = l.includes("$") && paper(l);
    const figures = [...l.matchAll(amtRe)];
    finished = ownPaper && finishes(l, figures.length ? money(figures[figures.length - 1][1]) : 0);
    const figureUnderLabel = aboveIsLabel && l.includes("$") && !labelOf(l) && !readRow(`${above} ${l}`, { allowTotalish: true });
    const stopish = stopRe.test(l) || /^total\b/i.test(l) || (ownPaper && !finished) || figureUnderLabel;
    if (!bare && stopish) {
      // the LAST row's wrapped tail sits in pending when the totals arrive
      // (a label waiting there is the totals', and is dropped)
      tailToLastRow();
      stopAt = i; break;
    }
    // words that open like paperwork ("tax and delivery") waiting above a
    // line that is work all on its own are the row above's wrapped tail
    if (above && paper(above) && l.includes("$") && labelOf(l) && !paper(l)) tailToLastRow();
    if (bare && pending && rows.length > 0) {
      rows[rows.length - 1].description = `${rows[rows.length - 1].description} ${pending}`.replace(/\s{2,}/g, " ").trim();
      pending = "";
    }
    const row = bare || (l.includes("$") && !stopish ? readRow(`${pending} ${l}`.trim(), { allowTotalish: true }) : null);
    if (row && !finished && paperOn(wordsOf(l, row.description), row.description)) { pending = ""; skip(row.description, Math.round(row.qty * row.unit_price * 100) / 100); continue; }
    if (row) {
      pending = "";
      rows.push({ description: row.description, qty: row.qty, unit_price: row.unit_price, property: "", unit: punit, ...(row.uom ? { uom: row.uom } : {}) });
      continue;
    }
    // a work table's column headings ("Description Qty Unit price Amount")
    // are not a work line — and must not glue themselves to the first one
    if (!l.includes("$") && /^(?:item|description|scope|work)\b/i.test(l) && /\b(?:qty|quantity|unit|price|amount|cost)\b/i.test(l)) { pending = ""; continue; }
    // a room banner ("BEDROOM 1", "KITCHEN") — short, no money, and printed
    // in capitals by the letter itself — names the section, not the work
    if (!l.includes("$") && l.length <= 32 && /[A-Z]/.test(l) && !/[a-z]/.test(l)) continue;
    const monies = [...l.matchAll(amtRe)];
    if (monies.length === 0) { pending = pending ? `${pending} ${l}` : l; continue; }
    // walk the line, pairing each amount with the text before it
    let cursor = 0;
    for (let mi = 0; mi < monies.length; mi++) {
      const m = monies[mi];
      const own = l.slice(cursor, m.index).trim();
      const full = `${pending} ${own}`.trim();
      pending = "";
      cursor = (m.index as number) + m[0].length;
      // "desc 2 x $450.00 $900.00" — a unit price then the line total
      const qm = full.match(/(\d+(?:\.\d+)?)\s*[x@]\s*$/i);
      const next = monies[mi + 1];
      if (qm && next && l.slice(cursor, next.index).trim() === "") {
        const qty = parseFloat(qm[1]);
        const up = money(m[1]);
        const amt = money(next[1]);
        const desc = full.replace(/(\d+(?:\.\d+)?)\s*[x@]\s*$/i, "").trim();
        if (Math.abs(qty * up - amt) < 0.02) rows.push({ description: desc, qty, unit_price: up, property: "", unit: punit });
        else pushItem(desc, amt, own.replace(/(\d+(?:\.\d+)?)\s*[x@]\s*$/i, "").trim());
        cursor = (next.index as number) + next[0].length;
        mi++;
        continue;
      }
      pushItem(full, money(m[1]), own);
    }
    const tail = l.slice(cursor).trim();
    if (tail) pending = tail;
  }

  // the totals are read from below the work, so a work line that opens with
  // "Tax…" or "Total…" can never be mistaken for one
  const totalsText = stopAt >= 0 ? lines.slice(stopAt).join("\n") : t;
  const lineStart = (label: string) => new RegExp(`^\\s*(?:${label})\\b[^$\\n]{0,40}\\$\\s*([\\d,]+\\.?\\d*)`, "im");
  const rowsSum = Math.round(rows.reduce((s, r) => s + r.qty * r.unit_price, 0) * 100) / 100;
  const taxM = totalsText.match(lineStart("(?:(?:NYS|NYC|NY|New York|State|City|Combined|Total)\\s+)*(?:Sales\\s*)?Tax"));
  const tax = money(taxM?.[1] || "");
  const grand = money(totalsText.match(lineStart("Grand Total|Amount Due|Total Due"))?.[1] || "");
  // a rate worked back out of the money is a sales tax rate or nothing (a work
  // figure taken for the tax must never become a 60% rate on the job)
  const capped = (r: number) => (r >= 0 && r <= 20 ? r : undefined);
  // (a worked-out rate that is a New York rate to the cent is that rate:
  // $69.23 on $780.00 is 8.875%, not 8.876%)
  const nyRate = (base: number) => (tax > 0 && base > 0 ? taxRateOf([{ description: "", qty: 1, unit_price: tax }], base, { strict: true }) : undefined);
  const workedOut = (base: number) => nyRate(base) ?? (base > 0 ? capped(Math.round((tax / base) * 100 * 1000) / 1000) : undefined);
  // What the letter itself subtotalled and taxed: its printed figure, or its
  // rows with what it skipped added back. A skipped tax line was billed as a
  // row and taxed along with the work. A skipped Total row may have been
  // billed too, or may only have summed the rows above it: of the two, the
  // base whose tax is a New York rate to the cent (or that comes to the
  // letter's grand total) is the one, and with neither the rate is left to
  // the job (a worked-out rate off the wrong base would be twice the real one).
  const printedSub = money(totalsText.match(lineStart("Labor and materials?|Total Cost|Sub\\s*-?\\s*total|Subtotal"))?.[1] || "");
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const bases = Array.from(new Set([r2(rowsSum + skippedTax), r2(rowsSum + skipped)]));
  const fitBase = printedSub ? printedSub
    : bases.find((b) => nyRate(b) !== undefined) ?? bases.find((b) => grand > 0 && Math.abs(r2(b + tax) - grand) <= 0.05);
  const sub = fitBase ?? bases[0];
  const unsure = !printedSub && bases.length > 1;
  // the percentage the letter prints beats one worked back out of the money,
  // and a tax line of $0.00 means no tax, not "no tax rate given"
  const printed = taxM ? parseFloat(taxM[0].match(/\(?\s*([\d.]+)\s*%/)?.[1] || "") : NaN;
  const taxPct = Number.isFinite(printed) ? printed
    : taxM && sub > 0 ? (tax > 0 ? (unsure ? nyRate(sub) : workedOut(sub)) : 0)
      : undefined;

  const desc = rows[0]?.description || t.match(/proposal for the property/i)?.[0] || "";
  // a letter that carried a tax or totals line among its work billed that line
  // and taxed it again: the job bills its work, taxed once at the letter's rate
  const billed = skipped > 0 ? rowsSum : sub;
  return {
    po, poDate, desc, scope: rows.map((r) => r.description).join(". ").slice(0, 600), partner: "", address, billBlock, contact: contactName, punit, rowsAddUp: true,
    amount: (skipped > 0 ? 0 : grand) || (billed > 0 ? Math.round(billed * (1 + (taxPct ?? 8.875) / 100) * 100) / 100 : 0),
    rows, readable: rows.length > 0 || !!po || !!svc, taxPct,
  };
}

export function parsePactProposalDocx(buf: ArrayBuffer): PactPoFields & PactProposalExtra {
  return parsePactProposalText(docxToText(buf));
}

// A PDF dropped on the PACT tab is either a partner's purchase order or one of
// our own proposal letters coming back signed. Both readers live behind this
// one call so the server and the phone can never decide it differently.
export function readPoOrProposalPages(pages: PoItem[][]): PactPoFields & PactProposalExtra {
  const text = pages.map((items, i) => linesFromItems(items, i + 1).map((l) => l.text).join("\n")).join("\n");
  return looksLikeProposal(text) ? parsePactProposalText(text) : parsePactPoPages(pages);
}
