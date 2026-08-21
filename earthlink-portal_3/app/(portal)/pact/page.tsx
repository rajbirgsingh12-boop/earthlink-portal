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
import ActionMenu, { RowActions } from "@/components/ActionMenu";
import PageHeader from "@/components/PageHeader";
import CardToolbar from "@/components/CardToolbar";
import Modal from "@/components/Modal";
import Disclosure from "@/components/Disclosure";
import { useLive } from "@/lib/useLive";
import { COMPANY } from "@/lib/company";
import { useNumBuffer } from "@/lib/numBuffer";
import { shrinkImage } from "@/lib/shrinkImage";
import { cleanPhone, smsHref, prettyPhone } from "@/lib/notify";
import { parsePactPoText, type PactPoFields, type PoItem } from "@/lib/parsePactPo";
import { priceLinesFor, soleKey, keysIn, normUnit, loadPrices, attnFrom, DEFAULT_ATTN, type PriceItem, cleanLineWording } from "@/lib/priceBook";

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
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [invJob, setInvJob] = useState<Job | null>(null);
  // which jobs show their details panel — per job, so opening one job's
  // details never flips another's, and closing a job doesn't forget it
  const [detailsOpen, setDetailsOpen] = useState<Record<string, boolean>>({});
  const showDetailsFor = (id: string) => setDetailsOpen((p) => ({ ...p, [id]: true }));
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
    const first = d.split(/(?<=[.;])\s+/)[0] || d;
    return first.length > 54 ? `${first.slice(0, 54).trim()}…` : first;
  };
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
  const priceFromList = async (text: string, existing: Item[], opts: { bundle?: boolean; refresh?: boolean; fillOnly?: boolean; prepOnly?: boolean } = {}): Promise<Item[]> => {
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
      // its own wording first; failing that, the wording it had before its
      // wrapped line was added — otherwise a row reading "plaster … and paint"
      // matches nothing and the list bills the plaster a second time
      const k = it.key || exact || soleKey(it.description, bk) || (it.base ? soleKey(it.base, bk) : null);
      if (k && !covered.has(k)) covered.set(k, i);
    });
    const out = [...existing];
    for (const l of lines) {
      const at = covered.get(l.key);
      if (at === undefined) {
        // A PO that priced its own table is the agreement — nothing new goes
        // beside it, EXCEPT the prep a wet trade always carries: plaster is
        // never billed without its primer and paint.
        const isPrep = l.key === "primer" || l.key === "paint_sf";
        if (opts.fillOnly && !(opts.prepOnly && isPrep)) continue;
        out.push({ description: l.description, qty: l.qty, unit: l.unit, unit_price: l.unit_price, key: l.key });
        covered.set(l.key, out.length - 1);
        continue;
      }
      const it = out[at];
      // a line that says nothing but the trade's own name follows the list's
      // wording — that is how "Plaster" picks up its "Scrape and" on a repair
      // job. A PO's own sentence matches neither name and keeps its words.
      const bkName = bk.find((b) => b.key === l.key)?.description || "";
      const takesName = !!it.key || sameText(it.description, bkName) || sameText(it.description, l.description);
      // a line the portal put there follows the list; a price the PO stated
      // stays the PO's, because that one is the agreement
      if (realPrice(it.unit_price)) {
        // a line that already carries a price of its own is the PO's or theirs
        // — re-pricing only touches lines the portal itself wrote
        if (opts.refresh && it.key) out[at] = { ...it, description: l.description, unit: l.unit, unit_price: l.unit_price };
        // a hand-typed "Plaster" that someone also priced by hand still takes
        // the list's wording ("Scrape and plaster") — the typed price stays
        else if (opts.refresh && takesName) out[at] = { ...it, description: l.description, key: it.key || l.key };
        continue;
      }
      out[at] = { ...it, description: takesName ? l.description : it.description, unit: it.unit || l.unit, unit_price: l.unit_price, qty: Number(it.qty) > 1 ? it.qty : l.qty, key: it.key || l.key };
    }
    return out.filter((it) => it.description.trim());
  };

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
      const next = await priceFromList(text, before, { refresh: true });
      const added = next.length - before.length;
      const changed = next.filter((n, i) => i < before.length && (n.unit_price !== before[i].unit_price || n.description !== before[i].description)).length;
      if (added === 0 && changed === 0) {
        if (!auto) flash("Already matching the price list — nothing to change");
        return;
      }
      setItems(live, next, true);
      flash(auto
        ? "Priced off the quantities on the job — check the lines before invoicing"
        : [added > 0 ? `${added} line${added === 1 ? "" : "s"} added` : "", changed > 0 ? `${changed} re-priced` : ""]
            .filter(Boolean).join(" · ") + " from the price list — check them before invoicing");
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
      if (!made) { flash("Nothing priced on this job yet — fill the work lines in first"); return; }
      const { bytes, name: def } = made;
      const name = askFileName(def);
      if (!name) return;
      saveBytes(bytes, name, "application/pdf");
      await keepOnJob(j, bytes, def, "application/pdf");
      await stampProposalSent(j);
      flash("Proposal saved as a PDF — a copy is kept on the job, and the signed one reads straight back in here");
    } catch (err) {
      flash(`Couldn't build the proposal (${err instanceof Error ? err.message.slice(0, 60) : "unknown"})`);
    } finally { setBusy(false); }
  };

  const makeProposal = async (j: Job) => {
    setBusy(true);
    try {
      const made = await proposalBytes(j);
      if (!made) { flash("Nothing priced on this job yet — fill the work lines in first"); return; }
      const { bytes, name: def } = made;
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
  // the one-shot card saves straight off — no name to type, same as the invoice
  const saveProposalPdfFor = async (j: Job, quiet = false): Promise<boolean> => {
    if (!quiet) setBusy(true);
    try {
      const made = await proposalPdfBytes(j);
      if (!made) { flash("Nothing priced on this job yet — fill the work lines in first"); return false; }
      const { bytes, name } = made;
      saveBytes(bytes, name, "application/pdf");
      await keepOnJob(j, bytes, name, "application/pdf");
      await stampProposalSent(j);
      if (!quiet) flash("Proposal saved as a PDF — a copy is kept on the job");
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
      if (!made) { flash("Nothing priced on this job yet — fill the work lines in first"); return false; }
      const { bytes, name } = made;
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
      const p = await saveProposalPdfFor(j, true);
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
      // …and so does an answer whose work lines don't add up to the total the PO
      // printed: the server's PDF engine can run two figures together on a tight
      // table, and the line it then drops is a line nobody would get paid for.
      // The phone reads it with a different engine, so it's worth asking.
      const serverShort = !isDocx && !!fields && !fields.rowsAddUp;
      const serverFields = fields;
      if (serverShort) fields = null;
      // 2) browser fallback
      if (!fields && isDocx) fields = { po: "", poDate: "", desc: "", scope: "", partner: "", address: "", billBlock: "", contact: "", punit: "", amount: 0, rows: [], rowsAddUp: true, readable: false };
      if (!fields) {
        try {
          const pdfjs = await import("pdfjs-dist");
          pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
          const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
          const { readPoOrProposalPages } = await import("@/lib/parsePactProposal");
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
      // one (a hand-typed job carries the PO in job_number, so check both)
      // a letter with no PO number is still the same job if it's the same
      // address for the same money — otherwise every upload makes a new one
      if (!f.po && f.address) {
        const { data: same } = await sb().from("pact_jobs").select("id,amount,address").ilike("address", `${f.address.slice(0, 30)}%`).limit(20);
        const hit = ((same || []) as Job[]).find((x) => Math.abs(Number(x.amount || 0) - amount) < 0.02);
        if (hit) {
          setBusy(false);
          await load();
          setOpenId(hit.id); showDetailsFor(hit.id);
          flash("That proposal is already here — opened it (nothing new was created)");
          return;
        }
      }
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
          setOpenId(dupe.id); showDetailsFor(dupe.id);
          flash(`PO ${f.po} is already here — opened it (nothing new was created)`);
          return;
        }
      }
      const bkNow = await priceBook();
      const seed: Item[] = unreadable ? []
        : f.rows.length > 0
          ? f.rows.map((r) => ({ description: r.description, qty: r.qty, unit: normUnit(r.uom || unitFor(r.description)), unit_price: r.unit_price, ...(r.base ? { base: r.base } : {}) }))
            // a placeholder row that names more than one trade ("scrape plaster
            // paint") is dropped: keeping it would leave a dollar line sitting
            // beside the three real lines it stands for
            .filter((it) => realPrice(it.unit_price) || keysIn(it.description, bkNow).length < 2)
          : (f.desc || f.scope) ? [{ description: (f.desc || f.scope).slice(0, 120), qty: 1, unit: unitFor(f.desc || f.scope), unit_price: 0 }] : [];
      // What is this PO for? Whatever the price list already answers — plaster
      // brings its primer and paint with it — gets filled in, priced. A price
      // the PO itself states is never touched: that one is the agreement.
      // when the PO priced its own lines, that IS the deal — fill the gaps but
      // never add prep work it didn't ask for
      const poPriced = seed.some((it) => realPrice(it.unit_price));
      // the same words must only be priced once — a PO often repeats its
      // description as its scope, and counting both doubles every quantity
      const said = [...new Set([f.desc, f.scope, f.rows.map((r) => r.description).join(" ")]
        .map((x) => (x || "").trim()).filter(Boolean))];
      const priced = (await priceFromList(said.join(". "), seed, { fillOnly: poPriced, prepOnly: poPriced }))
        // a placeholder the list had no answer for is work still to be priced —
        // showing it as a dollar would put "$1.00" on a proposal
        .map((it) => (Number(it.unit_price) === PLACEHOLDER ? { ...it, unit_price: 0 } : it));
      // a PO that totals a dollar hasn't told us the money — the priced lines have
      const lineSub = priced.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);
      const amountOut = amount > PLACEHOLDER || lineSub <= 0 ? amount : Math.round(lineSub * 1.08875 * 100) / 100;
      const { data: job, error } = await sb().from("pact_jobs").insert({
        partner: f.partner, development: "", job_number: f.po, description: (f.desc || f.scope).slice(0, 120), amount: amountOut,
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
      showDetailsFor((job as Job).id);
      // the finished job, with the lines the price list filled in — and if
      // that read comes back empty, the job we just made is still the truth
      const { data: fresh } = await sb().from("pact_jobs").select("*").eq("id", (job as Job).id).single();
      const ready = (fresh as Job | null)?.id ? (fresh as Job) : (job as Job);
      if (!unreadable) setOneShot({ id: ready.id, job: ready, note: f.po ? `PO ${f.po}` : "PO read" });
      flash(ue
        ? `Job created, but the PDF didn't attach (${/bucket/i.test(ue.message) ? "storage not set up — run supabase/upgrade_invoices_aging_docs.sql" : ue.message.slice(0, 80)}) — open the job → ⋯ → Documents`
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
      // the file the user downloads keeps the name they expect. Papers the
      // portal wrote live under their own folder so the invoice package can
      // tell them apart from the PO and the photos and never swallow itself.
      const safe = name.replace(/[#?%&]+/g, "").replace(/\s{2,}/g, " ").trim();
      const path = `pact/${j.id}/made/${safe}`;
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
          const seed: Item[] = parsed.rows.map((r) => ({ description: r.description, qty: r.qty, unit: r.uom || unitFor(r.description), unit_price: r.unit_price, ...(r.base ? { base: r.base } : {}) }));
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
      for (const j0 of folderResult.made) {
        flash(`Making invoices… ${++done} of ${folderResult.made.length}`);
        // whatever was corrected since the import is what gets billed
        const j = jobs.find((x) => x.id === j0.id) || j0;
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
  // a paper the portal made, filed on the job — never merged back into a package
  const isMade = (a: { path?: string; name?: string }) => /\/made\//.test(a.path || "");

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

  // Until the profile answers, nothing renders — the money on this page must
  // not flash at an account that isn't allowed to see it.
  if (!role) return <div className="card p-4 text-sm text-inksoft">Checking your account…</div>;

  return (
    <div>
      <PageHeader title="PACT">
        <Link className="btn btn-ghost" href="/pact/schedule">📅 Schedule</Link>
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
            <CardToolbar className="mt-3"
              primary={canInvoice && billable.length > 0 ? (
                <button className="btn btn-primary" disabled={busy} onClick={() => saveBoth(j)}>
                  {busy ? "Working…" : "⬇ Proposal + invoice"}
                </button>
              ) : undefined}
              secondary={<button className="btn btn-ghost" disabled={busy} onClick={() => setOneShot(null)}>Done</button>}
              menuLabel="Papers"
              menu={[
                { label: "View proposal", disabled: busy, title: "Read the proposal letter on screen first", onSelect: () => viewProposal(j) },
                { label: "⬇ Proposal (PDF)", disabled: busy, title: "The proposal to send — opens the same everywhere", onSelect: () => saveProposalPdfFor(j) },
                // this one saves the invoice PDF alone — the full zip lives on the job's Papers menu
                { label: "⬇ Invoice (PDF)", hidden: !canInvoice, disabled: busy || billable.length === 0,
                  title: billable.length === 0 ? "The job needs a work line first" : "Just the invoice, as a PDF",
                  onSelect: () => saveInvoiceFor(j) },
              ]} />
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
                {busy ? "Working…" : `⬇ Download all ${folderResult.made.length} proposals (zip)`}
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
            {canPrice && <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Amount</div>
              <input className="field" inputMode="decimal" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} /></div>}
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
              <div className="text-[11px] uppercase tracking-[.12em] text-inksoft">{l}</div>
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
          <div className="flex shrink-0 flex-wrap gap-2">
            <button className="btn btn-primary" onClick={() => poRef.current?.click()} disabled={busy} title="A partner PO (PDF) or one of our proposal letters (Word)">📄 Upload PO / proposal</button>
            <ActionMenu label="More ways to add" items={[
              { label: "Upload a folder of proposals", hidden: !canInvoice, disabled: busy, title: "Pick a folder of proposal letters — every one becomes a job, then all the invoices download in one zip", onSelect: () => folderRef.current?.click() },
              { label: "Proposal template", hidden: !canInvoice, disabled: busy, title: "A blank proposal letter in our layout — fill it in, and uploading it back here builds the job and the invoice", onSelect: blankProposal },
              { label: "Add a job manually", onSelect: () => setAddOpen(!addOpen) },
            ]} />
          </div>
        </div>
      )}
      <input className="field mb-3" placeholder="Search partner, address, PO #…" value={q} onChange={(e) => setQ(e.target.value)} />

      <div className="card divide-y divide-rulesoft">
        {list.map((j) => (
          <div key={j.id} className={`p-3.5 ${j.canceled ? "opacity-50" : ""}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button className="min-w-0 text-left" onClick={() => setOpenId(openId === j.id ? null : j.id)}>
                <div className={`text-[14px] font-semibold ${j.canceled ? "line-through" : ""}`}>
                  {shortSite(j)}
                  {(j.po_number || j.job_number) ? <span className="ml-1.5 font-mono text-xs text-inksoft">PO {j.po_number || j.job_number}</span> : null}
                </div>
                <div className="max-w-[340px] truncate text-[13px] text-inksoft">{[j.partner, shortWork(j)].filter(Boolean).join(" · ")}</div>
                {!j.canceled && (() => {
                  const stages = pipeline(j);
                  const current = stages.findIndex(([, done]) => !done);
                  return (
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {stages.map(([l, done], i) => (
                        <span key={l} className={`chip rounded-[2px] border px-1 py-px font-semibold ${done ? "border-ok bg-ok/10 text-ok" : i === current ? "border-work text-work" : "border-rulesoft text-rule"}`}>{l}</span>
                      ))}
                      {j.proposal_sent && !j.approved && <span className="chip ml-1 text-work">{days(j.proposal_sent)}d waiting</span>}
                      {canInvoice && j.invoice_sent && !j.received && <span className="chip ml-1 text-inksoft">{days(j.invoice_sent)}d out</span>}
                    </div>
                  );
                })()}
              </button>
              <div className="flex shrink-0 items-center gap-2">
                {canPrice && <span className="font-mono text-sm font-semibold">{fmt(Number(j.amount) || invTotal(j))}</span>}
                {(j.attachments || []).length > 0 && <span className="chip text-inksoft" title="Documents & photos">📎 {(j.attachments || []).length}</span>}
                <RowActions items={[
                  { label: `Documents (📎 ${(j.attachments || []).length})`, onSelect: () => setAttachJob(j) },
                  { label: "Restore", glyph: "↺", hidden: !canEdit || !j.canceled, onSelect: () => patch(j, { canceled: false }) },
                  // deleteJob asks its own window.confirm — no second prompt here
                  { label: "Delete job…", hidden: !canEdit, destructive: true, onSelect: () => deleteJob(j) },
                ]} />
              </div>
            </div>
            {openId === j.id && !j.canceled && (() => {
              const beforeN = (j.attachments || []).filter((a) => isImg(a.name) && a.name.toLowerCase().startsWith("before")).length;
              const afterN = (j.attachments || []).filter((a) => isImg(a.name) && a.name.toLowerCase().startsWith("after")).length;
              return (
              <div className="mt-3 border-t border-rulesoft pt-3">
                <div className="mb-2.5 flex flex-wrap items-center gap-2">
                  {canEdit && <button className="btn min-h-[44px] px-3 py-1.5 text-[13px]" onClick={() => snapPhotos(j, "before")} disabled={busy}>📷 Before{beforeN > 0 ? ` · ${beforeN}` : ""}</button>}
                  {canEdit && <button className="btn min-h-[44px] px-3 py-1.5 text-[13px]" onClick={() => snapPhotos(j, "after")} disabled={busy}>📷 After{afterN > 0 ? ` · ${afterN}` : ""}</button>}
                  <RowActions items={[
                    { label: `Documents (📎 ${(j.attachments || []).length})`, onSelect: () => setAttachJob(j) },
                    { label: "Text worker", hidden: !canEdit, onSelect: () => openNotify(j) },
                  ]} />
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
                                ? <a className="btn min-h-[44px] px-3 py-1.5 text-[13px]" href={smsHref(buf, msgFor(e.name.split(" ")[0]))}>Text</a>
                                : <span className="text-[11px] text-inksoft">add a number to text them</span>}
                            </div>
                          );
                        })}
                        {match.length === 0 && <div className="py-2 text-[13px] text-inksoft">No one matches “{crewQ}”.</div>}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 border-t border-rulesoft pt-2">
                        <button className="btn btn-ghost min-h-[44px] px-3 py-1.5 text-[13px]"
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
                  <button className="btn-stamp" onClick={() => patch(j, j.proposal_sent ? { proposal_sent: null } : { proposal_sent: today() })}><Stamp label={j.proposal_sent ? `PROPOSAL SENT ${prettyDate(j.proposal_sent)}` : "MARK PROPOSAL SENT"} tone={j.proposal_sent ? "ok" : "mute"} /></button>
                  <button className="btn-stamp" onClick={() => patch(j, { approved: !j.approved })}><Stamp label={j.approved ? "APPROVED ✓" : "MARK APPROVED"} tone={j.approved ? "ok" : "mute"} /></button>
                  <button className="btn-stamp" onClick={() => patch(j, { work_done: !j.work_done })}><Stamp label={j.work_done ? "WORK DONE ✓" : "MARK WORK DONE"} tone={j.work_done ? "ok" : "mute"} /></button>
                  {canInvoice && <button className="btn-stamp" onClick={() => patch(j, j.received ? { received: false, paid_date: null } : { received: true, paid_date: today() })}><Stamp label={j.received ? `PAID ${prettyDate(j.paid_date)}` : "MARK PAID"} tone={j.received ? "ok" : "work"} /></button>}
                </div>
                )}
                <Disclosure label="Job details" sublabel="partner, PO #, contact" open={!!detailsOpen[j.id]}
                  onToggle={() => setDetailsOpen((p) => ({ ...p, [j.id]: !p[j.id] }))}>
                <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
                  {([["partner", "Partner"], ["address", "Work address (ship to)"], ["po_number", "PO #"], ...(canInvoice ? [["invoice_number", "Invoice #"]] : []), ["property_unit", "Property unit"], ["contact", "Contact"], ["description", "Work description"]] as ["partner" | "address" | "po_number" | "invoice_number" | "property_unit" | "contact" | "description", string][]).map(([k, label]) => (
                    <div key={k} className={k === "description" || k === "address" ? "col-span-2" : ""}><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">{label}</div>
                      <input className="field" value={j[k] || ""} readOnly={!canEdit} onChange={(e) => canEdit && setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, [k]: e.target.value } : x)))}
                        onBlur={(e) => canEdit && patch(j, { [k]: e.target.value } as Partial<Job>)} /></div>
                  ))}
                </div>
                </Disclosure>
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
                  {/* each line stacks: the description on its own row, the numbers
                      in a fixed grid under it — nothing scrolls sideways */}
                  {canEdit && itemsOf(j).map((it, i) => (
                    <div key={i} className="mb-2 rounded-sm border border-rulesoft p-2">
                      <div className="flex items-start gap-1.5">
                        <input className="field flex-1" placeholder="What was done — door, plaster, paint…" value={it.description}
                          onChange={(e) => {
                            const next = [...itemsOf(j)];
                            const auto = unitFor(e.target.value);
                            next[i] = { ...it, description: e.target.value, unit: it.unit === unitFor(it.description) || !it.unit ? auto : it.unit };
                            setItems(j, next);
                          }}
                          onBlur={() => setItems(j, itemsOf(j), true)} />
                        <button className="btn-icon border-0 bg-transparent shadow-none text-alert" title="Remove line" onClick={() => setItems(j, itemsOf(j).filter((_, x) => x !== i), true)}>✕</button>
                      </div>
                      <div className={`mt-1.5 grid items-end gap-1.5 ${canPrice ? "grid-cols-4" : "grid-cols-2"}`}>
                        <div><div className="text-[11px] uppercase text-inksoft">Qty</div>
                          <input className="field px-1.5 py-1.5 text-right font-mono" inputMode="decimal" title="Quantity"
                            {...num(`${j.id}:wl${i}:q`, Number(it.qty) || 0,
                              (n) => { const next = [...itemsOf(j)]; next[i] = { ...next[i], qty: n }; setItems(j, next); },
                              (n) => { const next = [...itemsOf(j)]; next[i] = { ...next[i], qty: n }; setItems(j, next, true); })} /></div>
                        <div><div className="text-[11px] uppercase text-inksoft">Unit</div>
                          <input className="field px-1 py-1.5 text-center font-mono" title="Unit of measure" value={it.unit}
                            onChange={(e) => { const next = [...itemsOf(j)]; next[i] = { ...it, unit: e.target.value }; setItems(j, next); }}
                            onBlur={() => setItems(j, itemsOf(j), true)} /></div>
                        {canPrice && (
                          <div><div className="text-[11px] uppercase text-inksoft">Price</div>
                            <input className="field px-1.5 py-1.5 text-right font-mono" inputMode="decimal" title="Price per unit"
                              {...num(`${j.id}:wl${i}:p`, Number(it.unit_price) || 0,
                                (n) => { const next = [...itemsOf(j)]; next[i] = { ...next[i], unit_price: n }; setItems(j, next); },
                                (n) => { const next = [...itemsOf(j)]; next[i] = { ...next[i], unit_price: n }; setItems(j, next, true); })} /></div>
                        )}
                        {canPrice && (
                          <div><div className="text-[11px] uppercase text-inksoft">Total</div>
                            <div className="py-1.5 text-right font-mono text-[13px]">{fmt((Number(it.qty) || 0) * (Number(it.unit_price) || 0))}</div></div>
                        )}
                      </div>
                    </div>
                  ))}
                  {canEdit && (
                    <div className="flex flex-wrap gap-2">
                      <button className="btn btn-ghost min-h-[44px] px-3 py-1.5 text-[13px]" onClick={() => setItems(j, [...itemsOf(j), { description: "", qty: 1, unit: "EACH", unit_price: 0 }], true)}>+ Add line</button>
                      {canPrice && <button className="btn btn-ghost min-h-[44px] px-3 py-1.5 text-[13px]" disabled={busy} title="Fill the lines and prices from the partner price list — plaster brings its primer and paint" onClick={() => fillFromList(j)}>Price from list</button>}
                      {canPrice && (
                        <label className="flex items-center gap-1 text-[12px] text-inksoft" title="The sales tax printed on the proposal and the invoice">
                          Sales tax
                          <input className="field w-16 px-1.5 py-1.5 text-right font-mono text-[12px]" inputMode="decimal"
                            {...num(`${j.id}:tax`, taxRate(j), () => null, (n2) => {
                              // the billed amount follows the rate — otherwise the
                              // job keeps yesterday's total at today's tax
                              const sub = invSubtotal(j);
                              patch(j, sub > 0 ? { tax_pct: n2, amount: sub * (1 + n2 / 100) } : { tax_pct: n2 });
                            }, { showZero: true })} />
                          %
                        </label>
                      )}
                    </div>
                  )}
                </div>
                <CardToolbar className="mt-3 justify-end border-t border-rulesoft pt-3"
                  primary={<button className="btn btn-primary" onClick={() => {
                    (document.activeElement as HTMLElement | null)?.blur?.();
                    setOpenId(null);
                  }}>Save & close</button>}
                  menuLabel="Papers"
                  menu={canInvoice ? [
                    { label: "⬇ Proposal + invoice", disabled: busy, title: "Both files in one tap — the proposal PDF and the invoice PDF", onSelect: () => saveBoth(j) },
                    { label: "View proposal", disabled: busy, title: "Read the proposal letter on screen first", onSelect: () => viewProposal(j) },
                    { label: "⬇ Proposal (PDF)", disabled: busy, title: "The proposal to send — opens the same everywhere", onSelect: () => makeProposalPdf(j) },
                    { label: "⬇ Proposal (Word)", disabled: busy, title: "The same letter as a Word file, to edit before sending", onSelect: () => makeProposal(j) },
                    { label: "⬇ Invoice package (zip)", disabled: busy, title: "Invoice, the PO and the before/after photos in one PDF", onSelect: () => buildPackage(j) },
                    { label: "Edit invoice", title: "The invoice lines, tax and total", onSelect: () => setInvJob(j) },
                  ] : []} />
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
          <Modal wide title={`Invoice · PO ${j.po_number || j.job_number}`} onClose={() => setInvJob(null)}
            footer={<CardToolbar className="justify-end"
              secondary={<button className="btn btn-ghost" disabled={busy} onClick={() => { setInvJob(null); buildPackage(j); }}>⬇ Invoice package (zip)</button>}
              primary={<button className="btn btn-primary" onClick={() => {
                (document.activeElement as HTMLElement | null)?.blur?.();
                setInvJob(null);
              }}>Save & close</button>} />}>
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
                    <button className="btn-icon border-0 bg-transparent shadow-none text-alert" title="Remove line" onClick={() => setItems(j, items.filter((_, x) => x !== i), true)}>✕</button>
                  </div>
                  <div className="mt-2 grid grid-cols-4 gap-2">
                    <div><div className="text-[11px] uppercase text-inksoft">Qty</div>
                      <input className="field px-2 py-1.5 text-right font-mono" inputMode="decimal"
                        {...num(`${j.id}:inv${i}:q`, Number(it.qty) || 0,
                          (n) => { const next = [...itemsOf(j)]; next[i] = { ...next[i], qty: n }; setItems(j, next); },
                          (n) => { const next = [...itemsOf(j)]; next[i] = { ...next[i], qty: n }; setItems(j, next, true); })} /></div>
                    <div><div className="text-[11px] uppercase text-inksoft">Unit</div>
                      <input className="field px-2 py-1.5 text-center font-mono" value={it.unit}
                        onChange={(e) => { const next = [...items]; next[i] = { ...it, unit: e.target.value }; setItems(j, next); }}
                        onBlur={() => setItems(j, items, true)} /></div>
                    <div><div className="text-[11px] uppercase text-inksoft">Unit price</div>
                      <input className="field px-2 py-1.5 text-right font-mono" inputMode="decimal"
                        {...num(`${j.id}:inv${i}:p`, Number(it.unit_price) || 0,
                          (n) => { const next = [...itemsOf(j)]; next[i] = { ...next[i], unit_price: n }; setItems(j, next); },
                          (n) => { const next = [...itemsOf(j)]; next[i] = { ...next[i], unit_price: n }; setItems(j, next, true); })} /></div>
                    <div><div className="text-[11px] uppercase text-inksoft">Amount</div>
                      <div className="field bg-paper px-2 py-1.5 text-right font-mono">{fmt((Number(it.qty) || 0) * (Number(it.unit_price) || 0))}</div></div>
                  </div>
                </div>
              ))}
              <button className="btn btn-ghost" onClick={() => setItems(j, [...items, { description: "", qty: 1, unit: "EACH", unit_price: 0 }], true)}>+ Add line</button>
          </Modal>
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
                {/* centered, matching the letter the PDF and Word file print */}
                <div className="text-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/logo.png" alt="" className="mx-auto h-12 w-auto" />
                  <div className="mt-1 font-display text-xl font-bold">{COMPANY.letterhead.name}</div>
                  <div className="text-[11px] text-inksoft">{COMPANY.letterhead.address}</div>
                  <div className="text-[11px] text-inksoft">{COMPANY.letterhead.phones.replace(/^Phone:\s*/, "").replace(/\s*\|\s*/g, "  ·  ")}</div>
                  <div className="text-[11px] text-inksoft">{COMPANY.letterhead.emails.replace(/^Email:\s*/, "").replace(/\s*\|\s*Office Email:\s*/, "  ·  ")}</div>
                  <div className="mt-2 border-b-2 border-work" />
                </div>
                {/* this is the letter they are about to send — it reads the same
                    as the PDF and the Word file, down to the sign-off */}
                <div className="mt-4 flex items-end justify-between border-b-[3px] border-work pb-2">
                  <div className="font-display text-2xl font-bold uppercase tracking-wide text-work">Proposal</div>
                  <div className="text-right text-[12px] leading-tight">
                    {f.poNumber && <div><span className="text-[10px] uppercase tracking-widest text-inksoft">PO # </span><b>{f.poNumber}</b></div>}
                    <div><span className="text-[10px] uppercase tracking-widest text-inksoft">Date </span><b>{f.date}</b></div>
                  </div>
                </div>
                <div className="mt-4 text-[13px] leading-relaxed">
                  {f.attn && <div className="font-semibold">ATTN: {f.attn}</div>}
                  {f.attnTitle && <div className="text-inksoft">{f.attnTitle}</div>}
                  {f.billTo.map((b, i) => <div key={i} className="text-inksoft">{b}</div>)}
                  <div className="mt-3">Dear {(f.attn || "").split(/[\s,]+/)[0] || "Sir or Madam"},</div>
                  <div className="mt-2">
                    {COMPANY.letterhead.name} is pleased to submit this proposal for the following work
                    {(f.serviceAddress || "").split(",")[0].trim() ? ` at ${(f.serviceAddress || "").split(",")[0].trim()}` : ""}.
                  </div>
                </div>
                <div className="mt-3 bg-card px-3 py-2 text-[13px]">
                  <span className="text-[10px] uppercase tracking-widest text-inksoft">Service Address: </span>
                  <b>{f.serviceAddress || "—"}</b>
                </div>
                <div className="mt-4 font-display text-[13px] font-bold uppercase tracking-widest text-work">Scope of Work</div>
                <table className="mt-1 w-full border-collapse text-[12px]">
                  <thead><tr className="border-b-2 border-work bg-card text-left font-display text-[10px] uppercase tracking-widest text-inksoft">
                    <th className="p-1.5">Description</th>
                    <th className="p-1.5 text-center">Qty</th>
                    <th className="p-1.5 text-right">Unit price</th>
                    <th className="p-1.5 text-right">Amount</th>
                  </tr></thead>
                  <tbody>
                    {f.lines.map((l, i) => (
                      <tr key={i} className="align-top border-b border-rulesoft [&>td]:py-2">
                        <td className="p-1.5">{l.description}</td>
                        <td className="p-1.5 text-center font-mono text-inksoft">{l.qty}{l.unit && l.unit.toUpperCase() !== "EACH" ? ` ${l.unit.toUpperCase()}` : ""}</td>
                        <td className="p-1.5 text-right font-mono text-inksoft">{fmt(l.unit_price)}</td>
                        <td className="p-1.5 text-right font-mono font-semibold">{fmt(l.qty * l.unit_price)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-3 flex flex-col items-end gap-0.5 text-[13px] text-inksoft">
                  <div>Total Cost — labor and materials: <span className="font-mono text-ink">{fmt(sub)}</span></div>
                  <div>Sales Tax ({f.taxPct}%): <span className="font-mono text-ink">{fmt(tax)}</span></div>
                </div>
                <div className="mt-2 flex items-center justify-end gap-4 bg-work px-3 py-2 text-white">
                  <div className="font-display text-[13px] font-bold uppercase tracking-widest">Grand Total</div>
                  <div className="font-mono text-base font-bold">{fmt(sub + tax)}</div>
                </div>
                <div className="mt-4 text-[13px]">Please sign and return a copy of this proposal to authorize the work.</div>
                <div className="mt-8 flex gap-6 text-[10px] uppercase tracking-widest text-inksoft">
                  <div className="flex-1 border-t border-rulesoft pt-1">Accepted by</div>
                  <div className="flex-1 border-t border-rulesoft pt-1">Date</div>
                </div>
                <div className="mt-6 text-[13px]">
                  <div>Best regards,</div>
                  <div className="mt-2 font-semibold">{COMPANY.letterhead.signer}</div>
                  <div className="text-[12px] text-inksoft">{COMPANY.letterhead.signerTitle}  ·  {COMPANY.letterhead.name}</div>
                </div>
                <div className="mt-6 border-t border-rulesoft pt-2 text-center text-[10px] text-inksoft">{COMPANY.letterhead.footer}</div>
              </div>
              <div className="no-print mx-auto mt-3 flex max-w-3xl flex-wrap justify-end gap-2">
                <button className="btn btn-primary" disabled={busy} onClick={() => saveProposalPdfFor(j)}>⬇ Proposal (PDF)</button>
                <button className="btn btn-ghost bg-white" onClick={() => setViewJob(null)}>Close</button>
                <ActionMenu label="⋯" items={[
                  { label: "⬇ Proposal (Word)", disabled: busy, title: "The same letter as a Word file, to edit before sending", onSelect: () => saveProposalFor(j) },
                  { label: "Print / Save as PDF", onSelect: () => window.print() },
                ]} />
              </div>
            </div>
          </PrintShell>
        );
      })()}

      {attachJob && (
        <Modal title={`Documents · PO ${attachJob.po_number || attachJob.job_number || ""}`} onClose={() => setAttachJob(null)}
          footer={canEdit ? (
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-ghost" onClick={() => snapPhotos(attachJob, "before")} disabled={busy}>📷 Before</button>
              <button className="btn btn-ghost" onClick={() => snapPhotos(attachJob, "after")} disabled={busy}>📷 After</button>
              <button className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={busy}>Upload file</button>
            </div>
          ) : undefined}>
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
        </Modal>
      )}
      <input ref={fileRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f && attachJob) attachFile(attachJob, f); e.target.value = ""; }} />
      <input ref={photoRef} type="file" accept="image/*" capture="environment" multiple className="hidden"
        onChange={(e) => { const fs = Array.from(e.target.files || []); const t = photoTarget; const j = t ? jobs.find((x) => x.id === t.id) : null; if (fs.length && t && j) addPhotos(j, fs, t.kind); e.target.value = ""; }} />

      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
      {busy && <div className="fixed bottom-14 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink/80 px-4 py-2 text-sm text-paper">Working…</div>}
    </div>
  );
}
