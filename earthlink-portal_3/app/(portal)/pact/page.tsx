"use client";
import { useEffect, useRef, useState } from "react";
import { matches } from "@/lib/search";
import Link from "next/link";
// pdf-lib is heavy — loaded only when a package PDF is actually built
import { sb } from "@/lib/supabase";
import { myProfile } from "@/lib/profile";
import { fmt, parseNum, askFileName } from "@/lib/format";
import { prettyDate, localISO, type Org } from "@/lib/docs";
import Stamp from "@/components/Stamp";
import PrintShell from "@/components/PrintShell";
import { RowActions } from "@/components/ActionMenu";
import PageHeader from "@/components/PageHeader";
import CardToolbar from "@/components/CardToolbar";
import Modal from "@/components/Modal";
import Disclosure from "@/components/Disclosure";
import MeasurePanel from "@/components/MeasurePanel";
import WorkLines from "@/components/WorkLines";
import Letterhead from "@/components/Letterhead";
import Toast, { useFlash } from "@/components/Toast";
import { scrollTo } from "@/lib/motion";
import { applyMeasure } from "@/lib/measure";
import { useLive } from "@/lib/useLive";
import { findDupe, DUPE_COLS } from "@/lib/po";
import { INVOICE_FLOOR, insertJob, subtotalOf, intakePoFile, claimInvoiceNo, noMoney } from "@/lib/pactIntake";
import { COMPANY } from "@/lib/company";
import { useNumBuffer } from "@/lib/numBuffer";
import { shrinkImage } from "@/lib/shrinkImage";
import { parsePactPoText, type PactPoFields, type PoItem } from "@/lib/parsePactPo";
import { priceLinesFor, soleKey, keysIn, normUnit, loadPrices, attnFrom, DEFAULT_ATTN, type PriceItem, cleanLineWording, unitFor, mergePricedLines, linesFromPoRead, PRICE_BOOK } from "@/lib/priceBook";

// `base` is a PO row's wording before its wrapped line was added — a wrap can
// name a second trade ("…and paint"), and then the row no longer reads as the
// one price-list line it is. Kept so the list still recognises it.
interface Item { description: string; qty: number; unit: string; unit_price: number; key?: string; base?: string; }
interface Job {
  id: string; partner: string; development: string; job_number: string; description: string;
  amount: number; approved: boolean; work_done: boolean; invoice_sent: string | null;
  received: boolean; paid_date: string | null; canceled: boolean;
  attachments?: { name: string; path: string }[] | null; notes: string; created_at: string;
  po_number?: string; po_date?: string; address?: string; property_unit?: string;
  contact?: string; bill_to?: string; items?: Item[] | null; invoice_number?: string; tax_pct?: number | null;
  proposal_sent?: string | null;
  start_date?: string | null; finish_date?: string | null;
  // RUN_ME section 15: the auto lines' subtotal at upload, and whether the
  // lines have since been priced for real (the calendar drops priced jobs)
  list_subtotal?: number | null; priced?: boolean | null;
}
const BLANK = { partner: "", development: "", job_number: "", description: "", amount: "" };

export default function Pact() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [org, setOrg] = useState<Org | null>(null);
  // Admin 1 (admin) sees everything. Admin 2 (office) works the field side —
  // POs in, photos, square feet — and never sees a price, an amount, an
  // invoice or a proposal. Accountants can look but not edit.
  const [role, setRole] = useState("");
  const canInvoice = role === "admin";
  const canEdit = role === "admin" || role === "office";
  // prices, totals and the sales tax are Admin 1's alone
  const canPrice = role === "admin";
  const [q, setQ] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState({ ...BLANK });
  const [openId, setOpenId] = useState<string | null>(null);
  const [attachJob, setAttachJob] = useState<Job | null>(null);
  const [lightbox, setLightbox] = useState<{ name: string; path: string } | null>(null); // a photo opened big from the Documents dialog
  const [measureJob, setMeasureJob] = useState<Job | null>(null); // "Sq ft from photos" is open for this job
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [invJob, setInvJob] = useState<Job | null>(null);
  // which jobs show their details panel — per job, so opening one job's
  // details never flips another's, and closing a job doesn't forget it
  const [detailsOpen, setDetailsOpen] = useState<Record<string, boolean>>({});
  const showDetailsFor = (id: string) => setDetailsOpen((p) => ({ ...p, [id]: true }));
  // a row opens and closes from its title. The card is brought into view when
  // its body would run off the bottom of the phone, and back when it closes.
  const toggleOpen = (j: Job) => {
    const card = () => document.querySelector(`[data-job-card="${j.id}"]`);
    if (openId === j.id) {
      (document.activeElement as HTMLElement | null)?.blur?.();
      setOpenId(null);
      requestAnimationFrame(() => scrollTo(card(), "nearest"));
      return;
    }
    setOpenId(j.id);
    setTimeout(() => {
      const el = card();
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.bottom > window.innerHeight) scrollTo(el, r.height > window.innerHeight ? "start" : "nearest");
    }, 60);
  };
  // a stamp's date, short: the year is on the job, not in a list
  const shortDay = (iso?: string | null) => (iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");
  const [busy, setBusy] = useState(false);
  // the first fetch: skeleton rows until it answers, the empty words only after
  const [loaded, setLoaded] = useState(false);
  const { msg, flash, progress, setProgress, action, flashWithUndo } = useFlash();
  const fileRef = useRef<HTMLInputElement>(null);
  // one camera input serves every job card — snapPhotos aims it first
  const photoRef = useRef<HTMLInputElement>(null);
  const [photoTarget, setPhotoTarget] = useState<{ id: string; kind: "before" | "after" } | null>(null);
  const snapPhotos = (j: Job, kind: "before" | "after") => { setPhotoTarget({ id: j.id, kind }); photoRef.current?.click(); };
  const poRef = useRef<HTMLInputElement>(null);
  const num = useNumBuffer();
  // what the office reads when a save fails: never the database's own words
  // or a file path (the console keeps those)
  const upgradeHint = (m: string, what = "Couldn't save") => {
    console.warn(m);
    if (/proposal_sent/i.test(m)) return "Proposals sent can't be tracked until the database update is run (Settings → System check)";
    if (/relation|column|schema/i.test(m)) return "This can't be saved until the database update is run (Settings → System check)";
    return `${what}. Check your signal and try again.`;
  };
  const today = () => localISO();
  const isImg = (n: string) => /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(n);
  const itemsOf = (j: Job): Item[] => (Array.isArray(j.items) ? j.items : []);
  // a job with a line to bill — an invoice number is only ever given out for one of these
  const hasLines = (j: Job) => cleanLineWording(itemsOf(j)).items.some((it) => Number(it.qty) > 0 && it.description.trim());
  const atFocus = useRef(""); // what a text box held when it was tapped into — a blur that changed nothing writes nothing
  // the job's short name: the street and the apartment, nothing else. The
  // borough, the state and the zip are on the invoice, not in a list you
  // scroll on a phone.
  const shortSite = (j: Job): string => {
    const street = (j.address || "").split(",")[0].replace(/\s{2,}/g, " ").trim();
    const apt = j.property_unit ? `Apt ${j.property_unit}` : "";
    return [street || j.development || j.partner, apt].filter(Boolean).join(" · ");
  };
  // and its short description: the first thing it says, not the whole scope
  const shortWork = (j: Job): string => {
    const d = (j.description || "").replace(/\s+/g, " ").trim();
    // (no regex lookbehind — Safari before 16.4 fails to load the whole page on it)
    const first = (d.match(/^[^.;]*[.;]?/)?.[0] || d).trim() || d;
    return first.length > 90 ? `${first.slice(0, 90).trim()}…` : first;
  };
  // private work is taxable — NYC sales tax by default, editable per job
  const taxRate = (j: Job) => (j.tax_pct === null || j.tax_pct === undefined ? 8.875 : Number(j.tax_pct));
  const invSubtotal = (j: Job) => itemsOf(j).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);
  const invTax = (j: Job) => invSubtotal(j) * taxRate(j) / 100;
  const invTotal = (j: Job) => invSubtotal(j) + invTax(j);

  const load = async () => {
    const { data, error } = await sb().from("pact_jobs").select("*").order("created_at", { ascending: false });
    setLoaded(true);
    if (error) { flash(upgradeHint(error.message, "Couldn't load the POs")); return; }
    setJobs((data || []) as Job[]);
  };
  useEffect(() => {
    load();
    sb().from("org").select("*").single().then(({ data }) => data && setOrg(data as Org));
    myProfile().then((p) => setRole(p?.role || ""));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // ?job=<id> (the "Open the job" button on a From-the-crew notice): that job, open and in view
  const jobParamDone = useRef(false);
  useEffect(() => {
    if (jobParamDone.current || jobs.length === 0 || !role) return;
    jobParamDone.current = true;
    const id = new URLSearchParams(window.location.search).get("job") || "";
    if (!id || !jobs.some((j) => j.id === id)) return;
    setOpenId(id);
    showDetailsFor(id);
    setTimeout(() => scrollTo(document.querySelector(`[data-job-card="${id}"]`), "center"), 250);
  }, [jobs, role]); // eslint-disable-line react-hooks/exhaustive-deps

  // live: PACT jobs changing anywhere refresh the list without a reload
  useLive(["pact_jobs"], () => load(), { skipWhileTyping: true });

  // invoice numbers, the job insert and the PO reader live in lib/pactIntake —
  // the Schedule tab takes POs in through the same door
  const patch = async (j: Job, p: Partial<Job>) => {
    setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, ...p } : x)));
    setInvJob((prev) => (prev && prev.id === j.id ? { ...prev, ...p } : prev));
    let { error } = await sb().from("pact_jobs").update(p).eq("id", j.id);
    if (error && "list_subtotal" in p && /list_subtotal/i.test(error.message)) { // before RUN_ME section 15
      const { list_subtotal: _skip, ...rest } = p; void _skip;
      ({ error } = await sb().from("pact_jobs").update(rest).eq("id", j.id));
    }
    if (error) { flash(upgradeHint(error.message)); load(); }
  };

  // delete = gone for good (after a confirm) — the job, its photos and documents
  const deleteJob = async (j: Job) => {
    const label = [j.po_number || j.job_number, j.partner].filter(Boolean).join(" · ");
    if (!window.confirm(`Delete PO ${label}? The job and its photos/documents disappear for good. This can't be undone.`)) return;
    await deleteJobNow(j);
  };
  const deleteJobNow = async (j: Job): Promise<boolean> => {
    // the row goes first — if its delete fails the files are untouched; and the
    // file list comes fresh from the database, not this device's possibly-stale copy
    const { data: freshRow } = await sb().from("pact_jobs").select("attachments").eq("id", j.id).single();
    const paths = (((freshRow as { attachments?: { path: string }[] } | null)?.attachments) || j.attachments || []).map((a) => a.path);
    const { error } = await sb().from("pact_jobs").delete().eq("id", j.id);
    if (error) { flash(upgradeHint(error.message)); return false; }
    // its crew comes off the Schedule too (the database cascades this once
    // RUN_ME section 14 is in; before that the column isn't there — ignored)
    await sb().from("schedule_days").delete().eq("pact_job_id", j.id);
    let cleanupFailed = false;
    if (paths.length > 0) {
      const { error: se } = await sb().storage.from("docs").remove(paths);
      cleanupFailed = !!se;
    }
    if (openId === j.id) setOpenId(null);
    if (attachJob?.id === j.id) setAttachJob(null);
    if (invJob?.id === j.id) setInvJob(null);
    setJobs((prev) => prev.filter((x) => x.id !== j.id));
    flash(cleanupFailed ? "PO deleted. Some of its files couldn't be cleaned up, so they still count toward storage." : "PO deleted");
    return true;
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
  // who proposals are addressed to, as set in Settings — a partner's PO prints
  // their office, not the person at it
  const [attnSaved, setAttnSaved] = useState<{ name: string; title: string }>(DEFAULT_ATTN);
  useEffect(() => { loadPrices().then(({ store, ok }) => { if (ok) setAttnSaved(attnFrom(store)); }).catch(() => null); }, []);
  // Their partner's purchase orders price every line at $1.00 — that is the
  // form's placeholder, not an agreement. A dollar is not a price.
  const PLACEHOLDER = 1;
  const realPrice = (n: unknown) => Number(n) > PLACEHOLDER;
  // "8G" is an apartment; "13-02" and "0807-08G" are the partner's own property
  // codes, and calling one of those an apartment on a letter is just wrong
  const isPropertyCode = (v: string) => /^\d+\s*-\s*\w+$/.test(v);
  const unitLabel = (u: string) => {
    const v = (u || "").trim();
    if (!v) return "";
    return `${isPropertyCode(v) ? "Unit" : "Apartment"} ${v.toUpperCase()}`;
  };
  const aptOnly = (u: string) => {
    const v = (u || "").trim();
    return !v || isPropertyCode(v) ? "" : `Apartment ${v.toUpperCase()}`;
  };
  // the person the PO names at the office, if it names one at all
  const poPerson = (j: Job) => {
    const seg = (j.contact || "").split("·").map((x) => x.trim());
    const named = seg[0] && !/\d[\d\s().-]{6,}/.test(seg[0]) ? seg[0] : "";
    return { name: named, title: named ? seg[1] || "" : "" };
  };
  const priceBook = async (): Promise<PriceItem[]> => {
    if (book && Date.now() - book.at < 30_000) return book.items;
    const { items, ok, store } = await loadPrices();
    if (ok) setAttnSaved(attnFrom(store));
    if (!ok) {
      // the saved list couldn't be read: say so rather than quietly pricing
      // from the standard sheet with their own line items missing
      flash("Couldn't read your saved line items. Using the standard sheet, so check the prices before sending anything.");
      if (book) return book.items; // the last good copy beats the fallback
      return items;
    }
    setBook({ items, at: Date.now() });
    return items;
  };

  // Work lines for this text, from the price list. Anything the PO already
  // priced stays exactly as the PO wrote it — the list only fills the gaps,
  // and work the PO named in its own words never gets a second copy beside it.
  // the merge itself lives in lib/priceBook.ts so the email intake prices a
  // PO the same way the phone does
  const priceFromList = async (text: string, existing: Item[], opts: { bundle?: boolean; refresh?: boolean; fillOnly?: boolean; prepOnly?: boolean } = {}): Promise<Item[]> =>
    mergePricedLines(text, existing, await priceBook(), opts) as Item[];

  // "Price from list" on a job already here
  const fillFromList = async (j: Job, auto = false) => {
    if (!auto) setBusy(true);
    try {
      // Price against the database's copy, never this page's. A tab that sat
      // open while the other admin entered lines holds an old array — saving
      // from it would wipe their work, which is exactly what happened once.
      const { data: liveRow } = await sb().from("pact_jobs").select("items,description,tax_pct").eq("id", j.id).single();
      const live = liveRow ? { ...j, ...(liveRow as Partial<Job>) } : j;
      const before = itemsOf(live);
      // What gets priced: the PO's words PLUS every line a person typed in by
      // hand — Admin 2 writing "Plaster" over 130 SF is asking for the plaster
      // job, primer and paint included, and that stays true when someone
      // typed the $6 in themselves. Only lines the portal itself wrote (they
      // carry a key) stay out, so "Primer" can never read as a fresh painting
      // order. A priced line's own PRICE is never changed by this — see the
      // merge — only its wording and what belongs beside it.
      const typed = before
        .filter((it) => !it.key && it.description.trim())
        .map((it) => it.description);
      const text = [live.description || "", ...typed].filter(Boolean).join(". ");
      // the lines as they are, priced — never a line's unit or quantity changed
      // here: a job someone entered by hand stays the way they entered it (the
      // by-the-room rules run when a PO is first read in, lib/priceBook linesFromPoRead)
      const next = await priceFromList(text, before, { refresh: true });
      const added = next.length - before.length;
      const changed = next.filter((n, i) => i < before.length && (n.unit_price !== before[i].unit_price || n.description !== before[i].description)).length;
      if (added === 0 && changed === 0) {
        if (!auto) flash("Already matching the price list. Nothing to change.");
        return;
      }
      setItems(live, next, true, auto);
      flash(auto
        ? "Priced off the quantities on the job. Check the lines before invoicing."
        : [added > 0 ? `${added} line${added === 1 ? "" : "s"} added` : "", changed > 0 ? `${changed} re-priced` : ""]
            .filter(Boolean).join(" · ") + " from the price list. Check them before invoicing.");
    } finally { if (!auto) setBusy(false); }
  };

  // Opening a job pulls its CURRENT row before anything else happens — a page
  // that sat open on one phone while the other admin worked holds yesterday's
  // lines, and any save from that copy would erase today's. Once the fresh
  // row is in hand: Admin 2 entered the square feet out in the field, so for
  // Admin 1 the prices fill themselves in from the list — no button to
  // remember. A line that already carries a real price is never touched.
  const autoPriced = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!openId) return;
    let closed = false;
    (async () => {
      const { data } = await sb().from("pact_jobs").select("*").eq("id", openId).single();
      if (closed || !data) return;
      let fresh = data as Job;
      // old wording on the lines heals here, against the row just fetched —
      // so the jobs already in the portal pick up the cleanup one by one
      // even before RUN_ME.sql sweeps the rest
      const cleaned = cleanLineWording(itemsOf(fresh));
      if (cleaned.changed && (role === "admin" || role === "office")) {
        fresh = { ...fresh, items: cleaned.items };
        sb().from("pact_jobs").update({ items: cleaned.items }).eq("id", fresh.id).then(() => null);
      }
      setJobs((prev) => prev.map((x) => (x.id === openId ? { ...x, ...fresh } : x)));
      if (role !== "admin" || autoPriced.current.has(openId)) return;
      const needs = itemsOf(fresh).some((it) => Number(it.qty) > 0 && it.description.trim() && !realPrice(it.unit_price));
      if (!needs) return;
      autoPriced.current.add(openId);
      await fillFromList(fresh, true);
    })();
    return () => { closed = true; };
  }, [openId, role]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- test POs: three jobs to try the whole flow on, gone in one tap ----------
  // Marked in their notes and partner, so "Delete test POs" finds exactly
  // them and nothing else. Their lines come from the price list the way a
  // read-in PO's would: plaster by the square foot with its primer and paint
  // by the room, baseboard by the linear foot, an apartment at the apartment price.
  const TEST_MARK = "🧪 Test PO";
  const isTestJob = (j: Job) => (j.notes || "").includes(TEST_MARK) || (j.partner || "").startsWith("TEST ");
  const addTestPos = async () => {
    if (!canPrice) return;
    setBusy(true);
    try {
      const bk = await priceBook();
      const day = today();
      const samples = [
        { po: "900001", address: "908 Ashford St, Brooklyn, NY 11207", apt: "4D", description: "Wall cracking: bedroom wall scrape plaster paint, bathroom wall scrape plaster paint", extra: [] as Item[] },
        { po: "900002", address: "2156 Linden Blvd, Brooklyn, NY 11207", apt: "12D", description: "Remove existing baseboard throughout the apartment and install new; prime and paint the kitchen and hallway", extra: [{ description: "Remove and replace baseboard", qty: 1, unit: "LF", unit_price: 0 }] as Item[] },
        { po: "900003", address: "1355 E 18th St, Brooklyn, NY 11230", apt: "5M", description: "Paint 2 bedroom 1 bath apartment", extra: [] as Item[] },
      ];
      let made = 0;
      for (const t of samples) {
        if (jobs.some((j) => (j.po_number || j.job_number) === t.po)) continue;
        const lines = [...t.extra, ...(priceLinesFor(t.description, { book: bk }) as Item[])];
        const sub = lines.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);
        const { data, error } = await insertJob({
          partner: "TEST Boulevard", development: "", job_number: t.po, po_number: t.po, description: t.description, address: t.address, property_unit: t.apt,
          start_date: day, items: lines, amount: Math.round(sub * 1.08875 * 100) / 100, list_subtotal: sub,
          notes: `${TEST_MARK} made ${prettyDate(day)} to try the portal on: put a crew on it, text them, send photos, then tap "Delete test POs" on Billing`,
        });
        if (error || !data) { flash(upgradeHint(error?.message || "", "Couldn't make the test POs")); break; }
        made += 1;
      }
      if (made) { await load(); flash(`${made} test PO${made === 1 ? "" : "s"} added (900001 to 900003, today). Put a crew on them from the PACT Schedule; Delete test POs takes them off.`); }
      else flash("The test POs are already here (900001 to 900003)");
    } finally { setBusy(false); }
  };
  const deleteTestPos = async () => {
    const mine = jobs.filter(isTestJob);
    if (!mine.length) { flash("No test POs here"); return; }
    if (!window.confirm(`Delete the ${mine.length} test PO${mine.length === 1 ? "" : "s"} (${mine.map((j) => j.po_number || j.job_number).join(", ")}) with their photos, documents and crew? Nothing else is touched.`)) return;
    setBusy(true);
    try { for (const j of mine) await deleteJobNow(j); } finally { setBusy(false); }
  };

  // a paper the portal made, filed on the job — never merged back into a package, never re-read as the PO
  const isMade = (a: { path?: string; name?: string }) => /\/made\//.test(a.path || "");

  // ---------- the job's photos as one PDF to send ----------
  const makePhotoPdf = async (j: Job) => {
    const imgs = (j.attachments || []).filter((a) => isImg(a.name));
    if (imgs.length === 0) { flash("No photos on this job yet"); return; }
    setBusy(true);
    try {
      const { data, error } = await sb().storage.from("docs").createSignedUrls(imgs.map((a) => a.path), 600);
      if (error || !data) throw new Error(error?.message || "couldn't reach the photos");
      const photos: { name: string; bytes: Uint8Array; type?: string }[] = [];
      const missed: string[] = [];
      for (const a of imgs) {
        const url = data.find((d) => d.path === a.path)?.signedUrl;
        const res = url ? await fetch(url).catch(() => null) : null;
        if (!res || !res.ok) { missed.push(a.name); continue; }
        // The browser redraws each picture before it goes in: that bakes the
        // phone's orientation into the pixels (pdf-lib ignores the EXIF tag, so
        // a portrait shot would print sideways), turns HEIC, WEBP or GIF into a
        // JPEG where the browser can read them, and shrinks a multi-MB original
        // so the phone holds one small copy of each instead of several large ones.
        // What the browser can't read stays as it came; the PDF names it.
        const raw = await res.blob();
        const pic = await shrinkImage(new File([raw], a.name, { type: raw.type }), 1400, 0.72, true);
        photos.push({ name: a.name, bytes: new Uint8Array(await pic.arrayBuffer()), type: pic.type || res.headers.get("content-type") || undefined });
      }
      if (photos.length === 0) throw new Error("none of the photos would download");
      const { buildPhotoPdf, photoPdfName } = await import("@/lib/photoPdf");
      const job = { po: j.po_number || j.job_number || "", partner: j.partner || "", address: j.address || "", apt: j.property_unit || "", description: j.description || "", date: prettyDate(today()) };
      const made = await buildPhotoPdf(job, photos, await logoBytes());
      photos.length = 0; // the pictures are in the PDF now; let the phone free them
      // one Blob of the PDF serves both the download and the copy kept on the job
      const b = made.bytes;
      const pdf = new Blob([b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? (b.buffer as ArrayBuffer) : (b.slice().buffer as ArrayBuffer)], { type: "application/pdf" });
      const name = photoPdfName(job);
      saveBytes(pdf, name, "application/pdf");
      const kept = await keepOnJob(j, pdf, name, "application/pdf");
      const left = [...missed, ...made.skipped];
      const pages = `${made.pages} page${made.pages === 1 ? "" : "s"}`;
      const names = left.length ? ` · ${left.length} picture${left.length === 1 ? "" : "s"} couldn't go in: ${left.slice(0, 3).join(", ")}${left.length > 3 ? ` and ${left.length - 3} more` : ""}` : "";
      flash(kept ? `Photos PDF saved (${pages}) · a copy is kept on the job${names}` : `Photos PDF downloaded (${pages}) · the copy couldn't be kept on the job${names}`);
    } catch (err) {
      flash(`Couldn't build the photos PDF (${err instanceof Error ? err.message.slice(0, 80) : "unknown"})`);
    } finally { setBusy(false); }
  };

  // ---------- the proposal letter ----------
  const logoBytes = async (): Promise<Uint8Array | undefined> => {
    try {
      const r = await fetch("/logo.png");
      return r.ok ? new Uint8Array(await r.arrayBuffer()) : undefined;
    } catch { return undefined; }
  };

  // bytes, or a Blob already made of them (the photos PDF hands the same one to keepOnJob)
  const saveBytes = (bytes: Uint8Array | Blob, name: string, type: string) => {
    let blob: Blob;
    if (bytes instanceof Blob) blob = bytes;
    else { const ab = new ArrayBuffer(bytes.byteLength); new Uint8Array(ab).set(bytes); blob = new Blob([ab], { type }); }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  // the job's proposal letter — the same shape the reader here understands,
  // so a signed copy coming back makes the invoice without retyping anything
  // everything the proposal letter says, for the view and the file alike
  const proposalFields = async (j: Job) => {
    let lines = cleanLineWording(itemsOf(j)).items
      .filter((it) => it.description.trim() && Number(it.qty) > 0)
      .map((it) => ({ description: it.description, qty: Number(it.qty), unit: it.unit, unit_price: Number(it.unit_price) || 0 }));
    if (lines.length === 0) {
      const seeded = await priceFromList(j.description || "", []);
      lines = seeded.map((it) => ({ description: it.description, qty: Number(it.qty) || 1, unit: it.unit, unit_price: Number(it.unit_price) || 0 }));
    }
    return {
      poNumber: j.po_number || j.job_number || "",
      date: prettyDate(today()),
      // whoever the PO named at the office, otherwise whoever Settings says
      // these go to. A "Contact info" name with a phone beside it is the super
      // who lets the crew in — not who a proposal is addressed to.
      attn: poPerson(j).name || attnSaved.name || "",
      attnTitle: poPerson(j).name ? poPerson(j).title : attnSaved.title || "",
      // the partner's office, the way their own letters print it: the address
      // on one line, with no company name above it — the letter is going TO a
      // person, and the company is named on the purchase order already
      billTo: (() => {
        const seen = new Set<string>();
        const same = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]/g, "") === b.toLowerCase().replace(/[^a-z0-9]/g, "");
        const attnName = (j.contact || "").split("·")[0].replace(/\s*\d[\d\s().-]{6,}$/, "").trim();
        const attnRole = (j.contact || "").split("·")[1]?.trim() || "";
        const parts = (j.bill_to || "").split(/,\s*/).map((x) => (x || "").trim()).filter(Boolean)
          .filter((x) => !same(x, j.partner || "") && !same(x, attnName) && !same(x, attnRole))
          .filter((x) => { const k = x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
        return parts.length > 0 ? [parts.join(", ")] : [];
      })(),
      // their own letters print the street and the apartment. The partner's
      // property code ("13-02") is their internal filing, not part of an address
      serviceAddress: [j.address, aptOnly(j.property_unit || "")].filter(Boolean).join(", "),
      lines,
      taxPct: taxRate(j),
    };
  };

  const proposalBytes = async (j: Job): Promise<{ bytes: Uint8Array; name: string } | null> => {
    const { buildProposalDocx, proposalFileName } = await import("@/lib/proposalDoc");
    const fields = await proposalFields(j);
    // a letter with nothing priced on it isn't a proposal
    if (!fields.lines.some((l) => l.description.trim() && l.qty > 0 && l.unit_price > 0)) return null;
    return { bytes: buildProposalDocx(fields, await logoBytes()), name: proposalFileName(fields) };
  };

  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  // The proposal as a PDF — what actually gets sent. It looks the same wherever
  // it is opened, and a signed copy still reads straight back in here.
  const proposalPdfBytes = async (j: Job): Promise<{ bytes: Uint8Array; name: string } | null> => {
    const { buildProposalPdf, proposalPdfName } = await import("@/lib/proposalPdf");
    const fields = await proposalFields(j);
    if (!fields.lines.some((l) => l.description.trim() && l.qty > 0 && l.unit_price > 0)) return null;
    return { bytes: await buildProposalPdf(fields, await logoBytes()), name: proposalPdfName(fields) };
  };

  const makeProposalPdf = async (j: Job) => {
    setBusy(true);
    try {
      const made = await proposalPdfBytes(j);
      if (!made) { flash("Nothing priced on this job yet: fill the work lines in first"); return; }
      const { bytes, name: def } = made;
      const name = askFileName(def);
      if (!name) return;
      saveBytes(bytes, name, "application/pdf");
      await keepOnJob(j, bytes, def, "application/pdf");
      await stampProposalSent(j);
      flash("Proposal saved as a PDF. A copy is kept on the job, and the signed one reads straight back in here.");
    } catch (err) {
      flash(`Couldn't build the proposal (${err instanceof Error ? err.message.slice(0, 60) : "unknown"})`);
    } finally { setBusy(false); }
  };

  const makeProposal = async (j: Job) => {
    setBusy(true);
    try {
      const made = await proposalBytes(j);
      if (!made) { flash("Nothing priced on this job yet: fill the work lines in first"); return; }
      const { bytes, name: def } = made;
      const name = askFileName(def);
      if (!name) return;
      saveBytes(bytes, name, DOCX);
      await keepOnJob(j, bytes, def, DOCX);
      await stampProposalSent(j);
      flash("Proposal saved. A copy is kept on the job, and the signed one reads straight back in here.");
    } catch (err) {
      flash(`Couldn't build the proposal (${err instanceof Error ? err.message.slice(0, 60) : "unknown"})`);
    } finally { setBusy(false); }
  };

  // One PO in, both papers out: the proposal to send now and the invoice for
  // when the work is done. Each saves on its own tap so no browser blocks the
  // second file, and "both" saves them back to back.
  // the one-shot card saves straight off — no name to type, same as the invoice
  const saveProposalPdfFor = async (j: Job, quiet = false): Promise<boolean> => {
    if (!quiet) setBusy(true);
    try {
      const made = await proposalPdfBytes(j);
      if (!made) { flash("Nothing priced on this job yet: fill the work lines in first"); return false; }
      const { bytes, name } = made;
      saveBytes(bytes, name, "application/pdf");
      await keepOnJob(j, bytes, name, "application/pdf");
      await stampProposalSent(j);
      if (!quiet) flash("Proposal saved as a PDF. A copy is kept on the job.");
      return true;
    } catch (err) {
      flash(`Couldn't build the proposal (${err instanceof Error ? err.message.slice(0, 60) : "unknown"})`);
      return false;
    } finally { if (!quiet) setBusy(false); }
  };

  const saveProposalFor = async (j: Job, quiet = false): Promise<boolean> => {
    if (!quiet) setBusy(true);
    try {
      const made = await proposalBytes(j);
      if (!made) { flash("Nothing priced on this job yet: fill the work lines in first"); return false; }
      const { bytes, name } = made;
      saveBytes(bytes, name, DOCX);
      await keepOnJob(j, bytes, name, DOCX);
      await stampProposalSent(j);
      if (!quiet) flash("Proposal saved. A copy is kept on the job.");
      return true;
    } catch (err) {
      flash(`Couldn't build the proposal (${err instanceof Error ? err.message.slice(0, 60) : "unknown"})`);
      return false;
    } finally { if (!quiet) setBusy(false); }
  };

  const saveInvoiceFor = async (j0: Job, quiet = false): Promise<boolean> => {
    let j = j0;
    if (!quiet) setBusy(true);
    try {
      const theOrg = await companyOrg();
      if (!theOrg) { flash("Company details haven't loaded. Check your signal and try again."); return false; }
      if (!hasLines(j)) { flash("Couldn't build the invoice: the job needs at least one priced work line"); return false; }
      // the invoice number is given out the moment an invoice is built, if the
      // job has none yet — the same number the zip package carries later
      const no = await claimInvoiceNo(j.id, j.invoice_number);
      if (no !== (j.invoice_number || "")) { j = { ...j, invoice_number: no }; setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, invoice_number: no } : x))); }
      const bytes = await buildPackageBytes(j, theOrg);
      if (!bytes) { flash("Couldn't build the invoice: the job needs at least one priced work line"); return false; }
      saveBytes(bytes, invoiceFileName(j), "application/pdf");
      await keepOnJob(j, bytes, invoiceFileName(j), "application/pdf");
      if (!quiet) flash("Invoice saved. A copy is kept on the job.");
      return true;
    } catch (err) {
      flash(`Couldn't build the invoice (${err instanceof Error ? err.message.slice(0, 60) : "unknown"})`);
      return false;
    } finally { if (!quiet) setBusy(false); }
  };

  const saveBoth = async (j: Job) => {
    setBusy(true);
    try {
      const p = await saveProposalPdfFor(j, true);
      await new Promise((r) => setTimeout(r, 600)); // let the first download land
      const i = await saveInvoiceFor(j, true);
      // whatever actually happened is what gets said
      if (p && i) flash("Proposal and invoice both saved");
      else if (p) flash("Proposal saved. The invoice didn't build (see the message above).");
      else if (i) flash("Invoice saved. The proposal didn't build.");
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
        setProgress(`Writing proposals… ${++done} of ${folderResult.made.length}`);
        const live = jobs.find((x) => x.id === j.id) || j;
        try {
          const made = await proposalBytes(live);
          if (!made) continue;
          const { bytes, name } = made;
          let nm = name;
          for (let n = 2; files[nm]; n++) nm = name.replace(/\.docx$/i, ` (${n}).docx`);
          files[nm] = bytes;
          await keepOnJob(live, bytes, name, DOCX);
          await stampProposalSent(live);
        } catch { /* one bad letter must not stop the rest */ }
      }
      if (Object.keys(files).length === 0) { flash("Couldn't build any of them. Open one and check its work lines."); return; }
      saveBytes(zipSync(files, { level: 1 }), fname, "application/zip");
      flash(`${Object.keys(files).length} proposal${Object.keys(files).length === 1 ? "" : "s"} saved`);
    } finally { setProgress(""); setBusy(false); }
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
      flash("Template saved. Fill it in, keep the layout, and uploading it back here builds the job.");
    } catch (err) {
      flash(`Couldn't build the template (${err instanceof Error ? err.message.slice(0, 60) : "unknown"})`);
    } finally { setBusy(false); }
  };

  // what a PO's read turns into on the job — the same lines the email intake makes
  const linesFromPo = async (f: PactPoFields, unreadable: boolean, amount: number): Promise<{ items: Item[]; amount: number; warnings: string[] }> =>
    linesFromPoRead(f, unreadable, amount, await priceBook()) as { items: Item[]; amount: number; warnings: string[] };

  // ---------- re-read a job's PO from its attached PDF ----------
  // The job is rebuilt from the PDF the way a fresh upload would build it —
  // through the server's reader (Claude when it is switched on), then the
  // price list. Everything the PO says is replaced; photos and the PDF stay.
  const smartOn = async (): Promise<boolean> => {
    try { return !!((await (await fetch("/api/parse-po")).json()) as { smart?: boolean }).smart; } catch { return false; }
  };
  const rereadJob = async (j: Job, quiet = false): Promise<"claude" | "rules" | "none"> => {
    // the PO's own PDF, never a paper the portal made (the photos PDF, the kept invoice)
    const pdf = (j.attachments || []).find((a) => /\.pdf$/i.test(a.name) && !isMade(a));
    if (!pdf) { if (!quiet) flash("No PO PDF on this job to re-read"); return "none"; }
    const { data: signed, error: se } = await sb().storage.from("docs").createSignedUrl(pdf.path, 600);
    if (se || !signed) { if (!quiet) flash("Couldn't fetch the PO PDF. Check your signal and try again."); return "none"; }
    const res0 = await fetch(signed.signedUrl).catch(() => null);
    if (!res0 || !res0.ok) { if (!quiet) flash("Couldn't download the PDF"); return "none"; }
    const bytes = await res0.blob();
    const { data: { session } } = await sb().auth.getSession();
    const res = await fetch("/api/parse-po", {
      method: "POST",
      headers: { "Content-Type": "application/pdf", ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
      body: bytes,
    });
    if (!res.ok) { if (!quiet) flash(`The reader couldn't be reached (${res.status}). Try again.`); return "none"; }
    const out = (await res.json()) as { fields: PactPoFields & { taxPct?: number }; readBy?: "claude" | "rules"; note?: string };
    const f = out.fields;
    const unreadable = !f.po && !f.partner && !f.desc;
    if (unreadable) { if (!quiet) flash("The PDF couldn't be read. Nothing changed."); return "none"; }
    const amount = f.amount;
    const { items, amount: amountOut, warnings: listNotes } = await linesFromPo(f, false, amount);
    const stamp = `${out.readBy === "claude" ? "🔁 Re-read by Claude" : "🔁 Re-read by the rules"} ${prettyDate(localISO(new Date()))}${out.note ? ` (${out.note})` : ""}`;
    // (the notes are read by everyone with the card open: words, never money)
    const flags = [...(f.warnings || []), ...(listNotes || [])].map((w) => `⚠ ${noMoney(w)}`);
    const notes = `${(j.notes || "").trim()}${(j.notes || "").trim() ? "\n" : ""}${stamp}${flags.length ? `\n${flags.join("\n")}` : ""}`;
    const patchRow: Partial<Job> = {
      description: (f.desc || f.scope).slice(0, 600), amount: amountOut, items,
      po_date: f.poDate, address: f.address, property_unit: f.punit, contact: f.contact, bill_to: f.billBlock, notes,
      ...(f.partner ? { partner: f.partner } : {}),
      ...(f.po ? { po_number: f.po, job_number: f.po } : {}),
      ...(f.taxPct !== undefined ? { tax_pct: f.taxPct } : {}),
      // (a new day here moves the job's crew rows with it — RUN_ME section 14's trigger)
      ...(f.accessDate && !j.work_done ? { start_date: f.accessDate } : {}),
      // the auto price starts over — this read's lines are the new "original"
      list_subtotal: subtotalOf(items),
    };
    let { error } = await sb().from("pact_jobs").update(patchRow).eq("id", j.id);
    if (error && /list_subtotal/i.test(error.message)) { // before RUN_ME section 15
      delete patchRow.list_subtotal;
      ({ error } = await sb().from("pact_jobs").update(patchRow).eq("id", j.id));
    }
    if (error) { if (!quiet) flash(upgradeHint(error.message)); return "none"; }
    // a crew row that carried the old wording (the crew text reads the row's copy first) follows the job,
    // matched on what it says (a doubled space or a trailing one must not leave it behind)
    if (patchRow.description && patchRow.description !== (j.description || "")) {
      const squash = (s: string) => (s || "").replace(/\s+/g, " ").trim();
      const { data: crewRows } = await sb().from("schedule_days").select("id,description").eq("pact_job_id", j.id);
      const stale = ((crewRows || []) as { id: string; description?: string | null }[]).filter((r) => squash(r.description || "") === squash(j.description || "")).map((r) => r.id);
      if (stale.length) await sb().from("schedule_days").update({ description: patchRow.description }).in("id", stale).then(() => null, () => null);
    }
    setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, ...patchRow } : x)));
    if (!quiet) flash(`PO ${f.po || ""} re-read ${out.readBy === "claude" ? "by Claude" : "by the rules"} · ${items.length} line${items.length === 1 ? "" : "s"}`);
    return out.readBy === "claude" ? "claude" : "rules";
  };

  // ---------- one-time clean-up of what the old email intake made ----------
  // Jobs that came in by email and nobody has touched go. A job someone has
  // put photos on, or priced for real, stays — that work is worth more than
  // a tidy list. "Real" money means at least $100 on the job, so a $13 line
  // the reader invented doesn't count as priced.
  const isEmailJob = (j: Job) => (j.notes || "").startsWith("📧");
  const hasPhotos = (j: Job) => (j.attachments || []).some((a) => isImg(a.name));
  const hasRealPrices = (j: Job) => Number(j.amount || 0) >= 100
    || (j.items || []).some((it) => (Number(it.qty) || 0) * (Number(it.unit_price) || 0) >= 100);
  const emailJobsToClean = () => jobs.filter((j) => isEmailJob(j) && !hasPhotos(j) && !hasRealPrices(j));
  const cleanupEmailJobs = async () => {
    const gone = emailJobsToClean();
    const kept = jobs.filter((j) => isEmailJob(j) && !gone.includes(j));
    if (gone.length === 0) { flash("Nothing to clean up"); return; }
    const name = (j: Job) => `PO ${j.po_number || j.job_number || "?"}${j.address ? ` · ${j.address.split(",")[0]}` : ""}`;
    const why = (j: Job) => [hasPhotos(j) && "photos", hasRealPrices(j) && `${fmt(Number(j.amount) || 0)}`].filter(Boolean).join(" + ");
    const msg = `Delete ${gone.length} email import${gone.length === 1 ? "" : "s"} nobody has worked on?\n\n${gone.slice(0, 12).map(name).join("\n")}${gone.length > 12 ? `\n…and ${gone.length - 12} more` : ""}`
      + (kept.length ? `\n\nKEPT (photos or real prices): ${kept.slice(0, 8).map((j) => `${name(j)} (${why(j)})`).join("; ")}${kept.length > 8 ? "…" : ""}` : "")
      + "\n\nThe deleted jobs and their files disappear for good. Hand-made and phone-uploaded jobs are not touched.";
    if (!window.confirm(msg)) return;
    setBusy(true);
    let done = 0;
    for (const j of gone) if (await deleteJobNow(j)) done += 1;
    setBusy(false);
    flash(`${done} of ${gone.length} deleted · ${kept.length} kept for their photos or prices`);
  };

  // ---------- invoice numbers in a straight line ----------
  // Invoices count up by one. Deleting jobs (the email imports, say) leaves a
  // hole — 620, then 631 — and every invoice after it sits ten too high. This
  // closes the hole: every invoice above the last number before it moves down,
  // in order, so the sequence reads 620, 621, 622… again. An invoice already
  // marked sent or paid keeps its number unless the owner says otherwise —
  // the partner has that number on their side.
  const renumberInvoices = async () => {
    type Row = { id: string; invoice_number?: string | null; invoice_sent?: string | null; received?: boolean; canceled?: boolean; po_number?: string; job_number?: string; address?: string; created_at?: string; attachments?: { name: string; path: string }[] | null };
    const { data, error } = await sb().from("pact_jobs").select("id,invoice_number,invoice_sent,received,canceled,po_number,job_number,address,created_at,attachments");
    if (error) { flash(upgradeHint(error.message)); return; }
    const rows = ((data || []) as Row[])
      .map((r) => ({ r, n: /^\d+$/.test(String(r.invoice_number || "").trim()) ? parseInt(String(r.invoice_number).trim(), 10) : NaN }))
      // only the portal's own run counts — an old hand-typed "12" is not a hole
      .filter((x) => Number.isFinite(x.n) && x.n > INVOICE_FLOOR)
      .sort((a, b) => a.n - b.n || String(a.r.created_at || "").localeCompare(String(b.r.created_at || "")));
    // two jobs on one number: sort that out by hand first — moving numbers
    // around a duplicate could hand two jobs the same one for good
    const twin = rows.find((x, i) => i > 0 && rows[i - 1].n === x.n);
    if (twin) { flash(`Two jobs share invoice #${twin.n}. Give one of them its own number first (PO details → Invoice #).`); return; }
    // the last number before the first hole — offered as the starting point,
    // and the owner confirms it: an older hole from some long-deleted job must
    // never pull already-sent invoices down with it
    let gapAt = -1;
    for (let i = 0; i + 1 < rows.length; i++) if (rows[i + 1].n > rows[i].n + 1) { gapAt = i; break; }
    if (gapAt < 0) { flash("Invoice numbers already go up by one. Nothing to fix."); return; }
    const typed = window.prompt(`Continue the numbers from which invoice? Everything above it moves down to follow on; it and everything before it stay as they are.`, String(rows[gapAt].n));
    if (typed === null) return;
    const last = /^\d+$/.test(typed.trim()) ? parseInt(typed.trim(), 10) : NaN;
    if (!Number.isFinite(last) || last <= INVOICE_FLOOR) { flash(`"${typed}" isn't an invoice number in the portal's run (above ${INVOICE_FLOOR})`); return; }
    const above = rows.filter((x) => x.n > last);
    if (above.length === 0) { flash(`Nothing above #${last} to move`); return; }
    if (above[0].n === last + 1 && !above.some((x, i) => i > 0 && x.n > above[i - 1].n + 1)) { flash(`The numbers after #${last} already go up by one`); return; }
    const label = (x: { r: Row; n: number }) => `PO ${x.r.po_number || x.r.job_number || "?"}${x.r.address ? ` · ${x.r.address.split(",")[0]}` : ""}${x.r.canceled ? " (canceled)" : ""}`;
    const sent = above.filter((x) => x.r.invoice_sent || x.r.received);
    let keep = new Set<string>();
    if (sent.length > 0) {
      const also = window.confirm(`${sent.length} of the invoices after #${last} ${sent.length === 1 ? "was" : "were"} already marked sent or paid:\n\n${sent.slice(0, 10).map((x) => `#${x.n}  ${label(x)}`).join("\n")}${sent.length > 10 ? "\n…" : ""}\n\nOK renumbers those too (tell the partner the new number). Cancel leaves those as they are and renumbers only the rest.`);
      if (!also) keep = new Set(sent.map((x) => x.r.id));
    }
    const kept = new Set(above.filter((x) => keep.has(x.r.id)).map((x) => x.n));
    const plan: { x: { r: Row; n: number }; to: number }[] = [];
    let next = last;
    for (const x of above) {
      if (keep.has(x.r.id)) continue;
      do { next += 1; } while (kept.has(next));
      if (next !== x.n) plan.push({ x, to: next });
    }
    const nextNew = Math.max(INVOICE_FLOOR, next, ...kept) + 1;
    if (plan.length === 0) { flash(`Nothing to move. The next new invoice is #${nextNew}.`); return; }
    const msg = `Close the hole after #${last}? ${plan.length} invoice${plan.length === 1 ? "" : "s"} move${plan.length === 1 ? "s" : ""} down:\n\n${plan.slice(0, 14).map((p) => `#${p.x.n} → #${p.to}  ${label(p.x)}`).join("\n")}${plan.length > 14 ? `\n…and ${plan.length - 14} more` : ""}\n\nThe next new invoice will be #${nextNew}. Invoice PDFs already saved on these jobs are removed. Download them again with the new number.`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    let done = 0, stopped = "";
    // in order of the old numbers: each new number sits below every old number
    // still to come, so no two jobs ever hold the same one, even for a moment
    for (const p of plan) {
      const { error: e } = await sb().from("pact_jobs").update({ invoice_number: String(p.to) }).eq("id", p.x.r.id);
      if (e) { console.warn(e.message); stopped = `Stopped at #${p.x.n}`; break; }
      done += 1;
      // the invoice PDF the portal shelved carries the old number in its name —
      // off the shelf it goes; the next download makes a fresh one. The list is
      // read again right here: another phone may have added photos since the
      // click, and those stay. Only the portal's own shelf is touched, never a
      // file someone uploaded.
      const { data: cur } = await sb().from("pact_jobs").select("attachments").eq("id", p.x.r.id).single();
      const atts = ((cur as { attachments?: { name: string; path: string }[] } | null)?.attachments) || [];
      const stale = atts.filter((a) => /\/made\/invoice /i.test(a.path));
      if (stale.length) {
        try { await sb().storage.from("docs").remove(stale.map((a) => a.path)); } catch { /* best effort */ }
        await sb().from("pact_jobs").update({ attachments: atts.filter((a) => !stale.includes(a)) }).eq("id", p.x.r.id);
      }
    }
    setBusy(false);
    await load();
    // one message, and the truth: a run that stopped short says so, and
    // doesn't claim a next number it can't know
    flash(stopped
      ? `${stopped}. ${done} of ${plan.length} moved. Run Renumber invoices… again to finish.`
      : `${done} invoice${done === 1 ? "" : "s"} renumbered. The next new one is #${nextNew}.`);
  };

  const handlePo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setOneShot(null); // whatever was offered for the last PO no longer applies
    setBusy(true);
    try {
      const out = await intakePoFile(file, priceBook);
      setBusy(false);
      if (out.kind === "release") { flash("That's a NYCHA release. Upload it on the Releases tab: + Add release, then From release PDFs. PACT only takes partner POs and proposal letters."); return; }
      // the intake's own words when it says nothing was made — the hint alone would hide that
      if (out.kind === "error") { flash(/nothing was created/i.test(out.message) ? out.message : upgradeHint(out.message)); return; }
      await load();
      setOpenId(out.id); showDetailsFor(out.id);
      if (out.kind === "dupe") {
        const label = out.po ? `PO ${out.po}` : "That proposal";
        flash(out.moved
          ? `${label} is already here. The new PO moves it to ${prettyDate(out.movedTo!)}.`
          : out.grew
            ? `${label} is already here. Picked up the PO's full wording (tap Price from list to refresh the lines).`
            : `${label} is already here${out.canceled ? " (canceled)" : ""}. Opened it, nothing new was created.`);
        return;
      }
      // the finished job, with the lines the price list filled in — and if
      // that read comes back empty, the job we just made is still the truth
      const { data: fresh } = await sb().from("pact_jobs").select("*").eq("id", out.id).single();
      const ready = (fresh as Job | null)?.id ? (fresh as Job) : (out.job as unknown as Job);
      if (!out.unreadable) setOneShot({ id: ready.id, job: ready, note: out.po ? `PO ${out.po}` : "PO read" });
      // one line: what came in, how it was read, and the day it landed on (the card above says what to check)
      flash(out.attachError
        ? "PO created, but the PDF didn't attach. Open the job, then ⋯ → Documents to add it."
        : out.unreadable
          ? out.isDocx
            ? "File attached, but the proposal couldn't be read. Type the partner, address and description below."
            : `PDF attached, but no text could be read (scanned copy?${out.how ? ` · ${out.how}` : ""}). Type the partner, address and description below.`
          : `PO ${out.po || "imported"}${out.isDocx ? " (our letter)" : out.readBy === "claude" ? " read by Claude" : ` ⚠ read by the rules${out.readNote ? ` (${out.readNote})` : ""}`} · ${out.accessDate ? `on the Schedule for ${prettyDate(out.accessDate)}` : "no date on the PO"}${out.flags.length ? ` · ⚠ ${out.flags[0]}` : ""}`);
    } catch (err) {
      setBusy(false);
      console.warn(err);
      flash("Couldn't finish the upload. Try again.");
    }
  };

  const addJob = async () => {
    if (!draft.partner.trim() || !draft.description.trim()) { flash("Type a partner and a description first"); return; }
    // a typed PO number that's already a job opens that job instead
    if (draft.job_number.trim()) {
      const { data: all, error: le } = await sb().from("pact_jobs").select(DUPE_COLS).limit(5000);
      if (le) { flash("Couldn't check for duplicates. Nothing was created, try again."); return; }
      const dupe = findDupe((all || []) as Job[], { po: draft.job_number });
      if (dupe) {
        setAddOpen(false); await load();
        setOpenId(dupe.id); showDetailsFor(dupe.id);
        flash(`PO ${draft.job_number.trim()} is already here${dupe.canceled ? " (canceled)" : ""}. Opened it, nothing new was created.`);
        return;
      }
    }
    const { error } = await insertJob({
      partner: draft.partner.trim(), development: draft.development.trim(), job_number: draft.job_number.trim(),
      description: draft.description.trim(), amount: parseNum(draft.amount),
      // no invoice number yet — it is given out when the job is priced
      // no lines yet — a baseline of 0, so a line typed later at no price leaves it unpriced
      list_subtotal: 0,
    });
    if (error) { flash(upgradeHint(error.message)); return; }
    setDraft({ ...BLANK }); setAddOpen(false); load();
  };

  // ---------- invoice items ----------
  // baseline: the lines were priced by the list on its own (opening a job
  // fills the gaps) — that total is still the "original price", so the job is
  // not PRICED by it (RUN_ME section 15)
  // The office fixing how many rooms the list guessed, before the work is
  // done, is not pricing the job: every line still carries the list's own
  // price. Such a save moves the list's baseline along with it, so the job
  // does not flip to PRICED and spend an invoice number nobody asked for.
  const roomCountFix = (j: Job, was: Item[], items: Item[]): boolean => {
    if (j.work_done || j.list_subtotal === null || j.list_subtotal === undefined) return false;
    if (was.length !== items.length) return false;
    const bk = book?.items || PRICE_BOOK;
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      const a = was[i], b = items[i];
      if (a.description !== b.description || (a.unit || "") !== (b.unit || "") || Number(a.unit_price) !== Number(b.unit_price) || (a.key || "") !== (b.key || "")) return false;
      if (Number(a.qty) === Number(b.qty)) continue;
      const listPrice = b.key ? bk.find((p) => p.key === b.key)?.price : undefined;
      if (normUnit(b.unit || "") !== "ROOM" || listPrice === undefined || Number(b.unit_price) !== listPrice) return false;
      moved = true;
    }
    return moved;
  };
  // The Qty box writes every keystroke into the page's copy of the job, so by
  // the time the save comes that copy already carries the new count. The lines
  // from before the first keystroke are kept here, per job, and that is what
  // the save compares against; the save clears it.
  const beforeEdit = useRef<Record<string, Item[]>>({});
  const setItems = (j: Job, items: Item[], persist = false, baseline = false) => {
    if (!persist && !beforeEdit.current[j.id]) beforeEdit.current[j.id] = itemsOf(j);
    setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, items } : x)));
    setInvJob((prev) => (prev && prev.id === j.id ? { ...prev, items } : prev));
    if (persist) {
      const was = beforeEdit.current[j.id] ?? itemsOf(j);
      delete beforeEdit.current[j.id];
      if (!baseline && roomCountFix(j, was, items)) baseline = true;
    }
    if (persist) {
      const sub = items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);
      const amount = sub * (1 + taxRate(j) / 100); // billed total includes tax
      // unpriced lines must not wipe a hand-typed job amount
      patch({ ...j, items }, { ...(sub > 0 ? { items, amount } : { items }), ...(baseline ? { list_subtotal: subtotalOf(items) } : {}) });
    }
  };

  // A paper the portal made gets kept on the job, next to the PO and the
  // photos — so what was quoted and what was billed can be looked up later.
  // Making it again replaces that copy rather than piling up new ones.
  // Says whether the copy is on the job afterwards; the caller's download has happened either way.
  const keepOnJob = async (j: Job, bytes: Uint8Array | Blob, name: string, type: string): Promise<boolean> => {
    try {
      // "#" (and friends) end a web address, so the shelf name drops them —
      // the file the user downloads keeps the name they expect. Papers the
      // portal wrote live under their own folder so the invoice package can
      // tell them apart from the PO and the photos and never swallow itself.
      const safe = name.replace(/[#?%&]+/g, "").replace(/\s{2,}/g, " ").trim();
      const path = `pact/${j.id}/made/${safe}`;
      let blob: Blob;
      if (bytes instanceof Blob) blob = bytes;
      else { const ab = new ArrayBuffer(bytes.byteLength); new Uint8Array(ab).set(bytes); blob = new Blob([ab], { type }); }
      const { error } = await sb().storage.from("docs").upload(path, blob, { upsert: true, contentType: type });
      if (error) return false; // the download still happened — keeping a copy is a bonus, never a blocker
      const { data: cur } = await sb().from("pact_jobs").select("attachments").eq("id", j.id).single();
      const existing = (cur as { attachments?: { name: string; path: string }[] } | null)?.attachments
        || jobs.find((x) => x.id === j.id)?.attachments || [];
      if (existing.some((a) => a.path === path)) return true; // already listed, and now replaced on the shelf
      const list = [...existing, { name, path }];
      const { error: listErr } = await sb().from("pact_jobs").update({ attachments: list }).eq("id", j.id);
      setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, attachments: list } : x)));
      setAttachJob((prev) => (prev && prev.id === j.id ? { ...prev, attachments: list } : prev));
      return !listErr;
    } catch { return false; /* keeping the copy is best effort */ }
  };

  // a proposal going out is a date on the job, like an invoice going out
  const stampProposalSent = async (j: Job): Promise<void> => {
    if (j.proposal_sent) return;
    const { error } = await sb().from("pact_jobs").update({ proposal_sent: today() }).eq("id", j.id);
    if (error) { if (/column|schema cache/i.test(error.message)) flash("Proposals sent can't be tracked until the database update is run (Settings → System check)"); return; }
    setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, proposal_sent: today() } : x)));
  };

  // ---------- attachments & photos ----------
  const attachFiles = async (j: Job, files: File[]): Promise<{ name: string; path: string }[]> => {
    if (files.length === 0) return [];
    setBusy(true);
    const added: { name: string; path: string }[] = [];
    for (const file of files) {
      const path = `pact/${j.id}/${file.name}`;
      const { error } = await sb().storage.from("docs").upload(path, file, { upsert: true });
      if (error) { setBusy(false); flash(/bucket/i.test(error.message) ? "Storage isn't set up yet (Settings → System check)" : upgradeHint(error.message, "Couldn't upload")); return []; }
      added.push({ name: file.name, path });
    }
    // merge against the freshest row so multi-photo batches and other devices never lose files
    const { data: cur } = await sb().from("pact_jobs").select("attachments").eq("id", j.id).single();
    const existing = (cur as { attachments?: { name: string; path: string }[] } | null)?.attachments
      || jobs.find((x) => x.id === j.id)?.attachments || [];
    const list = [...existing.filter((a) => !added.some((b) => b.path === a.path)), ...added];
    const { error: e2 } = await sb().from("pact_jobs").update({ attachments: list }).eq("id", j.id);
    if (e2) flash(upgradeHint(e2.message, "Couldn't save the file list"));
    else {
      setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, attachments: list } : x)));
      setAttachJob((prev) => (prev && prev.id === j.id ? { ...prev, attachments: list } : prev));
      setMeasureJob((prev) => (prev && prev.id === j.id ? { ...prev, attachments: list } : prev));
    }
    setBusy(false);
    return e2 ? [] : added;
  };
  // the measured square feet, onto the job: the chosen square-foot line takes
  // the number (or a Plaster line is added, priced from the list for Admin 1),
  // and the job's notes say what was measured from what
  const applyMeasured = async (j0: Job, lineIndex: number | null, sqft: number, note: string): Promise<boolean> => {
    const j = jobs.find((x) => x.id === j0.id) || j0;
    const needsPrice = lineIndex === null;   // a new Plaster line; an existing line keeps its own price
    const price = needsPrice ? ((await priceBook()).find((p) => p.key === "plaster")?.price || 0) : 0;
    const next = applyMeasure(itemsOf(j), lineIndex, sqft, price) as Item[];
    setItems(j, next, true);
    const notes = `${(j.notes || "").trim()}${(j.notes || "").trim() ? "\n" : ""}${note}`;
    const { error } = await sb().from("pact_jobs").update({ notes }).eq("id", j.id);
    if (error) { flash(upgradeHint(error.message, "Couldn't save the note")); return false; }
    setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, notes } : x)));
    return true;
  };
  // "Upload files": pictures are shrunk like camera shots, a photos zip (the
  // one "⬇ Photos" makes) is opened back up into its pictures — their
  // before_/after_ names survive the round trip, so they land in the right
  // rows — and anything else (a PO, a letter) is attached as it is
  const uploadFiles = async (j: Job, files: File[]) => {
    const out: File[] = [];
    let zipped = 0;
    for (const f of files) {
      if (/\.zip$/i.test(f.name)) {
        try {
          const { unzipSync } = await import("fflate");
          const entries = unzipSync(new Uint8Array(await f.arrayBuffer()));
          for (const [name, bytes] of Object.entries(entries)) {
            const base = name.split("/").pop() || "";
            if (!base || !isImg(base) || bytes.length === 0) continue; // folders, junk, non-pictures
            const ab = new ArrayBuffer(bytes.byteLength); new Uint8Array(ab).set(bytes);
            out.push(new File([ab], base, { type: /png$/i.test(base) ? "image/png" : "image/jpeg" }));
            zipped += 1;
          }
        } catch { flash(`${f.name} isn't a zip this phone can open`); }
        continue;
      }
      out.push(isImg(f.name) ? await shrinkImage(f) : f);
    }
    if (out.length === 0) { flash("Nothing to attach in that: no pictures or documents found"); return; }
    await attachFiles(j, out);
    if (zipped) flash(`${zipped} picture${zipped === 1 ? "" : "s"} unpacked from the zip and attached`);
  };
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
    if (error || !data) { flash("Couldn't open that file"); return; }
    window.open(data.signedUrl, "_blank");
  };
  // deleting a photo or a file always asks first: there is no undo on the shelf
  const removeAttachment = async (j: Job, path: string, name = path): Promise<boolean> => {
    if (!window.confirm(isImg(name) ? "Delete this photo? It comes off the job for good." : "Delete this file? It comes off the job for good.")) return false;
    await sb().storage.from("docs").remove([path]);
    const cur = jobs.find((x) => x.id === j.id) || j;
    const list = (cur.attachments || []).filter((a) => a.path !== path);
    await sb().from("pact_jobs").update({ attachments: list }).eq("id", j.id);
    setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, attachments: list } : x)));
    setAttachJob((prev) => (prev && prev.id === j.id ? { ...prev, attachments: list } : prev));
    setLightbox((prev) => (prev && prev.path === path ? null : prev));
    return true;
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
      // one read up front: dupes and the partner lookup. No invoice numbers
      // here — those are given out as the invoices are made (below)
      const { data: priorRows, error: le } = await sb().from("pact_jobs").select(`partner,bill_to,${DUPE_COLS}`).limit(5000);
      if (le) { flash("Couldn't check for duplicates. Nothing was created, try again."); return; }
      const prior = (priorRows || []) as (Job & { partner: string; bill_to?: string })[];
      const made: Job[] = [];
      let skipped = 0, failed = 0, done = 0;
      for (const f of files) {
        done += 1;
        setProgress(`Reading proposals… ${done} of ${files.length}`);
        try {
          const parsed = parsePactProposalDocx(await f.arrayBuffer());
          if (!parsed.readable || parsed.rows.length === 0) { failed += 1; continue; }
          // already a job — on file, or made a moment ago from this same folder
          const probe = { po: parsed.po, address: parsed.address, property_unit: parsed.punit, amount: parsed.amount };
          if (findDupe(prior, probe) || findDupe(made, probe)) { skipped += 1; continue; }
          let partner = "";
          const street = parsed.billBlock.match(/\d+\s+[A-Za-z .]+/)?.[0] || "";
          if (street) {
            const re = new RegExp(`(^|[^0-9])${street.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
            const hit = prior.find((p) => re.test(p.bill_to || ""));
            if (hit) partner = hit.partner;
          }
          const seed: Item[] = parsed.rows.map((r) => ({ description: r.description, qty: r.qty, unit: r.uom || unitFor(r.description), unit_price: r.unit_price, ...(r.base ? { base: r.base } : {}) }));
          const { data: job, error } = await insertJob({
            partner, development: "", job_number: parsed.po, description: parsed.desc, amount: parsed.amount,
            po_number: parsed.po, po_date: parsed.poDate, address: parsed.address, property_unit: parsed.punit,
            contact: parsed.contact, bill_to: parsed.billBlock, items: seed,
            ...(parsed.taxPct !== undefined ? { tax_pct: parsed.taxPct } : {}),
            // the letter's own lines are this job's baseline — the same as uploading it one at a time
            list_subtotal: subtotalOf(seed),
          });
          if (error || !job) { failed += 1; continue; }
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
      setProgress("");
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
    if (!theOrg) { flash("Company details haven't loaded. Check your signal and try again."); return; }
    setBusy(true);
    try {
      const files: Record<string, Uint8Array> = {};
      let done = 0;
      for (const j0 of folderResult.made) {
        setProgress(`Making invoices… ${++done} of ${folderResult.made.length}`);
        // whatever was corrected since the import is what gets billed — and
        // the invoice number is given out right here, in this order
        const j1 = jobs.find((x) => x.id === j0.id) || j0;
        if (!hasLines(j1)) continue; // nothing to bill — no number spent on it
        const j = { ...j1, invoice_number: await claimInvoiceNo(j1.id, j1.invoice_number) };
        const bytes = await buildPackageBytes(j, theOrg);
        if (!bytes) continue;
        let base = `invoice # ${j.invoice_number || ""} PO ${j.po_number || j.job_number || ""} ${[j.address, j.property_unit && `Apt ${j.property_unit}`].filter(Boolean).join(" ")}`
          .trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s{2,}/g, " ").slice(0, 110);
        let name = `${base}.pdf`;
        for (let n = 2; files[name]; n++) name = `${base}_${n}.pdf`;
        files[name] = bytes;
        await keepOnJob(j, bytes, invoiceFileName(j), "application/pdf");
      }
      if (Object.keys(files).length === 0) { flash("No invoices could be built"); setProgress(""); setBusy(false); return; }
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
      flash("Couldn't build the zip. Check your signal and try again.");
    }
    setProgress("");
    setBusy(false);
  };

  // one job's full package as PDF bytes — invoice page, PO pages, photos
  const buildPackageBytes = async (j: Job, org2: Org): Promise<Uint8Array | null> => {
    const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
    const { money: usd } = await import("@/lib/proposalDoc");
    const items = cleanLineWording(itemsOf(j)).items.filter((it) => Number(it.qty) > 0 && it.description.trim());
    if (items.length === 0) return null;
      const pkg = await PDFDocument.create();
      const helv = await pkg.embedFont(StandardFonts.Helvetica);
      const bold = await pkg.embedFont(StandardFonts.HelveticaBold);
      // --- invoice page: clean letterhead layout ---
      let page = pkg.addPage([612, 792]);
      const L = 54, R = 558;
      let y = 736;
      const ink = rgb(0.09, 0.09, 0.08), soft = rgb(0.45, 0.44, 0.42);
      const ruleC = rgb(0.86, 0.84, 0.79), fillC = rgb(0.957, 0.945, 0.922);
      // the same orange as the proposal letter, so the pair look like one company
      const brand = rgb(0.761, 0.290, 0.039), white = rgb(1, 1, 1);
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
      putR("INVOICE", R, y - 3, 22, bold, brand);
      y -= 14;
      put(COMPANY.letterhead.address, lx, y, 8.5, helv, soft);
      y -= 11;
      put(COMPANY.letterhead.phones, lx, y, 8.5, helv, soft);
      y -= 11;
      put(COMPANY.letterhead.emails, lx, y, 8.5, helv, soft);
      y -= 12;
      hr(y, 2, brand);
      y -= 26;

      // invoice meta
      ([["INVOICE #", j.invoice_number || j.po_number || ""], ["DATE", prettyDate(today())], ["PURCHASE ORDER", j.po_number || j.job_number || ""]] as [string, string][]).forEach(([k, v], i) => {
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
      // "White Plains, NY 10606" is one place — splitting on every comma cut the
      // city off its state and zip, and the four-line cap then dropped them
      // entirely. An invoice missing the city is an invoice nobody can pay.
      const billParts: string[] = [];
      for (const part of billRest.trim().split(/,\s*/).map((x) => x.trim()).filter(Boolean)) {
        if (billParts.length > 0 && /^[A-Z]{2}\b\s*\d{5}(?:-\d{4})?$/.test(part)) billParts[billParts.length - 1] += `, ${part}`;
        else billParts.push(part);
      }
      const billLines = [j.partner, ...billParts].filter(Boolean).slice(0, 6) as string[];
      const siteLines = [j.address || "", unitLabel(j.property_unit || "")].filter(Boolean) as string[];
      const startY = y;
      billLines.forEach((s, i) => put(String(s).slice(0, 48), L, startY - i * 12, 9.5, i === 0 ? bold : helv));
      siteLines.forEach((s, i) => put(String(s).slice(0, 46), 330, startY - i * 12, 9.5, i === 0 ? bold : helv));
      y = startY - Math.max(billLines.length, siteLines.length, 1) * 12 - 16;

      // work table
      const tableHead = (label: string) => {
        page.drawRectangle({ x: L, y: y - 6, width: R - L, height: 20, color: fillC });
        page.drawLine({ start: { x: L, y: y - 6 }, end: { x: R, y: y - 6 }, thickness: 1.4, color: brand });
        put(label, L + 8, y, 8, bold, soft);
        putR("QTY", 388, y, 8, bold, soft);
        put("UNIT", 400, y, 8, bold, soft);
        putR("UNIT PRICE", 500, y, 8, bold, soft);
        putR("AMOUNT", R - 8, y, 8, bold, soft);
        y -= 22;
      };
      tableHead("DESCRIPTION OF WORK");
      // a long work list spills onto extra pages instead of running off the sheet
      const newItemsPage = () => {
        page = pkg.addPage([612, 792]);
        y = 736;
        tableHead("DESCRIPTION OF WORK (continued)");
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
          put(rt, L + 8, y);
          if (i2 === 0) {
            putR(String(it.qty), 388, y, 9.5, helv, soft);
            put(it.unit, 400, y, 9.5, helv, soft);
            putR(usd(Number(it.unit_price)), 500, y, 9.5, helv, soft);
            putR(usd(amount), R - 8, y);
          }
          y -= 14;
        });
        y -= 3;
        hr(y + 9, 0.5);
      });

      // totals
      if (y < 150) { page = pkg.addPage([612, 792]); y = 736; }
      y -= 8;
      const taxAmt = subtotal * taxRate(j) / 100;
      putR("Subtotal", 466, y, 9.5, helv, soft);
      putR(usd(subtotal), R - 8, y);
      y -= 16;
      putR(`Sales tax ${taxRate(j)}%`, 466, y, 9.5, helv, soft);
      putR(usd(taxAmt), R - 8, y);
      y -= 30;
      page.drawRectangle({ x: 330, y: y - 6, width: R - 330, height: 26, color: brand });
      putR("TOTAL DUE", 466, y, 10.5, bold, white);
      putR(usd(subtotal + taxAmt), R - 8, y, 13, bold, white);

      // footer
      hr(72, 0.6);
      const foot = `Make all checks payable to ${(org2.company || "").toUpperCase()} · Thank you for your business`;
      put(foot, (612 - helv.widthOfTextAtSize(foot, 8.5)) / 2, 58, 8.5, helv, soft);
      // --- the PO pdf(s) --- (never a package this job already produced)
      const atts = (j.attachments || []).filter((a) => !isMade(a));
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
            p.drawText(`${kind.toUpperCase()} · ${a.name}`, { x: 48, y: 760, size: 11, font: bold });
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

  const buildPackage = async (j0: Job) => {
    let j = j0;
    const theOrg = await companyOrg();
    if (!theOrg) { flash("Company details haven't loaded. Check your signal and try again."); return; }
    setBusy(true);
    try {
      if (!hasLines(j)) { flash("Fill in the invoice lines first (open the job → Papers → Edit invoice)"); setBusy(false); return; }
      // the invoice number is given out the moment an invoice is built, if the job has none yet
      const no = await claimInvoiceNo(j.id, j.invoice_number);
      if (no !== (j.invoice_number || "")) { j = { ...j, invoice_number: no }; setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, invoice_number: no } : x))); }
      const out = await buildPackageBytes(j, theOrg);
      if (!out) { flash("Fill in the invoice lines first (open the job → Papers → Edit invoice)"); setBusy(false); return; }
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
      flash("Package downloaded: invoice, PO and photos in one PDF");
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
  const list = jobs.filter((j) => matches(q, j.partner, j.development, j.job_number, j.po_number, j.address, j.description));
  const pipeline = (j: Job): [string, boolean][] => [
    ["PROPOSAL", !!j.proposal_sent], ["APPROVED", j.approved], ["WORK DONE", j.work_done],
    ...(canInvoice ? ([["INVOICED", !!j.invoice_sent], ["PAID", j.received]] as [string, boolean][]) : []),
  ];

  // the list's shape, shimmering, while the first fetch is in flight
  const skeletonRows = [0, 1, 2].map((i) => (
    <div key={`sk${i}`} className="p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="skeleton h-4 w-32" />
        <div className="skeleton h-4 w-16" />
      </div>
      <div className="skeleton mt-2 h-4 w-48" />
    </div>
  ));

  // Until the profile answers, only the page's shape renders — the money on
  // this page must not flash at an account that isn't allowed to see it.
  if (!role) {
    return (
      <div>
        <PageHeader title="PACT Billing" sub="POs, proposals, invoices" />
        <div className="card divide-y divide-rulesoft">{skeletonRows}</div>
      </div>
    );
  }

  const testPosHere = jobs.some(isTestJob);
  const emailLeft = emailJobsToClean().length;
  // a row's thumbnail in the Documents dialog: a tap opens it big, the ✕ deletes it
  const thumb = (j: Job, a: { name: string; path: string }) => (
    <div key={a.path} className="relative">
      <button type="button" className="block w-full transition-opacity active:opacity-80" onClick={() => setLightbox(a)} aria-label={`Open ${a.name}`}>
        {photoUrls[a.path]
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={photoUrls[a.path]} alt={a.name} className="h-24 w-full rounded-sm border border-rulesoft object-cover" onLoad={(e) => e.currentTarget.classList.add("anim-fade")} />
          : <span className="skeleton block h-24 w-full" />}
      </button>
      {canEdit && (
        <button type="button" className="btn-icon absolute -right-1 -top-1 h-11 w-11 border-0 bg-transparent shadow-none text-paper" aria-label="Delete photo" onClick={() => removeAttachment(j, a.path, a.name)}>
          <span className="rounded-sm bg-ink/70 px-1.5 text-xs">✕</span>
        </button>
      )}
    </div>
  );

  return (
    <div>
      <PageHeader title="PACT Billing" sub="POs, proposals, invoices"
        primary={canEdit ? <button type="button" className="btn btn-primary" onClick={() => poRef.current?.click()} disabled={busy}>📄 Upload PO or proposal</button> : undefined}
        menu={[
          { label: "Upload a folder of proposals", glyph: "📄", hidden: !canInvoice, disabled: busy, title: "Every letter in the folder becomes a job, then all the invoices download in one zip", onSelect: () => folderRef.current?.click() },
          { label: "Proposal template (Word)", glyph: "⬇", hidden: !canInvoice, disabled: busy, title: "A blank letter in our layout. Fill it in and upload it back here to build the job", onSelect: blankProposal },
          { label: "+ Type one in", glyph: "✎", hidden: !canEdit, onSelect: () => setAddOpen(!addOpen) },
          { label: "Renumber invoices…", hidden: !canInvoice, disabled: busy, title: "Closes a hole in the numbers after deleted jobs, so they go up by one again", onSelect: renumberInvoices },
          { label: "Add test POs", hidden: !canPrice || testPosHere, disabled: busy, title: "Three throwaway POs to try texting and photos on", onSelect: addTestPos },
          // deleteTestPos and cleanupEmailJobs ask their own window.confirm, naming what goes
          { label: "Delete test POs", hidden: !canPrice || !testPosHere, disabled: busy, destructive: true, title: "Takes the test POs and everything on them off, nothing else", onSelect: deleteTestPos },
          { label: `Clean up old email imports… (${emailLeft})`, hidden: !canPrice || emailLeft === 0, disabled: busy, destructive: true, title: "Deletes the untouched jobs the old email intake made. Jobs with photos or real prices stay", onSelect: cleanupEmailJobs },
        ]}>
        <Link className="btn btn-ghost" href="/pact/schedule">📅 PACT Schedule</Link>
      </PageHeader>
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
          <div className="card card-pad page-enter mb-3 border-work">
            <div className="font-display text-base font-bold uppercase">{oneShot.note} · {billable.length > 0 ? "papers ready" : "read, but nothing priced yet"}</div>
            <div className="mt-1 text-[12px] text-inksoft">
              {j.address || "This job"}{j.property_unit ? ` · Apt ${j.property_unit}` : ""}
              {" · "}{billable.length} work line{billable.length === 1 ? "" : "s"}
              {canPrice && Number(j.amount) > 0 ? ` · ${fmt(Number(j.amount))}` : ""}
              {canInvoice && j.invoice_number ? ` · invoice # ${j.invoice_number}` : ""}
              {billable.length === 0
                ? ". Nothing on the price list matched this one: add the work lines below, then come back here."
                : priced ? ". Check the lines below. The crew is picked on the Schedule tab."
                  : ". The lines have no prices yet: fill them in below first."}
            </div>
            <CardToolbar className="mt-3"
              primary={billable.length > 0 ? (
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => saveBoth(j)}>⬇ Proposal + invoice</button>
              ) : undefined}
              secondary={<button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setOneShot(null)}>Done</button>} />
          </div>
        );
      })()}

      {folderResult && (
        <div className="card card-pad page-enter mb-3 border-work">
          <div className="font-display text-base font-bold uppercase">{folderResult.made.length} proposal{folderResult.made.length === 1 ? "" : "s"} added</div>
          <div className="mt-1 text-[12px] text-inksoft">
            {folderResult.skipped > 0 && `${folderResult.skipped} skipped (already here). `}
            {folderResult.failed > 0 && `${folderResult.failed} couldn't be read. Upload those one at a time. `}
            {canInvoice && "Invoice numbers are given out as the invoices are made."}
          </div>
          <CardToolbar className="mt-3"
            primary={canInvoice ? (
              <button type="button" className="btn btn-primary" onClick={downloadFolderInvoices} disabled={busy || folderResult.made.length === 0}>⬇ All {folderResult.made.length} invoices (zip)</button>
            ) : undefined}
            secondary={<>
              {canInvoice && <button type="button" className="btn btn-ghost" onClick={downloadFolderProposals} disabled={busy || folderResult.made.length === 0}>⬇ All {folderResult.made.length} proposals (zip)</button>}
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setFolderResult(null)}>Done</button>
            </>} />
        </div>
      )}

      {jobs.length > 0 && canInvoice && (
        <div className="mb-3 grid grid-cols-3 gap-2">
          {([["PACT total", fmt(tot), "text-ink"], ["Paid", fmt(rec), "text-ok"], ["Outstanding", fmt(tot - rec), "text-work"]] as [string, string, string][]).map(([l, v, cls]) => (
            <div key={l} className="card card-tight">
              <div className="section-label">{l}</div>
              <div className={`truncate font-mono text-[15px] font-semibold tabular-nums ${cls}`}>{v}</div>
            </div>
          ))}
        </div>
      )}

      <input type="search" enterKeyHint="search" autoComplete="off" className="field mb-3" placeholder="Search PO #, partner, address…" aria-label="Search POs" value={q} onChange={(e) => setQ(e.target.value)} />

      {addOpen && canEdit && (
        <form className="card card-pad anim-open mb-3 border-work" onSubmit={(e) => { e.preventDefault(); addJob(); }}>
          <div className="mb-2 font-display text-base font-bold uppercase">New PO by hand</div>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
            <div><label className="section-label mb-1" htmlFor="newpo-partner">PACT partner</label>
              <input id="newpo-partner" className="field" list="partners" autoFocus value={draft.partner} onChange={(e) => setDraft({ ...draft, partner: e.target.value })} />
              <datalist id="partners">{partners.map((p) => <option key={p} value={p} />)}</datalist></div>
            <div><label className="section-label mb-1" htmlFor="newpo-po">PO #</label>
              <input id="newpo-po" className="field" value={draft.job_number} onChange={(e) => setDraft({ ...draft, job_number: e.target.value })} /></div>
            {canPrice && <div><label className="section-label mb-1" htmlFor="newpo-amount">Amount</label>
              <input id="newpo-amount" className="field" inputMode="decimal" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} /></div>}
            <div className="col-span-2 md:col-span-1"><label className="section-label mb-1" htmlFor="newpo-desc">Description</label>
              <input id="newpo-desc" className="field" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></div>
            <div><label className="section-label mb-1" htmlFor="newpo-dev">Development</label>
              <input id="newpo-dev" className="field" enterKeyHint="done" value={draft.development} onChange={(e) => setDraft({ ...draft, development: e.target.value })} /></div>
          </div>
          <div className="mt-3 flex gap-2">
            <button type="submit" className="btn btn-primary">Add PO</button>
            <button type="button" className="btn btn-ghost" onClick={() => setAddOpen(false)}>Cancel</button>
          </div>
        </form>
      )}

      {!loaded ? (
        <div className="card divide-y divide-rulesoft">{skeletonRows}</div>
      ) : list.length === 0 ? (
        <div className="empty">{jobs.length === 0 ? "No POs yet. Upload a partner PO and the job builds itself from it." : `Nothing matches “${q.trim()}”. Try a PO number, a partner or a street.`}</div>
      ) : (
      <div className="card anim-fade divide-y divide-rulesoft">
        {list.map((j) => (
          <div key={j.id} className={`card-pad ${openId === j.id ? "" : "transition-colors hover:bg-paper"} ${j.canceled ? "opacity-50" : ""}`} data-job-card={j.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button type="button" className="flex min-w-0 flex-1 items-start gap-2 text-left" aria-expanded={openId === j.id} onClick={() => toggleOpen(j)}>
                <span aria-hidden className={`mt-1 text-[11px] text-inksoft transition-transform duration-150 ${openId === j.id ? "rotate-90" : ""}`}>▸</span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-[14px] font-semibold ${j.canceled ? "line-through" : ""}`}>
                    {shortSite(j)}
                    {(j.po_number || j.job_number) ? <span className="ml-1.5 font-mono text-xs text-inksoft">PO {j.po_number || j.job_number}</span> : null}
                  </span>
                  <span className="block truncate text-[13px] text-inksoft md:max-w-[640px]">{[j.partner, shortWork(j)].filter(Boolean).join(" · ")}</span>
                  {!j.canceled && (() => {
                    const stages = pipeline(j);
                    const current = stages.findIndex(([, done]) => !done);
                    return (
                      <span className="mt-1 flex flex-wrap items-center gap-1">
                        {stages.map(([l, done], i) => (
                          <span key={l} className={`chip-outline ${done ? "border-ok bg-ok/10 text-ok" : i === current ? "border-work text-work" : "border-rulesoft text-rule"}`}>{l}</span>
                        ))}
                        {j.proposal_sent && !j.approved && <span className="chip-outline ml-1 border-work text-work">{days(j.proposal_sent)}D SINCE PROPOSAL</span>}
                        {canInvoice && j.work_done && !j.invoice_sent && <span className="chip-outline ml-1 border-work text-work" data-ready-to-invoice>READY TO INVOICE</span>}
                        {canInvoice && j.invoice_sent && !j.received && <span className="chip-outline ml-1 border-inksoft text-inksoft">{days(j.invoice_sent)}D UNPAID</span>}
                      </span>
                    );
                  })()}
                </span>
              </button>
              <div className="flex shrink-0 items-center gap-2">
                {canPrice && <span className="font-mono text-sm font-semibold tabular-nums">{fmt(Number(j.amount) || invTotal(j))}</span>}
                {(j.attachments || []).length > 0 && <button type="button" className="btn-icon chip w-auto min-w-[44px] border-0 px-1.5 shadow-none text-inksoft" aria-label="Documents and photos" onClick={() => setAttachJob(j)}>📎 {(j.attachments || []).length}</button>}
                <RowActions items={[
                  { label: "Documents", glyph: "📎", onSelect: () => setAttachJob(j) },
                  { label: "Open on Schedule", glyph: "📅", href: `/pact/schedule?job=${j.id}` },
                  { label: "Restore", glyph: "↺", hidden: !canEdit || !j.canceled, onSelect: () => patch(j, { canceled: false }) },
                  // deleteJob asks its own window.confirm — no second prompt here
                  { label: "Delete PO…", hidden: !canEdit, destructive: true, onSelect: () => deleteJob(j) },
                ]} />
              </div>
            </div>
            {openId === j.id && !j.canceled && (() => {
              const beforeN = (j.attachments || []).filter((a) => isImg(a.name) && a.name.toLowerCase().startsWith("before")).length;
              const afterN = (j.attachments || []).filter((a) => isImg(a.name) && a.name.toLowerCase().startsWith("after")).length;
              const photoN = (j.attachments || []).filter((a) => isImg(a.name)).length;
              const canReread = canPrice && (j.attachments || []).some((a) => /\.pdf$/i.test(a.name) && !isMade(a));
              return (
              <div className="anim-open mt-3 border-t border-rulesoft pt-3">
                <div className="mb-2.5 flex flex-wrap items-center gap-2">
                  {canEdit && <button type="button" className="btn btn-ghost btn-sm" onClick={() => snapPhotos(j, "before")} disabled={busy}>📷 Before{beforeN > 0 ? ` · ${beforeN}` : ""}</button>}
                  {canEdit && <button type="button" className="btn btn-ghost btn-sm" onClick={() => snapPhotos(j, "after")} disabled={busy}>📷 After{afterN > 0 ? ` · ${afterN}` : ""}</button>}
                  {photoN > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => makePhotoPdf(j)} disabled={busy} title="Before and after pictures on one PDF, with the job on top, to send out" data-photo-pdf>⬇ Photos (PDF)</button>}
                  {canReread && (
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} title="Rebuilds this job from its PDF: the reader, then the price list. Photos and documents stay"
                      onClick={async () => {
                        if (!window.confirm("Re-read this PO? The partner, address, description, work lines and amount are replaced with what the PDF says. Photos and documents stay.")) return;
                        setBusy(true); await rereadJob(j); setBusy(false);
                      }}>Re-read the PO</button>
                  )}
                </div>
                {canEdit && (
                <div className="mb-2.5 flex flex-wrap gap-2">
                  <button type="button" className="btn-stamp" title={j.proposal_sent ? "Tap to clear" : "Tap when the proposal has gone out"} onClick={() => patch(j, j.proposal_sent ? { proposal_sent: null } : { proposal_sent: today() })}><Stamp label={j.proposal_sent ? `PROPOSAL SENT · ${shortDay(j.proposal_sent)}` : "MARK PROPOSAL SENT"} tone={j.proposal_sent ? "ok" : "mute"} /></button>
                  <button type="button" className="btn-stamp" title={j.approved ? "Tap to clear" : "Tap when the partner approves"} onClick={() => patch(j, { approved: !j.approved })}><Stamp label={j.approved ? "APPROVED ✓" : "MARK APPROVED"} tone={j.approved ? "ok" : "mute"} /></button>
                  <button type="button" className="btn-stamp" title={j.work_done ? "Tap to clear" : "Tap when the work is done"} onClick={() => patch(j, { work_done: !j.work_done })}><Stamp label={j.work_done ? "WORK DONE ✓" : "MARK WORK DONE"} tone={j.work_done ? "ok" : "mute"} /></button>
                  {canInvoice && <button type="button" className="btn-stamp" title={j.received ? "Tap to clear" : "Tap when the payment comes in"} onClick={() => patch(j, j.received ? { received: false, paid_date: null } : { received: true, paid_date: today() })}><Stamp label={j.received ? `PAID${j.paid_date ? ` · ${shortDay(j.paid_date)}` : ""}` : "MARK PAID"} tone={j.received ? "ok" : "mute"} /></button>}
                </div>
                )}
                <Disclosure label="PO details" sublabel="partner, PO #, contact" open={!!detailsOpen[j.id]}
                  onToggle={() => setDetailsOpen((p) => ({ ...p, [j.id]: !p[j.id] }))}>
                <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
                  {([["partner", "Partner"], ["address", "Job address"], ["po_number", "PO #"], ...(canInvoice ? [["invoice_number", "Invoice #"]] : []), ["property_unit", "Apt / unit"], ["contact", "Contact"], ["description", "Work description"]] as ["partner" | "address" | "po_number" | "invoice_number" | "property_unit" | "contact" | "description", string][]).map(([k, label]) => (
                    <div key={k} className={k === "description" || k === "address" ? "col-span-2" : ""}><label className="section-label mb-1" htmlFor={`${j.id}-${k}`}>{label}</label>
                      <input id={`${j.id}-${k}`} className="field" value={j[k] || ""} readOnly={!canEdit} onChange={(e) => canEdit && setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, [k]: e.target.value } : x)))}
                        onFocus={(e) => { atFocus.current = e.target.value; }}
                        onBlur={(e) => { const v = k === "invoice_number" ? e.target.value.trim() : e.target.value; if (canEdit && v !== atFocus.current) patch(j, { [k]: v } as Partial<Job>); }} /></div>
                  ))}
                </div>
                </Disclosure>
                {/* the PO seeds one line — add more when the job runs past what's listed (excess materials etc.) */}
                <div className="mt-3">
                  <div className="section-label mb-1.5">Work lines · what gets billed for this job</div>
                  {!canEdit && itemsOf(j).map((it, i) => (
                    <div key={i} className="mb-1 flex flex-wrap items-center gap-2 text-[13px]">
                      <span className="flex-1">{it.description || "(no wording)"}</span>
                      <span className="font-mono text-inksoft">{it.qty} {it.unit}</span>
                    </div>
                  ))}
                  {!canEdit && itemsOf(j).length === 0 && <div className="empty">No lines yet.</div>}
                  {canEdit && (
                    <WorkLines items={itemsOf(j)} canPrice={canPrice} bufferKey={`${j.id}:wl`}
                      onChange={(next) => setItems(j, next)} onCommit={(next) => setItems(j, next, true)}
                      flashWithUndo={flashWithUndo}
                      taxPct={canPrice ? taxRate(j) : undefined}
                      onTax={canPrice ? (n2) => {
                        // the billed amount follows the rate — otherwise the
                        // job keeps yesterday's total at today's tax
                        const sub = invSubtotal(j);
                        patch(j, sub > 0 ? { tax_pct: n2, amount: sub * (1 + n2 / 100) } : { tax_pct: n2 });
                      } : undefined}
                      extra={canPrice ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} title="Fills the lines and prices from the partner price list. Plaster brings its primer and paint" onClick={() => fillFromList(j)}>Price from list</button> : undefined} />
                  )}
                </div>
                <CardToolbar className="mt-3" align="end" sticky
                  primary={<button type="button" className="btn btn-primary" onClick={() => toggleOpen(j)}>Done</button>}
                  menuLabel="Papers"
                  menu={canInvoice ? [
                    { label: "Proposal + invoice", glyph: "⬇", disabled: busy, title: "Both files in one tap: the proposal PDF and the invoice PDF", onSelect: () => saveBoth(j) },
                    { label: "View proposal", disabled: busy, title: "Read the letter on screen first", onSelect: () => viewProposal(j) },
                    { label: "Proposal (PDF)", glyph: "⬇", disabled: busy, title: "The proposal to send. Opens the same everywhere", onSelect: () => makeProposalPdf(j) },
                    { label: "Proposal (Word)", glyph: "⬇", disabled: busy, title: "The same letter as a Word file, to edit before sending", onSelect: () => makeProposal(j) },
                    { label: "Invoice package (PDF)", glyph: "⬇", disabled: busy, title: "The invoice, the PO and the before and after photos in one PDF", onSelect: () => buildPackage(j) },
                    { label: "Edit invoice", title: "The invoice lines, tax and total", onSelect: () => setInvJob(j) },
                  ] : []} />
              </div>
              );
            })()}
          </div>
        ))}
      </div>
      )}

      {/* ---------- invoice editor ---------- */}
      {invJob && canInvoice && (() => {
        const j = jobs.find((x) => x.id === invJob.id) || invJob;
        const items = itemsOf(j);
        return (
          <Modal wide title={`Invoice · PO ${j.po_number || j.job_number}`} onClose={() => setInvJob(null)}
            primary={<button type="button" className="btn btn-primary" onClick={() => {
              (document.activeElement as HTMLElement | null)?.blur?.();
              setInvJob(null);
            }}>Done</button>}
            secondary={<button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setInvJob(null); buildPackage(j); }}>⬇ Invoice package (PDF)</button>}>
              <div className="mb-3 text-[13px] text-inksoft">{j.partner} · {j.address}{j.property_unit ? ` · Apt ${j.property_unit}` : ""}</div>
              <div className="mb-3 grid grid-cols-2 gap-2.5 md:grid-cols-4">
                <div><div className="section-label mb-1">Invoice #</div>
                  <input className="field" aria-label="Invoice #" value={j.invoice_number || ""} placeholder="when priced"
                    onChange={(e) => { setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, invoice_number: e.target.value } : x))); setInvJob((prev) => (prev && prev.id === j.id ? { ...prev, invoice_number: e.target.value } : prev)); }}
                    onFocus={(e) => { atFocus.current = e.target.value; }}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v !== atFocus.current) patch(j, { invoice_number: v }); }} /></div>
                <div><div className="section-label mb-1">Subtotal</div>
                  <div className="field flex items-center bg-paper font-mono">{fmt(invSubtotal(j))}</div></div>
                <div><div className="section-label mb-1">Sales tax %</div>
                  <input className="field w-24 px-1.5 py-1.5 text-right font-mono" inputMode="decimal" aria-label="Sales tax %"
                    {...num(`${j.id}:tax`, taxRate(j),
                      (n) => setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, tax_pct: n } : x))),
                      (n) => { const j2 = { ...j, tax_pct: n }; const sub = invSubtotal(j2); patch(j2, sub > 0 ? { tax_pct: n, amount: sub * (1 + n / 100) } : { tax_pct: n }); },
                      { showZero: true })} /></div>
                <div><div className="section-label mb-1">Total (with tax)</div>
                  <div className="field flex items-center bg-paper font-mono font-semibold">{fmt(invTotal(j))}</div></div>
              </div>
              <WorkLines items={items} canPrice bufferKey={`${j.id}:inv`}
                onChange={(next) => setItems(j, next)} onCommit={(next) => setItems(j, next, true)} flashWithUndo={flashWithUndo} />
          </Modal>
        );
      })()}

      {/* ---------- the proposal letter, read on screen before it goes anywhere ---------- */}
      {viewJob && canInvoice && (() => {
        const { job: j, f } = viewJob;
        const sub = f.lines.reduce((t, l) => t + l.qty * l.unit_price, 0);
        const tax = Math.round(sub * f.taxPct) / 100;
        return (
          <PrintShell title={`proposal ${f.poNumber || ""} ${(f.serviceAddress || "").split(",")[0]}`.trim()} onClose={() => setViewJob(null)} sheetClass="text-logo-ink"
            toolbar={<>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => saveProposalPdfFor(j)}>⬇ Proposal (PDF)</button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => saveProposalFor(j)}>⬇ Proposal (Word)</button>
            </>}>
            {/* the name of what's on screen stays in view as the letter scrolls; never printed */}
            <div className="no-print sticky top-0 z-10 -mx-8 -mt-8 mb-4 border-b border-rulesoft bg-white/95 px-8 py-2 font-display text-[13px] font-bold uppercase tracking-wide">Proposal · PO {f.poNumber}</div>
            {/* centered, matching the letter the PDF and Word file print */}
            <Letterhead />
            {/* this is the letter they are about to send — it reads the same
                as the PDF and the Word file, down to the sign-off */}
            <div className="mt-5 flex items-end justify-between pb-2">
              <div className="font-display text-2xl font-bold uppercase tracking-wide text-logo-brown">Proposal</div>
              <div className="text-right text-[12px] leading-tight">
                {f.poNumber && <div><span className="text-[11px] font-bold uppercase tracking-widest text-logo-tan">PO # </span><b>{f.poNumber}</b></div>}
                <div><span className="text-[11px] font-bold uppercase tracking-widest text-logo-tan">Date </span><b>{f.date}</b></div>
              </div>
            </div>
            <div className="mt-4 text-[13px] leading-relaxed">
              {f.attn && <div className="font-semibold">ATTN: {f.attn}</div>}
              {f.attnTitle && <div className="text-logo-muted">{f.attnTitle}</div>}
              {f.billTo.map((b, i) => <div key={i} className="text-logo-muted">{b}</div>)}
              <div className="mt-3">Dear {(f.attn || "").split(/[\s,]+/)[0] || "Sir or Madam"},</div>
              <div className="mt-2">
                {COMPANY.letterhead.name} is pleased to submit this proposal for the following work
                {(f.serviceAddress || "").split(",")[0].trim() ? ` at ${(f.serviceAddress || "").split(",")[0].trim()}` : ""}.
              </div>
            </div>
            <div className="mt-3 bg-logo-cream px-3 py-2 text-[13px]">
              <span className="text-[11px] font-bold uppercase tracking-widest text-logo-tan">Service Address: </span>
              <b>{f.serviceAddress || ""}</b>
            </div>
            <div className="mt-4 font-display text-[13px] font-bold uppercase tracking-widest text-logo-teal">Scope of Work</div>
            <table className="mt-1 w-full border-collapse text-[12px]">
              <thead><tr className="border-b-2 border-logo-brown bg-logo-cream text-left font-display text-[11px] uppercase tracking-widest text-logo-tan">
                <th className="p-1.5">Description</th>
                <th className="p-1.5 text-center">Qty</th>
                <th className="p-1.5 text-right">Unit price</th>
                <th className="p-1.5 text-right">Amount</th>
              </tr></thead>
              <tbody>
                {f.lines.map((l, i) => (
                  <tr key={i} className="align-top border-b border-logo-hair [&>td]:py-2">
                    <td className="p-1.5">{l.description}</td>
                    <td className="p-1.5 text-center font-mono text-logo-muted">{l.qty}{l.unit && l.unit.toUpperCase() !== "EACH" ? ` ${l.unit.toUpperCase()}` : ""}</td>
                    <td className="p-1.5 text-right font-mono text-logo-muted">{fmt(l.unit_price)}</td>
                    <td className="p-1.5 text-right font-mono font-semibold">{fmt(l.qty * l.unit_price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex flex-col items-end gap-0.5 text-[13px] text-logo-muted">
              <div>Total Cost (labor and materials): <span className="font-mono text-logo-ink">{fmt(sub)}</span></div>
              <div>Sales Tax ({f.taxPct}%): <span className="font-mono text-logo-ink">{fmt(tax)}</span></div>
            </div>
            <div className="mt-2 flex items-center justify-end gap-4 bg-logo-brown px-3 py-2 text-white">
              <div className="font-display text-[13px] font-bold uppercase tracking-widest">Grand Total</div>
              <div className="font-mono text-base font-bold">{fmt(sub + tax)}</div>
            </div>
            <div className="mt-4 text-[13px]">Please sign and return a copy of this proposal to authorize the work.</div>
            <div className="mt-8 flex gap-6 text-[11px] font-bold uppercase tracking-widest text-logo-tan">
              <div className="flex-1 border-t border-logo-hair pt-1">Accepted by</div>
              <div className="flex-1 border-t border-logo-hair pt-1">Date</div>
            </div>
            <div className="mt-6 text-[13px]">
              <div>Best regards,</div>
              <div className="mt-2 font-semibold">{COMPANY.letterhead.signer}</div>
              <div className="text-[12px] text-logo-muted">{COMPANY.letterhead.signerTitle}  ·  {COMPANY.letterhead.name}</div>
            </div>
            <div className="mt-6 border-t border-logo-hair pt-2 text-center text-[11px] text-logo-muted">{COMPANY.letterhead.footer}</div>
          </PrintShell>
        );
      })()}

      {measureJob && (() => {
        const j = jobs.find((x) => x.id === measureJob.id) || measureJob;
        return (
          <MeasurePanel job={{ id: j.id, label: `PO ${j.po_number || j.job_number || ""}`, attachments: j.attachments || [], items: itemsOf(j) }}
            onAttach={(files) => attachFiles(j, files)} onApply={(li, sq, note) => applyMeasured(j, li, sq, note)}
            onClose={() => setMeasureJob(null)} flash={flash} />
        );
      })()}

      {/* ---------- documents & photos ---------- */}
      {attachJob && (() => {
        const photoN = (attachJob.attachments || []).filter((a) => isImg(a.name)).length;
        // images that came in through "Upload files" have no before/after
        // prefix — they still need to be viewable (and deletable) here
        const loose = (attachJob.attachments || []).filter((a) => isImg(a.name) && !/^(before|after)/i.test(a.name));
        return (
        <Modal title={`Documents · PO ${attachJob.po_number || attachJob.job_number || ""}`} onClose={() => setAttachJob(null)}
          primary={canEdit ? <button type="button" className="btn btn-primary" onClick={() => fileRef.current?.click()} disabled={busy} title="Pictures, a photos zip or a document, several at once">Upload files</button> : undefined}
          secondary={canEdit ? <>
            <button type="button" className="btn btn-ghost" onClick={() => snapPhotos(attachJob, "before")} disabled={busy}>📷 Before</button>
            <button type="button" className="btn btn-ghost" onClick={() => snapPhotos(attachJob, "after")} disabled={busy}>📷 After</button>
          </> : undefined}
          menu={photoN > 0 ? [
            { label: "Photos (PDF)", glyph: "⬇", disabled: busy, title: "Before and after pictures on one PDF, with the job on top, to send out", onSelect: () => makePhotoPdf(attachJob) },
          ] : undefined}>
            {(["before", "after"] as const).map((kind) => {
              const photos = (attachJob.attachments || []).filter((a) => isImg(a.name) && a.name.toLowerCase().startsWith(kind));
              return (
                <div key={kind} className="mb-3">
                  <div className="section-label mb-1">{kind} ({photos.length})</div>
                  {photos.length > 0
                    ? <div className="grid grid-cols-3 gap-1.5">{photos.map((a) => thumb(attachJob, a))}</div>
                    : <div className="empty py-3">No {kind} photos yet.</div>}
                </div>
              );
            })}
            {loose.length > 0 && (
              <div className="mb-3">
                <div className="section-label mb-1">other photos ({loose.length})</div>
                <div className="grid grid-cols-3 gap-1.5">{loose.map((a) => thumb(attachJob, a))}</div>
              </div>
            )}
            {(attachJob.attachments || []).filter((a) => !isImg(a.name)).map((a) => (
              <div key={a.path} className="mb-1.5 flex items-center gap-1">
                <button type="button" className="row-btn rounded-sm border border-rulesoft p-2.5 text-sm hover:border-work active:border-work" onClick={() => openAttachment(a.path)}>📄 {a.name}</button>
                {canEdit && <button type="button" className="btn-icon border-0 shadow-none text-alert" aria-label="Delete file" onClick={() => removeAttachment(attachJob, a.path, a.name)}>✕</button>}
              </div>
            ))}
        </Modal>
        );
      })()}
      {/* a photo, big: over the Documents dialog, closed with ✕, Escape or a tap outside */}
      {attachJob && lightbox && (
        <Modal wide title={/^before/i.test(lightbox.name) ? "Before photo" : /^after/i.test(lightbox.name) ? "After photo" : "Photo"} onClose={() => setLightbox(null)}
          secondary={<button type="button" className="btn btn-ghost" onClick={() => openAttachment(lightbox.path)}>Open in a new tab</button>}>
          {photoUrls[lightbox.path]
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={photoUrls[lightbox.path]} alt={lightbox.name} className="anim-fade mx-auto max-h-[70vh] w-auto max-w-full rounded-sm object-contain" />
            : <div className="skeleton mx-auto h-64 w-full" />}
          <div className="mt-2 truncate text-center text-[12px] text-inksoft">{lightbox.name}</div>
        </Modal>
      )}
      <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { const fs = Array.from(e.target.files || []); if (fs.length && attachJob) uploadFiles(attachJob, fs); e.target.value = ""; }} />
      {/* no capture= here on purpose: the phone offers the camera AND the photo
          library, so pictures someone else took (or downloaded) can go up too */}
      <input ref={photoRef} type="file" accept="image/*" multiple className="hidden"
        onChange={(e) => { const fs = Array.from(e.target.files || []); const t = photoTarget; const j = t ? jobs.find((x) => x.id === t.id) : null; if (fs.length && t && j) addPhotos(j, fs, t.kind); e.target.value = ""; }} />

      <Toast msg={msg} progress={progress} action={action} />
      {busy && <div className="busy-bar" aria-busy="true" aria-label="Working" />}
    </div>
  );
}
