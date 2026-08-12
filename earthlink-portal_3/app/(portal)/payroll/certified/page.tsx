"use client";
// Certified payroll → eComply CSV converter.
// Drop in the weekly certified payroll PDFs, check the numbers in the grid,
// download a CSV ready for eComply. Everything happens ON THIS PHONE —
// nothing here is uploaded or saved anywhere, and wages never touch the
// portal's database.
import { useRef, useState } from "react";
import Link from "next/link";
import { parseCertifiedPayroll, buildCsv, lcmWarnings, blankRow, dayLabels, type CpReport, type CpRow, type CpLine, type Cell } from "@/lib/certifiedPayroll";
import { askFileName } from "@/lib/format";

interface PdfDocLite { destroy?: () => Promise<void> }

export default function CertifiedPayroll() {
  const [reports, setReports] = useState<CpReport[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 4000); };

  // read a PDF into text lines: words clustered by row (y), ordered by x —
  // that keeps table columns in left-to-right order for the reader
  const extractLines = async (file: File, pdfjs: typeof import("pdfjs-dist")): Promise<CpLine[]> => {
    let doc: PdfDocLite | null = null;
    try {
      const loaded = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
      doc = loaded as unknown as PdfDocLite;
      const lines: CpLine[] = [];
      for (let pg = 1; pg <= loaded.numPages; pg++) {
        const tc = await (await loaded.getPage(pg)).getTextContent();
        const words: { x: number; y: number; s: string }[] = [];
        for (const it of tc.items) {
          if (!("str" in it) || !it.str.trim()) continue;
          const t = (it as { transform: number[] }).transform;
          words.push({ x: t[4], y: t[5], s: it.str.trim() });
        }
        // cluster into rows: same line = y within 3pt
        words.sort((a, b) => b.y - a.y || a.x - b.x);
        let cur: { y: number; ws: { x: number; s: string }[] } | null = null;
        for (const w of words) {
          if (!cur || Math.abs(cur.y - w.y) > 3) { cur = { y: w.y, ws: [] }; lines.push({ tokens: [] }); }
          cur.ws.push({ x: w.x, s: w.s });
          lines[lines.length - 1].tokens = cur.ws.sort((a, b) => a.x - b.x).map((v) => v.s);
        }
      }
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
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      const parsed: CpReport[] = [];
      for (const f of files) {
        try {
          const lines = await extractLines(f, pdfjs);
          parsed.push(parseCertifiedPayroll(f.name, lines));
        } catch {
          parsed.push({ ...emptyReport(), fileName: f.name, notes: [`Couldn't read ${f.name} — if it's a scan (a photo of paper), type the rows in below.`] });
        }
      }
      setReports((prev) => [...prev, ...parsed]);
      const found = parsed.reduce((s, r) => s + r.rows.length, 0);
      flash(`${parsed.length} report${parsed.length === 1 ? "" : "s"} read · ${found} worker row${found === 1 ? "" : "s"} found — check the grid, then download the CSV`);
    } finally {
      setBusy(false);
    }
  };

  const emptyReport = (): CpReport => ({ fileName: "typed in by hand", contractor: "Earth Link General Construction Inc.", payrollNo: "", weekEnding: "", project: "", contractNo: "", rows: [blankRow()], notes: [] });

  const setRep = (i: number, patch: Partial<CpReport>) =>
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

  // anything their upload would bounce gets shown BEFORE the file downloads
  const confirmWarnings = (reps: CpReport[]): boolean => {
    const warns = lcmWarnings(reps);
    if (warns.length === 0) return true;
    return window.confirm(`Their upload may reject this file:\n\n• ${warns.slice(0, 10).join("\n• ")}${warns.length > 10 ? `\n…and ${warns.length - 10} more` : ""}\n\nDownload anyway?`);
  };

  const download = (reps: CpReport[], name: string) => {
    if (!confirmWarnings(reps)) return;
    const fname = askFileName(name);
    if (!fname) return;
    const blob = new Blob([buildCsv(reps)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = fname; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  // their upload takes ONE week per file — many weeks = one CSV each, zipped
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
    const zipped = zipSync(files, { level: 6 });
    const ab = new ArrayBuffer(zipped.byteLength);
    new Uint8Array(ab).set(zipped);
    const url = URL.createObjectURL(new Blob([ab], { type: "application/zip" }));
    const a = document.createElement("a");
    a.href = url; a.download = fname; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const moneyFields: [keyof CpRow, string][] = [
    ["stRate", "ST rate"], ["otRate", "OT rate"], ["grossProject", "Gross (this job)"], ["grossTotal", "Gross (all jobs)"],
    ["fica", "FICA"], ["fedTax", "Federal tax"], ["stateTax", "State tax"], ["cityTax", "City tax"], ["otherDed", "Other ded."], ["net", "Net pay"],
  ];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-display text-2xl font-bold uppercase">eComply CSV</div>
          <div className="text-[11px] text-inksoft">Certified payroll PDF → CSV for upload. Nothing on this page is saved anywhere.</div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Link className="btn btn-ghost whitespace-nowrap px-3 py-2 text-[13px]" href="/payroll">← Payroll</Link>
          <button className="btn btn-ghost whitespace-nowrap px-3 py-2 text-[13px]" onClick={() => setReports((p) => [...p, emptyReport()])}>+ Type one in</button>
          <button className="btn btn-primary whitespace-nowrap px-3 py-2 text-[13px]" onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? "Reading…" : "📄 Upload payroll PDF(s)"}
          </button>
        </div>
      </div>
      <input ref={fileRef} type="file" accept="application/pdf" multiple className="hidden" onChange={handleFiles} />

      {reports.length === 0 && (
        <div className="card p-5 text-sm text-inksoft">
          Upload the certified payroll PDF(s) from your payroll company — one per week. The reader pulls out each worker&apos;s
          name, classification, day-by-day hours, rates, gross, deductions and net, shows it all in a grid you can correct,
          then makes a CSV file for eComply. If a PDF reads badly, fix the cells by hand — and send that PDF over so the
          reader can learn its layout.
        </div>
      )}

      {reports.map((rep, ri) => {
        const days = dayLabels(rep.weekEnding);
        return (
          <div key={ri} className="card mb-4 p-3.5">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="font-display text-base font-bold uppercase">Week {rep.weekEnding || "?"} <span className="ml-1 text-[11px] font-normal normal-case text-inksoft">from {rep.fileName}</span></div>
              <div className="flex gap-2">
                <button className="btn btn-primary px-3 py-1.5 text-[13px]" onClick={() => download([rep], `ecomply_${(rep.payrollNo || "payroll")}_${rep.weekEnding.replace(/\//g, "-") || "week"}.csv`)}>⬇ CSV for this week</button>
                <button className="text-xs text-alert" title="Remove this report" onClick={() => { if (window.confirm("Remove this report from the page? (Nothing was saved anywhere.)")) setReports((p) => p.filter((_, x) => x !== ri)); }}>✕</button>
              </div>
            </div>
            {rep.notes.length > 0 && (
              <div className="mb-2 rounded-sm border border-work bg-work/5 p-2 text-[12px]">
                {rep.notes.map((n, i) => <div key={i}>⚠ {n}</div>)}
              </div>
            )}
            <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
              {([["payrollNo", "Payroll #"], ["weekEnding", "Week ending (MM/DD/YYYY)"], ["contractNo", "Contract / PO #"], ["project", "Project / development"], ["contractor", "Contractor"]] as [keyof CpReport, string][]).map(([k, label]) => (
                <label key={k} className="block">
                  <span className="text-[10px] uppercase tracking-widest text-inksoft">{label}</span>
                  <input className="field px-2 py-2 text-sm" value={String(rep[k] ?? "")} onChange={(e) => setRep(ri, { [k]: e.target.value })} />
                </label>
              ))}
            </div>

            <div className="card overflow-x-auto">
              <table className="w-full border-collapse text-[13px]" style={{ minWidth: 1180 }}>
                <thead>
                  <tr className="border-b-[1.5px] border-ink text-left font-display text-[10px] uppercase tracking-widest text-inksoft">
                    <th className="min-w-[210px] p-2">Worker</th>
                    <th className="p-2">SSN<div className="font-normal">last 4 or full</div></th>
                    <th className="min-w-[120px] p-2">Classification</th>
                    {days.map((d, i) => <th key={i} className="p-2 text-center">{d}<div className="font-normal">ST / OT</div></th>)}
                    <th className="p-2 text-right">Hours</th>
                    {moneyFields.map(([k, label]) => <th key={String(k)} className="p-2 text-right">{label}</th>)}
                    <th className="p-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {rep.rows.map((w, wi) => {
                    const stT = w.st.reduce<number>((s, h) => s + (Number(h) || 0), 0);
                    const otT = w.ot.reduce<number>((s, h) => s + (Number(h) || 0), 0);
                    return (
                      <tr key={wi} className="border-b border-rulesoft align-top">
                        <td className="p-1.5">
                          <input className="field px-2 py-1.5 text-[13px]" placeholder="Last, First" value={w.name} onChange={(e) => setRow(ri, wi, { name: e.target.value })} />
                          <input className="field mt-1 px-2 py-1.5 text-[12px]" placeholder="Street address" value={w.address} onChange={(e) => setRow(ri, wi, { address: e.target.value })} />
                          <div className="mt-1 grid grid-cols-3 gap-1">
                            <input className="field px-1.5 py-1 text-[11px]" placeholder="City" value={w.city} onChange={(e) => setRow(ri, wi, { city: e.target.value })} />
                            <input className="field px-1.5 py-1 text-[11px]" placeholder="NY" maxLength={2} title="State (blank = read from the address, else NY)" value={w.state} onChange={(e) => setRow(ri, wi, { state: e.target.value.toUpperCase() })} />
                            <input className="field px-1.5 py-1 text-[11px]" placeholder="Zip" value={w.zip} onChange={(e) => setRow(ri, wi, { zip: e.target.value })} />
                          </div>
                          <div className="mt-1 flex gap-1">
                            <select className="field px-1 py-1 text-[11px]" title="Marital status" value={w.marital} onChange={(e) => setRow(ri, wi, { marital: e.target.value })}>
                              <option value="S">Single</option><option value="M">Married</option>
                            </select>
                            <select className="field px-1 py-1 text-[11px]" title="Gender" value={w.gender} onChange={(e) => setRow(ri, wi, { gender: e.target.value })}>
                              <option value="">—</option><option value="M">M</option><option value="F">F</option>
                            </select>
                            <select className="field px-1 py-1 text-[11px]" title="Journeyman or Apprentice" value={w.trade} onChange={(e) => setRow(ri, wi, { trade: e.target.value })}>
                              <option value="J">Journeyman</option><option value="A">Apprentice</option>
                            </select>
                            <select className="field px-1 py-1 text-[11px]" title="Ethnicity code (their upload wants it)" value={w.ethnicity} onChange={(e) => setRow(ri, wi, { ethnicity: e.target.value })}>
                              <option value="">Ethn.—</option><option value="1">1 Caucasian</option><option value="2">2 African American</option>
                              <option value="3">3 Hispanic</option><option value="4">4 Native Am./Alaskan</option>
                              <option value="5">5 Asian/Pac. Isl.</option><option value="6">6 Other</option>
                            </select>
                            <input className="field w-12 px-1 py-1 text-center text-[11px]" title="Tax exemptions claimed (0-99)" inputMode="numeric" maxLength={2}
                              value={String(w.exemption ?? "")} onChange={(e) => setRow(ri, wi, { exemption: e.target.value.replace(/\D/g, "") })} />
                          </div>
                        </td>
                        <td className="p-1.5"><input className="field w-24 px-2 py-1.5 text-center font-mono text-[13px]" maxLength={11} inputMode="numeric" title="Last 4 (goes out as 000-00-1234) or the full 9 digits" value={w.ssn4} onChange={(e) => setRow(ri, wi, { ssn4: e.target.value.replace(/[^\d-]/g, "") })} /></td>
                        <td className="p-1.5"><input className="field px-2 py-1.5 text-[13px]" placeholder="Laborer…" value={w.classification} onChange={(e) => setRow(ri, wi, { classification: e.target.value })} /></td>
                        {days.map((_, di) => (
                          <td key={di} className="p-1">
                            <input className="field w-12 px-1 py-1 text-center font-mono text-[12px]" inputMode="decimal" placeholder="0" value={String(w.st[di] ?? "")} onChange={(e) => setDay(ri, wi, "st", di, e.target.value)} />
                            <input className="field mt-1 w-12 bg-work/5 px-1 py-1 text-center font-mono text-[12px]" inputMode="decimal" placeholder="0" title="Overtime" value={String(w.ot[di] ?? "")} onChange={(e) => setDay(ri, wi, "ot", di, e.target.value)} />
                          </td>
                        ))}
                        <td className="whitespace-nowrap p-2 text-right font-mono text-[12px]">{stT || 0}<div className="text-work">{otT || 0} OT</div></td>
                        {moneyFields.map(([k]) => (
                          <td key={String(k)} className="p-1"><input className="field w-20 px-1.5 py-1.5 text-right font-mono text-[12px]" inputMode="decimal" value={String(w[k] ?? "")} onChange={(e) => setRow(ri, wi, { [k]: e.target.value } as Partial<CpRow>)} /></td>
                        ))}
                        <td className="p-2"><button className="text-xs text-alert" title="Remove worker" onClick={() => setRep(ri, { rows: rep.rows.filter((_, y) => y !== wi) })}>✕</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <button className="btn btn-ghost mt-2 px-3 py-1.5 text-[13px]" onClick={() => setRep(ri, { rows: [...rep.rows, blankRow()] })}>+ Add worker</button>
          </div>
        );
      })}

      {reports.length > 1 && (
        <button className="btn btn-primary" onClick={downloadAllZip}>⬇ All {reports.length} weeks — one CSV each, zipped</button>
      )}
      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
