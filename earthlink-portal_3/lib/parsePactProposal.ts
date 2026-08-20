// Reads one of the company's own PACT proposal letters (a .docx) — the
// "Dear …, Service Address …, PO …, Scope of Work" letter — into the same
// fields the PO reader produces, so uploading either kind of file makes a job.
import { unzipSync, strFromU8 } from "fflate";
import { readRow, type PactPoFields } from "./parsePactPo";

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

// is this letter-style text one of our proposals? (vs a partner PO pdf)
export const looksLikeProposal = (t: string) => /service address/i.test(t) && /scope of work/i.test(t);

export function parsePactProposalText(raw: string): PactPoFields & PactProposalExtra {
  const lines = raw.split("\n").map((l) => l.replace(/\s+/g, " ").trim());
  const t = lines.join("\n");

  const po = t.match(/\bP\.?\s*O\.?\s*#?\s*:?\s*(\d[\w-]*)/i)?.[1] || "";
  const poDate = t.match(/\bDate\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1] || "";

  // ATTN block: the person, their title, and the office address lines under it
  const attnIdx = lines.findIndex((l) => /^ATTN\b/i.test(l));
  const contactName = attnIdx >= 0 ? lines[attnIdx].replace(/^ATTN\s*:?\s*/i, "").trim() : "";
  const billLines: string[] = [];
  for (let i = attnIdx + 1; attnIdx >= 0 && i < lines.length && billLines.length < 3; i++) {
    const l = lines[i];
    if (!l) break;
    if (/^dear\b|service address/i.test(l)) break;
    billLines.push(l);
  }
  const billBlock = [contactName, ...billLines].filter(Boolean).join(", ");

  // "Service Address: Building 2156 LINDEN BOULEVARD, Apartment 8 A Brooklyn ,NY 11207"
  const svc = t.match(/Service Address[ \t]*:?[ \t]*([^\n]*)/i)?.[1]?.trim() || "";
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
    const row = readRow(`${pending} ${l}`.trim(), { allowTotalish: true });
    if (row) {
      pending = "";
      rows.push({ description: row.description, qty: row.qty, unit_price: row.unit_price, property: "", unit: punit, ...(row.uom ? { uom: row.uom } : {}) });
      continue;
    }

    if (stopRe.test(l) || /^total\b/i.test(l)) { stopAt = i; break; }
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
