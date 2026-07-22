"use client";
import { useEffect, useRef, useState } from "react";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { sb } from "@/lib/supabase";
import { fmt, parseNum, askFileName } from "@/lib/format";
import { prettyDate, type Org } from "@/lib/docs";
import Stamp from "@/components/Stamp";
import { useLive } from "@/lib/useLive";
import { useNumBuffer } from "@/lib/numBuffer";

interface Item { description: string; qty: number; unit: string; unit_price: number; }
interface Job {
  id: string; partner: string; development: string; job_number: string; description: string;
  amount: number; approved: boolean; work_done: boolean; invoice_sent: string | null;
  received: boolean; paid_date: string | null; canceled: boolean;
  attachments?: { name: string; path: string }[] | null; notes: string; created_at: string;
  po_number?: string; po_date?: string; address?: string; property_unit?: string;
  contact?: string; bill_to?: string; items?: Item[] | null; invoice_number?: string; tax_pct?: number | null;
}
const BLANK = { partner: "", development: "", job_number: "", description: "", amount: "" };

// the unit follows the work: doors are counted, plaster is measured
const unitFor = (desc: string): string => {
  const d = desc.toLowerCase();
  if (/(plaster|paint|sheetrock|drywall|skim|tile|floor|wall|ceiling|demo)/.test(d)) return "SF";
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
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 3500); };
  const num = useNumBuffer();
  const upgradeHint = (m: string) => (/relation|column|schema/i.test(m) ? "Database needs the upgrade — re-run supabase/upgrade_pact.sql" : m);
  const today = () => new Date().toISOString().slice(0, 10);
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
    (async () => {
      const { data: { user } } = await sb().auth.getUser();
      if (!user) return;
      const { data: prof } = await sb().from("profiles").select("role").eq("id", user.id).single();
      setRole((prof as { role?: string } | null)?.role || "");
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // live: PACT jobs changing anywhere refresh the list without a reload
  useLive(["pact_jobs"], () => load(), { skipWhileTyping: true });

  const patch = async (j: Job, p: Partial<Job>) => {
    setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, ...p } : x)));
    setInvJob((prev) => (prev && prev.id === j.id ? { ...prev, ...p } : prev));
    const { error } = await sb().from("pact_jobs").update(p).eq("id", j.id);
    if (error) { flash(upgradeHint(error.message)); load(); }
  };

  // ---------- PO upload: the job builds itself from the partner's PO ----------
  const handlePo = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        setBusy(true);
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const doc = await pdfjs.getDocument({ data: (ev.target?.result as ArrayBuffer).slice(0) }).promise;
        let raw = "";
        for (let pg = 1; pg <= doc.numPages; pg++) {
          const tc = await (await doc.getPage(pg)).getTextContent();
          raw += tc.items.map((it) => ("str" in it ? it.str : "")).join(" ") + " ";
        }
        const t = raw.replace(/\s+/g, " ");
        const po = t.match(/Purchase Order No\.?\s*:?\s*(\w+)/i)?.[1] || "";
        const poDate = t.match(/Date Ordered\s*:?\s*([\d/]+)/i)?.[1] || "";
        const desc = t.match(/Description\s*:?\s*(.*?)\s+(?:Scheduled|Date Payment|PO Closed|Bill To)/i)?.[1]?.trim() || "";
        const billBlock = t.match(/Bill To\s+(.*?)\s+Ship To/i)?.[1] || "";
        const shipBlock = t.match(/Ship To\s+(.*?)\s+Description\s/i)?.[1] || "";
        const partner = billBlock.match(/^(.*?)(?=\s+\d)/)?.[1]?.trim() || billBlock.trim();
        const address = (partner && shipBlock.startsWith(partner) ? shipBlock.slice(partner.length) : shipBlock).trim();
        const contact = t.match(/([A-Z][a-z]+ [A-Z][a-z]+)\s+(\d{3}[-.]?\d{3}[-.]?\d{4})/);
        const punit = t.match(/\$\s*[\d.,]+\s+([0-9]+-[0-9]+)/)?.[1] || "";
        if (!po && !partner) { setBusy(false); flash("Couldn't read this PDF as a PACT purchase order"); return; }
        const seed: Item[] = desc ? [{ description: desc, qty: 1, unit: unitFor(desc), unit_price: 0 }] : [];
        const { data: job, error } = await sb().from("pact_jobs").insert({
          partner, development: "", job_number: po, description: desc, amount: 0,
          po_number: po, po_date: poDate, address, property_unit: punit,
          contact: contact ? `${contact[1]} ${contact[2]}` : "", bill_to: billBlock,
          items: seed, invoice_number: po ? `${po}-1` : "",
        }).select().single();
        if (error || !job) { setBusy(false); flash(upgradeHint(error?.message || "Save failed")); return; }
        // attach the PO itself
        const path = `pact/${(job as Job).id}/${file.name}`;
        const { error: ue } = await sb().storage.from("docs").upload(path, file, { upsert: true });
        if (!ue) await sb().from("pact_jobs").update({ attachments: [{ name: file.name, path }] }).eq("id", (job as Job).id);
        setBusy(false);
        await load();
        setOpenId((job as Job).id);
        flash(`PO ${po} — ${partner} · ${address || "no address found"}`);
      } catch { setBusy(false); flash("Couldn't read that PDF"); }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  const addJob = async () => {
    if (!draft.partner.trim() || !draft.description.trim()) { flash("Partner and description are the minimum"); return; }
    const { error } = await sb().from("pact_jobs").insert({
      partner: draft.partner.trim(), development: draft.development.trim(), job_number: draft.job_number.trim(),
      description: draft.description.trim(), amount: parseNum(draft.amount),
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
    const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "");
    await attachFiles(j, files.map((f, i) => {
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

  // ---------- the submitted package: invoice + PO + before/after, one PDF ----------
  const buildPackage = async (j: Job) => {
    if (!org) return;
    const items = itemsOf(j).filter((it) => Number(it.qty) > 0 && it.description.trim());
    if (items.length === 0) { flash("Fill in the invoice lines first (open the job → Invoice)"); return; }
    setBusy(true);
    try {
      const pkg = await PDFDocument.create();
      const helv = await pkg.embedFont(StandardFonts.Helvetica);
      const bold = await pkg.embedFont(StandardFonts.HelveticaBold);
      // --- invoice page (the 540 letterhead layout) ---
      const page = pkg.addPage([612, 792]);
      const W = 612; let y = 750;
      const center = (txt: string, size: number, font = helv, color = rgb(0, 0, 0)) => {
        page.drawText(txt, { x: (W - font.widthOfTextAtSize(txt, size)) / 2, y, size, font, color }); y -= size + 4;
      };
      const line = (x1: number, x2: number, yy: number) => page.drawLine({ start: { x: x1, y: yy }, end: { x: x2, y: yy }, thickness: 0.8 });
      center(org.company || "Earth Link General Construction, Inc.", 15, bold);
      center([org.address1, org.address2].filter(Boolean).join(", "), 9);
      center([org.phone && `Phone: ${org.phone}`, org.email].filter(Boolean).join(" | "), 9);
      y -= 8; center("INVOICE", 17, bold); y -= 4;
      const L = 48, R = 564;
      line(L, R, y + 8); y -= 8;
      const kv = (k: string, v: string) => { page.drawText(k, { x: L, y, size: 10, font: bold }); page.drawText(v, { x: L + 110, y, size: 10, font: helv }); y -= 15; };
      kv("Invoice #:", j.invoice_number || j.po_number || "");
      kv("Date:", prettyDate(today()));
      kv("Contract/Order #:", j.po_number || j.job_number || "");
      y -= 4;
      page.drawText("Bill To:", { x: L, y, size: 10, font: bold });
      page.drawText("Job Site:", { x: 330, y, size: 10, font: bold }); y -= 14;
      const billLines = [j.partner, ...(j.bill_to || "").slice(j.partner.length).trim().split(/(?<=\d{5})\s|,\s*/).filter(Boolean)].slice(0, 4);
      const siteLines = [j.address || "", j.property_unit && `Unit ${j.property_unit}`, j.description].filter(Boolean) as string[];
      const startY = y;
      billLines.forEach((s) => { page.drawText(String(s).slice(0, 48), { x: L, y, size: 9.5, font: helv }); y -= 12; });
      let y2 = startY;
      siteLines.forEach((s) => { page.drawText(String(s).slice(0, 46), { x: 330, y: y2, size: 9.5, font: helv }); y2 -= 12; });
      y = Math.min(y, y2) - 10;
      // table
      line(L, R, y + 6);
      page.drawText("Description", { x: L, y: y - 6, size: 10, font: bold });
      page.drawText("Qty", { x: 350, y: y - 6, size: 10, font: bold });
      page.drawText("Unit", { x: 395, y: y - 6, size: 10, font: bold });
      page.drawText("Unit Price ($)", { x: 440, y: y - 6, size: 10, font: bold });
      page.drawText("Amount ($)", { x: 515, y: y - 6, size: 10, font: bold });
      y -= 20; line(L, R, y + 6);
      let subtotal = 0;
      items.forEach((it) => {
        const amount = (Number(it.qty) || 0) * (Number(it.unit_price) || 0);
        subtotal += amount;
        const words = it.description.split(" ");
        let cur = "";
        const rowsTxt: string[] = [];
        words.forEach((w) => { if ((cur + " " + w).trim().length > 55) { rowsTxt.push(cur.trim()); cur = w; } else cur += " " + w; });
        if (cur.trim()) rowsTxt.push(cur.trim());
        rowsTxt.forEach((rt, i2) => {
          page.drawText(rt, { x: L, y, size: 9.5, font: helv });
          if (i2 === 0) {
            page.drawText(String(it.qty), { x: 350, y, size: 9.5, font: helv });
            page.drawText(it.unit, { x: 395, y, size: 9.5, font: helv });
            page.drawText(Number(it.unit_price).toFixed(2), { x: 440, y, size: 9.5, font: helv });
            page.drawText(amount.toFixed(2), { x: 515, y, size: 9.5, font: helv });
          }
          y -= 13;
        });
        y -= 2;
      });
      y -= 4; line(L, R, y + 8);
      const taxAmt = subtotal * taxRate(j) / 100;
      page.drawText("Subtotal:", { x: 440, y: y - 6, size: 10, font: bold });
      page.drawText(subtotal.toFixed(2), { x: 515, y: y - 6, size: 10, font: helv }); y -= 15;
      page.drawText(`Tax (${taxRate(j)}%):`, { x: 440, y: y - 6, size: 10, font: bold });
      page.drawText(taxAmt.toFixed(2), { x: 515, y: y - 6, size: 10, font: helv }); y -= 16;
      page.drawText("Total Due:", { x: 440, y: y - 6, size: 11, font: bold });
      page.drawText(`$${(subtotal + taxAmt).toFixed(2)}`, { x: 515, y: y - 6, size: 11, font: bold }); y -= 30;
      page.drawText("Please make all checks payable to " + (org.company || "").toUpperCase() + ".", { x: L, y, size: 9, font: helv }); y -= 12;
      page.drawText("Thank you for your business!", { x: L, y, size: 9, font: helv });
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
      const out = await pkg.save();
      const blob = new Blob([out.buffer as ArrayBuffer], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const aEl = document.createElement("a");
      const fname = askFileName(`package_PO${j.po_number || j.job_number || ""}.pdf`);
      if (!fname) { URL.revokeObjectURL(url); setBusy(false); return; }
      aEl.href = url; aEl.download = fname; aEl.click();
      URL.revokeObjectURL(url);
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
    ["APPROVED", j.approved], ["WORK", j.work_done], ["INV", !!j.invoice_sent], ["PAID", j.received],
  ];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-display text-2xl font-bold uppercase">PACT</div>
        {canEdit && (
        <div className="flex gap-2">
          <button className="btn btn-primary" onClick={() => poRef.current?.click()} disabled={busy}>+ Upload PO (PDF)</button>
          <button className="btn btn-ghost" onClick={() => setAddOpen(!addOpen)}>+ Manual job</button>
        </div>
        )}
      </div>
      <input ref={poRef} type="file" accept="application/pdf" className="hidden" onChange={handlePo} />

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
                      {j.invoice_sent && !j.received && <span className="ml-1 font-mono text-[10px] text-inksoft">{days(j.invoice_sent)}d out</span>}
                    </div>
                  );
                })()}
              </button>
              <div className="flex shrink-0 items-center gap-2">
                {canInvoice && <span className="font-mono text-sm font-semibold">{fmt(Number(j.amount) || invTotal(j))}</span>}
                <button className="text-inksoft" title="Documents & photos" onClick={() => setAttachJob(j)}>📎{(j.attachments || []).length > 0 ? <span className="font-mono text-[10px]">{(j.attachments || []).length}</span> : null}</button>
                {canEdit && <button className={j.canceled ? "text-ok" : "text-alert"} title={j.canceled ? "Restore" : "Cancel job"} onClick={() => patch(j, { canceled: !j.canceled })}>{j.canceled ? "↺" : "✕"}</button>}
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
                    <button className="btn btn-ghost px-3 py-1.5 text-[13px]" onClick={() => setAttachJob(j)}>View photos & files</button>
                  )}
                  {canInvoice && <button className="btn px-3 py-1.5 text-[13px]" onClick={() => setInvJob(j)}>Invoice</button>}
                  {canInvoice && <button className="btn btn-primary px-3 py-1.5 text-[13px]" onClick={() => buildPackage(j)} disabled={busy}>📦 Package</button>}
                </div>
                {canEdit && (
                <div className="mb-2.5 flex flex-wrap gap-2">
                  <button onClick={() => patch(j, { approved: !j.approved })}><Stamp label={j.approved ? "APPROVED ✓" : "MARK APPROVED"} tone={j.approved ? "ok" : "mute"} /></button>
                  <button onClick={() => patch(j, { work_done: !j.work_done })}><Stamp label={j.work_done ? "WORK DONE ✓" : "MARK WORK DONE"} tone={j.work_done ? "ok" : "mute"} /></button>
                  <button onClick={() => patch(j, j.received ? { received: false, paid_date: null } : { received: true, paid_date: today() })}><Stamp label={j.received ? `PAID ${prettyDate(j.paid_date)}` : "MARK PAID"} tone={j.received ? "ok" : "work"} /></button>
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
                {/* the PO seeds one line — add more here when the job runs past what's listed (excess materials etc.) */}
                <div className="mt-3">
                  <div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Work lines</div>
                  {!canEdit && itemsOf(j).map((it, i) => (
                    <div key={i} className="mb-1 flex flex-wrap items-center gap-2 text-[13px]">
                      <span className="flex-1">{it.description || "—"}</span>
                      <span className="font-mono text-inksoft">{it.qty} {it.unit}</span>
                    </div>
                  ))}
                  {!canEdit && itemsOf(j).length === 0 && <div className="text-xs text-inksoft">No lines yet.</div>}
                  {canEdit && itemsOf(j).map((it, i) => (
                    <div key={i} className="mb-1.5 flex flex-wrap items-center gap-1.5">
                      <input className="field min-w-[160px] flex-1" placeholder="Line description (unit picks itself — door, plaster, paint…)" value={it.description}
                        onChange={(e) => {
                          const next = [...itemsOf(j)];
                          const auto = unitFor(e.target.value);
                          next[i] = { ...it, description: e.target.value, unit: it.unit === unitFor(it.description) || !it.unit ? auto : it.unit };
                          setItems(j, next);
                        }}
                        onBlur={() => setItems(j, itemsOf(j), true)} />
                      <input className="field w-16 px-2 py-1.5 text-right font-mono" inputMode="decimal" title="Qty"
                        {...num(`${j.id}:wl${i}:q`, Number(it.qty) || 0,
                          (n) => { const next = [...itemsOf(j)]; next[i] = { ...next[i], qty: n }; setItems(j, next); },
                          (n) => { const next = [...itemsOf(j)]; next[i] = { ...next[i], qty: n }; setItems(j, next, true); })} />
                      <input className="field w-16 px-2 py-1.5 text-center font-mono" title="Unit" value={it.unit}
                        onChange={(e) => { const next = [...itemsOf(j)]; next[i] = { ...it, unit: e.target.value }; setItems(j, next); }}
                        onBlur={() => setItems(j, itemsOf(j), true)} />
                      {canInvoice && (
                        <input className="field w-20 px-2 py-1.5 text-right font-mono" inputMode="decimal" title="Unit price"
                          {...num(`${j.id}:wl${i}:p`, Number(it.unit_price) || 0,
                            (n) => { const next = [...itemsOf(j)]; next[i] = { ...next[i], unit_price: n }; setItems(j, next); },
                            (n) => { const next = [...itemsOf(j)]; next[i] = { ...next[i], unit_price: n }; setItems(j, next, true); })} />
                      )}
                      {canInvoice && <span className="w-20 text-right font-mono text-[12px]">{fmt((Number(it.qty) || 0) * (Number(it.unit_price) || 0))}</span>}
                      <button className="text-alert" title="Remove line" onClick={() => setItems(j, itemsOf(j).filter((_, x) => x !== i), true)}>✕</button>
                    </div>
                  ))}
                  {canEdit && <button className="btn btn-ghost px-3 py-1.5 text-[13px]" onClick={() => setItems(j, [...itemsOf(j), { description: "", qty: 1, unit: "EACH", unit_price: 0 }], true)}>+ Add line</button>}
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
                  <input className="field" value={j.invoice_number || ""} onChange={(e) => patch(j, { invoice_number: e.target.value })} /></div>
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
                <button className="btn btn-primary" onClick={() => { setInvJob(null); buildPackage(j); }} disabled={busy}>📦 Download package</button>
                <button className="btn btn-ghost" onClick={() => setInvJob(null)}>Done</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ---------- documents & photos ---------- */}
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
