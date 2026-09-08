// Email intake: partner POs that arrive in the company Gmail become PACT jobs
// on their own. A small script inside the Gmail account (scripts/gmail-po-intake.gs)
// watches the inbox and POSTs each PDF here with a shared key; this route reads
// it with the same PO reader the phone uses, makes the job, attaches the PDF,
// and puts the day the PO names onto the schedule — no day means the job
// shows under "Need to schedule".
//
// Vercel → Project → Settings → Environment Variables:
//   PO_INTAKE_KEY              — any long random string; the same one goes in the script
//   SUPABASE_SERVICE_ROLE_KEY  — Supabase → Project Settings → API → service_role
// Until both are set, POST answers 501 and the Settings health check shows it.
import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { type PoItem, type PactPoFields } from "@/lib/parsePactPo";
import { readPoOrProposalPages } from "@/lib/parsePactProposal";
import { normUnit, unitFor } from "@/lib/priceBook";
import { findDupe, DUPE_COLS, type PoLike } from "@/lib/po";

export const runtime = "nodejs";
export const maxDuration = 60;

const env = (k: string) => process.env[k] || "";
const configured = () => !!(env("PO_INTAKE_KEY") && env("SUPABASE_SERVICE_ROLE_KEY") && env("NEXT_PUBLIC_SUPABASE_URL"));

type Att = { name?: string; base64?: string };
type Body = { from?: string; subject?: string; date?: string; messageId?: string; attachments?: Att[] };
type Result = { name: string; status: "created" | "duplicate" | "skipped" | "error"; po?: string; jobId?: string; startDate?: string; reason?: string };

export async function GET() {
  return NextResponse.json({ configured: configured() });
}

// the key is compared in constant time — a guessed prefix must not answer faster
const keyOk = (given: string) => {
  const want = env("PO_INTAKE_KEY");
  if (!want || !given || given.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(want));
};

// PostgREST with the service key: there is no signed-in person on this path
const base = () => env("NEXT_PUBLIC_SUPABASE_URL").replace(/\/+$/, "");
const auth = () => ({ apikey: env("SUPABASE_SERVICE_ROLE_KEY"), Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}` });
const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${base()}/rest/v1/${path}`, { ...init, headers: { ...auth(), "Content-Type": "application/json", ...(init.headers || {}) }, cache: "no-store" });

type JobRow = PoLike & { id: string; attachments?: { name: string; path: string }[] | null; description?: string };

const safeName = (n: string) => (n || "po.pdf").replace(/[\\/]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "po.pdf";

const attachPdf = async (jobId: string, name: string, bytes: Uint8Array, existing: { name: string; path: string }[]) => {
  const path = `pact/${jobId}/${name}`;
  const up = await fetch(`${base()}/storage/v1/object/docs/${path}`, {
    method: "POST", headers: { ...auth(), "Content-Type": "application/pdf", "x-upsert": "true" }, body: bytes, cache: "no-store",
  });
  if (!up.ok) return false;
  const list = [...existing.filter((a) => a.path !== path), { name, path }];
  const r = await rest(`pact_jobs?id=eq.${jobId}`, { method: "PATCH", body: JSON.stringify({ attachments: list }) });
  return r.ok;
};

const nextInvoiceNo = async (): Promise<string> => {
  const r = await rest("pact_jobs?select=invoice_number");
  const rows = r.ok ? ((await r.json()) as { invoice_number?: string }[]) : [];
  const nums = rows.map((x) => (/^\d+$/.test(String(x.invoice_number || "").trim()) ? parseInt(String(x.invoice_number).trim(), 10) : NaN))
    .filter((n) => Number.isFinite(n));
  return String(Math.max(568, ...nums) + 1);
};

const intakeOne = async (att: Att, mail: Body): Promise<Result> => {
  const name = safeName(att.name || "");
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(Buffer.from(att.base64 || "", "base64")); } catch { return { name, status: "skipped", reason: "attachment wasn't readable" }; }
  if (bytes.byteLength < 100) return { name, status: "skipped", reason: "empty attachment" };
  if (bytes.byteLength > 8 * 1024 * 1024) return { name, status: "skipped", reason: "over 8 MB — upload it on the PACT tab" };

  // read it the way the phone's server path does
  let pages: PoItem[][] = [];
  try {
    const { getResolvedPDFJS } = await import("unpdf");
    const pdfjs = await getResolvedPDFJS();
    // the reader takes the buffer it is handed and detaches it — it gets a
    // copy, so the original still exists to be attached to the job
    const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    for (let pg = 1; pg <= doc.numPages; pg++) {
      const tc = await (await doc.getPage(pg)).getTextContent();
      pages.push(tc.items as PoItem[]);
    }
    await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => null);
  } catch (e) {
    return { name, status: "skipped", reason: `couldn't open the PDF (${e instanceof Error ? e.message.slice(0, 80) : "unknown"})` };
  }
  const text = pages.map((it) => it.map((x) => x.str || "").join(" ")).join("\n");
  const cover = pages[0]?.map((x) => x.str || "").join(" ") || "";
  // the two things that are not partner POs but would read as garbage ones
  if (/Blanket\s+Release/i.test(cover) && /NYCHA|Supply\s+Management/i.test(cover)) {
    return { name, status: "skipped", reason: "NYCHA blanket release — upload it on the Releases tab" };
  }
  if (text.trim().length < 20) return { name, status: "skipped", reason: "no text in the PDF (a scan) — upload it on the PACT tab" };
  if (!/purchase\s*order|\bP\.?\s*O\.?\s*(?:no|#|number|:)|work\s*order/i.test(text)) {
    return { name, status: "skipped", reason: "doesn't look like a partner PO" };
  }

  const f: PactPoFields & { taxPct?: number } = readPoOrProposalPages(pages);
  if (!f.po || (!f.partner && !f.address && !f.desc)) return { name, status: "skipped", reason: "no PO number / partner found — upload it on the PACT tab to fill in by hand" };
  const po = f.po.trim();

  // this PO may already be a job — typed by hand, uploaded from the phone,
  // or forwarded twice. The number is matched in its stripped form, and a
  // misread number still matches on the same address for the same money.
  // If the list can't be read, nothing is made: a missed job is recoverable
  // (the email stays unlabeled and comes back next run), a duplicate isn't.
  const dq = await rest(`pact_jobs?select=${DUPE_COLS}&order=created_at.desc&limit=5000`);
  if (!dq.ok) return { name, status: "error", po, reason: "couldn't read the job list to check for duplicates — will retry" };
  const dupe = findDupe((await dq.json()) as JobRow[], { po, address: f.address, property_unit: f.punit, amount: f.amount });
  if (dupe) {
    const atts = dupe.attachments || [];
    if (!atts.some((a) => a.name === name)) await attachPdf(dupe.id, name, bytes, atts);
    return { name, status: "duplicate", po, jobId: dupe.id, reason: `PO ${po} is already job ${dupe.po_number || dupe.job_number || dupe.id} — the PDF was attached to it, nothing new was made` };
  }

  // a PO priced at $1.00 is a placeholder, not a price — the lines wait for
  // the price list, and the job's money stays blank until then
  const PLACEHOLDER = 1;
  const items = f.rows.map((r) => ({
    description: r.description, qty: r.qty, unit: normUnit(r.uom || unitFor(r.description)),
    unit_price: Number(r.unit_price) <= PLACEHOLDER ? 0 : r.unit_price,
    ...(r.base ? { base: r.base } : {}),
  }));
  const amount = f.amount > PLACEHOLDER ? f.amount : 0;
  const desc = (f.desc || f.scope).slice(0, 120);
  const seed = items.length > 0 ? items : desc ? [{ description: desc, qty: 1, unit: unitFor(desc), unit_price: 0 }] : [];
  const when = mail.date ? ` on ${String(mail.date).slice(0, 40)}` : "";
  const who = mail.from ? ` from ${String(mail.from).replace(/<[^>]*>/g, "").trim().slice(0, 60)}` : "";
  const subj = mail.subject ? ` — "${String(mail.subject).slice(0, 80)}"` : "";
  const flags = [
    ...(f.poStatus === "NOT APPROVED" ? ["⚠ The PO is stamped NOT APPROVED on the partner's system — don't start work until it is"] : []),
    ...(f.warnings || []).map((w) => `⚠ ${w}`),
  ];
  const notes = `📧 Came in by email${who}${when}${subj}. Read automatically — check the work lines before pricing or sending anything.${flags.length ? ` ${flags.join(". ")}.` : ""}`;
  const row = {
    partner: f.partner, development: "", job_number: po, description: desc, amount,
    po_number: po, po_date: f.poDate, address: f.address, property_unit: f.punit,
    contact: f.contact, bill_to: f.billBlock, items: seed, invoice_number: await nextInvoiceNo(), notes,
    ...(f.taxPct !== undefined ? { tax_pct: f.taxPct } : {}),
    ...(f.accessDate ? { start_date: f.accessDate } : {}),
  };
  const ins = await rest("pact_jobs", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
  if (!ins.ok) return { name, status: "error", po, reason: `save failed: ${(await ins.text().catch(() => "")).slice(0, 120)}` };
  const made = ((await ins.json()) as JobRow[])[0];
  if (!made?.id) return { name, status: "error", po, reason: "save returned no job" };
  const attached = await attachPdf(made.id, name, bytes, []);
  return { name, status: "created", po, jobId: made.id, startDate: f.accessDate || "", reason: attached ? undefined : "job made, but the PDF didn't attach" };
};

export async function POST(req: Request) {
  if (!configured()) {
    return NextResponse.json({ configured: false, error: "Email intake isn't set up — add PO_INTAKE_KEY and SUPABASE_SERVICE_ROLE_KEY in Vercel" }, { status: 501 });
  }
  if (!keyOk(req.headers.get("x-intake-key") || "")) return NextResponse.json({ error: "Wrong intake key" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return NextResponse.json({ error: "Send JSON: { from, subject, date, attachments: [{ name, base64 }] }" }, { status: 400 });
  const atts = (body.attachments || []).filter((a) => a && /\.pdf$/i.test(a.name || "") && a.base64);
  const results: Result[] = [];
  for (const a of atts.slice(0, 10)) results.push(await intakeOne(a, body));
  return NextResponse.json({ ok: true, results, note: atts.length === 0 ? "no PDF attachments" : undefined });
}
