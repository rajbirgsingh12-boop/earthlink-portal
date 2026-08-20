// Reads one of the company's own PACT proposal letters (a .docx) — the
// "Dear …, Service Address …, PO …, Scope of Work" letter — into the same
// fields the PO reader produces, so uploading either kind of file makes a job.
import { unzipSync, strFromU8 } from "fflate";
import { readRow, parsePactPoPages, linesFromItems, type PactPoFields, type PoItem } from "./parsePactPo";

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
  const stopRe = /total\s*cost|labor and materials|sales\s*tax|grand\s*total|amount\s*due|best regards|sincerely/i;
  const amtRe = /\$\s*([\d,]+(?:\.\d{1,2})?)/g;
  const pushItem = (descRaw: string, amount: number) => {
    const description = descRaw.replace(/[\t:;,\s-]+$/g, "").replace(/^[\s:;,-]+/, "").replace(/\s{2,}/g, " ").trim();
    if (!description || description.length < 3 || amount <= 0) return;
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
    // A work line is a line whose own numbers agree: quantity times price is
    // the line total. That holds for our own letters and for most partners',
    // and nothing else on the page can fake it.
    //
    // Two wrap layouts exist. Some letters put the description on its own
    // line with the money on the NEXT line — that is what `pending` gluing is
    // for. Our own PDF prints the money beside the FIRST fragment and wraps
    // the rest BELOW it, so when a line is a complete row all by itself, the
    // text waiting in `pending` belonged to the row before it.
    const bare = readRow(l, { allowTotalish: true });
    if (bare && pending && rows.length > 0) {
      rows[rows.length - 1].description = `${rows[rows.length - 1].description} ${pending}`.replace(/\s{2,}/g, " ").trim();
      pending = "";
    }
    const row = bare || readRow(`${pending} ${l}`.trim(), { allowTotalish: true });
    if (row) {
      pending = "";
      rows.push({ description: row.description, qty: row.qty, unit_price: row.unit_price, property: "", unit: punit, ...(row.uom ? { uom: row.uom } : {}) });
      continue;
    }

    if (stopRe.test(l) || /^total\b/i.test(l)) {
      // the LAST row's wrapped tail sits in pending when the totals arrive
      if (pending && !pending.includes("$") && rows.length > 0) {
        rows[rows.length - 1].description = `${rows[rows.length - 1].description} ${pending}`.replace(/\s{2,}/g, " ").trim();
        pending = "";
      }
      stopAt = i; break;
    }
    // a work table's column headings ("Description Qty Unit price Amount")
    // are not a work line — and must not glue themselves to the first one
    if (!l.includes("$") && /^(?:item|description|scope|work)\b/i.test(l) && /\b(?:qty|quantity|unit|price|amount|cost)\b/i.test(l)) { pending = ""; continue; }
    const monies = [...l.matchAll(amtRe)];
    if (monies.length === 0) { pending = pending ? `${pending} ${l}` : l; continue; }
    // walk the line, pairing each amount with the text before it
    let cursor = 0;
    for (let mi = 0; mi < monies.length; mi++) {
      const m = monies[mi];
      const full = `${pending} ${l.slice(cursor, m.index).trim()}`.trim();
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
        else pushItem(desc, amt);
        cursor = (next.index as number) + next[0].length;
        mi++;
        continue;
      }
      pushItem(full, money(m[1]));
    }
    const tail = l.slice(cursor).trim();
    if (tail) pending = tail;
  }

  // the totals are read from below the work, so a work line that opens with
  // "Tax…" or "Total…" can never be mistaken for one
  const totalsText = stopAt >= 0 ? lines.slice(stopAt).join("\n") : t;
  const lineStart = (label: string) => new RegExp(`^\\s*(?:${label})\\b[^$\\n]{0,40}\\$\\s*([\\d,]+\\.?\\d*)`, "im");
  const sub = money(totalsText.match(lineStart("Labor and materials?|Total Cost|Sub\\s*-?\\s*total|Subtotal"))?.[1] || "") || rows.reduce((s, r) => s + r.qty * r.unit_price, 0);
  const taxM = totalsText.match(lineStart("(?:Sales\\s*)?Tax"));
  const tax = money(taxM?.[1] || "");
  const grand = money(totalsText.match(lineStart("Grand Total|Amount Due|Total Due"))?.[1] || "");
  // the percentage the letter prints beats one worked back out of the money,
  // and a tax line of $0.00 means no tax — not "no tax rate given"
  const printed = taxM ? parseFloat(taxM[0].match(/\(?\s*([\d.]+)\s*%/)?.[1] || "") : NaN;
  const taxPct = Number.isFinite(printed) ? printed
    : taxM && sub > 0 ? Math.round((tax / sub) * 100 * 1000) / 1000
      : undefined;

  const desc = rows[0]?.description || t.match(/proposal for the property/i)?.[0] || "";
  return {
    po, poDate, desc, scope: rows.map((r) => r.description).join(". ").slice(0, 600), partner: "", address, billBlock, contact: contactName, punit, rowsAddUp: true,
    amount: grand || (sub > 0 ? Math.round(sub * (1 + (taxPct ?? 8.875) / 100) * 100) / 100 : 0),
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
