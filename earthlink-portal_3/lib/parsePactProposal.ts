// Reads one of the company's own PACT proposal letters (a .docx) — the
// "Dear …, Service Address …, PO …, Scope of Work" letter — into the same
// fields the PO reader produces, so uploading either kind of file makes a job.
import { unzipSync, strFromU8 } from "fflate";
import type { PactPoFields } from "./parsePactPo";

// document.xml → plain text, one line per paragraph
export function docxToText(buf: ArrayBuffer): string {
  const files = unzipSync(new Uint8Array(buf));
  const xml = strFromU8(files["word/document.xml"]);
  const unescape = (s: string) =>
    s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
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
  const svc = t.match(/Service Address\s*:?\s*(.+)/i)?.[1]?.trim() || "";
  const punit = svc.match(/\b(?:Apartment|Apt\.?|Unit)\s*#?\s*([\dA-Za-z][\dA-Za-z -]{0,8}?)(?=\s*(?:,|Brooklyn|Bronx|Queens|Manhattan|Staten|New York|NY\b|$))/i)?.[1]?.trim() || "";
  const address = svc
    .replace(/\bBuilding\s+/i, "")
    .replace(/,?\s*(?:Apartment|Apt\.?|Unit)\s*#?\s*[\dA-Za-z][\dA-Za-z -]{0,8}?(?=\s*(?:,|Brooklyn|Bronx|Queens|Manhattan|Staten|New York|NY\b|$))/i, "")
    .replace(/\s*,\s*/g, ", ").replace(/\s{2,}/g, " ").replace(/,\s*,/g, ",").trim();

  // scope lines: description … $ amount (one item per line, until the totals)
  const rows: PactPoFields["rows"] = [];
  const start = lines.findIndex((l) => /scope of work/i.test(l));
  for (let i = start + 1; start >= 0 && i < lines.length; i++) {
    const l = lines[i];
    if (/total cost|sales tax|grand total|best regards/i.test(l)) break;
    const m = l.match(/^(.+?)\s*\$\s*([\d,]+(?:\.\d{1,2})?)\s*$/);
    if (m && m[1].trim().length > 2) rows.push({ description: m[1].trim(), qty: 1, unit_price: money(m[2]), property: "", unit: punit });
  }

  const sub = money(t.match(/Labor and materials?\s*:?\s*\$\s*([\d,]+\.?\d*)/i)?.[1] || "") || rows.reduce((s, r) => s + r.unit_price, 0);
  const tax = money(t.match(/Sales Tax\s*:?\s*\$\s*([\d,]+\.?\d*)/i)?.[1] || "");
  const grand = money(t.match(/Grand Total\s*:?\s*\$\s*([\d,]+\.?\d*)/i)?.[1] || "");
  const taxPct = sub > 0 && tax > 0 ? Math.round((tax / sub) * 100 * 1000) / 1000 : undefined;

  const desc = rows[0]?.description || t.match(/proposal for the property/i)?.[0] || "";
  return {
    po, poDate, desc, partner: "", address, billBlock, contact: contactName, punit,
    amount: grand || (sub > 0 ? Math.round(sub * (1 + (taxPct ?? 8.875) / 100) * 100) / 100 : 0),
    rows, readable: rows.length > 0 || !!po || !!svc, taxPct,
  };
}

export function parsePactProposalDocx(buf: ArrayBuffer): PactPoFields & PactProposalExtra {
  return parsePactProposalText(docxToText(buf));
}
