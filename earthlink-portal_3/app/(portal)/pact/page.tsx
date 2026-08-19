"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
// pdf-lib is heavy — loaded only when a package PDF is actually built
import { sb } from "@/lib/supabase";
import { myProfile } from "@/lib/profile";
import { fmt, parseNum, askFileName } from "@/lib/format";
import { prettyDate, localISO, type Org } from "@/lib/docs";
import Stamp from "@/components/Stamp";
import PrintShell from "@/components/PrintShell";
import Letterhead from "@/components/Letterhead";
import { useLive } from "@/lib/useLive";
import { COMPANY } from "@/lib/company";
import { useNumBuffer } from "@/lib/numBuffer";
import { shrinkImage } from "@/lib/shrinkImage";
import { cleanPhone, smsHref, prettyPhone } from "@/lib/notify";
import { parsePactPoText, type PactPoFields } from "@/lib/parsePactPo";
import { priceLinesFor, soleKey, normUnit, loadPrices, type PriceItem } from "@/lib/priceBook";

interface Item { description: string; qty: number; unit: string; unit_price: number; key?: string; }
interface Job {
  id: string; partner: string; development: string; job_number: string; description: string;
  amount: number; approved: boolean; work_done: boolean; invoice_sent: string | null;
  received: boolean; paid_date: string | null; canceled: boolean;
  attachments?: { name: string; path: string }[] | null; notes: string; created_at: string;
  po_number?: string; po_date?: string; address?: string; property_unit?: string;
  contact?: string; bill_to?: string; items?: Item[] | null; invoice_number?: string; tax_pct?: number | null;
  proposal_sent?: string | null;
}
const BLANK = { partner: "", development: "", job_number: "", description: "", amount: "" };

// the unit follows the work: doors are counted, plaster is measured
const unitFor = (desc: string): string => {
  const d = desc.toLowerCase();
  if (/(plaster|paint|primer|prime\b|sheetrock|drywall|skim|tile|floor|wall|ceiling|demo|popcorn)/.test(d)) return "SF";
  if (/(molding|baseboard|cove|trim|pipe|caulk)/.test(d)) return "LF";
  if (/(hour|labor)/.test(d)) return "HOUR";
  return "EACH";
};

export default function Pact() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [org, setOrg] = useState<Org | null>(null);
  // Admin 1 (admin) sees everything; Admin 2 (office) sees POs & photos but no
  // invoices; accountants can look but not edit (matches the pact_jobs policies)
  const [role, setRole] = useState("");
  const canInvoice = role === "admin";
  const canEdit = role === "admin" || role === "office";
  // PACT proposals and invoices are Admin 1's; the office reads POs, prices
  // the work lines and tracks the job, and writes NYCHA proposals as before
  const canPrice = canEdit;
  const [q, setQ] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState({ ...BLANK });
  const [openId, setOpenId] = useState<string | null>(null);
  const [attachJob, setAttachJob] = useState<Job | null>(null);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [invJob, setInvJob] = useState<Job | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  // one camera input serves every job card — snapPhotos aims it first
  const photoRef = useRef<HTMLInputElement>(null);
  const [photoTarget, setPhotoTarget] = useState<{ id: string; kind: "before" | "after" } | null>(null);
  const snapPhotos = (j: Job, kind: "before" | "after") => { setPhotoTarget({ id: j.id, kind }); photoRef.current?.click(); };
  const poRef = useRef<HTMLInputElement>(null);
  // tap-to-text: pick a worker, their saved number + this job's address/description prefill the SMS
  const [notifyJob, setNotifyJob] = useState<string | null>(null);
  const [notifyDesc, setNotifyDesc] = useState("");
  const [crew, setCrew] = useState<{ id: string; name: string; phone?: string | null }[]>([]);
  const [crewQ, setCrewQ] = useState("");
  const [phoneBuf, setPhoneBuf] = useState<Record<string, string>>({});
  const openNotify = async (j: Job) => {
    if (notifyJob === j.id) { setNotifyJob(null); return; }
    setNotifyJob(j.id); setNotifyDesc(j.description || ""); setCrewQ("");
    if (crew.length === 0) {
      const { data } = await sb().from("employees").select("*").order("name");
      setCrew(((data || []) as { id: string; name: string; phone?: string | null; active?: boolean }[]).filter((e) => e.active !== false));
    }
  };
  const savePhone = async (empId: string, raw: string) => {
    const phone = cleanPhone(raw) || raw.trim();
    const { error } = await sb().from("employees").update({ phone }).eq("id", empId);
    if (error) { flash(/column|schema cache/i.test(error.message) ? "Run supabase/upgrade_worker_phone.sql first" : error.message); return; }
    setCrew((prev) => prev.map((e) => (e.id === empId ? { ...e, phone } : e)));
  };
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 3500); };
  const num = useNumBuffer();
  const upgradeHint = (m: string) => (/proposal_sent/i.test(m) ? "Run supabase/upgrade_pact_proposal.sql to track proposals sent"
    : /relation|column|schema/i.test(m) ? "Database needs the upgrade — re-run supabase/upgrade_pact.sql" : m);
  const today = () => localISO();
  const isImg = (n: string) => /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(n);
  const itemsOf = (j: Job): Item[] => (Array.isArray(j.items) ? j.items : []);
  // private work is taxable — NYC sales tax by default, editable per job
  const taxRate = (j: Job) => (j.tax_pct === null || j.tax_pct === undefined ? 8.875 : Number(j.tax_pct));
  const invSubtotal = (j: Job) => itemsOf(j).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);
  const invTax = (j: Job) => invSubtotal(j) * taxRate(j) / 100;
  const invTotal = (j: Job) => invSubtotal(j) + invTax(j);

  const load = async () => {
    const { data, error } = await sb().from("pact_jobs").select("*").order("created_at", { ascending: false });
    if (error) { flash(upgradeHint(error.message)); return; }
    setJobs((data || []) as Job[]);
  };
  useEffect(() => {
    load();
    sb().from("org").select("*").single().then(({ data }) => data && setOrg(data as Org));
    myProfile().then((p) => setRole(p?.role || ""));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // live: PACT jobs changing anywhere refresh the list without a reload
  useLive(["pact_jobs"], () => load(), { skipWhileTyping: true });

  // invoice numbers count up: 569, 570, 571… — the highest plain number wins,
  // so old "8300-1"-style numbers never skew the sequence
  const nextInvoiceNo = async (): Promise<string> => {
    const { data } = await sb().from("pact_jobs").select("invoice_number");
    const nums = ((data || []) as { invoice_number?: string }[])
      .map((r) => (/^\d+$/.test(String(r.invoice_number || "").trim()) ? parseInt(String(r.invoice_number).trim(), 10) : NaN))
      .filter((n) => Number.isFinite(n));
    return String(Math.max(568, ...nums) + 1);
  };

  const patch = async (j: Job, p: Partial<Job>) => {
    setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, ...p } : x)));
    setInvJob((prev) => (prev && prev.id === j.id ? { ...prev, ...p } : prev));
    const { error } = await sb().from("pact_jobs").update(p).eq("id", j.id);
    if (error) { flash(upgradeHint(error.message)); load(); }
  };

  // delete = gone for good (after a confirm) — the job, its photos and documents
  const deleteJob = async (j: Job) => {
    const label = [j.po_number || j.job_number, j.partner].filter(Boolean).join(" — ");
    if (!window.confirm(`Delete PO ${label}? The job and its photos/documents disappear for good. This can't be undone.`)) return;
    // the row goes first — if its delete fails the files are untouched; and the
    // file list comes fresh from the database, not this device's possibly-stale copy
    const { data: freshRow } = await sb().from("pact_jobs").select("attachments").eq("id", j.id).single();
    const paths = (((freshRow as { attachments?: { path: string }[] } | null)?.attachments) || j.attachments || []).map((a) => a.path);
    const { error } = await sb().from("pact_jobs").delete().eq("id", j.id);
    if (error) { flash(upgradeHint(error.message)); return; }
    let cleanupFailed = false;
    if (paths.length > 0) {
      const { error: se } = await sb().storage.from("docs").remove(paths);
      cleanupFailed = !!se;
    }
    if (openId === j.id) setOpenId(null);
    if (attachJob?.id === j.id) setAttachJob(null);
    if (invJob?.id === j.id) setInvJob(null);
    setJobs((prev) => prev.filter((x) => x.id !== j.id));
    flash(cleanupFailed ? "Job deleted — some of its files couldn't be cleaned up (they still count toward storage)" : "Job deleted");
  };

  // ---------- PO upload: the job builds itself from the partner's PO ----------
  // The PDF is read on the SERVER (same engine every time, no phone-browser
  // quirks); if the server can't be reached, the browser reads it as a backup.
  // Either way the upload always completes — worst case a blank job with the
  // PDF attached and a note to type the details.
  // ---------- the partner price list ----------
  // the line items as Settings has them now — re-read rather than remembered,
  // so a price changed on another phone is used on the very next PO (a folder
  // of proposals still only reads it once)
  const [book, setBook] = useState<{ items: PriceItem[]; at: number } | null>(null);
  const priceBook = async (): Promise<PriceItem[]> => {
    if (book && Date.now() - book.at < 30_000) return book.items;
    const { items, ok } = await loadPrices();
    if (!ok) {
      // the saved list couldn't be read: say so rather than quietly pricing
      // from the standard sheet with their own line items missing
      flash("Couldn't read your saved line items — using the standard sheet. Check the prices before sending anything.");
      if (book) return book.items; // the last good copy beats the fallback
      return items;
    }
    setBook({ items, at: Date.now() });
    return items;
  };

  // Work lines for this text, from the price list. Anything the PO already
  // priced stays exactly as the PO wrote it — the list only fills the gaps,
  // and work the PO named in its own words never gets a second copy beside it.
  const priceFromList = async (text: string, existing: Item[], opts: { bundle?: boolean; refresh?: boolean; fillOnly?: boolean } = {}): Promise<Item[]> => {
    const bk = await priceBook();
    const lines = priceLinesFor(text, { book: bk, bundle: opts.bundle ?? true });
    if (lines.length === 0) return existing;
    // what each line already on the job stands for. A line the portal wrote
    // remembers its own price-list line; one typed by hand or read off a PO is
    // matched only when it reads as exactly one line and nothing else, so
    // nothing gets silently swallowed or doubled.
    const covered = new Map<string, number>();
    const sameText = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]/g, "") === b.toLowerCase().replace(/[^a-z0-9]/g, "");
    existing.forEach((it, i) => {
      // a line that IS one of the price-list lines, word for word, covers that
      // one and nothing else — before falling back to reading its wording
      const exact = bk.find((p) => sameText(p.description, it.description))?.key;
      const k = it.key || exact || soleKey(it.description, bk);
      if (k && !covered.has(k)) covered.set(k, i);
    });
    const out = [...existing];
    for (const l of lines) {
      const at = covered.get(l.key);
      if (at === undefined) {
        // a PO that priced its own table is the agreement — fill what it left
        // blank, but never add work beside it
        if (opts.fillOnly) continue;
        out.push({ description: l.description, qty: l.qty, unit: l.unit, unit_price: l.unit_price, key: l.key });
        covered.set(l.key, out.length - 1);
        continue;
      }
      const it = out[at];
      // a line the portal put there follows the list; a price the PO stated
      // stays the PO's, because that one is the agreement
      if (Number(it.unit_price) > 0) {
        // a line that already carries a price of its own is the PO's or theirs
        // — re-pricing only touches lines the portal itself wrote
        if (opts.refresh && it.key) out[at] = { ...it, unit: l.unit, unit_price: l.unit_price };
        continue;
      }
      out[at] = { ...it, unit: it.unit || l.unit, unit_price: l.unit_price, qty: Number(it.qty) > 1 ? it.qty : l.qty, key: it.key || l.key };
    }
    return out.filter((it) => it.description.trim());
  };

  // "⚡ Price from list" on a job already here
  const fillFromList = async (j: Job) => {
    setBusy(true);
    try {
      // the job's own words only — feeding our generated line text back in
      // would let "Primer — 1 coat" read as a fresh painting order
      const before = itemsOf(j);
      const next = await priceFromList(j.description || "", before, { refresh: true });
      const added = next.length - before.length;
      const changed = next.filter((n, i) => i < before.length && n.unit_price !== before[i].unit_price).length;
      if (added === 0 && changed === 0) {
        flash("Already matching the price list — nothing to change");
        return;
      }
      setItems(j, next, true);
      flash([added > 0 ? `${added} line${added === 1 ? "" : "s"} added` : "", changed > 0 ? `${changed} re-priced` : ""]
        .filter(Boolean).join(" · ") + " from the price list — check them before invoicing");
    } finally { setBusy(false); }
  };

  // ---------- the proposal letter ----------
  const logoBytes = async (): Promise<Uint8Array | undefined> => {
    try {
      const r = await fetch("/logo.png");
      return r.ok ? new Uint8Array(await r.arrayBuffer()) : undefined;
    } catch { return undefined; }
  };

  const saveBytes = (bytes: Uint8Array, name: string, type: string) => {
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const url = URL.createObjectURL(new Blob([ab], { type }));
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  // the job's proposal letter — the same shape the reader here understands,
  // so a signed copy coming back makes the invoice without retyping anything
  // everything the proposal letter says, for the view and the file alike
  const proposalFields = async (j: Job) => {
    let lines = itemsOf(j)
      .filter((it) => it.description.trim() && Number(it.qty) > 0)
      .map((it) => ({ description: it.description, qty: Number(it.qty), unit: it.unit, unit_price: Number(it.unit_price) || 0 }));
    if (lines.length === 0) {
      const seeded = await priceFromList(j.description || "", []);
      lines = seeded.map((it) => ({ description: it.description, qty: Number(it.qty) || 1, unit: it.unit, unit_price: Number(it.unit_price) || 0 }));
    }
    if (lines.length === 0) lines = [{ description: j.description || "Work as discussed", qty: 1, unit: "EACH", unit_price: 0 }];
    return {
      poNumber: j.po_number || j.job_number || "",
      date: prettyDate(today()),
      attn: (j.contact || "").split("·")[0].replace(/\s*\d[\d\s().-]{6,}$/, "").trim(),
      billTo: (j.bill_to || j.partner || "").split(/,\s*/).filter(Boolean).slice(0, 3),
      serviceAddress: [j.address, j.property_unit ? `Apartment ${j.property_unit}` : ""].filter(Boolean).join(", "),
      lines,
      taxPct: taxRate(j),
    };
  };

  const proposalBytes = async (j: Job): Promise<{ bytes: Uint8Array; name: string }> => {
    const { buildProposalDocx, proposalFileName } = await import("@/lib/proposalDoc");
    const fields = await proposalFields(j);
    return { bytes: buildProposalDocx(fields, await logoBytes()), name: proposalFileName(fields) };
  };

  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  const makeProposal = async (j: Job) => {
    setBusy(true);
    try {
      const { bytes, name: def } = await proposalBytes(j);
      const name = askFileName(def);
      if (!name) return;
      saveBytes(bytes, name, DOCX);
      await keepOnJob(j, bytes, def, DOCX);
      await stampProposalSent(j);
      flash("Proposal saved — a copy is kept on the job, and the signed one reads straight back in here");
    } catch (err) {
      flash(`Couldn't build the proposal (${err instanceof Error ? err.message.slice(0, 60) : "unknown"})`);
    } finally { setBusy(false); }
  };

  // One PO in, both papers out: the proposal to send now and the invoice for
  // when the work is done. Each saves on its own tap so no browser blocks the
  // second file, and "both" saves them back to back.
  const saveProposalFor = async (j: Job, quiet = false): Promise<boolean> => {
    if (!quiet) setBusy(true);
    try {
      const { bytes, name } = await proposalBytes(j);
      saveBytes(bytes, name, DOCX);
      await keepOnJob(j, bytes, name, DOCX);
      await stampProposalSent(j);
      if (!quiet) flash("Proposal saved — a copy is kept on the job");
      return true;
    } catch (err) {
      flash(`Couldn't build the proposal (${err instanceof Error ? err.message.slice(0, 60) : "unknown"})`);
      return false;
    } finally { if (!quiet) setBusy(false); }
  };

  const saveInvoiceFor = async (j: Job, quiet = false): Promise<boolean> => {
    if (!quiet) setBusy(true);
    try {
      const theOrg = await companyOrg();
      if (!theOrg) { flash("Company details haven't loaded — check your signal and try again"); return false; }
      const bytes = await buildPackageBytes(j, theOrg);
      if (!bytes) { flash("Couldn't build the invoice — the job needs at least one priced work line"); return false; }
      saveBytes(bytes, invoiceFileName(j), "application/pdf");
      await keepOnJob(j, bytes, invoiceFileName(j), "application/pdf");
      if (!quiet) flash("Invoice saved — a copy is kept on the job");
      return true;
    } catch (err) {
      flash(`Couldn't build the invoice (${err instanceof Error ? err.message.slice(0, 60) : "unknown"})`);
      return false;
    } finally { if (!quiet) setBusy(false); }
  };

  const saveBoth = async (j: Job) => {
    setBusy(true);
    try {
      const p = await saveProposalFor(j, true);
      await new Promise((r) => setTimeout(r, 600)); // let the first download land
      const i = await saveInvoiceFor(j, true);
      // whatever actually happened is what gets said
      if (p && i) flash("Proposal and invoice both saved");
      else if (p) flash("Proposal saved — the invoice didn't build (see the message above)");
      else if (i) flash("Invoice saved — the proposal didn't build");
    } finally { setBusy(false); }
  };

  // every proposal from a folder import, in one zip
  const downloadFolderProposals = async () => {
    if (!folderResult || folderResult.made.length === 0 || busy) return;
    const fname = askFileName(`proposals_${today()}.zip`);
    if (!fname) return;
    setBusy(true);
    try {
      const { zipSync } = await import("fflate");
      const files: Record<string, Uint8Array> = {};
      let done = 0;
      for (const j of folderResult.made) {
        flash(`Writing proposals… ${++done} of ${folderResult.made.length}`);
        const live = jobs.find((x) => x.id === j.id) || j;
        try {
          const { bytes, name } = await proposalBytes(live);
          let nm = name;
          for (let n = 2; files[nm]; n++) nm = name.replace(/\.docx$/i, ` (${n}).docx`);
          files[nm] = bytes;
          await keepOnJob(live, bytes, name, DOCX);
          await stampProposalSent(live);
        } catch { /* one bad letter must not stop the rest */ }
      }
      if (Object.keys(files).length === 0) { flash("Couldn't build any of them — open one and check its work lines"); return; }
      saveBytes(zipSync(files, { level: 1 }), fname, "application/zip");
      flash(`${Object.keys(files).length} proposal${Object.keys(files).length === 1 ? "" : "s"} saved`);
    } finally { setBusy(false); }
  };

  // read it on screen before it goes anywhere
  const [viewJob, setViewJob] = useState<{ job: Job; f: Awaited<ReturnType<typeof proposalFields>> } | null>(null);
  const viewProposal = async (j: Job) => {
    setBusy(true);
    try { setViewJob({ job: j, f: await proposalFields(j) }); }
    catch (err) { flash(`Couldn't build the proposal (${err instanceof Error ? err.message.slice(0, 60) : "unknown"})`); }
    finally { setBusy(false); }
  };

  // the empty one to fill in by hand
  const blankProposal = async () => {
    setBusy(true);
    try {
      const { buildProposalDocx, BLANK_PROPOSAL } = await import("@/lib/proposalDoc");
      const name = askFileName("proposal template.docx");
      if (!name) return;
      saveBytes(buildProposalDocx({ ...BLANK_PROPOSAL, date: prettyDate(today()) }, await logoBytes()), name,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      flash("Template saved — fill it in, keep the layout, and uploading it back here builds the job");
    } catch (err) {
      flash(`Couldn't build the template (${err instanceof Error ? err.message.slice(0, 60) : "unknown"})`);
    } finally { setBusy(false); }
  };

  const handlePo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setOneShot(null); // whatever was offered for the last PO no longer applies
    setBusy(true);
    try {
      let fields: PactPoFields | null = null;
      let how = "";
      let taxFromDoc: number | undefined;
      // our own proposal letters (.docx) read right here on the device
      const isDocx = /\.docx$/i.test(file.name);
      if (isDocx) {
        try {
          const { parsePactProposalDocx } = await import("@/lib/parsePactProposal");
          const parsed = parsePactProposalDocx(await file.arrayBuffer());
          taxFromDoc = parsed.taxPct;
          fields = parsed;
          // the letter names the person, not the partner company — borrow the
          // partner from an earlier job billed to the same office
          if (!fields.partner && fields.billBlock) {
            const street = fields.billBlock.match(/\d+\s+[A-Za-z .]+/)?.[0] || "";
            if (street) {
              const { data: prior } = await sb().from("pact_jobs").select("partner,bill_to").not("partner", "eq", "").limit(200);
              // whole-number match — "10 Bank Street" must not hit "110 Bank Street"
              const re = new RegExp(`(^|[^0-9])${street.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
              const hit = ((prior || []) as { partner: string; bill_to?: string }[]).find((p) => re.test(p.bill_to || ""));
              if (hit) fields.partner = hit.partner;
            }
          }
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
          if (res.ok) fields = ((await res.json()) as { fields: PactPoFields }).fields;
          else how = `server said ${res.status}: ${(await res.text().catch(() => "")).slice(0, 90)}`;
        } catch { how = "server unreachable"; }
      } else how = "file too big for the server — read on this device";
      // the server answering with nothing usable counts as a miss too
      if (!isDocx && fields && !fields.po && !fields.partner && !fields.desc) fields = null;
      // 2) browser fallback
      if (!fields && isDocx) fields = { po: "", poDate: "", desc: "", scope: "", partner: "", address: "", billBlock: "", contact: "", punit: "", amount: 0, rows: [], readable: false };
      if (!fields) {
        try {
          const pdfjs = await import("pdfjs-dist");
          pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
          const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
          let raw = "";
          for (let pg = 1; pg <= doc.numPages; pg++) {
            const tc = await (await doc.getPage(pg)).getTextContent();
            const { textFromItems } = await import("@/lib/parsePactPo");
            raw += textFromItems(tc.items as { str?: string; transform?: number[] }[]) + "\n";
          }
          fields = parsePactPoText(raw);
        } catch {
          fields = parsePactPoText(""); // truly unreadable here — job still gets created
        }
      }
      const f = fields;
      const unreadable = !f.po && !f.partner && !f.desc;
      // this PO may already be a job — uploading it again must not make a second
      // one (a hand-typed job carries the PO in job_number, so check both)
      if (f.po) {
        const { data: dupes } = await sb().from("pact_jobs").select("id,attachments").or(`po_number.eq.${f.po},job_number.eq.${f.po}`).limit(1);
        const dupe = (dupes || [])[0] as Job | undefined;
        if (dupe) {
          const atts = dupe.attachments || [];
          if (!atts.some((a) => a.name === file.name)) {
            const dpath = `pact/${dupe.id}/${file.name}`;
            const { error: de } = await sb().storage.from("docs").upload(dpath, file, { upsert: true });
            if (!de) await sb().from("pact_jobs").update({ attachments: [...atts, { name: file.name, path: dpath }] }).eq("id", dupe.id);
          }
          setBusy(false);
          await load();
          setOpenId(dupe.id); setShowDetails(true);
          flash(`PO ${f.po} is already here — opened it (nothing new was created)`);
          return;
        }
      }
      // an unreadable PDF must not smuggle in a dollar amount from a stray "Total $" hit
      const amount = unreadable ? 0 : f.amount;
      const seed: Item[] = unreadable ? []
        : f.rows.length > 0
          ? f.rows.map((r) => ({ description: r.description, qty: r.qty, unit: normUnit(r.uom || unitFor(r.description)), unit_price: r.unit_price }))
          : (f.desc || f.scope) ? [{ description: (f.desc || f.scope).slice(0, 120), qty: 1, unit: unitFor(f.desc || f.scope), unit_price: 0 }] : [];
      // What is this PO for? Whatever the price list already answers — plaster
      // brings its primer and paint with it — gets filled in, priced. A price
      // the PO itself states is never touched: that one is the agreement.
      // when the PO priced its own lines, that IS the deal — fill the gaps but
      // never add prep work it didn't ask for
      const poPriced = seed.some((it) => Number(it.unit_price) > 0);
      // the same words must only be priced once — a PO often repeats its
      // description as its scope, and counting both doubles every quantity
      const said = [...new Set([f.desc, f.scope, f.rows.map((r) => r.description).join(" ")]
        .map((x) => (x || "").trim()).filter(Boolean))];
      const priced = await priceFromList(said.join(". "), seed, { bundle: !poPriced, fillOnly: poPriced });
      const { data: job, error } = await sb().from("pact_jobs").insert({
        partner: f.partner, development: "", job_number: f.po, description: f.desc || f.scope, amount,
        po_number: f.po, po_date: f.poDate, address: f.address, property_unit: f.punit,
        contact: f.contact, bill_to: f.billBlock, items: priced, invoice_number: await nextInvoiceNo(),
        ...(taxFromDoc !== undefined ? { tax_pct: taxFromDoc } : {}),
      }).select().single();
      if (error || !job) { setBusy(false); flash(upgradeHint(error?.message || "Save failed")); return; }
      // attach the PO itself
      const path = `pact/${(job as Job).id}/${file.name}`;
      const { error: ue } = await sb().storage.from("docs").upload(path, file, { upsert: true });
      if (!ue) await sb().from("pact_jobs").update({ attachments: [{ name: file.name, path }] }).eq("id", (job as Job).id);
      setBusy(false);
      await load();
      // open the fresh job with its details showing so what was read is on screen
      setOpenId((job as Job).id);
      setShowDetails(true);
      // the finished job, with the lines the price list filled in — and if
      // that read comes back empty, the job we just made is still the truth
      const { data: fresh } = await sb().from("pact_jobs").select("*").eq("id", (job as Job).id).single();
      const ready = (fresh as Job | null)?.id ? (fresh as Job) : (job as Job);
      if (!unreadable) setOneShot({ id: ready.id, job: ready, note: f.po ? `PO ${f.po}` : "PO read" });
      flash(ue
        ? `Job created, but the PDF didn't attach (${/bucket/i.test(ue.message) ? "storage not set up — run supabase/upgrade_invoices_aging_docs.sql" : ue.message.slice(0, 80)}) — add it from the Documents button`
        : unreadable
          ? isDocx
            ? "File attached, but the proposal couldn't be read — type the partner, address and description below"
            : `PDF attached, but no text could be read (scanned copy?${how ? ` · ${how}` : ""}) — type the partner, address and description below`
          : `PO ${f.po || "imported"} — check the details and work lines below`);
    } catch (err) {
      setBusy(false);
      flash(`Upload hit a snag — try again (${err instanceof Error ? err.message.slice(0, 80) : "unknown error"})`);
    }
  };

  const addJob = async () => {
    if (!draft.partner.trim() || !draft.description.trim()) { flash("Partner and description are the minimum"); return; }
    const { error } = await sb().from("pact_jobs").insert({
      partner: draft.partner.trim(), development: draft.development.trim(), job_number: draft.job_number.trim(),
      description: draft.description.trim(), amount: parseNum(draft.amount),
      invoice_number: await nextInvoiceNo(),
    });
    if (error) { flash(upgradeHint(error.message)); return; }
    setDraft({ ...BLANK }); setAddOpen(false); load();
  };

  // ---------- invoice items ----------
  const setItems = (j: Job, items: Item[], persist = false) => {
    setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, items } : x)));
    setInvJob((prev) => (prev && prev.id === j.id ? { ...prev, items } : prev));
    if (persist) {
      const sub = items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);
      const amount = sub * (1 + taxRate(j) / 100); // billed total includes tax
      // unpriced lines must not wipe a hand-typed job amount
      patch({ ...j, items }, sub > 0 ? { items, amount } : { items });
    }
  };

  // A paper the portal made gets kept on the job, next to the PO and the
  // photos — so what was quoted and what was billed can be looked up later.
  // Making it again replaces that copy rather than piling up new ones.
  const keepOnJob = async (j: Job, bytes: Uint8Array, name: string, type: string): Promise<void> => {
    try {
      // "#" (and friends) end a web address, so the shelf name drops them —
      // the file the user downloads keeps the name they expect
      const safe = name.replace(/[#?%&]+/g, "").replace(/\s{2,}/g, " ").trim();
      const path = `pact/${j.id}/${safe}`;
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      const { error } = await sb().storage.from("docs").upload(path, new Blob([ab], { type }), { upsert: true, contentType: type });
      if (error) return; // the download still happened — keeping a copy is a bonus, never a blocker
      const { data: cur } = await sb().from("pact_jobs").select("attachments").eq("id", j.id).single();
      const existing = (cur as { attachments?: { name: string; path: string }[] } | null)?.attachments
        || jobs.find((x) => x.id === j.id)?.attachments || [];
      if (existing.some((a) => a.path === path)) return; // already listed, and now replaced on the shelf
      const list = [...existing, { name, path }];
      await sb().from("pact_jobs").update({ attachments: list }).eq("id", j.id);
      setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, attachments: list } : x)));
      setAttachJob((prev) => (prev && prev.id === j.id ? { ...prev, attachments: list } : prev));
    } catch { /* keeping the copy is best effort */ }
  };

  // a proposal going out is a date on the job, like an invoice going out
  const stampProposalSent = async (j: Job): Promise<void> => {
    if (j.proposal_sent) return;
    const { error } = await sb().from("pact_jobs").update({ proposal_sent: today() }).eq("id", j.id);
    if (error) { if (/column|schema cache/i.test(error.message)) flash("Run supabase/upgrade_pact_proposal.sql to track proposals sent"); return; }
    setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, proposal_sent: today() } : x)));
  };

  // ---------- attachments & photos ----------
  const attachFiles = async (j: Job, files: File[]): Promise<void> => {
    if (files.length === 0) return;
    setBusy(true);
    const added: { name: string; path: string }[] = [];
    for (const file of files) {
      const path = `pact/${j.id}/${file.name}`;
      const { error } = await sb().storage.from("docs").upload(path, file, { upsert: true });
      if (error) { setBusy(false); flash(/bucket/i.test(error.message) ? "Storage not set up — run supabase/upgrade_invoices_aging_docs.sql" : error.message); return; }
      added.push({ name: file.name, path });
    }
    // merge against the freshest row so multi-photo batches and other devices never lose files
    const { data: cur } = await sb().from("pact_jobs").select("attachments").eq("id", j.id).single();
    const existing = (cur as { attachments?: { name: string; path: string }[] } | null)?.attachments
      || jobs.find((x) => x.id === j.id)?.attachments || [];
    const list = [...existing.filter((a) => !added.some((b) => b.path === a.path)), ...added];
    const { error: e2 } = await sb().from("pact_jobs").update({ attachments: list }).eq("id", j.id);
    if (e2) flash(e2.message);
    else {
      setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, attachments: list } : x)));
      setAttachJob((prev) => (prev && prev.id === j.id ? { ...prev, attachments: list } : prev));
    }
    setBusy(false);
  };
  const attachFile = (j: Job, file: File) => attachFiles(j, [file]);
  const addPhotos = async (j: Job, files: File[], kind: "before" | "after") => {
    const stamp = new Date().toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "");
    setBusy(true);
    const shrunk = await Promise.all(files.map((f) => shrinkImage(f)));
    await attachFiles(j, shrunk.map((f, i) => {
      const ext = (f.name.match(/\.\w+$/) || [".jpg"])[0];
      return new File([f], `${kind}_${stamp}${files.length > 1 ? `_${i + 1}` : ""}${ext}`, { type: f.type });
    }));
  };
  const openAttachment = async (path: string) => {
    const { data, error } = await sb().storage.from("docs").createSignedUrl(path, 3600);
    if (error || !data) { flash(error?.message || "Couldn't open"); return; }
    window.open(data.signedUrl, "_blank");
  };
  const removeAttachment = async (j: Job, path: string) => {
    await sb().storage.from("docs").remove([path]);
    const cur = jobs.find((x) => x.id === j.id) || j;
    const list = (cur.attachments || []).filter((a) => a.path !== path);
    await sb().from("pact_jobs").update({ attachments: list }).eq("id", j.id);
    setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, attachments: list } : x)));
    setAttachJob((prev) => (prev && prev.id === j.id ? { ...prev, attachments: list } : prev));
  };
  useEffect(() => {
    const imgs = (attachJob?.attachments || []).filter((a) => isImg(a.name));
    if (imgs.length === 0) { setPhotoUrls({}); return; }
    sb().storage.from("docs").createSignedUrls(imgs.map((a) => a.path), 3600).then(({ data }) => {
      const m: Record<string, string> = {};
      (data || []).forEach((d) => { if (d.signedUrl && d.path) m[d.path] = d.signedUrl; });
      setPhotoUrls(m);
    });
  }, [attachJob]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- a whole folder of proposals in, all their invoices out ----------
  const folderRef = useRef<HTMLInputElement>(null);
  const [folderResult, setFolderResult] = useState<{ made: Job[]; skipped: number; failed: number } | null>(null);
  // the PO that just came in — held by id, so the card and the papers always
  // read the job as it is now, edits and all
  const [oneShot, setOneShot] = useState<{ id: string; job: Job; note: string } | null>(null);
  const handleProposalFolder = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter((f) => /\.docx$/i.test(f.name));
    e.target.value = "";
    if (files.length === 0) { flash("No Word proposals (.docx) in that folder"); return; }
    setBusy(true);
    try {
      const { parsePactProposalDocx } = await import("@/lib/parsePactProposal");
      // one read up front: dupes, partner lookup, and the invoice number sequence
      const { data: priorRows } = await sb().from("pact_jobs").select("partner,bill_to,po_number,job_number,invoice_number");
      const prior = (priorRows || []) as { partner: string; bill_to?: string; po_number?: string; job_number?: string; invoice_number?: string }[];
      let seq = Math.max(568, ...prior
        .map((p) => (/^\d+$/.test(String(p.invoice_number || "").trim()) ? parseInt(String(p.invoice_number).trim(), 10) : NaN))
        .filter((n) => Number.isFinite(n)));
      const made: Job[] = [];
      let skipped = 0, failed = 0, done = 0;
      for (const f of files) {
        done += 1;
        flash(`Reading proposals… ${done} of ${files.length}`);
        try {
          const parsed = parsePactProposalDocx(await f.arrayBuffer());
          if (!parsed.readable || parsed.rows.length === 0) { failed += 1; continue; }
          const dupe = parsed.po && (
            prior.some((p) => p.po_number === parsed.po || p.job_number === parsed.po) ||
            made.some((m) => m.po_number === parsed.po)
          );
          if (dupe) { skipped += 1; continue; }
          let partner = "";
          const street = parsed.billBlock.match(/\d+\s+[A-Za-z .]+/)?.[0] || "";
          if (street) {
            const re = new RegExp(`(^|[^0-9])${street.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
            const hit = prior.find((p) => re.test(p.bill_to || ""));
            if (hit) partner = hit.partner;
          }
          seq += 1;
          const seed: Item[] = parsed.rows.map((r) => ({ description: r.description, qty: r.qty, unit: r.uom || unitFor(r.description), unit_price: r.unit_price }));
          const { data: job, error } = await sb().from("pact_jobs").insert({
            partner, development: "", job_number: parsed.po, description: parsed.desc, amount: parsed.amount,
            po_number: parsed.po, po_date: parsed.poDate, address: parsed.address, property_unit: parsed.punit,
            contact: parsed.contact, bill_to: parsed.billBlock, items: seed, invoice_number: String(seq),
            ...(parsed.taxPct !== undefined ? { tax_pct: parsed.taxPct } : {}),
          }).select().single();
          if (error || !job) { failed += 1; seq -= 1; continue; }
          const path = `pact/${(job as Job).id}/${f.name}`;
          const { error: ue } = await sb().storage.from("docs").upload(path, f, { upsert: true });
          if (!ue) await sb().from("pact_jobs").update({ attachments: [{ name: f.name, path }] }).eq("id", (job as Job).id);
          made.push({ ...(job as Job), attachments: ue ? [] : [{ name: f.name, path }] });
        } catch { failed += 1; }
      }
      await load();
      setFolderResult({ made, skipped, failed });
      flash(`${made.length} proposal${made.length === 1 ? "" : "s"} added${skipped ? `, ${skipped} already here` : ""}${failed ? `, ${failed} couldn't be read` : ""}`);
    } finally {
      setBusy(false);
    }
  };

  const downloadFolderInvoices = async () => {
    if (!folderResult || folderResult.made.length === 0 || busy) return;
    let theOrg = org;
    if (!theOrg) {
      const { data } = await sb().from("org").select("*").single();
      if (data) { theOrg = data as Org; setOrg(theOrg); }
    }
    if (!theOrg) { flash("Company details haven't loaded — check your signal and try again"); return; }
    setBusy(true);
    try {
      const files: Record<string, Uint8Array> = {};
      let done = 0;
      for (const j of folderResult.made) {
        flash(`Making invoices… ${++done} of ${folderResult.made.length}`);
        const bytes = await buildPackageBytes(j, theOrg);
        if (!bytes) continue;
        let base = `invoice # ${j.invoice_number || ""} PO ${j.po_number || j.job_number || ""} ${[j.address, j.property_unit && `Apt ${j.property_unit}`].filter(Boolean).join(" ")}`
          .trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s{2,}/g, " ").slice(0, 110);
        let name = `${base}.pdf`;
        for (let n = 2; files[name]; n++) name = `${base}_${n}.pdf`;
        files[name] = bytes;
        await keepOnJob(j, bytes, invoiceFileName(j), "application/pdf");
      }
      if (Object.keys(files).length === 0) { flash("No invoices could be built"); setBusy(false); return; }
      const { zipSync } = await import("fflate");
      const zipped = zipSync(files, { level: 1 });
      const ab = new ArrayBuffer(zipped.byteLength);
      new Uint8Array(ab).set(zipped);
      const fname = askFileName(`invoices_${localISO()}.zip`);
      if (fname) {
        const url = URL.createObjectURL(new Blob([ab], { type: "application/zip" }));
        const a = document.createElement("a");
        a.href = url; a.download = fname; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        await sb().from("pact_jobs").update({ invoice_sent: today() }).in("id", folderResult.made.map((j) => j.id));
        flash(`${Object.keys(files).length} invoices downloaded in one zip`);
        setFolderResult(null);
        load();
      }
    } catch {
      flash("Couldn't build the zip — check your signal and try again");
    }
    setBusy(false);
  };

  // one job's full package as PDF bytes — invoice page, PO pages, photos
  const buildPackageBytes = async (j: Job, org2: Org): Promise<Uint8Array | null> => {
    const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
    const items = itemsOf(j).filter((it) => Number(it.qty) > 0 && it.description.trim());
    if (items.length === 0) return null;
      const pkg = await PDFDocument.create();
      const helv = await pkg.embedFont(StandardFonts.Helvetica);
      const bold = await pkg.embedFont(StandardFonts.HelveticaBold);
      // --- invoice page: clean letterhead layout ---
      let page = pkg.addPage([612, 792]);
      const L = 54, R = 558;
      let y = 736;
      const ink = rgb(0.09, 0.09, 0.08), soft = rgb(0.45, 0.44, 0.42);
      const ruleC = rgb(0.82, 0.8, 0.75), fillC = rgb(0.94, 0.93, 0.9);
      const put = (t: string, x: number, yy: number, size = 9.5, font = helv, color = ink) =>
        page.drawText(t, { x, y: yy, size, font, color });
      const putR = (t: string, xr: number, yy: number, size = 9.5, font = helv, color = ink) =>
        put(t, xr - font.widthOfTextAtSize(t, size), yy, size, font, color);
      const hr = (yy: number, w = 0.6, color = ruleC) =>
        page.drawLine({ start: { x: L, y: yy }, end: { x: R, y: yy }, thickness: w, color });

      // letterhead: the logo with the company block beside it, same as the proposal
      void org2;
      let lx = L;
      try {
        const logoBytes = await fetch("/logo.png").then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("no logo"))));
        const logo = await pkg.embedPng(logoBytes);
        const lh2 = 60, lw2 = (logo.width / logo.height) * lh2;
        page.drawImage(logo, { x: L, y: y - lh2 + 13, width: lw2, height: lh2 });
        lx = L + lw2 + 12;
      } catch { /* logo unavailable — text-only letterhead */ }
      put(COMPANY.letterhead.name, lx, y, 14, bold);
      putR("INVOICE", R, y - 3, 21, bold);
      y -= 14;
      put(COMPANY.letterhead.address, lx, y, 8.5, helv, soft);
      y -= 11;
      put(COMPANY.letterhead.phones, lx, y, 8.5, helv, soft);
      y -= 11;
      put(COMPANY.letterhead.emails, lx, y, 8.5, helv, soft);
      y -= 12;
      hr(y, 1.6, ink);
      y -= 24;

      // invoice meta
      ([["INVOICE #", j.invoice_number || j.po_number || "—"], ["DATE", prettyDate(today())], ["PURCHASE ORDER", j.po_number || j.job_number || "—"]] as [string, string][]).forEach(([k, v], i) => {
        const x = L + i * 172;
        put(k, x, y, 7, bold, soft);
        put(v, x, y - 14, 10.5, bold);
      });
      y -= 40;

      // bill to / job site
      put("BILL TO", L, y, 7, bold, soft);
      put("JOB SITE", 330, y, 7, bold, soft);
      y -= 14;
      // strip the partner name off the bill-to block only when it really starts with it —
      // a hand-edited partner otherwise chops the address at a random offset
      const billRest = (j.bill_to || "").startsWith(j.partner || "") && j.partner
        ? (j.bill_to || "").slice(j.partner.length)
        : (j.bill_to || "");
      const billLines = [j.partner, ...billRest.trim().split(/(?<=\d{5})\s|,\s*/).filter(Boolean)].filter(Boolean).slice(0, 4) as string[];
      const siteLines = [j.address || "", j.property_unit && `Unit ${j.property_unit}`].filter(Boolean) as string[];
      const startY = y;
      billLines.forEach((s, i) => put(String(s).slice(0, 48), L, startY - i * 12, 9.5, i === 0 ? bold : helv));
      siteLines.forEach((s, i) => put(String(s).slice(0, 46), 330, startY - i * 12, 9.5, i === 0 ? bold : helv));
      y = startY - Math.max(billLines.length, siteLines.length, 1) * 12 - 16;

      // work table
      page.drawRectangle({ x: L, y: y - 5, width: R - L, height: 18, color: fillC });
      put("DESCRIPTION OF WORK", L + 6, y, 8, bold, soft);
      putR("QTY", 388, y, 8, bold, soft);
      put("UNIT", 400, y, 8, bold, soft);
      putR("UNIT PRICE", 500, y, 8, bold, soft);
      putR("AMOUNT", R - 6, y, 8, bold, soft);
      y -= 20;
      // a long work list spills onto extra pages instead of running off the sheet
      const newItemsPage = () => {
        page = pkg.addPage([612, 792]);
        y = 736;
        page.drawRectangle({ x: L, y: y - 5, width: R - L, height: 18, color: fillC });
        put("DESCRIPTION OF WORK (continued)", L + 6, y, 8, bold, soft);
        putR("QTY", 388, y, 8, bold, soft);
        put("UNIT", 400, y, 8, bold, soft);
        putR("UNIT PRICE", 500, y, 8, bold, soft);
        putR("AMOUNT", R - 6, y, 8, bold, soft);
        y -= 20;
      };
      let subtotal = 0;
      items.forEach((it) => {
        const amount = (Number(it.qty) || 0) * (Number(it.unit_price) || 0);
        subtotal += amount;
        const words = it.description.split(" ");
        let cur = "";
        const rowsTxt: string[] = [];
        words.forEach((w) => { if ((cur + " " + w).trim().length > 52) { rowsTxt.push(cur.trim()); cur = w; } else cur += " " + w; });
        if (cur.trim()) rowsTxt.push(cur.trim());
        rowsTxt.forEach((rt, i2) => {
          if (y < 96) newItemsPage();
          put(rt, L + 6, y);
          if (i2 === 0) {
            putR(String(it.qty), 388, y);
            put(it.unit, 400, y);
            putR(Number(it.unit_price).toFixed(2), 500, y);
            putR(amount.toFixed(2), R - 6, y);
          }
          y -= 13;
        });
        y -= 3;
        hr(y + 9, 0.5);
      });

      // totals
      if (y < 150) { page = pkg.addPage([612, 792]); y = 736; }
      y -= 8;
      const taxAmt = subtotal * taxRate(j) / 100;
      putR("Subtotal", 470, y, 9.5, helv, soft);
      putR(`$${subtotal.toFixed(2)}`, R - 6, y);
      y -= 15;
      putR(`Sales tax ${taxRate(j)}%`, 470, y, 9.5, helv, soft);
      putR(`$${taxAmt.toFixed(2)}`, R - 6, y);
      y -= 10;
      page.drawLine({ start: { x: 380, y }, end: { x: R, y }, thickness: 1.2, color: ink });
      y -= 17;
      putR("TOTAL DUE", 470, y, 10.5, bold);
      putR(`$${(subtotal + taxAmt).toFixed(2)}`, R - 6, y, 12.5, bold);

      // footer
      hr(72, 0.6);
      const foot = `Make all checks payable to ${(org2.company || "").toUpperCase()} · Thank you for your business`;
      put(foot, (612 - helv.widthOfTextAtSize(foot, 8.5)) / 2, 58, 8.5, helv, soft);
      // --- the PO pdf(s) ---
      const atts = j.attachments || [];
      for (const a of atts.filter((x) => /\.pdf$/i.test(x.name))) {
        try {
          const { data } = await sb().storage.from("docs").createSignedUrl(a.path, 600);
          if (!data) continue;
          const bytes = await (await fetch(data.signedUrl)).arrayBuffer();
          const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
          const pages = await pkg.copyPages(src, src.getPageIndices());
          pages.forEach((p) => pkg.addPage(p));
        } catch { /* skip unreadable pdf */ }
      }
      // --- photos: before then after, one per page ---
      for (const kind of ["before", "after"] as const) {
        const photos = atts.filter((x) => isImg(x.name) && x.name.toLowerCase().startsWith(kind));
        for (const a of photos) {
          try {
            const { data } = await sb().storage.from("docs").createSignedUrl(a.path, 600);
            if (!data) continue;
            const bytes = new Uint8Array(await (await fetch(data.signedUrl)).arrayBuffer());
            const img = bytes[0] === 0x89 ? await pkg.embedPng(bytes) : await pkg.embedJpg(bytes);
            const p = pkg.addPage([612, 792]);
            p.drawText(`${kind.toUpperCase()} — ${a.name}`, { x: 48, y: 760, size: 11, font: bold });
            const maxW = 516, maxH = 680;
            const scale = Math.min(maxW / img.width, maxH / img.height, 1);
            p.drawImage(img, { x: (612 - img.width * scale) / 2, y: 740 - img.height * scale, width: img.width * scale, height: img.height * scale });
          } catch { /* skip bad image */ }
        }
      }
      return await pkg.save();
  };

  // ---------- the submitted package: invoice + PO + before/after, one PDF ----------
  // the letterhead needs the company details — if the one fetch at page-open
  // failed (bad signal), try again now instead of being a dead button
  const companyOrg = async (): Promise<Org | null> => {
    if (org) return org;
    const { data } = await sb().from("org").select("*").single();
    if (!data) return null;
    setOrg(data as Org);
    return data as Org;
  };

  // "invoice # <invoice number> PO <PO number> <address>" — easy to spot in downloads
  const invoiceFileName = (j: Job) =>
    `invoice # ${j.invoice_number || ""} PO ${j.po_number || j.job_number || ""} ${[j.address, j.property_unit && `Apt ${j.property_unit}`].filter(Boolean).join(" ")}`
      .trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s{2,}/g, " ").slice(0, 120) + ".pdf";

  const buildPackage = async (j: Job) => {
    const theOrg = await companyOrg();
    if (!theOrg) { flash("Company details haven't loaded — check your signal and try again"); return; }
    setBusy(true);
    try {
      const out = await buildPackageBytes(j, theOrg);
      if (!out) { flash("Fill in the invoice lines first (open the job → Invoice)"); setBusy(false); return; }
      const blob = new Blob([out.buffer as ArrayBuffer], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const aEl = document.createElement("a");
      const fname = askFileName(invoiceFileName(j));
      if (!fname) { URL.revokeObjectURL(url); setBusy(false); return; }
      aEl.href = url; aEl.download = fname; aEl.click();
      await keepOnJob(j, out, invoiceFileName(j), "application/pdf");
      // revoking right away can abort the download on iPhone — give it a minute
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (!j.invoice_sent) patch(j, { invoice_sent: today() });
      flash("Package downloaded — invoice, PO, and photos in one PDF");
    } catch {
      flash("Couldn't build the package");
    }
    setBusy(false);
  };

  const live = jobs.filter((j) => !j.canceled);
  const rec = live.filter((j) => j.received).reduce((s, j) => s + Number(j.amount), 0);
  const tot = live.reduce((s, j) => s + Number(j.amount), 0);
  const days = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso + "T00:00:00").getTime()) / 86400000));
  const partners = [...new Set(jobs.map((j) => j.partner).filter(Boolean))];
  const list = jobs.filter((j) => !q || `${j.partner} ${j.development} ${j.job_number} ${j.po_number || ""} ${j.address || ""} ${j.description}`.toLowerCase().includes(q.toLowerCase()));
  const pipeline = (j: Job): [string, boolean][] => [
    ["PROPOSAL", !!j.proposal_sent], ["APPROVED", j.approved], ["WORK DONE", j.work_done],
    ...(canInvoice ? ([["INVOICED", !!j.invoice_sent], ["PAID", j.received]] as [string, boolean][]) : []),
  ];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-display text-2xl font-bold uppercase">PACT</div>
        <div className="flex flex-wrap gap-2">
          <Link className="btn btn-ghost" href="/pact/schedule">📅 Schedule</Link>
        </div>
      </div>
      <input ref={poRef} type="file" accept="application/pdf,.pdf,.docx" className="hidden" onChange={handlePo} />
      {/* a folder (or multi-select) of proposal letters, read in one go */}
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <input ref={folderRef} type="file" multiple {...({ webkitdirectory: "" } as any)} className="hidden" onChange={handleProposalFolder} />
      {oneShot && canInvoice && (() => {
        // always the job as it stands right now — edits included. The copy
        // taken at upload only stands in while the list is still loading; a
        // deleted job closes the card outright (deleteJob clears it).
        const j = jobs.find((x) => x.id === oneShot.id) || oneShot.job;
        const billable = itemsOf(j).filter((it) => it.description.trim() && Number(it.qty) > 0);
        const priced = billable.some((it) => Number(it.unit_price) > 0);
        return (
          <div className="card mb-3 border-work p-3.5">
            <div className="font-display text-base font-bold uppercase">{oneShot.note} — {billable.length > 0 ? "papers ready" : "read, but nothing priced yet"}</div>
            <div className="mt-1 text-xs text-inksoft">
              {j.address || "This job"}{j.property_unit ? ` · Apt ${j.property_unit}` : ""}
              {" · "}{billable.length} work line{billable.length === 1 ? "" : "s"}
              {canPrice && Number(j.amount) > 0 ? ` · ${fmt(Number(j.amount))}` : ""}
              {canInvoice && j.invoice_number ? ` · invoice # ${j.invoice_number}` : ""}
              {billable.length === 0
                ? ". Nothing on the price list matched this one — add the work lines below, then come back here."
                : priced ? ". Check the lines below before you send anything."
                  : ". The lines have no prices yet — fill them in below first."}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {canInvoice && billable.length > 0 && (
                <button className="btn btn-primary" disabled={busy} onClick={() => saveBoth(j)}>
                  {busy ? "Working…" : "⬇ Proposal + invoice"}
                </button>
              )}
              <button className="btn" disabled={busy} onClick={() => viewProposal(j)}>👁 View proposal</button>
              <button className={billable.length > 0 ? "btn" : "btn btn-primary"} disabled={busy} onClick={() => saveProposalFor(j)}>📝 Proposal only</button>
              {canInvoice && <button className="btn" disabled={busy || billable.length === 0} title={billable.length === 0 ? "The job needs a work line first" : ""} onClick={() => saveInvoiceFor(j)}>🧾 Invoice only</button>}
              <button className="btn btn-ghost" disabled={busy} onClick={() => setOneShot(null)}>Done</button>
            </div>
          </div>
        );
      })()}

      {folderResult && (
        <div className="card mb-3 border-work p-3.5">
          <div className="font-display text-base font-bold uppercase">{folderResult.made.length} proposal{folderResult.made.length === 1 ? "" : "s"} added</div>
          <div className="mt-1 text-xs text-inksoft">
            {folderResult.skipped > 0 && `${folderResult.skipped} skipped (already here). `}
            {folderResult.failed > 0 && `${folderResult.failed} couldn't be read — upload those one at a time. `}
            {canInvoice && `Invoice numbers ${folderResult.made[0]?.invoice_number}–${folderResult.made[folderResult.made.length - 1]?.invoice_number} assigned.`}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {canInvoice && (
              <button className="btn btn-primary" onClick={downloadFolderInvoices} disabled={busy || folderResult.made.length === 0}>
                {busy ? "Making invoices…" : `⬇ Download all ${folderResult.made.length} invoices (zip)`}
              </button>
            )}
            {canInvoice && (
              <button className="btn" onClick={downloadFolderProposals} disabled={busy || folderResult.made.length === 0}>
                {busy ? "Working…" : `📝 Download all ${folderResult.made.length} proposals (zip)`}
              </button>
            )}
            <button className="btn btn-ghost" disabled={busy} onClick={() => setFolderResult(null)}>Not now</button>
          </div>
        </div>
      )}

      {addOpen && (
        <div className="card mb-3 border-work p-3.5">
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
            <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">PACT partner</div>
              <input className="field" list="partners" value={draft.partner} onChange={(e) => setDraft({ ...draft, partner: e.target.value })} />
              <datalist id="partners">{partners.map((p) => <option key={p} value={p} />)}</datalist></div>
            <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Development</div>
              <input className="field" value={draft.development} onChange={(e) => setDraft({ ...draft, development: e.target.value })} /></div>
            <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Job / PO #</div>
              <input className="field" value={draft.job_number} onChange={(e) => setDraft({ ...draft, job_number: e.target.value })} /></div>
            <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Amount</div>
              <input className="field" inputMode="decimal" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} /></div>
            <div className="col-span-2 md:col-span-1"><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Description</div>
              <input className="field" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></div>
          </div>
          <div className="mt-3 flex gap-2">
            <button className="btn btn-primary" onClick={addJob}>Add job</button>
            <button className="btn btn-ghost" onClick={() => setAddOpen(false)}>Cancel</button>
          </div>
        </div>
      )}

      {jobs.length > 0 && canInvoice && (
        <div className="mb-3 grid grid-cols-3 gap-2">
          {([["PACT total", fmt(tot), "text-ink"], ["Received", fmt(rec), "text-ok"], ["Outstanding", fmt(tot - rec), "text-work"]] as [string, string, string][]).map(([l, v, cls]) => (
            <div key={l} className="card p-3">
              <div className="text-[10px] uppercase tracking-[.12em] text-inksoft">{l}</div>
              <div className={`font-mono text-base font-semibold ${cls}`}>{v}</div>
            </div>
          ))}
        </div>
      )}

      {canEdit && (
        <div className="card mb-3 flex flex-wrap items-center justify-between gap-2 border-work p-3.5">
          <div className="min-w-0 text-sm">
            <b>Got a purchase order?</b>{" "}
            <span className="text-inksoft">Upload the PDF — the job builds itself with the address, contacts, work lines and amount.</span>
          </div>
          <div className="flex shrink-0 gap-2">
            <button className="btn btn-primary" onClick={() => poRef.current?.click()} disabled={busy} title="A partner PO (PDF) or one of our proposal letters (Word)">📄 Upload PO / proposal</button>
            <button className="btn whitespace-nowrap" onClick={() => folderRef.current?.click()} disabled={busy} title="Pick a folder of proposal letters — every one becomes a job, then all the invoices download in one zip">📁 Proposal folder</button>
            {canInvoice && <button className="btn btn-ghost whitespace-nowrap" onClick={blankProposal} disabled={busy} title="A blank proposal letter in our layout — fill it in, and uploading it back here builds the job and the invoice">📝 Proposal template</button>}
            <button className="btn btn-ghost" onClick={() => setAddOpen(!addOpen)}>+ Manual</button>
          </div>
        </div>
      )}
      <input className="field mb-3" placeholder="Search partner, address, PO #…" value={q} onChange={(e) => setQ(e.target.value)} />

      <div className="card divide-y divide-rulesoft">
        {list.map((j) => (
          <div key={j.id} className={`p-3.5 ${j.canceled ? "opacity-50" : ""}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button className="min-w-0 text-left" onClick={() => { setOpenId(openId === j.id ? null : j.id); setShowDetails(false); }}>
                <div className={`text-[14px] font-semibold ${j.canceled ? "line-through" : ""}`}>
                  {j.address || j.development || j.partner}
                  {(j.po_number || j.job_number) ? <span className="ml-1.5 font-mono text-xs text-inksoft">PO {j.po_number || j.job_number}</span> : null}
                </div>
                <div className="max-w-[340px] truncate text-[13px] text-inksoft">{j.partner}{j.description ? ` · ${j.description}` : ""}</div>
                {!j.canceled && (() => {
                  const stages = pipeline(j);
                  const current = stages.findIndex(([, done]) => !done);
                  return (
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {stages.map(([l, done], i) => (
                        <span key={l} className={`rounded-[2px] border px-1 py-px font-mono text-[9px] font-semibold ${done ? "border-ok bg-ok/10 text-ok" : i === current ? "border-work text-work" : "border-rulesoft text-rule"}`}>{l}</span>
                      ))}
                      {j.proposal_sent && !j.approved && <span className="ml-1 font-mono text-[10px] text-work">{days(j.proposal_sent)}d waiting</span>}
                      {canInvoice && j.invoice_sent && !j.received && <span className="ml-1 font-mono text-[10px] text-inksoft">{days(j.invoice_sent)}d out</span>}
                    </div>
                  );
                })()}
              </button>
              <div className="flex shrink-0 items-center gap-2">
                {canPrice && <span className="font-mono text-sm font-semibold">{fmt(Number(j.amount) || invTotal(j))}</span>}
                <button className="text-inksoft" title="Documents & photos" onClick={() => setAttachJob(j)}>📎{(j.attachments || []).length > 0 ? <span className="font-mono text-[10px]">{(j.attachments || []).length}</span> : null}</button>
                {canEdit && j.canceled && <button className="text-ok" title="Restore" onClick={() => patch(j, { canceled: false })}>↺</button>}
                {canEdit && <button className="text-alert" title="Delete job" onClick={() => deleteJob(j)}>✕</button>}
              </div>
            </div>
            {openId === j.id && !j.canceled && (() => {
              const beforeN = (j.attachments || []).filter((a) => isImg(a.name) && a.name.toLowerCase().startsWith("before")).length;
              const afterN = (j.attachments || []).filter((a) => isImg(a.name) && a.name.toLowerCase().startsWith("after")).length;
              return (
              <div className="mt-3 border-t border-rulesoft pt-3">
                <div className="mb-2.5 flex flex-wrap gap-2">
                  {canEdit && <button className="btn px-3 py-1.5 text-[13px]" onClick={() => snapPhotos(j, "before")} disabled={busy}>📷 Before{beforeN > 0 ? ` · ${beforeN}` : ""}</button>}
                  {canEdit && <button className="btn px-3 py-1.5 text-[13px]" onClick={() => snapPhotos(j, "after")} disabled={busy}>📷 After{afterN > 0 ? ` · ${afterN}` : ""}</button>}
                  {(beforeN > 0 || afterN > 0 || (j.attachments || []).length > 0) && (
                    <button className="btn btn-ghost px-3 py-1.5 text-[13px]" onClick={() => setAttachJob(j)}>📎 Files{(j.attachments || []).length > 0 ? ` · ${(j.attachments || []).length}` : ""}</button>
                  )}
                  {canEdit && <button className="btn px-3 py-1.5 text-[13px]" onClick={() => openNotify(j)}>📱 Text worker</button>}
                </div>
                {notifyJob === j.id && (() => {
                  const desc = notifyDesc.trim();
                  const site = [j.address || j.development || "", j.property_unit && `Unit ${j.property_unit}`].filter(Boolean).join(", ");
                  const msgFor = (who?: string) =>
                    `Earth Link:${who ? ` ${who},` : ""} you're assigned to a job at ${site || "(no address on file)"}.${desc ? ` Work: ${desc}` : ""}`;
                  const cq = crewQ.trim().toLowerCase();
                  const match = crew.filter((e) => !cq || e.name.toLowerCase().includes(cq));
                  return (
                    <div className="mb-2.5 rounded-sm border border-rulesoft bg-paper p-2.5">
                      <div className="mb-1.5 text-[11px] uppercase tracking-widest text-inksoft">
                        Text a worker — the address fills in automatically
                      </div>
                      <input className="field mb-1" placeholder="Work description (what should they do there?)"
                        value={notifyDesc} onChange={(e) => setNotifyDesc(e.target.value)} />
                      <input className="field mb-1" placeholder="Find a worker by name…" value={crewQ} onChange={(e) => setCrewQ(e.target.value)} />
                      <div className="max-h-64 overflow-y-auto">
                        {match.map((e) => {
                          const buf = phoneBuf[e.id] ?? prettyPhone(e.phone || "");
                          const ok = !!cleanPhone(buf);
                          return (
                            <div key={e.id} className="flex flex-wrap items-center gap-2 border-t border-rulesoft py-1.5 first:border-t-0">
                              <b className="text-[13px]">{e.name}</b>
                              <input className="field w-44 px-2 py-1.5 text-[13px]" placeholder="Phone number" inputMode="tel"
                                value={buf} onChange={(ev) => setPhoneBuf((p) => ({ ...p, [e.id]: ev.target.value }))}
                                onBlur={() => { if (cleanPhone(buf) !== cleanPhone(e.phone || "")) savePhone(e.id, buf); }} />
                              {ok
                                ? <a className="btn px-3 py-1.5 text-[13px]" href={smsHref(buf, msgFor(e.name.split(" ")[0]))}>Text 📱</a>
                                : <span className="text-[11px] text-inksoft">add a number to text them</span>}
                            </div>
                          );
                        })}
                        {match.length === 0 && <div className="py-2 text-[13px] text-inksoft">No one matches “{crewQ}”.</div>}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 border-t border-rulesoft pt-2">
                        <button className="btn btn-ghost px-3 py-1.5 text-[12px]"
                          onClick={() => { navigator.clipboard?.writeText(msgFor()); flash("Message copied — paste it into any group chat"); }}>
                          Copy message
                        </button>
                        <span className="text-[11px] text-inksoft">numbers save to the crew list for next time</span>
                      </div>
                    </div>
                  );
                })()}
                {canEdit && (
                <div className="mb-2.5 flex flex-wrap gap-2">
                  <button onClick={() => patch(j, j.proposal_sent ? { proposal_sent: null } : { proposal_sent: today() })}><Stamp label={j.proposal_sent ? `PROPOSAL SENT ${prettyDate(j.proposal_sent)}` : "MARK PROPOSAL SENT"} tone={j.proposal_sent ? "ok" : "mute"} /></button>
                  <button onClick={() => patch(j, { approved: !j.approved })}><Stamp label={j.approved ? "APPROVED ✓" : "MARK APPROVED"} tone={j.approved ? "ok" : "mute"} /></button>
                  <button onClick={() => patch(j, { work_done: !j.work_done })}><Stamp label={j.work_done ? "WORK DONE ✓" : "MARK WORK DONE"} tone={j.work_done ? "ok" : "mute"} /></button>
                  {canInvoice && <button onClick={() => patch(j, j.received ? { received: false, paid_date: null } : { received: true, paid_date: today() })}><Stamp label={j.received ? `PAID ${prettyDate(j.paid_date)}` : "MARK PAID"} tone={j.received ? "ok" : "work"} /></button>}
                </div>
                )}
                <button className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-inksoft hover:text-ink"
                  onClick={() => setShowDetails(!showDetails)}>{showDetails ? "▴ Hide details" : "▾ Details (partner, PO #, contact…)"}</button>
                {showDetails && (
                <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
                  {([["partner", "Partner"], ["address", "Work address (ship to)"], ["po_number", "PO #"], ...(canInvoice ? [["invoice_number", "Invoice #"]] : []), ["property_unit", "Property unit"], ["contact", "Contact"], ["description", "Work description"]] as ["partner" | "address" | "po_number" | "invoice_number" | "property_unit" | "contact" | "description", string][]).map(([k, label]) => (
                    <div key={k} className={k === "description" || k === "address" ? "col-span-2" : ""}><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">{label}</div>
                      <input className="field" value={j[k] || ""} readOnly={!canEdit} onChange={(e) => canEdit && setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, [k]: e.target.value } : x)))}
                        onBlur={(e) => canEdit && patch(j, { [k]: e.target.value } as Partial<Job>)} /></div>
                  ))}
                </div>
                )}
                {/* the PO seeds one line — add more when the job runs past what's listed (excess materials etc.) */}
                <div className="mt-3">
                  <div className="mb-1.5 text-[11px] uppercase tracking-widest text-inksoft">Work lines — what gets billed for this job</div>
                  {!canEdit && itemsOf(j).map((it, i) => (
                    <div key={i} className="mb-1 flex flex-wrap items-center gap-2 text-[13px]">
                      <span className="flex-1">{it.description || "—"}</span>
                      <span className="font-mono text-inksoft">{it.qty} {it.unit}</span>
                    </div>
                  ))}
                  {!canEdit && itemsOf(j).length === 0 && <div className="text-xs text-inksoft">No lines yet.</div>}
                  {canEdit && (() => {
                    const cols = canPrice ? "minmax(150px,1fr) 52px 52px 72px 72px 18px" : "minmax(150px,1fr) 52px 52px 18px";
                    return (
                      <div className="overflow-x-auto">
                        <div className={canPrice ? "min-w-[460px]" : ""}>
                          {itemsOf(j).length > 0 && (
                            <div className="mb-1 grid gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-inksoft" style={{ gridTemplateColumns: cols }}>
                              <span>Description of work</span><span className="text-right">Qty</span><span className="text-center">Unit</span>
                              {canPrice && <span className="text-right">Price</span>}
                              {canPrice && <span className="text-right">Total</span>}
                              <span />
                            </div>
                          )}
                          {itemsOf(j).map((it, i) => (
                            <div key={i} className="mb-1.5 grid items-center gap-1.5" style={{ gridTemplateColumns: cols }}>
                              <input className="field" placeholder="What was done — door, plaster, paint…" value={it.description}
                                onChange={(e) => {
                                  const next = [...itemsOf(j)];
                                  const auto = unitFor(e.target.value);
                                  next[i] = { ...it, description: e.target.value, unit: it.unit === unitFor(it.description) || !it.unit ? auto : it.unit };
                                  setItems(j, next);
                                }}
                                onBlur={() => setItems(j, itemsOf(j), true)} />
                              <input className="field px-1.5 py-1.5 text-right font-mono" inputMode="decimal" title="Quantity"
                                {...num(`${j.id}:wl${i}:q`, Number(it.qty) || 0,
                                  (n) => { const next = [...itemsOf(j)]; next[i] = { ...next[i], qty: n }; setItems(j, next); },
                                  (n) => { const next = [...itemsOf(j)]; next[i] = { ...next[i], qty: n }; setItems(j, next, true); })} />
                              <input className="field px-1 py-1.5 text-center font-mono" title="Unit of measure" value={it.unit}
                                onChange={(e) => { const next = [...itemsOf(j)]; next[i] = { ...it, unit: e.target.value }; setItems(j, next); }}
                                onBlur={() => setItems(j, itemsOf(j), true)} />
                              {canPrice && (
                                <input className="field px-1.5 py-1.5 text-right font-mono" inputMode="decimal" title="Price per unit"
                                  {...num(`${j.id}:wl${i}:p`, Number(it.unit_price) || 0,
                                    (n) => { const next = [...itemsOf(j)]; next[i] = { ...next[i], unit_price: n }; setItems(j, next); },
                                    (n) => { const next = [...itemsOf(j)]; next[i] = { ...next[i], unit_price: n }; setItems(j, next, true); })} />
                              )}
                              {canPrice && <span className="text-right font-mono text-[12px]">{fmt((Number(it.qty) || 0) * (Number(it.unit_price) || 0))}</span>}
                              <button className="text-alert" title="Remove line" onClick={() => setItems(j, itemsOf(j).filter((_, x) => x !== i), true)}>✕</button>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                  {canEdit && (
                    <div className="flex flex-wrap gap-2">
                      <button className="btn btn-ghost px-3 py-1.5 text-[13px]" onClick={() => setItems(j, [...itemsOf(j), { description: "", qty: 1, unit: "EACH", unit_price: 0 }], true)}>+ Add line</button>
                      <button className="btn btn-ghost px-3 py-1.5 text-[13px]" disabled={busy} title="Fill the lines and prices from the partner price list — plaster brings its primer and paint" onClick={() => fillFromList(j)}>⚡ Price from list</button>
                      {canPrice && (
                        <label className="flex items-center gap-1 text-[12px] text-inksoft" title="The sales tax printed on the proposal and the invoice">
                          Sales tax
                          <input className="field w-16 px-1.5 py-1.5 text-right font-mono text-[12px]" inputMode="decimal"
                            {...num(`${j.id}:tax`, taxRate(j), () => null, (n2) => patch(j, { tax_pct: n2 }))} />
                          %
                        </label>
                      )}
                    </div>
                  )}
                </div>
                {canInvoice && (
                  <div className="mt-3 border-t border-rulesoft pt-3">
                    <div className="mb-1.5 text-[10px] uppercase tracking-[.15em] text-inksoft">Papers</div>
                    <div className="flex flex-wrap gap-2">
                      <button className="btn px-3 py-1.5 text-[13px]" disabled={busy} title="Read the proposal letter on screen first" onClick={() => viewProposal(j)}>👁 View proposal</button>
                      <button className="btn px-3 py-1.5 text-[13px]" disabled={busy} title="Save the proposal letter as a Word file" onClick={() => makeProposal(j)}>⬇ Proposal (Word)</button>
                      <button className="btn px-3 py-1.5 text-[13px]" title="The invoice lines, tax and total" onClick={() => setInvJob(j)}>🧾 Invoice</button>
                      <button className="btn btn-primary px-3 py-1.5 text-[13px]" disabled={busy} title="Invoice, the PO and the before/after photos in one PDF" onClick={() => buildPackage(j)}>📦 Invoice package</button>
                    </div>
                  </div>
                )}
                <div className="mt-3 flex justify-end">
                  <button className="btn btn-primary px-3 py-1.5 text-[13px]" onClick={() => {
                    (document.activeElement as HTMLElement | null)?.blur?.();
                    setOpenId(null); setShowDetails(false);
                  }}>Save & close</button>
                </div>
              </div>
              );
            })()}
          </div>
        ))}
        {list.length === 0 && <div className="p-5 text-sm text-inksoft">{jobs.length === 0 ? "No PACT jobs yet. Upload a partner PO — the job builds itself from it." : "Nothing matches."}</div>}
      </div>

      {/* ---------- invoice editor ---------- */}
      {invJob && canInvoice && (() => {
        const j = jobs.find((x) => x.id === invJob.id) || invJob;
        const items = itemsOf(j);
        return (
          <div className="fixed inset-0 z-40 overflow-y-auto bg-ink/50 px-2 py-6">
            <div className="card mx-auto max-w-3xl border-work bg-card p-4">
              <div className="mb-1 font-display text-lg font-bold uppercase">Invoice · PO {j.po_number || j.job_number}</div>
              <div className="mb-3 text-[13px] text-inksoft">{j.partner} · {j.address}{j.property_unit ? ` · Unit ${j.property_unit}` : ""}</div>
              <div className="mb-3 grid grid-cols-2 gap-2.5 md:grid-cols-4">
                <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Invoice #</div>
                  <input className="field" value={j.invoice_number || ""}
                    onChange={(e) => { setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, invoice_number: e.target.value } : x))); setInvJob((prev) => (prev && prev.id === j.id ? { ...prev, invoice_number: e.target.value } : prev)); }}
                    onBlur={(e) => patch(j, { invoice_number: e.target.value })} /></div>
                <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Subtotal</div>
                  <div className="field bg-paper font-mono">{fmt(invSubtotal(j))}</div></div>
                <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Tax %</div>
                  <input className="field text-right font-mono" inputMode="decimal"
                    {...num(`${j.id}:tax`, taxRate(j),
                      (n) => setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, tax_pct: n } : x))),
                      (n) => { const j2 = { ...j, tax_pct: n }; const sub = invSubtotal(j2); patch(j2, sub > 0 ? { tax_pct: n, amount: sub * (1 + n / 100) } : { tax_pct: n }); },
                      { showZero: true })} /></div>
                <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Total (with tax)</div>
                  <div className="field bg-paper font-mono font-semibold">{fmt(invTotal(j))}</div></div>
              </div>
              {items.map((it, i) => (
                <div key={i} className="mb-2 rounded-sm border border-rulesoft p-2">
                  <div className="flex items-start gap-2">
                    <input className="field flex-1" placeholder="Work description (unit picks itself — door, plaster, paint…)" value={it.description}
                      onChange={(e) => {
                        const next = [...items];
                        const auto = unitFor(e.target.value);
                        next[i] = { ...it, description: e.target.value, unit: it.unit === unitFor(it.description) || !it.unit ? auto : it.unit };
                        setItems(j, next);
                      }}
                      onBlur={() => setItems(j, items, true)} />
                    <button className="mt-2 text-alert" onClick={() => setItems(j, items.filter((_, x) => x !== i), true)}>✕</button>
                  </div>
                  <div className="mt-2 grid grid-cols-4 gap-2">
                    <div><div className="text-[10px] uppercase text-inksoft">Qty</div>
                      <input className="field px-2 py-1.5 text-right font-mono" inputMode="decimal"
                        {...num(`${j.id}:inv${i}:q`, Number(it.qty) || 0,
                          (n) => { const next = [...itemsOf(j)]; next[i] = { ...next[i], qty: n }; setItems(j, next); },
                          (n) => { const next = [...itemsOf(j)]; next[i] = { ...next[i], qty: n }; setItems(j, next, true); })} /></div>
                    <div><div className="text-[10px] uppercase text-inksoft">Unit</div>
                      <input className="field px-2 py-1.5 text-center font-mono" value={it.unit}
                        onChange={(e) => { const next = [...items]; next[i] = { ...it, unit: e.target.value }; setItems(j, next); }}
                        onBlur={() => setItems(j, items, true)} /></div>
                    <div><div className="text-[10px] uppercase text-inksoft">Unit price</div>
                      <input className="field px-2 py-1.5 text-right font-mono" inputMode="decimal"
                        {...num(`${j.id}:inv${i}:p`, Number(it.unit_price) || 0,
                          (n) => { const next = [...itemsOf(j)]; next[i] = { ...next[i], unit_price: n }; setItems(j, next); },
                          (n) => { const next = [...itemsOf(j)]; next[i] = { ...next[i], unit_price: n }; setItems(j, next, true); })} /></div>
                    <div><div className="text-[10px] uppercase text-inksoft">Amount</div>
                      <div className="field bg-paper px-2 py-1.5 text-right font-mono">{fmt((Number(it.qty) || 0) * (Number(it.unit_price) || 0))}</div></div>
                  </div>
                </div>
              ))}
              <button className="btn btn-ghost mb-3" onClick={() => setItems(j, [...items, { description: "", qty: 1, unit: "EACH", unit_price: 0 }], true)}>+ Add line</button>
              <div className="flex justify-end gap-2">
                <button className="btn" onClick={() => { setInvJob(null); buildPackage(j); }} disabled={busy}>📦 Download package</button>
                <button className="btn btn-primary" onClick={() => {
                  (document.activeElement as HTMLElement | null)?.blur?.();
                  setInvJob(null);
                }}>Save & close</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ---------- documents & photos ---------- */}
      {viewJob && canInvoice && (() => {
        const { job: j, f } = viewJob;
        const sub = f.lines.reduce((t, l) => t + l.qty * l.unit_price, 0);
        const tax = Math.round(sub * f.taxPct) / 100;
        return (
          <PrintShell title={`proposal ${f.poNumber || ""} ${(f.serviceAddress || "").split(",")[0]}`.trim()}>
            <div className="fixed inset-0 z-50 overflow-y-auto bg-ink/50 px-2 py-5">
              <div className="printable mx-auto max-w-3xl rounded-sm border-t-4 border-ink bg-white p-8 text-ink">
                <Letterhead />
                <div className="text-[13px] leading-relaxed">
                  <div>Date: {f.date}</div>
                  {f.poNumber && <div>PO #: {f.poNumber}</div>}
                  <div>ATTN: {f.attn || "—"}</div>
                  {f.billTo.map((b, i) => <div key={i}>{b}</div>)}
                  <div className="mt-3">Dear {f.attn || "Sir or Madam"},</div>
                  <div className="mt-1">We are pleased to submit our proposal for the property below.</div>
                  <div className="mt-3"><b>Service Address:</b> {f.serviceAddress || "—"}</div>
                </div>
                <div className="mt-4 font-display text-base font-bold uppercase">Scope of Work</div>
                <table className="mt-1 w-full border-collapse border border-ink text-[12px]">
                  <thead><tr className="bg-paper text-left font-display text-[10px] uppercase tracking-widest">
                    <th className="border border-ink p-1.5">Description</th>
                    <th className="border border-ink p-1.5 text-right">Qty</th>
                    <th className="border border-ink p-1.5 text-right">Unit price</th>
                    <th className="border border-ink p-1.5 text-right">Amount</th>
                  </tr></thead>
                  <tbody>
                    {f.lines.map((l, i) => (
                      <tr key={i} className="align-top">
                        <td className="border border-rulesoft p-1.5">{l.description}</td>
                        <td className="border border-rulesoft p-1.5 text-right font-mono">{l.qty}{l.unit && l.unit.toUpperCase() !== "EACH" ? ` ${l.unit.toUpperCase()}` : ""}</td>
                        <td className="border border-rulesoft p-1.5 text-right font-mono">{fmt(l.unit_price)}</td>
                        <td className="border border-rulesoft p-1.5 text-right font-mono font-semibold">{fmt(l.qty * l.unit_price)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-3 flex flex-col items-end gap-0.5 text-[13px]">
                  <div>Total Cost: <span className="font-mono">{fmt(sub)}</span></div>
                  <div>Sales Tax ({f.taxPct}%): <span className="font-mono">{fmt(tax)}</span></div>
                  <div className="font-display text-base font-bold">Grand Total: <span className="font-mono">{fmt(sub + tax)}</span></div>
                </div>
                <div className="mt-5 text-[13px]">
                  <div>Thank you for the opportunity. Please sign and return a copy to authorize the work.</div>
                  <div className="mt-4">Best regards,</div>
                  <div className="font-semibold">{COMPANY.letterhead.name}</div>
                  <div className="text-[12px]">{COMPANY.letterhead.phones.replace(/^Phone:\s*/, "")}</div>
                </div>
              </div>
              <div className="no-print mx-auto mt-3 flex max-w-3xl flex-wrap justify-end gap-2">
                <button className="btn bg-white" disabled={busy} onClick={() => saveProposalFor(j)}>⬇ Download Word</button>
                <button className="btn bg-white" onClick={() => window.print()}>Print / Save as PDF</button>
                <button className="btn btn-ghost bg-white" onClick={() => setViewJob(null)}>Close</button>
              </div>
            </div>
          </PrintShell>
        );
      })()}

      {attachJob && (
        <div className="fixed inset-0 z-40 overflow-y-auto bg-ink/50 px-2 py-10" onClick={() => setAttachJob(null)}>
          <div className="card mx-auto max-w-md bg-card p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 font-display text-base font-bold uppercase">Documents · PO {attachJob.po_number || attachJob.job_number || ""}</div>
            {(["before", "after"] as const).map((kind) => {
              const photos = (attachJob.attachments || []).filter((a) => isImg(a.name) && a.name.toLowerCase().startsWith(kind));
              return (
                <div key={kind} className="mb-3">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-inksoft">{kind} ({photos.length})</div>
                  {photos.length > 0 ? (
                    <div className="grid grid-cols-3 gap-1.5">
                      {photos.map((a) => (
                        <div key={a.path} className="relative">
                          <button className="block w-full" onClick={() => openAttachment(a.path)} title={a.name}>
                            {photoUrls[a.path]
                              // eslint-disable-next-line @next/next/no-img-element
                              ? <img src={photoUrls[a.path]} alt={a.name} className="h-24 w-full rounded-sm border border-rulesoft object-cover" />
                              : <div className="grid h-24 w-full place-items-center rounded-sm border border-rulesoft text-xs text-inksoft">…</div>}
                          </button>
                          {canEdit && <button className="absolute right-1 top-1 rounded-sm bg-ink/70 px-1.5 text-xs text-paper" onClick={() => removeAttachment(attachJob, a.path)}>✕</button>}
                        </div>
                      ))}
                    </div>
                  ) : <div className="text-xs text-inksoft">No {kind} photos yet.</div>}
                </div>
              );
            })}
            {(() => {
              // images that came in through "Upload file" have no before/after
              // prefix — they still need to be viewable (and deletable) here
              const loose = (attachJob.attachments || []).filter((a) => isImg(a.name) && !/^(before|after)/i.test(a.name));
              return loose.length > 0 ? (
                <div className="mb-3">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-inksoft">other photos ({loose.length})</div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {loose.map((a) => (
                      <div key={a.path} className="relative">
                        <button className="block w-full" onClick={() => openAttachment(a.path)} title={a.name}>
                          {photoUrls[a.path]
                            // eslint-disable-next-line @next/next/no-img-element
                            ? <img src={photoUrls[a.path]} alt={a.name} className="h-24 w-full rounded-sm border border-rulesoft object-cover" />
                            : <div className="grid h-24 w-full place-items-center rounded-sm border border-rulesoft text-xs text-inksoft">…</div>}
                        </button>
                        {canEdit && <button className="absolute right-1 top-1 rounded-sm bg-ink/70 px-1.5 text-xs text-paper" onClick={() => removeAttachment(attachJob, a.path)}>✕</button>}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null;
            })()}
            {(attachJob.attachments || []).filter((a) => !isImg(a.name)).map((a) => (
              <div key={a.path} className="mb-1.5 flex items-center gap-1">
                <button className="block w-full rounded-sm border border-rulesoft p-2.5 text-left text-sm hover:border-work" onClick={() => openAttachment(a.path)}>📄 {a.name}</button>
                {canEdit && <button className="shrink-0 px-1 text-xs text-alert" onClick={() => removeAttachment(attachJob, a.path)}>✕</button>}
              </div>
            ))}
            <div className="mt-3 flex flex-wrap gap-2">
              {canEdit && <button className="btn btn-primary" onClick={() => snapPhotos(attachJob, "before")} disabled={busy}>📷 Before</button>}
              {canEdit && <button className="btn btn-primary" onClick={() => snapPhotos(attachJob, "after")} disabled={busy}>📷 After</button>}
              {canEdit && <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>Upload file</button>}
              <button className="btn btn-ghost" onClick={() => setAttachJob(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
      <input ref={fileRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f && attachJob) attachFile(attachJob, f); e.target.value = ""; }} />
      <input ref={photoRef} type="file" accept="image/*" capture="environment" multiple className="hidden"
        onChange={(e) => { const fs = Array.from(e.target.files || []); const t = photoTarget; const j = t ? jobs.find((x) => x.id === t.id) : null; if (fs.length && t && j) addPhotos(j, fs, t.kind); e.target.value = ""; }} />

      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
      {busy && <div className="fixed bottom-14 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink/80 px-4 py-2 text-sm text-paper">Working…</div>}
    </div>
  );
}
