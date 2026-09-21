// A partner PO (or one of our own proposal letters) becoming a PACT job —
// the one pipeline the Billing tab and the Schedule tab both use, so a PO
// dropped on either lands the same way: read by the server (Claude when it
// is switched on), read on the phone when the server can't, checked against
// the jobs already here (one PO is one job), priced from the list, filed
// with its PDF. Nothing here touches the screen; each tab says what happened.
import { sb } from "./supabase";
import { prettyDate } from "./docs";
import { findDupe, DUPE_COLS } from "./po";
import { parsePactPoText, type PactPoFields, type PoItem } from "./parsePactPo";
import { linesFromPoRead, type JobLine, type PriceItem } from "./priceBook";

// Invoice numbers count up: 569, 570, 571… — the highest plain number wins,
// so old "8300-1"-style numbers never skew the sequence. The portal's run
// starts above the floor — anything at or below it is an old hand-typed
// number, outside the sequence. A PO coming in gets NO number: the number
// is given out when the job is priced (RUN_ME section 17's trigger), or —
// before that section is in — when an invoice is built for it, so the run
// of numbers follows the invoices, not the POs.
export const INVOICE_FLOOR = 568;
export async function nextInvoiceNo(): Promise<string> {
  const { data } = await sb().from("pact_jobs").select("invoice_number");
  const nums = ((data || []) as { invoice_number?: string }[])
    .map((r) => (/^\d+$/.test(String(r.invoice_number || "").trim()) ? parseInt(String(r.invoice_number).trim(), 10) : NaN))
    .filter((n) => Number.isFinite(n));
  return String(Math.max(INVOICE_FLOOR, ...nums) + 1);
}
// the job's invoice number, given out now if it has none: the database's
// counter (one for everyone), else — before RUN_ME section 17 — the page's
// own count, written only where no number is there yet
export async function claimInvoiceNo(jobId: string, current?: string | null): Promise<string> {
  if ((current || "").trim()) return (current || "").trim();
  const rpc = await sb().rpc("pact_claim_invoice_no", { job: jobId });
  if (!rpc.error && typeof rpc.data === "string" && rpc.data) return rpc.data;
  // the function isn't there yet (RUN_ME section 17 not run): count up here. Any other error is an error.
  if (rpc.error && !/could not find|schema cache|does not exist|not found|404/i.test(rpc.error.message)) throw new Error(rpc.error.message);
  const n = await nextInvoiceNo();
  const { error } = await sb().from("pact_jobs").update({ invoice_number: n }).eq("id", jobId).or("invoice_number.is.null,invoice_number.eq.");
  if (error) throw new Error(error.message);
  const { data } = await sb().from("pact_jobs").select("invoice_number").eq("id", jobId).single();
  return String((data as { invoice_number?: string } | null)?.invoice_number || n);
}
export const subtotalOf = (items: { qty: number; unit_price: number }[]) =>
  Math.round(items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0) * 100) / 100;

// every new job carries its auto-price baseline (RUN_ME section 15) — the
// same rule then judges an uploaded PO, a proposal letter and a hand-typed
// job alike. Before the section is in, the column isn't there: written without.
export async function insertJob(row: Record<string, unknown>) {
  let res = await sb().from("pact_jobs").insert(row).select().single();
  if (res.error && "list_subtotal" in row && /list_subtotal/i.test(res.error.message)) {
    const { list_subtotal: _skip, ...rest } = row; void _skip;
    res = await sb().from("pact_jobs").insert(rest).select().single();
  }
  return res;
}

type DupeRow = { id: string; po_number?: string; job_number?: string; address?: string; property_unit?: string; amount?: number; canceled?: boolean; attachments?: { name: string; path: string }[] | null; description?: string; start_date?: string; work_done?: boolean; notes?: string };
export type IntakeJob = { id: string; po_number?: string; job_number?: string; start_date?: string | null; [k: string]: unknown };
export type IntakeOutcome =
  | { kind: "release" }                                                                          // a NYCHA blanket release — the Releases tab's
  | { kind: "dupe"; id: string; po: string; canceled: boolean; moved: boolean; movedTo?: string; grew: boolean } // already a job — nothing new made
  | { kind: "made"; id: string; job: IntakeJob; po: string; unreadable: boolean; isDocx: boolean; readBy: "claude" | "rules"; readNote: string; how: string; flags: string[]; accessDate?: string; attachError?: string }
  | { kind: "error"; message: string };

const blankFields = (): PactPoFields => ({ po: "", poDate: "", desc: "", scope: "", partner: "", address: "", billBlock: "", contact: "", punit: "", amount: 0, rows: [], rowsAddUp: true, readable: false });

// the file, read into a job. `priceBook` is the tab's own copy of the price
// list (the Billing tab caches it; the Schedule tab loads it fresh).
export async function intakePoFile(file: File, priceBook: () => Promise<PriceItem[]>): Promise<IntakeOutcome> {
  let fields: PactPoFields | null = null;
  let how = "";
  let taxFromDoc: number | undefined;
  // which reader did the reading, and why it wasn't Claude when it wasn't
  let readBy: "claude" | "rules" = "rules";
  let readNote = "";
  // our own proposal letters (.docx) read right here on the device
  const isDocx = /\.docx$/i.test(file.name);
  // a NYCHA blanket release dropped here by mistake would be minced into a
  // garbage job — its cover page names it, so it gets sent to the right tab
  if (!isDocx) {
    try {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
      const tc = await (await doc.getPage(1)).getTextContent();
      const cover = (tc.items as { str?: string }[]).map((it) => it.str || "").join(" ");
      await doc.destroy();
      if (/Blanket\s+Release/i.test(cover) && /NYCHA|Supply\s+Management/i.test(cover)) return { kind: "release" };
    } catch { /* no text layer or reader hiccup — the real readers below handle it */ }
  }
  if (isDocx) {
    try {
      const { parsePactProposalDocx } = await import("./parsePactProposal");
      const parsed = parsePactProposalDocx(await file.arrayBuffer());
      taxFromDoc = parsed.taxPct;
      fields = parsed;
    } catch { fields = null; }
  }
  // 1) server read (Vercel caps request bodies ~4.5 MB — bigger scans go straight to the phone)
  if (!isDocx && file.size <= 4 * 1024 * 1024) {
    try {
      const { data: { session } } = await sb().auth.getSession();
      const res = await fetch("/api/parse-po", {
        method: "POST",
        headers: { "Content-Type": "application/pdf", ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: file,
      });
      if (res.ok) {
        const out = (await res.json()) as { fields: PactPoFields; readBy?: "claude" | "rules"; note?: string };
        fields = out.fields; readBy = out.readBy === "claude" ? "claude" : "rules"; readNote = out.note || "";
      }
      else how = `server said ${res.status}: ${(await res.text().catch(() => "")).slice(0, 90)}`;
    } catch { how = "server unreachable"; }
  } else if (!isDocx) how = "file too big for the server — read on this device";
  // the server answering with nothing usable counts as a miss too
  if (!isDocx && fields && !fields.po && !fields.partner && !fields.desc) fields = null;
  // …and so does an answer whose work lines don't add up to the total the PO
  // printed: the server's PDF engine can run two figures together on a tight
  // table, and the line it then drops is a line nobody would get paid for.
  // The phone reads it with a different engine, so it's worth asking.
  const serverShort = !isDocx && !!fields && !fields.rowsAddUp;
  const serverFields = fields;
  if (serverShort) fields = null;
  // 2) browser fallback
  if (!fields && isDocx) fields = blankFields();
  if (!fields) {
    try {
      readBy = "rules"; readNote = readNote || how || "read on this device";
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
      const { readPoOrProposalPages } = await import("./parsePactProposal");
      const pages: PoItem[][] = [];
      for (let pg = 1; pg <= doc.numPages; pg++) {
        const tc = await (await doc.getPage(pg)).getTextContent();
        pages.push(tc.items as PoItem[]);
      }
      fields = readPoOrProposalPages(pages);
      taxFromDoc = (fields as { taxPct?: number }).taxPct ?? taxFromDoc;
      // whichever read explains the PO's own total is the one to believe —
      // but a read that found NO work rows explains nothing, so it never
      // replaces one that found priced lines
      if (serverShort && serverFields
        && (serverFields.rows.length > fields.rows.length
          || (!fields.rowsAddUp && serverFields.rows.length >= fields.rows.length))) fields = serverFields;
    } catch {
      fields = serverFields || parsePactPoText(""); // truly unreadable here — job still gets created
    }
  }
  // one of our own letters names the person, not the partner company —
  // borrow the partner from an earlier job billed to the same office
  if (fields && !fields.partner && fields.billBlock) {
    const street = fields.billBlock.match(/\d+\s+[A-Za-z .]+/)?.[0] || "";
    if (street) {
      const { data: prior } = await sb().from("pact_jobs").select("partner,bill_to").not("partner", "eq", "").limit(200);
      // whole-number match — "10 Bank Street" must not hit "110 Bank Street"
      const re = new RegExp(`(^|[^0-9])${street.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
      const hit = ((prior || []) as { partner: string; bill_to?: string }[]).find((p) => re.test(p.bill_to || ""));
      if (hit) fields.partner = hit.partner;
    }
  }
  // whichever read won, a proposal letter's own tax rate travels with it —
  // the server path returns taxPct too, and dropping it here billed 8.875%
  // against letters that printed a different rate
  taxFromDoc = (fields as { taxPct?: number }).taxPct ?? taxFromDoc;
  const f = fields;
  const unreadable = !f.po && !f.partner && !f.desc;
  // an unreadable PDF must not smuggle in a dollar amount from a stray "Total $" hit
  const amount = unreadable ? 0 : f.amount;
  // this PO may already be a job — uploading it again must not make a second
  // one (a hand-typed job carries the PO in job_number, so check both).
  // One PO is one job: the number is matched in its stripped form ("PO
  // 8388" = "8388"), and a letter with no number — or a misread one — is
  // still the same job when it's the same address for the same money.
  // If the list can't be read, nothing is made rather than risk a twin.
  const { data: all, error: le } = await sb().from("pact_jobs").select(DUPE_COLS).order("created_at", { ascending: false }).limit(5000);
  if (le) return { kind: "error", message: `Couldn't check for duplicates (${le.message.slice(0, 60)}) — nothing was created, try again` };
  const dupe = findDupe((all || []) as DupeRow[], { po: f.po, address: f.address, property_unit: f.punit, amount });
  if (dupe) {
    const atts = dupe.attachments || [];
    if (!atts.some((a) => a.name === file.name)) {
      const dpath = `pact/${dupe.id}/${file.name}`;
      const { error: de } = await sb().storage.from("docs").upload(dpath, file, { upsert: true });
      if (!de) await sb().from("pact_jobs").update({ attachments: [...atts, { name: file.name, path: dpath }] }).eq("id", dupe.id);
    }
    // A job made before the reader learned this PO's shape may hold only
    // half the description. When the fresh read carries MORE of the same
    // words, the job takes the fuller wording — a description someone
    // rewrote by hand matches nothing and is left alone.
    const oldD = (dupe.description || "").replace(/\s+/g, " ").trim();
    const newD = (f.desc || "").replace(/\s+/g, " ").trim();
    const grew = !!newD && newD.toLowerCase() !== oldD.toLowerCase()
      && (oldD === "" || newD.toLowerCase().includes(oldD.toLowerCase()));
    if (grew) await sb().from("pact_jobs").update({ description: newD }).eq("id", dupe.id);
    // the partner re-issued the PO with a different access date: that IS
    // the new schedule — unless the work is already done
    const moved = !!f.accessDate && !dupe.work_done && (dupe.start_date || "") !== f.accessDate;
    if (moved) {
      const was = dupe.start_date ? ` (was ${prettyDate(dupe.start_date)})` : "";
      const line = `📅 Moved to ${prettyDate(f.accessDate!)} by a re-uploaded PO${was}`;
      // the crew rows follow to the new day (RUN_ME section 14's trigger) and
      // lose their TEXTED mark — the calendar shows who needs the new day
      await sb().from("pact_jobs").update({ start_date: f.accessDate, notes: `${(dupe.notes || "").trim()}${(dupe.notes || "").trim() ? "\n" : ""}${line}` }).eq("id", dupe.id);
    }
    return { kind: "dupe", id: dupe.id, po: f.po, canceled: !!dupe.canceled, moved, ...(moved ? { movedTo: f.accessDate } : {}), grew };
  }
  // a "NOT APPROVED" stamp is normal — the partner approves after the
  // work is done — so only real reading calls are flagged
  const flags = [...(f.warnings || [])];
  const { items: priced, amount: amountOut } = linesFromPoRead(f, unreadable, amount, await priceBook()) as { items: JobLine[]; amount: number };
  const newRow: Record<string, unknown> = {
    partner: f.partner, development: "", job_number: f.po, description: (f.desc || f.scope).slice(0, 120), amount: amountOut,
    po_number: f.po, po_date: f.poDate, address: f.address, property_unit: f.punit,
    contact: f.contact, bill_to: f.billBlock, items: priced,
    ...(taxFromDoc !== undefined ? { tax_pct: taxFromDoc } : {}),
    // the day the PO set goes straight onto the calendar; no day = pick one on the card
    ...(f.accessDate ? { start_date: f.accessDate } : {}),
    // the auto price — when the lines later add up to something else, the
    // job is priced and the calendar is done with it (RUN_ME section 15)
    list_subtotal: subtotalOf(priced),
    // which reader read it, and anything a person should know about the read
    notes: [isDocx ? "✓ Read from our own letter" : readBy === "claude" ? "✓ Read by Claude" : `⚠ Read by the rules${readNote ? ` (${readNote})` : ""}`, ...flags.map((w) => `⚠ ${w}`)].join("\n"),
  };
  const { data: job, error } = await insertJob(newRow);
  if (error || !job) return { kind: "error", message: error?.message || "Save failed" };
  const made = job as IntakeJob;
  // attach the PO itself
  const path = `pact/${made.id}/${file.name}`;
  const { error: ue } = await sb().storage.from("docs").upload(path, file, { upsert: true });
  if (!ue) await sb().from("pact_jobs").update({ attachments: [{ name: file.name, path }] }).eq("id", made.id);
  const attachError = ue ? (/bucket/i.test(ue.message) ? "storage not set up — run supabase/upgrade_invoices_aging_docs.sql" : ue.message.slice(0, 80)) : undefined;
  return { kind: "made", id: made.id, job: made, po: f.po, unreadable, isDocx, readBy, readNote, how, flags, ...(f.accessDate ? { accessDate: f.accessDate } : {}), ...(attachError ? { attachError } : {}) };
}

// a job typed in by hand — from the Billing tab (partner, description, an
// amount) or the Schedule tab (the PO, the address, the day). A typed PO
// number that is already a job opens that job instead of making a twin.
export type HandJob = { partner: string; job_number?: string; development?: string; description: string; amount?: number; address?: string; property_unit?: string; start_date?: string; notes?: string };
export type HandOutcome = { kind: "dupe"; id: string; canceled: boolean; start_date?: string | null } | { kind: "made"; id: string } | { kind: "error"; message: string };
export async function addJobByHand(d: HandJob): Promise<HandOutcome> {
  const po = (d.job_number || "").trim();
  if (po) {
    const { data: all, error: le } = await sb().from("pact_jobs").select(DUPE_COLS).limit(5000);
    if (le) return { kind: "error", message: `Couldn't check for duplicates (${le.message.slice(0, 60)}) — nothing was created, try again` };
    const dupe = findDupe((all || []) as DupeRow[], { po });
    if (dupe) return { kind: "dupe", id: dupe.id, canceled: !!dupe.canceled, start_date: dupe.start_date ?? null };
  }
  const { data, error } = await insertJob({
    partner: d.partner.trim(), development: (d.development || "").trim(), job_number: po, description: d.description.trim(), amount: Number(d.amount) || 0,
    ...(po ? { po_number: po } : {}),
    ...(d.address !== undefined ? { address: d.address.trim() } : {}),
    ...(d.property_unit !== undefined ? { property_unit: d.property_unit.trim() } : {}),
    ...(d.start_date ? { start_date: d.start_date } : {}),
    ...(d.notes ? { notes: d.notes } : {}),
    // no lines yet — a baseline of 0, so a line typed later at no price leaves it unpriced
    list_subtotal: 0,
  });
  if (error || !data) return { kind: "error", message: error?.message || "Save failed" };
  return { kind: "made", id: (data as { id: string }).id };
}
