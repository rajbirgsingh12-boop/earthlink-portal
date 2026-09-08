// The smart PO reader: Claude reads the PO PDF itself and fills a fixed form.
// The rule-based reader (parsePactPo) still runs first — it is the cross-check
// (the PO number and the money must agree with what is printed) and the
// fallback when there is no API key, the call fails, or the answer doesn't
// add up. Server-only: needs ANTHROPIC_API_KEY.
import { z } from "zod";
import { isoDate, type PactPoFields } from "./parsePactPo";

export const PoSchema = z.object({
  po_number: z.string().describe("The purchase order number exactly as printed, digits and dashes only, no 'PO' prefix. Empty if none."),
  po_date: z.string().describe("Date ordered as MM/DD/YYYY. Empty if none."),
  partner: z.string().describe("The company that issued the PO — the management company / owner LLC at the top or in Bill To. Not Earth Link."),
  bill_to: z.string().describe("The Bill To block as one line, parts separated by ', '. Empty if none."),
  service_address: z.string().describe("The job site street address with city, state and zip, as one line, parts separated by ', ' — WITHOUT the apartment. This is the Ship To block on partner POs."),
  apartment: z.string().describe("The apartment / unit the work is in, e.g. '3A'. When the PO names more than one, use the one its Unit code (like 0884-03A → 3A) points to. Empty if none."),
  contact: z.string().describe("The partner's contact person and/or phone for this job, if printed. Never Earth Link's own phone or email. Empty if none."),
  description: z.string().describe("What the work is, in the PO's own words: the Description field plus the work-row wording, joined, without labels, dates or form headings."),
  access_date: z.string().describe("The day the work is set for ('Access date', 'Scheduled'), as YYYY-MM-DD. Empty if the PO names none."),
  po_status: z.string().describe("A status stamp printed on the PO such as 'NOT APPROVED' or 'APPROVED'. Empty if none."),
  rows: z.array(z.object({
    description: z.string(),
    qty: z.number(),
    uom: z.string().describe("Unit of measure as printed (EACH, SF, LF, HOUR…) or empty."),
    unit_price: z.number(),
    property: z.string().describe("Property code column, if any."),
    unit: z.string().describe("Unit code column, if any."),
  })).describe("The priced work rows of the table, one per row, with wrapped lines joined into the row they belong to."),
  total: z.number().describe("The total printed on the PO. 0 if none."),
  warnings: z.array(z.string()).describe("Anything a person should double-check, in plain words: two apartments named, a total that doesn't add up, unreadable text. Empty when clean."),
});
export type SmartPo = z.infer<typeof PoSchema>;

export const SMART_PO_SYSTEM = `You read purchase orders (POs) that property-management partners send to Earth Link General Construction, a NYC contractor doing apartment repairs (plaster, paint, doors, floors, kitchens). Fill the form from the PO exactly as printed. Rules:
- Earth Link is the vendor ("To:" / "Vendor"). The partner is whoever issued the PO — the LLC or management company at the top or in Bill To.
- The Ship To block is the job site (service address). Keep the apartment out of the address line and put it in "apartment".
- A Unit code like "0884-03A" means building 884, apartment 3A. When the address block names two apartments, the Unit code decides — and say so in warnings.
- "Access date" / "Scheduled" is the day the work is set for. "Date Required" and "Date Ordered" are not.
- Money: read the rows and the total as printed. A PO priced at $1.00 is a placeholder — report it as 1, do not invent prices.
- Never guess a field that is not on the page: leave it empty.`;

export type SmartRead = { fields: PactPoFields & { taxPct?: number }; readBy: "claude" | "rules"; note?: string };

const digits = (s: string) => String(s || "").replace(/\D/g, "");
const cents = (v: number) => Math.round((Number(v) || 0) * 100) / 100;

// Does Claude's answer agree with what is printed? The PO number must be on
// the page, the money must add up, and dates must be real days.
export function smartAgrees(s: SmartPo, text: string): string | null {
  const t = text.replace(/\s+/g, " ");
  if (!s.po_number.trim()) return "no PO number";
  if (!digits(t).includes(digits(s.po_number)) && !t.includes(s.po_number.trim())) return `PO number ${s.po_number} isn't printed on the page`;
  if (!s.partner.trim() && !s.service_address.trim() && !s.description.trim()) return "no partner, address or description";
  const rowSum = s.rows.reduce((a, r) => a + cents(cents(r.unit_price) * (Number(r.qty) || 0)), 0);
  if (s.rows.length > 0 && s.total > 1 && Math.abs(rowSum - s.total) > 0.02) return `rows add to ${rowSum.toFixed(2)} but the PO says ${s.total.toFixed(2)}`;
  if (s.access_date && !/^\d{4}-\d{2}-\d{2}$/.test(s.access_date)) return `access date "${s.access_date}" isn't a date`;
  if (s.rows.some((r) => r.qty < 0 || r.unit_price < 0)) return "a negative quantity or price";
  return null;
}

// Claude's answer laid over the rule read: Claude's field wins where it has
// one, the rules fill whatever it left empty.
export function mergeSmart(rules: PactPoFields & { taxPct?: number }, s: SmartPo): PactPoFields & { taxPct?: number } {
  const pick = (a: string, b: string) => (a && a.trim() ? a.trim() : b || "");
  const rows = s.rows.length
    ? s.rows.map((r) => ({ description: r.description.trim(), qty: Number(r.qty) || 0, unit_price: cents(r.unit_price), property: r.property || "", unit: r.unit || "", uom: r.uom || undefined }))
    : rules.rows;
  const rowSum = rows.reduce((a, r) => a + cents(cents(r.unit_price) * (Number(r.qty) || 0)), 0);
  const amount = s.total > 0 ? cents(s.total) : rules.amount || rowSum;
  const accessDate = isoDate(s.access_date) || (/^\d{4}-\d{2}-\d{2}$/.test(s.access_date) ? s.access_date : "") || rules.accessDate || "";
  const warnings = [...new Set([...(rules.warnings || []), ...s.warnings.map((w) => w.trim()).filter(Boolean)])];
  return {
    ...rules,
    po: pick(s.po_number, rules.po),
    poDate: pick(s.po_date, rules.poDate),
    partner: pick(s.partner, rules.partner),
    billBlock: pick(s.bill_to, rules.billBlock),
    address: pick(s.service_address, rules.address),
    punit: pick(s.apartment, rules.punit),
    contact: pick(s.contact, rules.contact),
    desc: pick(s.description, rules.desc),
    rows, amount,
    rowsAddUp: rows.length === 0 || amount <= 1 || Math.abs(rowSum - amount) < 0.02,
    readable: true,
    ...(accessDate ? { accessDate } : {}),
    ...(pick(s.po_status, rules.poStatus || "") ? { poStatus: pick(s.po_status, rules.poStatus || "").toUpperCase() } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

export const smartConfigured = () => !!process.env.ANTHROPIC_API_KEY;

// Only a partner purchase order is ever shown to Claude — never a NYCHA
// release, a payroll sheet, an invoice, a balance sheet, a photo. This is
// the gate every path goes through before the smart reader is even asked.
export const looksLikePactPo = (text: string): boolean => {
  const t = text || "";
  if (t.trim().length < 20) return false;
  if (/Blanket\s+Release/i.test(t) && /NYCHA|Supply\s+Management/i.test(t)) return false;
  if (/certified\s+payroll|WH-347|social\s+security|gross\s+wages|statement\s+of\s+compliance/i.test(t)) return false;
  if (/balance\s+sheet|profit\s+(?:and|&)\s+loss|income\s+statement|form\s+w-?[29]\b|1099/i.test(t)) return false;
  return /purchase\s*order|\bP\.?\s*O\.?\s*(?:no|#|number|:)|work\s*order/i.test(t);
};

// the call itself — swapped out in tests. Time-boxed: the server has 60
// seconds for the whole request, so a slow read gives way to the rules
// read rather than taking the PO down with it.
export const SMART_TIMEOUT_MS = 40_000;
export async function askClaude(pdf: Uint8Array, timeoutMs: number = SMART_TIMEOUT_MS): Promise<SmartPo | null> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const client = new Anthropic({ timeout: timeoutMs, maxRetries: 0 });
  const res = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 8000,
    // a form fill from a one-page PO doesn't need deep thought — medium keeps
    // it well inside the server's time limit
    output_config: { effort: "medium", format: zodOutputFormat(PoSchema) },
    system: SMART_PO_SYSTEM,
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(pdf).toString("base64") } },
        { type: "text", text: "Fill the form from this purchase order." },
      ],
    }],
  });
  if (res.stop_reason === "refusal") return null;
  return res.parsed_output ?? null;
}

// The whole thing: rules first, Claude on top when it is switched on and its
// answer agrees with the page. Never throws — a failed smart read is a rules read.
export async function readPoSmart(
  pdf: Uint8Array, text: string, rules: PactPoFields & { taxPct?: number },
  ask: (pdf: Uint8Array, timeoutMs: number) => Promise<SmartPo | null> = askClaude,
  timeoutMs: number = SMART_TIMEOUT_MS,
): Promise<SmartRead> {
  if (!smartConfigured()) return { fields: rules, readBy: "rules" };
  if (!looksLikePactPo(text)) return { fields: rules, readBy: "rules", note: "not a partner PO — the smart reader is only shown POs" };
  if (timeoutMs < 8_000) return { fields: rules, readBy: "rules", note: "no time left in this request — use Re-read the PO to read it with Claude" };
  try {
    // the reader's own clock, so a hung call can never outlive the request
    const s = await Promise.race<SmartPo | null>([
      ask(pdf, timeoutMs),
      new Promise<null>((_, rej) => setTimeout(() => rej(new Error("the smart reader took too long")), timeoutMs + 2_000)),
    ]);
    if (!s) return { fields: rules, readBy: "rules", note: "the smart reader declined — used the rules read" };
    const why = smartAgrees(s, text);
    if (why) return { fields: rules, readBy: "rules", note: `the smart read didn't match the page (${why}) — used the rules read` };
    return { fields: mergeSmart(rules, s), readBy: "claude" };
  } catch (e) {
    return { fields: rules, readBy: "rules", note: `smart reader unavailable (${e instanceof Error ? e.message.slice(0, 80) : "unknown"}) — used the rules read` };
  }
}
