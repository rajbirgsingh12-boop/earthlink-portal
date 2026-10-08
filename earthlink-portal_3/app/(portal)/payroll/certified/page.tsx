"use client";
// Certified payroll → eComply CSV converter.
// Drop in the weekly certified payroll PDFs, check the numbers in the grid,
// download a CSV ready for eComply. Everything happens ON THIS PHONE —
// nothing here is uploaded or saved anywhere, and wages never touch the
// portal's database.
import { useRef, useState } from "react";
import { parseCertifiedPayroll, buildCsv, lcmWarnings, blankRow, dayLabels, splitReportByRelease, workerKey, type ReleaseHours, type CpReport, type CpRow, type CpLine, type Cell } from "@/lib/certifiedPayroll";
import { askFileName } from "@/lib/format";
import { sb } from "@/lib/supabase";
import PageHeader from "@/components/PageHeader";
import CardToolbar from "@/components/CardToolbar";
import Toast, { useFlash } from "@/components/Toast";

interface PdfDocLite { destroy?: () => Promise<void> }

// every report and worker row carries its own key, so a row that was just
// added slides in while the ones around it stay put
let uidSeq = 0;
const uid = () => `u${++uidSeq}`;
type RowU = CpRow & { uid: string };
type ReportU = Omit<CpReport, "rows"> & { uid: string; rows: RowU[] };
const tagReport = (r: CpReport): ReportU => ({ ...r, uid: uid(), rows: r.rows.map((w) => ({ ...w, uid: uid() })) });
const tagRow = (w: CpRow): RowU => ({ ...w, uid: uid() });

const TYPED_IN = "typed in by hand";
// the reader's notes and the pre-download warnings come from the CSV builder,
// which is kept byte-stable; the dash and the "their upload" wording are swapped
// here, on the way to the screen
const clean = (s: string) => s
  .replace(/\s+[—–]\s+(\S)/g, (_m, c: string) => `. ${c.toUpperCase()}`)
  .replace(/their upload/gi, "eComply");
// the week runs Saturday to Friday on the portal's timesheets; a dated label gets its real weekday
const WEEK_DAYS = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];
const dayNames = (weekEnding: string): string[] => {
  const m = weekEnding.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const labels = dayLabels(weekEnding);
  if (!m) return WEEK_DAYS;
  const end = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  return labels.map((d, i) => {
    const day = new Date(end);
    day.setDate(end.getDate() - (6 - i));
    return `${day.toLocaleDateString("en-US", { weekday: "short" })} ${d}`;
  });
};

export default function CertifiedPayroll() {
  const [reports, setReports] = useState<ReportU[]>([]);
  const [busy, setBusy] = useState(false);
  const { msg, flash } = useFlash();
  const fileRef = useRef<HTMLInputElement>(null);

  // read a PDF into text lines: words clustered by row (y), ordered by x —
  // that keeps table columns in left-to-right order for the reader
  const extractLines = async (file: File, pdfjs: typeof import("pdfjs-dist")): Promise<CpLine[]> => {
    let doc: PdfDocLite | null = null;
    try {
      const loaded = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
      doc = loaded as unknown as PdfDocLite;
      const lines: CpLine[] = [];
      let sawText = 0;
      for (let pg = 1; pg <= loaded.numPages; pg++) {
        const tc = await (await loaded.getPage(pg)).getTextContent();
        const words: { x: number; y: number; w: number; s: string }[] = [];
        for (const it of tc.items) {
          if (!("str" in it) || !it.str.trim()) continue;
          const t = (it as { transform: number[] }).transform;
          // how WIDE the word is matters as much as where it starts: a payroll
          // that right-aligns "8" in the Wednesday box starts it near Thursday
          words.push({ x: t[4], y: t[5], w: Number((it as { width?: number }).width) || 0, s: it.str.trim() });
          sawText += 1;
        }
        // cluster into rows: same line = y within 3pt. Where each word sits
        // across the page is kept too — on a WH-347 grid that's the only way
        // to know which DAY a lone "6.0" belongs to.
        words.sort((a, b) => b.y - a.y || a.x - b.x);
        let cur: { y: number; ws: { x: number; w: number; s: string }[] } | null = null;
        for (const w of words) {
          if (!cur || Math.abs(cur.y - w.y) > 3) { cur = { y: w.y, ws: [] }; lines.push({ tokens: [], xs: [], ws: [] }); }
          cur.ws.push({ x: w.x, w: w.w, s: w.s });
          const sorted = cur.ws.sort((a, b) => a.x - b.x);
          lines[lines.length - 1].tokens = sorted.map((v) => v.s);
          lines[lines.length - 1].xs = sorted.map((v) => v.x);
          lines[lines.length - 1].ws = sorted.map((v) => v.w);
        }
      }
      // a real PDF that renders pages but carries NO text is a scan — a photo
      // of paper, or an email attachment run through "print to PDF"
      if (sawText === 0) throw new Error("scan");
      return lines;
    } finally {
      await doc?.destroy?.().catch(() => null);
    }
  };

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;
    setBusy(true);
    try {
      // the PDF reader loads on demand — right after an update goes out, a page
      // that's been sitting open can fail to fetch it. That is NOT a scan.
      let pdfjs: typeof import("pdfjs-dist");
      try {
        pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      } catch {
        flash("The PDF reader didn't load. The portal was probably just updated: pull down to refresh and upload again.");
        return;
      }
      const parsed: CpReport[] = [];
      for (const f of files) {
        try {
          const lines = await extractLines(f, pdfjs);
          parsed.push(parseCertifiedPayroll(f.name, lines));
        } catch (err) {
          const scan = err instanceof Error && err.message === "scan";
          parsed.push({ ...emptyReport(), fileName: f.name, notes: [scan
            ? `${f.name} is a scan: a photo of paper with no real text in it. Upload the original PDF from the payroll company's email (forward the email and save its attachment), not a printed or photographed copy. Or type the rows in below.`
            : `Couldn't read ${f.name}. Refresh the page and try once more. If it still fails, type the rows in below.`] });
        }
      }
      setReports((prev) => [...prev, ...parsed.map(tagReport)]);
      const found = parsed.reduce((s, r) => s + r.rows.length, 0);
      flash(`${parsed.length} report${parsed.length === 1 ? "" : "s"} read · ${found} worker row${found === 1 ? "" : "s"} found. Check the grid, then download the CSV.`);
    } finally {
      setBusy(false);
    }
  };

  const emptyReport = (): CpReport => ({ fileName: TYPED_IN, contractor: "Earth Link General Construction Inc.", payrollNo: "", weekEnding: "", project: "", contractNo: "", rows: [blankRow()], notes: [] });

  const setRep = (i: number, patch: Partial<ReportU>) =>
    setReports((prev) => prev.map((r, x) => (x === i ? { ...r, ...patch } : r)));
  const setRow = (ri: number, wi: number, patch: Partial<CpRow>) =>
    setReports((prev) => prev.map((r, x) => (x === ri ? { ...r, rows: r.rows.map((w, y) => (y === wi ? { ...w, ...patch } : w)) } : r)));
  const setDay = (ri: number, wi: number, which: "st" | "ot", di: number, v: string) =>
    setReports((prev) => prev.map((r, x) => {
      if (x !== ri) return r;
      return { ...r, rows: r.rows.map((w, y) => {
        if (y !== wi) return w;
        const arr: Cell[] = [...w[which]];
        arr[di] = v;
        return { ...w, [which]: arr };
      }) };
    }));

  // anything eComply would bounce gets shown BEFORE the file downloads
  const confirmWarnings = (reps: CpReport[]): boolean => {
    const warns = lcmWarnings(reps).map(clean);
    if (warns.length === 0) return true;
    return window.confirm(`eComply may reject this file:\n\n• ${warns.slice(0, 10).join("\n• ")}${warns.length > 10 ? `\n…and ${warns.length - 10} more` : ""}\n\nDownload anyway?`);
  };

  const download = (reps: CpReport[], name: string) => {
    if (!confirmWarnings(reps)) return;
    const fname = askFileName(name);
    if (!fname) return;
    saveBlob(buildCsv(reps), "text/csv;charset=utf-8", fname);
  };

  const saveBlob = (bytes: Uint8Array | string, type: string, fname: string) => {
    const blob = typeof bytes === "string" ? new Blob([bytes], { type }) : (() => {
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      return new Blob([ab], { type });
    })();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = fname; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  // NYCHA takes certified payroll per RELEASE: one CSV for each release the
  // crew worked that week. The money stays exactly as the payroll report says —
  // only the HOURS split, using the portal's own timesheets (which never hold
  // wages) to see who was on which release.
  const downloadByRelease = async (ri: number, rep: CpReport) => {
    const m = rep.weekEnding.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) { flash("Type the week-ending date (MM/DD/YYYY) first. The split looks up that week's timesheet."); return; }
    // "8/7/2026" becomes "08/07/2026" everywhere — the grid, the CSV, the file names
    const pretty = `${m[1].padStart(2, "0")}/${m[2].padStart(2, "0")}/${m[3]}`;
    if (pretty !== rep.weekEnding) { rep = { ...rep, weekEnding: pretty }; setRep(ri, { weekEnding: pretty }); }
    const iso = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    setBusy(true);
    try {
      const { data: wks, error: wkErr } = await sb().from("timesheet_weeks").select("id").eq("week_ending", iso);
      if (wkErr) { flash("Couldn't reach the portal. Check your signal and try again."); return; }
      if (!wks?.length) { flash(`No payroll week ending ${rep.weekEnding} in the portal. Enter that week's hours on the Payroll tab first.`); return; }
      const [entsRes, empsRes] = await Promise.all([
        sb().from("timesheet_entries").select("employee_id,release_id,hours").in("week_id", wks.map((w: { id: string }) => w.id)),
        sb().from("employees").select("id,name"),
      ]);
      if (entsRes.error || empsRes.error) { flash("Couldn't reach the portal. Check your signal and try again."); return; }
      const ents = entsRes.data, emps = empsRes.data;
      const relIds = [...new Set((ents || []).map((e: { release_id: string | null }) => e.release_id).filter(Boolean))] as string[];
      const relsRes = relIds.length
        ? await sb().from("releases").select("id,rel_number").in("id", relIds)
        : { data: [] as { id: string; rel_number: string }[], error: null };
      if (relsRes.error) { flash("Couldn't reach the portal. Check your signal and try again."); return; }
      const relNumById = new Map((relsRes.data || []).map((r: { id: string; rel_number: string | null }) => [r.id, String(r.rel_number ?? "")]));
      const nameById = new Map((emps || []).map((e: { id: string; name: string }) => [e.id, e.name]));
      // hours by release → by worker (7 days, Sat…Fri — same order as the CSV grid)
      const byRel: Record<string, ReleaseHours> = {};
      // hours that belong to no release — shop, yard, anything off the jobs.
      // They aren't billed to a release, but the week's pay covers them, so
      // they have to count when the pay is shared out.
      const offRelease: Record<string, number[]> = {};
      for (const en of (ents || []) as { employee_id: string; release_id: string | null; hours: (number | string)[] }[]) {
        const k = workerKey(nameById.get(en.employee_id) || "");
        if (!k) continue;
        let rel = en.release_id ? relNumById.get(en.release_id) : undefined;
        if (rel === undefined) {
          const off = (offRelease[k] ||= [0, 0, 0, 0, 0, 0, 0]);
          (en.hours || []).forEach((h, i) => { if (i < 7) off[i] += Number(h) || 0; });
          continue;
        }
        if (!rel.trim()) rel = "unnumbered"; // a release saved without a number still counts
        const g = (byRel[rel] ||= { rel, byWorker: {} });
        const arr = (g.byWorker[k] ||= [0, 0, 0, 0, 0, 0, 0]);
        (en.hours || []).forEach((h, i) => { if (i < 7) arr[i] += Number(h) || 0; });
      }
      const { groups, unmatched } = splitReportByRelease(rep, Object.values(byRel), offRelease);
      if (groups.length === 0) {
        flash("Nobody on this report has release hours that week in the portal. Check the names match the crew list in Settings.");
        return;
      }
      const week = rep.weekEnding.replace(/\//g, "-");
      const allReps = [...groups.map((g) => g.report), ...(unmatched ? [unmatched] : [])];
      if (!confirmWarnings(allReps)) return;
      if (groups.length === 1 && !unmatched) {
        const fname = askFileName(`cpr_rel${groups[0].rel}_${week}.csv`);
        if (!fname) return;
        saveBlob(buildCsv([groups[0].report]), "text/csv;charset=utf-8", fname);
        flash(`The whole week was release #${groups[0].rel}: one CSV made.`);
        return;
      }
      const fname = askFileName(`cpr_by_release_${week}.zip`);
      if (!fname) return;
      const { zipSync, strToU8 } = await import("fflate");
      const files: Record<string, Uint8Array> = {};
      const put = (base: string, rep2: CpReport) => {
        let name = `${base.replace(/[\\/:*?"<>|]/g, "-")}.csv`;
        for (let n = 2; files[name]; n++) name = `${base.replace(/[\\/:*?"<>|]/g, "-")}_${n}.csv`;
        files[name] = strToU8(buildCsv([rep2]));
      };
      groups.forEach((g) => put(`cpr_rel${g.rel}_${week}`, g.report));
      if (unmatched) put(`cpr_NO_RELEASE_FOUND_${week}`, unmatched);
      saveBlob(zipSync(files, { level: 6 }), "application/zip", fname);
      const skipped = unmatched ? ` · not split (see the NO_RELEASE_FOUND file): ${unmatched.rows.map((r) => r.name || "?").join(", ")}` : "";
      flash(`Split into ${groups.length} releases (${groups.map((g) => `#${g.rel}`).join(", ")}), one CSV each${skipped}`);
    } finally {
      setBusy(false);
    }
  };

  // eComply takes ONE week per file — many weeks = one CSV each, zipped
  const downloadAllZip = async () => {
    if (!confirmWarnings(reports)) return;
    const fname = askFileName("cpr_uploads.zip");
    if (!fname) return;
    const { zipSync, strToU8 } = await import("fflate");
    const files: Record<string, Uint8Array> = {};
    reports.forEach((rep, i) => {
      // safe file names, and no week may silently overwrite another
      let base = `cpr_${(rep.payrollNo || String(i + 1))}_${rep.weekEnding.replace(/\//g, "-") || "week"}`.replace(/[\\/:*?"<>|]/g, "-");
      let name = `${base}.csv`;
      for (let n = 2; files[name]; n++) name = `${base}_${n}.csv`;
      files[name] = strToU8(buildCsv([rep]));
    });
    saveBlob(zipSync(files, { level: 6 }), "application/zip", fname);
  };

  const moneyFields: [keyof CpRow, string][] = [
    ["stRate", "ST rate"], ["otRate", "OT rate"], ["grossProject", "Gross (this job)"], ["grossTotal", "Gross (all jobs)"],
    ["fica", "FICA"], ["fedTax", "Federal tax"], ["stateTax", "State tax"], ["cityTax", "City tax"], ["otherDed", "Other deductions"], ["net", "Net pay"],
  ];
  const headFields: [keyof CpReport, string][] = [["payrollNo", "Payroll #"], ["weekEnding", "Week ending"], ["contractNo", "Contract / PO #"], ["project", "Project"], ["contractor", "Contractor"]];
  const lab = (t: string) => <span className="section-label mb-0.5">{t}</span>;

  return (
    <div>
      {busy && <div className="busy-bar" aria-busy="true" aria-label="Working" />}
      <PageHeader title="Certified payroll" sub="Turns the payroll company's PDFs into the CSV eComply takes. Nothing on this page is saved."
        primary={
          <button type="button" className={`btn btn-primary whitespace-nowrap${busy ? " btn-busy" : ""}`} aria-busy={busy || undefined} onClick={() => fileRef.current?.click()} disabled={busy}>
            Upload payroll PDFs
          </button>
        }>
        <button type="button" className="btn btn-ghost whitespace-nowrap" onClick={() => setReports((p) => [...p, tagReport(emptyReport())])}>+ Type a week in</button>
      </PageHeader>
      <input ref={fileRef} type="file" accept="application/pdf" multiple className="hidden" onChange={handleFiles} />

      {/* a PDF is being read: a placeholder card holds the spot where its report will land */}
      {busy && <div className="card mb-4 card-pad"><div className="skeleton h-40 w-full" /></div>}

      {reports.length === 0 && !busy && (
        <div className="card card-pad text-[14px] leading-relaxed text-inksoft">
          <p>
            Upload the certified payroll PDFs from the payroll company, one per week. The reader pulls each worker&apos;s
            name, classification, daily hours, rates, gross, deductions and net into boxes you can correct, then makes the
            CSV for eComply. If a PDF reads badly, fix the boxes by hand and send that PDF over so the reader learns its layout.
          </p>
          <p className="mt-2">
            <b>CSV per release</b> splits a week into one CSV per release: hours from the Payroll tab, money from the payroll
            report, the way NYCHA wants it.
          </p>
        </div>
      )}

      {reports.map((rep, ri) => {
        const days = dayNames(rep.weekEnding);
        return (
          <div key={rep.uid} className="card anim-row mb-4 card-pad">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="font-display text-base font-bold uppercase">
                Week {rep.weekEnding || "(date not set)"}
                <span className="ml-1 text-[12px] font-normal normal-case text-inksoft">{rep.fileName === TYPED_IN ? ` · ${TYPED_IN}` : ` · from ${rep.fileName}`}</span>
              </div>
              <CardToolbar align="end"
                primary={<button type="button" className="btn btn-primary btn-sm" onClick={() => download([rep], `ecomply_${(rep.payrollNo || "payroll")}_${rep.weekEnding.replace(/\//g, "-") || "week"}.csv`)}>⬇ CSV for this week</button>}
                menu={[
                  { label: "CSV per release", glyph: "⬇", title: "One CSV per release. Hours split by the Payroll tab's timesheets, the way NYCHA wants it", disabled: busy, onSelect: () => downloadByRelease(ri, rep) },
                  { label: "Remove this report…", destructive: true, confirm: "Remove this report from the page? (Nothing was saved anywhere.)", onSelect: () => setReports((p) => p.filter((_, x) => x !== ri)) },
                ]} />
            </div>
            {rep.notes.length > 0 && (
              <div className="notice-work mb-3 text-[12px]">
                {rep.notes.map((n, i) => <div key={i}>⚠ {clean(n)}</div>)}
              </div>
            )}
            <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
              {headFields.map(([k, label]) => (
                <label key={k} className="block">
                  {lab(label)}
                  <input className="field px-2 py-2 text-sm" value={String(rep[k] ?? "")} onChange={(e) => setRep(ri, { [k]: e.target.value })}
                    placeholder={k === "weekEnding" ? "MM/DD/YYYY" : undefined} inputMode={k === "weekEnding" ? "numeric" : undefined} />
                </label>
              ))}
            </div>

            {/* one section per worker — the sideways 1,180px grid was unreadable on
                a phone, and a phone is where this gets filled in. Every box is
                full-size (16px on phones, so nothing zooms), every box has its
                label, and the days are labeled over each hour. */}
            {rep.rows.map((w, wi) => {
              const stT = w.st.reduce<number>((s2, h) => s2 + (Number(h) || 0), 0);
              const otT = w.ot.reduce<number>((s2, h) => s2 + (Number(h) || 0), 0);
              return (
                <div key={w.uid} className="anim-row mb-3 border-t border-rulesoft pt-3">
                  <div className="flex items-start gap-2">
                    <label className="block flex-1">{lab("Worker")}
                      <input className="field" placeholder="Last, First" value={w.name} onChange={(e) => setRow(ri, wi, { name: e.target.value })} /></label>
                    <label className="block w-28">{lab("SSN last 4")}
                      <input className="field text-center font-mono" maxLength={11} inputMode="numeric" placeholder="1234" value={w.ssn4} onChange={(e) => setRow(ri, wi, { ssn4: e.target.value.replace(/[^\d-]/g, "") })} /></label>
                    <button type="button" className="btn-icon mt-5 text-alert" aria-label={`Remove ${w.name || "this worker"}`} onClick={() => { if (window.confirm(`Remove ${w.name || "this worker"} from this payroll?`)) setRep(ri, { rows: rep.rows.filter((_, y) => y !== wi) }); }}>✕</button>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <label className="block">{lab("Classification")}
                      <input className="field" placeholder="Laborer…" value={w.classification} onChange={(e) => setRow(ri, wi, { classification: e.target.value })} /></label>
                    <label className="block">{lab("Level")}
                      <select className="field" value={w.trade} onChange={(e) => setRow(ri, wi, { trade: e.target.value })}>
                        <option value="J">Journeyman</option><option value="A">Apprentice</option>
                      </select></label>
                  </div>
                  <label className="mt-2 block">{lab("Street address")}
                    <input className="field" placeholder="123 Main Street" value={w.address} onChange={(e) => setRow(ri, wi, { address: e.target.value })} /></label>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <label className="block">{lab("City")}
                      <input className="field" value={w.city} onChange={(e) => setRow(ri, wi, { city: e.target.value })} /></label>
                    <label className="block">{lab("State")}
                      <input className="field text-center" maxLength={2} placeholder="NY" autoCapitalize="characters" spellCheck={false} value={w.state} onChange={(e) => setRow(ri, wi, { state: e.target.value.toUpperCase() })} /></label>
                    <label className="block">{lab("Zip")}
                      <input className="field" inputMode="numeric" value={w.zip} onChange={(e) => setRow(ri, wi, { zip: e.target.value })} /></label>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <label className="block">{lab("Married?")}
                      <select className="field" value={w.marital} onChange={(e) => setRow(ri, wi, { marital: e.target.value })}>
                        <option value="S">Single</option><option value="M">Married</option>
                      </select></label>
                    <label className="block">{lab("Ethnicity")}
                      <select className="field" value={w.ethnicity} onChange={(e) => setRow(ri, wi, { ethnicity: e.target.value })}>
                        <option value="">(pick one)</option><option value="1">1 Caucasian</option><option value="2">2 African American</option>
                        <option value="3">3 Hispanic</option><option value="4">4 Native Am./Alaskan</option>
                        <option value="5">5 Asian/Pac. Isl.</option><option value="6">6 Other</option>
                      </select></label>
                    <label className="block">{lab("Exemptions")}
                      <input className="field text-center" inputMode="numeric" maxLength={2} placeholder="0"
                        value={String(w.exemption ?? "")} onChange={(e) => setRow(ri, wi, { exemption: e.target.value.replace(/\D/g, "") })} /></label>
                  </div>
                  <div className="section-label mt-3">Straight-time hours</div>
                  <div className="mt-1 grid grid-cols-7 gap-1">
                    {days.map((d, di) => (
                      <label key={di} className="block text-center">
                        <span className="block text-[11px] text-inksoft">{d}</span>
                        <input className="field px-1 py-2.5 text-center font-mono" inputMode="decimal" placeholder="0" value={String(w.st[di] ?? "")} onChange={(e) => setDay(ri, wi, "st", di, e.target.value)} />
                      </label>
                    ))}
                  </div>
                  <div className="section-label mt-2 text-work">Overtime hours</div>
                  <div className="mt-1 grid grid-cols-7 gap-1">
                    {days.map((d, di) => (
                      <label key={di} className="block text-center">
                        <span className="block text-[11px] text-inksoft">{d}</span>
                        <input className="field bg-work/5 px-1 py-2.5 text-center font-mono" inputMode="decimal" placeholder="0" value={String(w.ot[di] ?? "")} onChange={(e) => setDay(ri, wi, "ot", di, e.target.value)} />
                      </label>
                    ))}
                  </div>
                  <div className="mt-1.5 text-right font-mono text-[13px]">{stT || 0} hours{otT ? <span className="text-work"> · {otT} OT</span> : null}</div>
                  <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-5">
                    {moneyFields.map(([k, label]) => (
                      <label key={String(k)} className="block">{lab(label)}
                        <input className="field text-right font-mono" inputMode="decimal" value={String(w[k] ?? "")} onChange={(e) => setRow(ri, wi, { [k]: e.target.value } as Partial<CpRow>)} />
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
            <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={() => setRep(ri, { rows: [...rep.rows, tagRow(blankRow())] })}>+ Add worker</button>
          </div>
        );
      })}

      {reports.length > 1 && (
        <button type="button" className="btn btn-primary mt-2 min-h-[44px]" onClick={downloadAllZip}>⬇ All {reports.length} weeks (one CSV each, zipped)</button>
      )}
      <Toast msg={msg} />
    </div>
  );
}
