"use client";
import { useEffect, useRef, useState } from "react";
import Modal from "@/components/Modal";
import Stamp from "@/components/Stamp";
import PhotoMarker from "@/components/PhotoMarker";
import { sb } from "@/lib/supabase";
import { shrinkImage } from "@/lib/shrinkImage";
import { annotate } from "@/lib/photoMark";
import { CONF_LABEL, DEFAULT_HINTS, MAX_PHOTOS, firstSfLine, lineHasNumber, measureNote, measurePhotos, roundSf, sfLines, typedNote, type MeasureHints, type MeasureResult, type PhotoMarks, type SfLine } from "@/lib/measure";

// "Sq ft from photos" on a PACT job: pick the photos of the wall or ceiling
// (or take them right here — they go on the job as before-photos), mark a
// ruler on each one when nothing in the shot has a known size (floor to
// ceiling works in any room), tell it what's being measured, and Claude
// works out the square feet — from the ruler's arithmetic when there is
// one. Claude's number is an estimate the owner can take as it is or replace
// with their own, row by row — and the square feet can be typed straight in
// with no photo at all (measured with the tape). No dollar figure ever
// shows here — the office uses this too.
export interface MeasureJob { id: string; label: string; attachments: { name: string; path: string }[]; items: SfLine[] }
const isImg = (n: string) => /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(n);
const today = () => { const d = new Date(); return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); };

export default function MeasurePanel({ job, onAttach, onApply, onClose, flash }: {
  job: MeasureJob;
  onAttach: (files: File[]) => Promise<{ name: string; path: string }[]>;   // photos taken here go on the job
  onApply: (lineIndex: number | null, sqft: number, note: string) => Promise<boolean>;
  onClose: () => void;
  flash: (m: string) => void;
}) {
  const photos = job.attachments.filter((a) => isImg(a.name))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith("before")) - Number(!b.name.toLowerCase().startsWith("before")));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const fresh = useRef<Map<string, File>>(new Map()); // the bytes of photos taken here — no download needed
  const objUrls = useRef<Map<string, string>>(new Map());
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [marks, setMarks] = useState<Record<string, PhotoMarks>>({});
  const [hints, setHints] = useState<MeasureHints>({ ...DEFAULT_HINTS });
  // held as typed: a number in the box would swallow the dot in "8.5"
  const [ceiling, setCeiling] = useState(String(DEFAULT_HINTS.ceilingFt));
  const ceilingFt = Number(ceiling) > 0 ? Number(ceiling) : DEFAULT_HINTS.ceilingFt;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MeasureResult | null>(null);
  const [sent, setSent] = useState<string[]>([]);       // the paths that went, in photo order
  const [edits, setEdits] = useState<Record<number, string>>({});   // the owner's own number for a row, as typed — blank means Claude's
  const [manual, setManual] = useState("");                          // square feet typed straight in, no photo
  const [ownTotal, setOwnTotal] = useState("");                      // the owner's own total over the measured rows — beats everything
  const lines = sfLines(job.items);
  const [lineIdx, setLineIdx] = useState<number | null>(firstSfLine(job.items));
  const input = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; objUrls.current.forEach((u) => URL.revokeObjectURL(u)); }, []);

  // thumbnails: a short-lived signed link per photo on the job
  useEffect(() => {
    const paths = photos.map((a) => a.path);
    if (paths.length === 0) { setUrls({}); return; }
    sb().storage.from("docs").createSignedUrls(paths, 900).then(({ data }) => {
      const m: Record<string, string> = {};
      (data || []).forEach((d) => { if (d.signedUrl && d.path) m[d.path] = d.signedUrl; });
      if (alive.current) setUrls(m);
    }).catch(() => { if (alive.current) setUrls({}); });
  }, [job.attachments]); // eslint-disable-line react-hooks/exhaustive-deps
  const srcOf = (path: string): string => objUrls.current.get(path) || urls[path] || "";

  const toggle = (path: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path);
    else if (next.size >= MAX_PHOTOS) { flash(`Up to ${MAX_PHOTOS} photos at a time`); return prev; }
    else next.add(path);
    return next;
  });
  // photos taken here: shrunk like every other photo, put on the job as
  // before-photos, and picked straight away
  const addPhotos = async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "");
      const shrunk = await Promise.all(files.map((f) => shrinkImage(f)));
      const named = shrunk.map((f, i) => new File([f], `before_${stamp}${files.length > 1 ? `_${i + 1}` : ""}${(f.name.match(/\.\w+$/) || [".jpg"])[0]}`, { type: f.type }));
      const added = await onAttach(named);
      added.forEach((a) => { const f = named.find((x) => x.name === a.name); if (f) { fresh.current.set(a.path, f); objUrls.current.set(a.path, URL.createObjectURL(f)); } });
      setPicked((prev) => { const next = new Set(prev); added.forEach((a) => { if (next.size < MAX_PHOTOS) next.add(a.path); }); return next; });
    } finally { setBusy(false); }
  };
  // the bytes of a picked photo: what was taken here, else the copy on the shelf
  const bytesOf = async (path: string): Promise<Blob | null> => {
    const f = fresh.current.get(path);
    if (f) return f;
    const url = urls[path];
    if (!url) return null;
    try { const res = await fetch(url); return res.ok ? await res.blob() : null; } catch { return null; }
  };
  const measure = async () => {
    const paths = photos.map((a) => a.path).filter((p) => picked.has(p));
    if (paths.length === 0) { flash("Pick a photo first — tap one, or take one"); return; }
    const half = paths.filter((p) => marks[p]?.ruler && !(marks[p].ruler!.inches > 0));
    if (half.length) { flash("A ruler on one photo has no length yet — pick how long it is, or clear it"); return; }
    setBusy(true);
    try {
      const got = await Promise.all(paths.map(async (p) => ({ path: p, name: photos.find((a) => a.path === p)?.name || "photo.jpg", blob: await bytesOf(p) })));
      const missing = got.filter((g) => !g.blob);
      if (missing.length) { flash(`Couldn't load ${missing.map((g) => g.name).join(", ")} — check your signal and try again`); return; }
      // the marks are drawn onto the copies that go, and sent as numbers too
      const drawn = await Promise.all(got.map(async (g) => { const a = await annotate(g.blob!, marks[g.path]); return { name: g.name, blob: a.blob, width: a.width, height: a.height, marks: marks[g.path] }; }));
      const out = await measurePhotos(drawn, { ...hints, ceilingFt });
      if (!alive.current) return;
      if (!out.ok) { flash(out.note); return; }
      setResult(out.result); setSent(paths); setEdits({});
      setOwnTotal(manual.trim()); // a number already typed is never lost to the estimate
    } finally { if (alive.current) setBusy(false); }
  };
  // the number for a row: the owner's, when they typed one, else Claude's estimate
  const mine = (i: number): boolean => (edits[i] || "").trim() !== "";
  const sqOf = (i: number): number => {
    const a = result!.areas[i];
    if (a.same_as) return 0;
    return mine(i) ? roundSf(parseFloat(edits[i]) || 0) : a.sq_ft;
  };
  const rowsTotal = result ? result.areas.reduce((s, _a, i) => s + sqOf(i), 0) : 0;
  const ownN = roundSf(parseFloat(ownTotal) || 0);
  const useOwn = ownTotal.trim() !== "" && ownN > 0;
  const total = useOwn ? ownN : rowsTotal;
  const estimateTotal = result ? result.total_sq_ft : 0;
  const nMine = result ? result.areas.filter((a, i) => !a.same_as && mine(i)).length : 0;
  const typedAny = useOwn || nMine > 0;
  const manualN = roundSf(parseFloat(manual) || 0);
  const pickedPaths = photos.map((a) => a.path).filter((p) => picked.has(p));
  const nPicked = pickedPaths.length;
  const nRulers = pickedPaths.filter((p) => marks[p]?.ruler && marks[p].ruler!.inches > 0).length;
  const apply = async () => {
    if (!result || total <= 0) { flash("Nothing to put on the job yet"); return; }
    // a number already on the line — typed on the card, or read off the PO — stays unless the owner types the new one
    if (!typedAny && lineHasNumber(job.items, lineIdx)) { flash(`That line already has ${Number(job.items[lineIdx!].qty)} sq ft on it. An estimate never replaces a number that's there — type the new one in "Your own total" if you want it changed.`); return; }
    setSaving(true);
    try {
      const note = useOwn
        ? typedNote(total, today(), estimateTotal)
        : measureNote({ ...result, areas: result.areas.map((a, i) => ({ ...a, sq_ft: sqOf(i) })), total_sq_ft: total }, sent.length || 1, today(), estimateTotal);
      const ok = await onApply(lineIdx, total, note);
      if (ok) { flash(`${total} sq ft is on the job${typedAny ? "" : " — check it with the tape"}`); onClose(); }
    } finally { if (alive.current) setSaving(false); }
  };
  // the number typed straight in: onto the line, no photo, no estimate
  const applyManual = async () => {
    if (!(manualN > 0)) { flash("Type the square feet first"); return; }
    setSaving(true);
    try {
      const ok = await onApply(lineIdx, manualN, typedNote(manualN, today()));
      if (ok) { flash(`${manualN} sq ft is on the job`); onClose(); }
    } finally { if (alive.current) setSaving(false); }
  };
  // which line takes the number — the job's square-foot lines, or a new Plaster line
  const lineChooser = () => (
    <div role="radiogroup" aria-label="Which line" className="mt-1">
      {lines.map((i) => {
        const it = job.items[i];
        return (
          <button key={i} type="button" role="radio" aria-checked={lineIdx === i} onClick={() => setLineIdx(i)}
            className={`flex min-h-[44px] w-full items-center gap-2 border-b border-rulesoft px-2 text-left text-[13px] last:border-b-0 ${lineIdx === i ? "bg-work/10" : ""}`}>
            <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-[1.5px] border-ink text-[11px] ${lineIdx === i ? "bg-ink text-white" : ""}`}>{lineIdx === i ? "✓" : ""}</span>
            <span className="min-w-0 flex-1 truncate">{it.description || "(no wording)"}</span>
            <span className="shrink-0 font-mono text-[11px] text-inksoft">now {Number(it.qty) || 0} {it.unit || "SF"}</span>
          </button>
        );
      })}
      <button type="button" role="radio" aria-checked={lineIdx === null} onClick={() => setLineIdx(null)}
        className={`flex min-h-[44px] w-full items-center gap-2 px-2 text-left text-[13px] ${lines.length ? "border-t border-rulesoft" : ""} ${lineIdx === null ? "bg-work/10" : ""}`}>
        <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-[1.5px] border-ink text-[11px] ${lineIdx === null ? "bg-ink text-white" : ""}`}>{lineIdx === null ? "✓" : ""}</span>
        <span>+ A new Plaster line</span>
      </button>
    </div>
  );
  const tone = (c: "low" | "medium" | "high") => (c === "high" ? "ok" : c === "medium" ? "work" : "alert");

  return (
    <Modal title={`Sq ft from photos · ${job.label}`} onClose={onClose} wide
      footer={result ? (
        <div className="flex flex-wrap items-center gap-2" data-measure-apply>
          <button type="button" className="btn btn-primary min-h-[44px]" disabled={saving || total <= 0} onClick={apply}>
            {saving ? "Saving…" : `Put ${total} sq ft on the job`}
          </button>
          <button type="button" className="btn btn-ghost min-h-[44px]" disabled={busy} onClick={() => { setResult(null); setEdits({}); }}>Measure again</button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-primary min-h-[44px]" disabled={busy || nPicked === 0} onClick={measure} data-measure-go>
            {busy ? "Measuring…" : `Measure${nPicked ? ` ${nPicked} photo${nPicked === 1 ? "" : "s"}` : ""}`}
          </button>
          <button type="button" className="btn btn-ghost min-h-[44px]" disabled={busy} onClick={() => input.current?.click()}>📷 Take or pick photos</button>
        </div>
      )}>
      <input ref={input} type="file" accept="image/*" multiple className="hidden" data-measure-input
        onChange={(e) => { const fs = Array.from(e.target.files || []); e.target.value = ""; void addPhotos(fs); }} />
      {!result && (
        <>
          <p className="mb-2 text-[13px] text-inksoft">Tap the photos of the wall or ceiling. Best shot: step back so the floor and the ceiling are both in the picture. The number that comes back is a starting point — the tape measure wins.</p>
          {photos.length === 0 && <div className="mb-2 rounded-sm border border-rulesoft bg-paper p-3 text-[13px] text-inksoft">No photos on this job yet — take some, or pick them from the camera roll.</div>}
          {photos.length > 0 && (
            <div className="mb-3 grid grid-cols-3 gap-1.5">
              {photos.map((a) => {
                const on = picked.has(a.path);
                return (
                  <button key={a.path} type="button" role="checkbox" aria-checked={on} aria-label={a.name} data-measure-photo={a.name} onClick={() => toggle(a.path)}
                    className={`relative block min-h-[44px] w-full rounded-sm border-2 ${on ? "border-work" : "border-rulesoft"}`}>
                    {srcOf(a.path)
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={srcOf(a.path)} alt={a.name} className="h-24 w-full rounded-[2px] object-cover" />
                      : <div className="grid h-24 w-full place-items-center px-1 text-center text-[11px] text-inksoft">{a.name.replace(/\.\w+$/, "")}</div>}
                    {on && <span className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-work text-[13px] font-bold text-white">✓</span>}
                  </button>
                );
              })}
            </div>
          )}
          {nPicked > 0 && (
            <div className="mb-3" data-measure-marks>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-inksoft">A ruler on each photo — {nRulers} of {nPicked}</div>
              <p className="mb-2 text-[12px] text-inksoft">When nothing in the shot has a known size, mark one thing you do know: tap the floor and the ceiling on the wall (that's {ceilingFt} ft), the top and bottom of a door, or two ends of something you measured with the tape. With a ruler the number is worked out, not guessed.</p>
              <div className="grid gap-2">
                {pickedPaths.map((p) => {
                  const a = photos.find((x) => x.path === p)!;
                  return srcOf(p)
                    ? <PhotoMarker key={p} src={srcOf(p)} name={a.name} natural={null} marks={marks[p] || {}} onChange={(m) => setMarks((prev) => ({ ...prev, [p]: m }))} ceilingFt={ceilingFt} />
                    : <div key={p} className="rounded-sm border border-rulesoft bg-paper p-3 text-[12px] text-inksoft">{a.name} — can't be shown right now (no signal?), so no ruler on it; Claude will look for one in the shot.</div>;
                })}
              </div>
            </div>
          )}
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-inksoft">What to measure</div>
          <div className="mb-3 inline-flex rounded-sm border-[1.5px] border-ink" role="radiogroup" aria-label="What to measure">
            {([["spots", "Just the damaged spots"], ["whole", "The whole wall or ceiling"]] as const).map(([v, label], i) => (
              <button key={v} type="button" role="radio" aria-checked={hints.scope === v} onClick={() => setHints({ ...hints, scope: v })}
                className={`min-h-[44px] px-3 font-display text-[12px] font-semibold uppercase tracking-wider ${i > 0 ? "border-l-[1.5px] border-ink" : ""} ${hints.scope === v ? "bg-ink text-white" : "bg-white text-ink"}`}>{label}</button>
            ))}
          </div>
          <div className="grid gap-2 sm:grid-cols-[140px_1fr]">
            <label className="block"><span className="mb-1 block text-[11px] uppercase tracking-widest text-inksoft">Ceiling height (ft)</span>
              <input className="field font-mono" inputMode="decimal" value={ceiling} onChange={(e) => setCeiling(e.target.value)} /></label>
            <label className="block"><span className="mb-1 block text-[11px] uppercase tracking-widest text-inksoft">Anything it should know</span>
              <input className="field" placeholder="e.g. the door is 32 in wide, the tile is 4 in" value={hints.note} onChange={(e) => setHints({ ...hints, note: e.target.value })} /></label>
          </div>
          <div className="mt-4 border-t border-rulesoft pt-3" data-measure-manual>
            <div className="text-[11px] font-semibold uppercase tracking-widest text-inksoft">Or type it in yourself</div>
            <p className="mb-1.5 text-[12px] text-inksoft">Measured it with the tape? Put the number straight on the job — no photos needed.</p>
            <label className="inline-flex items-center gap-2 text-[13px]">
              <input className="field w-28 px-2 py-2 text-right font-mono" inputMode="decimal" placeholder="0" aria-label="Square feet, typed in" value={manual} onChange={(e) => setManual(e.target.value)} />sq ft
            </label>
            {lineChooser()}
            <button type="button" className="btn btn-primary mt-2 min-h-[44px]" disabled={saving || !(manualN > 0)} onClick={applyManual} data-measure-manual-go>
              {saving ? "Saving…" : `Put ${manualN || ""} sq ft on the job`}
            </button>
          </div>
        </>
      )}
      {result && (
        <div data-measure-result>
          {result.warnings.map((w, i) => <div key={i} className="mb-2 rounded-sm border border-alert/40 bg-white px-3 py-2 text-[13px] text-alert">⚠ {w}</div>)}
          {/* the photos, with what got measured drawn on them */}
          <div className="mb-2 grid gap-2">
            {sent.map((p, pi) => {
              const a = photos.find((x) => x.path === p);
              const boxes = result.areas.map((ar, i) => ({ ar, i })).filter(({ ar }) => ar.photo === pi + 1 && !ar.same_as && ar.box).map(({ ar, i }) => ({ box: ar.box!, label: `${sqOf(i)} sq ft` }));
              return a && srcOf(p) && boxes.length
                ? <PhotoMarker key={p} src={srcOf(p)} name={a.name} natural={null} marks={marks[p] || {}} onChange={() => null} ceilingFt={ceilingFt} boxes={boxes} readOnly />
                : null;
            })}
          </div>
          {result.areas.map((a, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 border-t border-rulesoft py-2 first:border-t-0" data-measure-area>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold">{a.where}<span className="ml-1.5 text-[11px] font-normal uppercase tracking-widest text-inksoft">{a.surface} · photo {a.photo}</span></div>
                <div className="text-[11px] text-inksoft">
                  {a.same_as ? `the same area as photo ${a.same_as} — counted once` : `${a.width_ft} × ${a.height_ft} ft${a.ruler ? ` · ruler: ${a.ruler}` : ""}`}{a.note ? ` · ${a.note}` : ""}
                </div>
              </div>
              {!a.same_as && (
                <div className="flex basis-full flex-wrap items-center gap-2 pt-1">
                  <Stamp label={CONF_LABEL[a.confidence]} tone={tone(a.confidence)} />
                  <span className={`text-[13px] ${mine(i) ? "text-inksoft line-through decoration-rulesoft" : "font-semibold"}`} data-measure-estimate>Claude: {a.sq_ft} sq ft</span>
                  <label className="ml-auto flex items-center gap-1 text-[11px] uppercase tracking-widest text-inksoft">Yours
                    <input className="field w-20 px-1.5 py-1.5 text-right font-mono normal-case" inputMode="decimal" aria-label={`Square feet for ${a.where}`} placeholder={String(a.sq_ft)} value={edits[i] ?? ""}
                      onChange={(e) => setEdits({ ...edits, [i]: e.target.value })} />sq ft
                  </label>
                  {mine(i) && <button type="button" className="min-h-[44px] px-2 text-[12px] text-inksoft underline" onClick={() => setEdits({ ...edits, [i]: "" })}>use Claude's</button>}
                </div>
              )}
            </div>
          ))}
          <div className="mt-2 flex items-center justify-between border-t-2 border-ink pt-2">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-inksoft">Total</span>
            <span className="font-mono text-[15px] font-bold" data-measure-total>{total} sq ft</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[12px] text-inksoft" data-measure-using>
            <span>{useOwn ? `Using your own total — Claude's estimate was ${estimateTotal} sq ft.` : nMine ? `Using your number on ${nMine} row${nMine === 1 ? "" : "s"} — Claude's estimate was ${estimateTotal} sq ft.` : "Using Claude's estimate. Type your own in any row, or your own total, to use that instead."}</span>
            {(nMine > 0 || useOwn) && <button type="button" className="min-h-[44px] text-[12px] underline" onClick={() => { setEdits({}); setOwnTotal(""); }}>Use Claude's estimate for all</button>}
          </div>
          <label className="mt-1 flex flex-wrap items-center gap-2 text-[13px]" data-measure-own>
            <span className="text-[11px] font-semibold uppercase tracking-widest text-inksoft">Your own total</span>
            <input className="field w-24 px-2 py-1.5 text-right font-mono" inputMode="decimal" placeholder={String(rowsTotal)} aria-label="Your own total, in square feet" value={ownTotal} onChange={(e) => setOwnTotal(e.target.value)} />sq ft
            <span className="text-[11px] text-inksoft">— a number you type always wins</span>
          </label>
          <p className="mt-2 text-[12px] text-inksoft">{nRulers ? "Solid rows were worked out from your ruler." : "For a solid number next time, mark a ruler on the photo."} The tape measure wins.</p>
          <div className="mt-3 text-[11px] font-semibold uppercase tracking-widest text-inksoft">Put it on</div>
          {lineChooser()}
          <p className="mt-2 text-[11px] text-inksoft">Only this line's square feet change. The photos, the PO and the other lines are not touched, and a number already on the line stays unless you type the new one.</p>
        </div>
      )}
    </Modal>
  );
}
