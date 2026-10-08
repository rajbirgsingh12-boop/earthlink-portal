"use client";
import { useEffect, useRef, useState } from "react";
import { matches } from "@/lib/search";
// styled fork of SheetJS — same API, plus cell borders/fonts for the export
// the export engine is heavy — it loads on demand, never with the page itself
let XLSX!: typeof import("xlsx-js-style");
const ensureXLSX = async () => { XLSX = XLSX || (await import("xlsx-js-style")); };
import { sb } from "@/lib/supabase";
import { myProfile } from "@/lib/profile";
import { fmt, askFileName } from "@/lib/format";
import { Org, prettyDate, localISO, invoiceNumberOf } from "@/lib/docs";
import type { Contract, Release } from "@/lib/types";
import ContractPicker from "@/components/ContractPicker";
import PageHeader from "@/components/PageHeader";
import CardToolbar from "@/components/CardToolbar";
import { RowActions } from "@/components/ActionMenu";
import { useLive } from "@/lib/useLive";
import NychaInvoicePrint, { invoiceFileBase } from "@/components/NychaInvoicePrint";
import { gatherReleaseDoc, buildInvoiceXlsx, buildInvoiceBytes, buildInvoicePdfBytes, type DocRow } from "@/lib/releaseDoc";
import { PKG_SLOTS, type PkgSlot, listPkgOverrides, uploadPkgOverride, removePkgOverride, buildPackagePdf, downloadPdf } from "@/lib/packageDocs";
import PrintShell from "@/components/PrintShell";
import Toast, { useFlash } from "@/components/Toast";

// the aging buckets: the keys stay short, the words a person reads say "to"
const BUCKET_LABEL: Record<string, string> = { "0-30": "0 to 30 days", "31-60": "31 to 60 days", "61-90": "61 to 90 days", "90+": "90+ days" };

export default function InvoicePackage() {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [sel, setSel] = useState("");
  const [tq, setTq] = useState(""); // filter the outstanding list on screen
  const [rows, setRows] = useState<Release[]>([]);
  const [org, setOrg] = useState<Org | null>(null);
  const [printOpen, setPrintOpen] = useState(false);
  const [invPreview, setInvPreview] = useState<{ number: string; date: string; cNumber: string; relNum: string; dev: string; workOrder: string; rows: DocRow[] } | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [booted, setBooted] = useState(false); // first fetch finished?
  const [stubs, setStubs] = useState<Release[]>([]); // open releases with no release data yet
  // which contract the rows on screen belong to: until it is the one picked, the statement is loading
  const [rowsFor, setRowsFor] = useState("");
  const { msg, flash, progress, setProgress } = useFlash();
  // the accountant can read everything here but the database won't accept their
  // writes — keep the dates view-only for them instead of edits that don't save
  const [role, setRole] = useState("");
  const readOnly = role === "accountant";
  const today = localISO();

  const genInvoice = async (r: Release) => {
    const c = contracts.find((x) => x.id === sel);
    const d = await gatherReleaseDoc(sel, r);
    if (d.rows.length === 0) { flash(`Release ${r.rel_number} has no line items yet. Import its release PDF or fill a walk sheet first`); return; }
    if (!r.invoice_sent && !readOnly) {
      await sb().from("releases").update({ invoice_sent: today }).eq("id", r.id);
      setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, invoice_sent: today } : x)));
    }
    setPrintOpen(false); // one preview at a time — two would print as one concatenated PDF
    setInvPreview({ number: invoiceNumberOf(c?.number, r.rel_number), date: today, cNumber: c?.number || "", relNum: r.rel_number, dev: r.location || d.dev, workOrder: r.ticket || "", rows: d.rows });
  };

  useEffect(() => {
    (async () => {
      // independent reads go out together instead of one after another
      const fetchRel = async () => {
        // (ordered — pages of an unordered scan can overlap between requests)
        const rel: { contract_id: string; amount: number; received: boolean; canceled: boolean }[] = [];
        for (let from = 0; ; from += 1000) {
          // the database keeps paid/canceled/zero rows to itself — only open
          // balances come over (usually a few dozen rows, not thousands)
          const { data: page } = await sb().from("releases").select("contract_id,amount,received,canceled")
            .not("received", "is", true).not("canceled", "is", true).gt("amount", 0)
            .order("id").range(from, from + 999);
          rel.push(...((page || []) as typeof rel));
          if (!page || page.length < 1000) break;
        }
        return rel;
      };
      const [prof, { data }, rel] = await Promise.all([
        myProfile(),
        sb().from("contracts").select("id,number,name").order("number"),
        fetchRel(),
      ]);
      setRole(prof?.role || "");
      const cs = (data || []) as Contract[];
      // only contracts with an active statement (something still owed)
      const open = new Set(
        rel
          .filter((r) => !r.canceled && !r.received && Number(r.amount) > 0)
          .map((r) => r.contract_id)
      );
      const activeContracts = cs.filter((c) => open.has(c.id));
      setContracts(activeContracts);
      if (activeContracts[0]) setSel(activeContracts[0].id);
      setBooted(true);
    })();
    sb().from("org").select("*").single().then(({ data }) => data && setOrg(data as Org));
  }, []);

  // live: releases, their items and walk sheets refresh the statement
  useLive(["releases", "release_items", "proposals", "contracts"], () => setReloadTick((t) => t + 1), { enabled: !!sel });

  const selRef = useRef(sel); selRef.current = sel;
  useEffect(() => {
    if (!sel) { setRows([]); setStubs([]); return; }
    (async () => {
      const pages: Release[] = [];
      for (let from = 0; ; from += 1000) { // paginated — an unranged select stops silently at 1000
        // the statement needs a dozen columns, not attachments and labor JSON
        const { data } = await sb().from("releases")
          .select("id,contract_id,rel_number,location,buildings,address,ticket,amount,received,canceled,invoice_sent,paid_date")
          .eq("contract_id", sel).order("id").range(from, from + 999);
        pages.push(...((data || []) as Release[]));
        if (!data || data.length < 1000) break;
      }
      const all = pages.filter((r) => !r.canceled && Number(r.amount) > 0 && !r.received);
      // only releases with real release data connected — imported line items
      // or a walk sheet with quantities on the same release number
      const ready = new Set<string>();
      // one tiny answer from the database (run supabase/upgrade_speed.sql) —
      // otherwise fall back to downloading a row id per line item
      const { data: withItems, error: wiErr } = await sb().rpc("releases_with_items", { cid: sel });
      if (!wiErr && Array.isArray(withItems)) {
        (withItems as string[]).forEach((id) => ready.add(id));
      } else {
        const ids = all.map((r) => r.id);
        // chunks fetch together — serially this was seconds of dead time on big contracts
        const chunks: string[][] = [];
        for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
        await Promise.all(chunks.map(async (chunk) => {
          for (let f = 0; ; f += 1000) {
            const { data: its } = await sb().from("release_items").select("release_id").in("release_id", chunk).range(f, f + 999);
            ((its || []) as { release_id: string }[]).forEach((it) => ready.add(it.release_id));
            if (!its || its.length < 1000) break;
          }
        }));
      }
      const { data: props } = await sb().from("proposals").select("release_number,qty_map").eq("contract_id", sel);
      // "007" and "7" are the same release — compare with leading zeros stripped
      const relNorm = (v: unknown) => String(v ?? "").trim().replace(/^0+(?=\d)/, "");
      const walkNums = new Set(
        ((props || []) as { release_number?: string; qty_map?: Record<string, number> | null }[])
          .filter((p) => p.release_number && p.qty_map && Object.keys(p.qty_map).length > 0)
          .map((p) => relNorm(p.release_number))
      );
      const connected = all.filter((r) => ready.has(r.id) || walkNums.has(relNorm(r.rel_number)));
      connected.sort((a, b) => (parseFloat(a.rel_number) || 0) - (parseFloat(b.rel_number) || 0));
      if (sel !== selRef.current) return; // another contract was picked while this one loaded
      setRows(connected);
      // open money the statement can't show yet, so "all square" is never a lie
      setStubs(all.filter((r) => !ready.has(r.id) && !walkNums.has(relNorm(r.rel_number))));
      setRowsFor(sel);
    })();
  }, [sel, reloadTick]);
  const rowsLoaded = rowsFor === sel;

  const contract = contracts.find((c) => c.id === sel);
  const days = (r: Release) => (r.invoice_sent ? Math.max(0, Math.floor((new Date(today + "T00:00:00").getTime() - new Date(r.invoice_sent + "T00:00:00").getTime()) / 86400000)) : null);
  const buckets: [string, number][] = [["0-30", 0], ["31-60", 0], ["61-90", 0], ["90+", 0]];
  let notInvoiced = 0;
  rows.forEach((r) => {
    const d = days(r); const v = Number(r.amount);
    if (d === null) notInvoiced += v;
    else if (d <= 30) buckets[0][1] += v; else if (d <= 60) buckets[1][1] += v; else if (d <= 90) buckets[2][1] += v; else buckets[3][1] += v;
  });
  const total = rows.reduce((s, r) => s + Number(r.amount), 0);
  // release-number order, everywhere on this page
  const sorted = [...rows].sort((a, b) => (parseFloat(a.rel_number) || 0) - (parseFloat(b.rel_number) || 0));
  const shownRows = sorted.filter((r) => matches(tq, r.rel_number, r.location, r.buildings));

  // ---- the invoice package: invoice + affidavit + REP + hiring + EO in one zip ----
  const [pkgBusy, setPkgBusy] = useState(""); // release id being packaged
  const [overrides, setOverrides] = useState<Set<string>>(new Set());
  const upRef = useRef<HTMLInputElement>(null);
  const upSlot = useRef<PkgSlot | null>(null);
  useEffect(() => {
    if (!sel) { setOverrides(new Set()); return; }
    listPkgOverrides(sel).then(setOverrides);
  }, [sel, reloadTick]);

  const downloadPackage = async (r: Release) => {
    const c = contracts.find((x) => x.id === sel);
    if (!c || pkgBusy) return;
    setPkgBusy(r.id);
    try {
      const d = await gatherReleaseDoc(sel, r);
      if (d.rows.length === 0) { flash(`Release ${r.rel_number} has no line items yet. Import its release PDF or fill a walk sheet first`); return; }
      setProgress("Making the package…");
      const invPdf = await buildInvoicePdfBytes({
        org: org || ({} as Org), cNumber: c.number, relNum: r.rel_number, workOrder: r.ticket || "",
        dev: r.location || d.dev, number: invoiceNumberOf(c.number, r.rel_number),
        date: r.invoice_sent || today, rows: d.rows,
      });
      const merged = await buildPackagePdf(sel, c.number, r.rel_number, invPdf);
      const fname = askFileName(`package_${c.number}_rel${r.rel_number}.pdf`);
      if (fname) {
        downloadPdf(merged, fname);
        if (!r.invoice_sent && !readOnly) {
          await sb().from("releases").update({ invoice_sent: today }).eq("id", r.id);
          setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, invoice_sent: today } : x)));
        }
        flash(`Package for release ${r.rel_number} downloaded: one PDF, invoice + the 4 documents`);
      }
    } catch {
      flash("Couldn't build the package. Check your signal and try again");
    } finally { setProgress(""); setPkgBusy(""); }
  };

  const pickUpload = (slot: PkgSlot) => { upSlot.current = slot; upRef.current?.click(); };
  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; const slot = upSlot.current;
    e.target.value = "";
    if (!f || !slot || !sel) return;
    const err = await uploadPkgOverride(sel, slot, f);
    if (err) { flash(`Couldn't save that PDF. Check your signal and try again`); return; }
    setOverrides((prev) => new Set([...prev, slot.file]));
    flash(`${slot.label} for this contract saved. Packages now use your copy`);
  };
  const onRemoveOverride = async (slot: PkgSlot) => {
    if (!sel) return;
    if (!window.confirm(`Go back to the standard ${slot.label}? This contract's uploaded copy is deleted.`)) return;
    const err = await removePkgOverride(sel, slot);
    if (err) { flash(`Couldn't remove this contract's copy. Check your signal and try again`); return; }
    setOverrides((prev) => { const n = new Set(prev); n.delete(slot.file); return n; });
    flash(`${slot.label} back to the standard copy`);
  };

  // every outstanding release's full package, regenerated as merged PDFs and
  // zipped — for re-sending paperwork after the documents changed
  const [allPkgBusy, setAllPkgBusy] = useState(false);
  const downloadAllPackages = async () => {
    if (!contract || sorted.length === 0 || allPkgBusy) return;
    setAllPkgBusy(true);
    try {
      const files: Record<string, Uint8Array> = {};
      const stampIds: string[] = [];
      let done = 0;
      for (const r of sorted) {
        const d = await gatherReleaseDoc(sel, r);
        if (d.rows.length === 0) continue;
        const invPdf = await buildInvoicePdfBytes({
          org: org || ({} as Org), cNumber: contract.number, relNum: r.rel_number, workOrder: r.ticket || "",
          dev: r.location || d.dev, number: invoiceNumberOf(contract.number, r.rel_number),
          date: r.invoice_sent || today, rows: d.rows,
        });
        files[`package_${contract.number}_rel${r.rel_number}.pdf`] = await buildPackagePdf(sel, contract.number, r.rel_number, invPdf);
        if (!r.invoice_sent) stampIds.push(r.id);
        done += 1;
        setProgress(`Making packages: ${done} of ${sorted.length}`);
      }
      if (done === 0) { flash("No releases with line items to package yet"); return; }
      const { zipSync } = await import("fflate");
      const zipped = zipSync(files, { level: 1 }); // PDFs barely compress — keep it quick
      const ab = new ArrayBuffer(zipped.byteLength);
      new Uint8Array(ab).set(zipped);
      const fname = askFileName(`packages_${contract.number}.zip`);
      if (fname) {
        const url = URL.createObjectURL(new Blob([ab], { type: "application/zip" }));
        const a = document.createElement("a");
        a.href = url; a.download = fname; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        if (stampIds.length > 0 && !readOnly) {
          await sb().from("releases").update({ invoice_sent: today }).in("id", stampIds);
          setRows((prev) => prev.map((x) => (stampIds.includes(x.id) ? { ...x, invoice_sent: today } : x)));
        }
        flash(`${done} package${done === 1 ? "" : "s"} downloaded, one PDF each: invoice + the 4 documents`);
      }
    } catch {
      flash("Couldn't build the packages. Check your signal and try again");
    } finally { setProgress(""); setAllPkgBusy(false); }
  };

  // every outstanding release's invoice, regenerated in the template format,
  // zipped into one download — for re-issuing paperwork made before the new look
  const [zipBusy, setZipBusy] = useState(false);
  const downloadAllInvoices = async () => {
    if (!contract || sorted.length === 0 || zipBusy) return;
    setZipBusy(true);
    try {
      const files: Record<string, Uint8Array> = {};
      let done = 0;
      for (const r of sorted) {
        const d = await gatherReleaseDoc(sel, r);
        if (d.rows.length === 0) continue;
        const bytes = await buildInvoiceBytes({
          org: org || ({} as Org), cNumber: contract.number, relNum: r.rel_number, workOrder: r.ticket || "",
          dev: r.location || d.dev, number: invoiceNumberOf(contract.number, r.rel_number),
          date: r.invoice_sent || today, rows: d.rows,
        });
        files[`invoice_${contract.number}_rel${r.rel_number}.xlsx`] = bytes;
        done += 1;
        setProgress(`Making invoices: ${done} of ${sorted.length}`);
      }
      if (done === 0) { flash("No releases with line items to invoice yet"); return; }
      const { zipSync } = await import("fflate");
      const zipped = zipSync(files, { level: 6 });
      const ab = new ArrayBuffer(zipped.byteLength);
      new Uint8Array(ab).set(zipped);
      const blob = new Blob([ab], { type: "application/zip" });
      const fname = askFileName(`invoices_${contract.number}.zip`);
      if (fname) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = fname; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        flash(`${done} invoice${done === 1 ? "" : "s"} downloaded in one zip, all in the template format`);
      }
    } catch {
      flash("Couldn't build the zip. Check your signal and try again");
    } finally { setProgress(""); setZipBusy(false); }
  };

  const downloadExcel = async () => {
    try { await ensureXLSX(); } catch { flash("Couldn't load the Excel engine. Check your signal and try again"); return; }
    if (!contract) return;
    const aoa: (string | number)[][] = [];
    aoa.push(["STATEMENT OF ACCOUNT"]);
    aoa.push([(org?.company || "").toUpperCase()]);
    aoa.push([[org?.address1, org?.address2].filter(Boolean).join(", ")]);
    aoa.push([[org?.phone, org?.email].filter(Boolean).join(" · ")]);
    aoa.push([]);
    aoa.push(["Contract / PO:", /^\d+$/.test(contract.number) ? Number(contract.number) : contract.number, "", "Date:", prettyDate(today)]);
    aoa.push([]);
    const headerRow = aoa.length;
    aoa.push(["Release", "Development", "Location", "Invoiced", "Days out", "Balance"]);
    sorted.forEach((r) => {
      const d = days(r);
      aoa.push([/^\d+$/.test(r.rel_number) ? Number(r.rel_number) : r.rel_number, r.location || "", r.buildings || "", r.invoice_sent ? prettyDate(r.invoice_sent) : "not invoiced", d === null ? "" : d, Number(r.amount)]);
    });
    const totalRow = aoa.length;
    aoa.push(["", "", "", "", "Total due", total]);
    aoa.push([]);
    aoa.push(["Aging:", ...buckets.map(([b, v]) => `${BUCKET_LABEL[b]}: ${fmt(v)}`), `Not invoiced: ${fmt(notInvoiced)}`]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 12 }, { wch: 30 }, { wch: 40 }, { wch: 16 }, { wch: 12 }, { wch: 16 }];
    ws["!merges"] = [0, 1, 2, 3].map((r) => ({ s: { r, c: 0 }, e: { r, c: 5 } }));
    const thin = { style: "thin", color: { rgb: "000000" } };
    const box = { top: thin, bottom: thin, left: thin, right: thin };
    const shade = { patternType: "solid", fgColor: { rgb: "E8E4DA" } };
    const cellAt = (row: number, col: number) => ws[XLSX.utils.encode_cell({ r: row, c: col })];
    const c0 = cellAt(0, 0); if (c0) c0.s = { font: { bold: true, sz: 14 }, alignment: { horizontal: "center" }, fill: shade, border: box };
    const c5 = cellAt(5, 0); if (c5) c5.s = { font: { bold: true } };
    const c53 = cellAt(5, 3); if (c53) c53.s = { font: { bold: true } };
    for (let row = headerRow; row <= totalRow; row++) {
      for (let col = 0; col < 6; col++) {
        const cell = cellAt(row, col) || (ws[XLSX.utils.encode_cell({ r: row, c: col })] = { t: "s", v: "" });
        cell.s = {
          border: box,
          alignment: { vertical: "center", horizontal: row === headerRow ? "center" : col >= 4 ? "right" : "left" },
          ...(row === headerRow ? { font: { bold: true }, fill: shade } : {}),
          ...(row === totalRow ? { font: { bold: true } } : {}),
        };
        if (col === 5 && typeof cell.v === "number") cell.z = "#,##0.00";
      }
    }
    ws["!rows"] = [];
    ws["!rows"][0] = { hpt: 26 };
    ws["!rows"][headerRow] = { hpt: 22 };
    for (let row = headerRow + 1; row <= totalRow; row++) ws["!rows"][row] = { hpt: 19 };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const fname = askFileName(`statement_${contract.number}.xlsx`);
    if (!fname) return;
    XLSX.writeFile(wb, fname);
  };

  const skeletonRows = (
    <div className="card">
      {[0, 1, 2].map((i) => (
        /* the statement's shape, shimmering, while the contract loads */
        <div key={`sk${i}`} className="border-b border-rulesoft p-3 last:border-b-0">
          <div className="flex items-center justify-between gap-2">
            <div className="skeleton h-4 w-14" />
            <div className="skeleton h-4 w-20" />
          </div>
          <div className="skeleton mt-2 h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
  const stubTotal = fmt(stubs.reduce((s, r) => s + Number(r.amount), 0));

  return (
    <div>
      {(allPkgBusy || zipBusy || !!pkgBusy) && <div className="busy-bar" aria-busy="true" aria-label="Working" />}
      <PageHeader title="Invoice Package" sub="What NYCHA still owes on each contract, with the invoice and package for every release" />
      {contracts.length > 0 && <div className="mb-3"><ContractPicker contracts={contracts} value={sel} onChange={setSel} /></div>}
      <input ref={upRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={onUpload} />
      {contract && (
        <div key={sel} className="anim-fade">
          <input type="search" enterKeyHint="search" autoComplete="off" className="field mb-3" placeholder="Search release #, development…" value={tq} onChange={(e) => setTq(e.target.value)} />
          {!rowsLoaded ? skeletonRows : sorted.length === 0 ? (
            <div className="empty">{stubs.length > 0
              ? `${stubs.length} open release${stubs.length === 1 ? "" : "s"} totaling ${stubTotal} ${stubs.length === 1 ? "is" : "are"} waiting on release data. Import the release PDF or fill a walk sheet to put ${stubs.length === 1 ? "it" : "them"} on the statement.`
              : `Nothing outstanding on contract ${contract.number}. All square.`}</div>
          ) : shownRows.length === 0 ? (
            <div className="empty">Nothing matches that search. Clear the box to see every release.</div>
          ) : (
          <div className="card overflow-x-auto">
            <table className="w-full border-collapse text-sm" style={{ minWidth: 560 }}>
              <thead><tr className="border-b-[1.5px] border-ink text-left font-display text-xs uppercase tracking-widest text-inksoft">
                <th className="p-2.5">Release</th><th className="p-2.5">Development</th><th className="p-2.5">Invoiced</th><th className="p-2.5 text-right">Days out</th><th className="p-2.5 text-right">Balance</th><th className="p-2.5"></th></tr></thead>
              <tbody>
                {shownRows.map((r) => {
                  const d = days(r);
                  return (
                    <tr key={r.id} className="border-b border-rulesoft">
                      <td className="p-2.5 font-mono text-[13px]">{r.rel_number}</td>
                      <td className="p-2.5">{r.location}<div className="max-w-[220px] truncate text-[12px] text-inksoft">{r.buildings}</div></td>
                      <td className="p-2.5">
                        {readOnly
                          ? <span className="font-mono text-xs">{r.invoice_sent ? prettyDate(r.invoice_sent) : "not yet"}</span>
                          : <input type="date" aria-label={`Invoiced date, release ${r.rel_number}`} className="min-h-[44px] rounded-sm border border-rulesoft px-2 py-1 font-mono text-base sm:text-xs" defaultValue={r.invoice_sent || ""}
                              onChange={async (e) => {
                                const v = e.target.value || null;
                                const { error } = await sb().from("releases").update({ invoice_sent: v }).eq("id", r.id);
                                if (error) { flash("Couldn't save the invoice date. Check your signal and try again"); return; }
                                setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, invoice_sent: v } : x)));
                                flash(v ? `Release ${r.rel_number} marked invoiced ${prettyDate(v)}` : `Release ${r.rel_number} marked not invoiced`);
                              }} />}
                      </td>
                      <td className={`p-2.5 text-right font-mono ${d !== null && d > 90 ? "text-alert" : ""}`}>{d === null ? "" : d}</td>
                      <td className="p-2.5 text-right font-mono font-semibold">{fmt(Number(r.amount))}</td>
                      <td className="p-1.5 text-right">
                        <RowActions items={[
                          { label: "Invoice", title: "Make the NYCHA invoice", onSelect: () => genInvoice(r) },
                          { label: pkgBusy === r.id ? "Making…" : "Invoice package (PDF)", glyph: "⬇", disabled: !!pkgBusy,
                            title: "Invoice + affidavit + REP + hiring summary + equal opportunity report, one PDF",
                            onSelect: () => downloadPackage(r) },
                        ]} />
                      </td>
                    </tr>
                  );
                })}
                <tr><td colSpan={5} className="p-2.5 font-display font-bold uppercase">Total due</td><td className="p-2.5 text-right font-mono text-base font-bold">{fmt(total)}</td></tr>
              </tbody>
            </table>
          </div>
          )}
          {sorted.length > 0 && stubs.length > 0 && (
            <div className="no-print mt-2 text-xs text-inksoft">Not on this statement: {stubs.length} open release{stubs.length === 1 ? "" : "s"} totaling {fmt(stubs.reduce((s, r) => s + Number(r.amount), 0))} still waiting on release data (import the release PDF or fill a walk sheet).</div>
          )}
          {sorted.length > 0 && (
            <>
              <div className="mt-3 grid grid-cols-3 gap-2 md:grid-cols-5">
                {[...buckets, ["Not invoiced", notInvoiced] as [string, number]].map(([b, v]) => (
                  <div key={b} className="card card-tight text-center">
                    <div className="section-label">{BUCKET_LABEL[b] || b}</div>
                    <div className={`truncate font-mono text-[15px] font-semibold tabular-nums ${b === "90+" && v > 0 ? "text-alert" : ""}`}>{fmt(v)}</div>
                  </div>
                ))}
              </div>
              <CardToolbar className="mt-3.5"
                primary={
                  <button type="button" className="btn btn-primary" onClick={downloadAllPackages} disabled={allPkgBusy} title="One zip with every outstanding release's package PDF">
                    {allPkgBusy ? "Making packages…" : `⬇ All packages (${sorted.length}, zip)`}
                  </button>
                }
                secondary={<button type="button" className="btn btn-ghost" onClick={() => { setInvPreview(null); setPrintOpen(true); }}>Preview statement</button>}
                menu={[
                  { label: "Statement (Excel)", glyph: "⬇", onSelect: downloadExcel },
                  { label: zipBusy ? "Making invoices…" : `All invoices (${sorted.length}) as Excel`, glyph: "⬇", disabled: zipBusy,
                    title: "Every outstanding invoice on this contract, regenerated in the template format, in one zip",
                    onSelect: downloadAllInvoices },
                ]} />
            </>
          )}
          {/* the paperwork that rides along with every invoice on this contract */}
          <div className="card card-pad mt-4">
            <div className="mb-1 font-display text-sm font-semibold uppercase tracking-wide">Package documents · contract {contract.number}</div>
            <div className="mb-2.5 text-xs text-inksoft">
              Every invoice package is one PDF: the invoice plus these four documents. Contracts with their own signed copies use them;
              the rest get the standard copies with the contract number filled in. Upload a PDF to replace one for this contract.
            </div>
            <div className="grid gap-2">
              {PKG_SLOTS.map((s) => {
                const custom = overrides.has(s.file);
                return (
                  <div key={s.key} className="flex items-center gap-2 border-b border-rulesoft pb-2 last:border-b-0 last:pb-0">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold">{s.label}</div>
                      <div className="text-[12px] text-inksoft">{custom ? "this contract's uploaded copy" : "standard copy, contract # filled in"}</div>
                      {/* the slot's note comes from lib/packageDocs as written; the dash is swapped here, on display only */}
                      {!custom && s.note && <div className="text-[12px] text-inksoft">{s.note.replace(/\s[—–]\s/g, ": ")}</div>}
                    </div>
                    {!readOnly && (
                      <RowActions items={[
                        { label: custom ? "Replace this contract's copy" : "Upload this contract's copy", glyph: "📄", onSelect: () => pickUpload(s) },
                        { label: "Use the standard copy", hidden: !custom, onSelect: () => onRemoveOverride(s) },
                      ]} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          {printOpen && org && (
            <PrintShell onClose={() => setPrintOpen(false)} wide sheetClass="text-ink"
              toolbar={<button type="button" className="btn btn-ghost bg-white" onClick={downloadExcel}>⬇ Statement (Excel)</button>}>
                <div className="border-2 border-ink bg-paper p-2 text-center font-display text-xl font-bold uppercase">Statement of Account</div>
                <div className="my-4 flex justify-between text-[13px]">
                  <div>
                    <div className="font-display text-lg font-bold uppercase">{org.company}</div>
                    <div className="text-inksoft">{[org.address1, org.address2].filter(Boolean).join(", ")}</div>
                    <div className="text-inksoft">{[org.phone, org.email].filter(Boolean).join(" · ")}</div>
                  </div>
                  <div className="text-right">
                    <div><span className="text-[11px] uppercase tracking-wider text-inksoft">Contract / PO </span><span className="font-mono font-semibold">{contract.number}</span></div>
                    <div className="font-mono text-xs text-inksoft">{prettyDate(today)}</div>
                  </div>
                </div>
                <table className="w-full border-collapse border border-ink text-[12px]">
                  <thead><tr className="bg-paper text-left font-display text-[11px] uppercase tracking-widest">
                    <th className="border border-ink p-1.5">Release</th><th className="border border-ink p-1.5">Development</th>
                    <th className="border border-ink p-1.5">Invoiced</th><th className="border border-ink p-1.5 text-right">Days out</th>
                    <th className="border border-ink p-1.5 text-right">Balance</th>
                  </tr></thead>
                  <tbody>
                    {sorted.map((r) => {
                      const d = days(r);
                      return (
                        <tr key={r.id} className="align-top">
                          <td className="border border-rulesoft p-1.5 font-mono">{r.rel_number}</td>
                          <td className="border border-rulesoft p-1.5">{r.location}{r.buildings ? <span className="text-[11px] text-inksoft"> · {r.buildings}</span> : ""}</td>
                          <td className="border border-rulesoft p-1.5 font-mono text-[11px]">{r.invoice_sent ? prettyDate(r.invoice_sent) : "not invoiced"}</td>
                          <td className="border border-rulesoft p-1.5 text-right font-mono">{d === null ? "" : d}</td>
                          <td className="border border-rulesoft p-1.5 text-right font-mono font-semibold">{fmt(Number(r.amount))}</td>
                        </tr>
                      );
                    })}
                    <tr><td colSpan={4} className="border border-ink p-1.5 text-right font-display font-bold uppercase">Total due</td>
                      <td className="border border-ink p-1.5 text-right font-mono text-base font-bold">{fmt(total)}</td></tr>
                  </tbody>
                </table>
                <div className="mt-3 text-[11px] text-inksoft">
                  Aging: {buckets.map(([b, v]) => `${BUCKET_LABEL[b]} ${fmt(v)}`).join(", ")}, not invoiced {fmt(notInvoiced)}
                </div>
            </PrintShell>
          )}
        </div>
      )}
      {invPreview && org && (
        <NychaInvoicePrint org={org} number={invPreview.number} date={invPreview.date}
          contractNumber={invPreview.cNumber} releaseNumber={invPreview.relNum} development={invPreview.dev}
          workOrder={invPreview.workOrder}
          items={invPreview.rows.map((it) => ({ line: it.line, code: it.code, category: it.category, description: it.description, unit: it.uom, qty: it.qty, unit_price: it.unit_price }))}
          onPdf={async () => { const fname = askFileName(`${invoiceFileBase(invPreview.cNumber, invPreview.relNum)}.pdf`); if (!fname) return; downloadPdf(await buildInvoicePdfBytes({ org, cNumber: invPreview.cNumber, relNum: invPreview.relNum, workOrder: invPreview.workOrder, dev: invPreview.dev, number: invPreview.number, date: invPreview.date, rows: invPreview.rows }), fname); }}
          onExcel={() => { const fname = askFileName(`${invoiceFileBase(invPreview.cNumber, invPreview.relNum)}.xlsx`); if (fname) buildInvoiceXlsx({ org, cNumber: invPreview.cNumber, relNum: invPreview.relNum, workOrder: invPreview.workOrder, dev: invPreview.dev, number: invPreview.number, date: invPreview.date, rows: invPreview.rows, filename: fname }); }}
          close={() => setInvPreview(null)} />
      )}
      {contracts.length === 0 && (booted
        ? <div className="empty">Nothing is owed on any contract right now. Releases NYCHA hasn&apos;t paid show up here by themselves.</div>
        : skeletonRows)}
      <Toast msg={msg} progress={progress} />
    </div>
  );
}
