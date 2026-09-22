"use client";
import { useEffect, useRef, useState } from "react";
import Modal from "@/components/Modal";
import Stamp from "@/components/Stamp";
import PhotoMarker from "@/components/PhotoMarker";
import { sb } from "@/lib/supabase";
import { shrinkImage } from "@/lib/shrinkImage";
import { annotate } from "@/lib/photoMark";
import { CONF_LABEL, DEFAULT_HINTS, MAX_PHOTOS, measureNote, measurePhotos, roundSf, sfLines, type MeasureHints, type MeasureResult, type PhotoMarks, type SfLine } from "@/lib/measure";

// "Sq ft from photos" on a PACT job: pick the photos of the wall or ceiling
// (or take them right here — they go on the job as before-photos), mark a
// ruler on each one when nothing in the shot has a known size (floor to
// ceiling works in any room), tell it what's being measured, and Claude
// works out the square feet — from the ruler's arithmetic when there is
// one. Every number can be changed before it lands on the job's square-foot
// line. No dollar figure ever shows here — the office uses this too.
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
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MeasureResult | null>(null);
  const [sent, setSent] = useState<string[]>([]);       // the paths that went, in photo order
  const [edits, setEdits] = useState<Record<number, string>>({});   // the owner's own number for a row, as typed
  const lines = sfLines(job.items);
  const [lineIdx, setLineIdx] = useState<number | null>(lines.length ? lines[0] : null);
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
      const out = await measurePhotos(drawn, hints);
      if (!alive.current) return;
      if (!out.ok) { flash(out.note); return; }
      setResult(out.result); setSent(paths); setEdits({});
    } finally { if (alive.current) setBusy(false); }
  };
  // the number for a row: the owner's, when typed, else Claude's
  const sqOf = (i: number): number => {
    const a = result!.areas[i];
    if (a.same_as) return 0;
    const e = edits[i];
    return e === undefined ? a.sq_ft : roundSf(parseFloat(e) || 0);
  };
  const total = result ? result.areas.reduce((s, _a, i) => s + sqOf(i), 0) : 0;
  const pickedPaths = photos.map((a) => a.path).filter((p) => picked.has(p));
  const nPicked = pickedPaths.length;
  const nRulers = pickedPaths.filter((p) => marks[p]?.ruler && marks[p].ruler!.inches > 0).length;
  const apply = async () => {
    if (!result || total <= 0) { flash("Nothing to put on the job yet"); return; }
    setSaving(true);
    try {
      const r: MeasureResult = { ...result, areas: result.areas.map((a, i) => ({ ...a, sq_ft: sqOf(i) })), total_sq_ft: total };
      const ok = await onApply(lineIdx, total, measureNote(r, sent.length || 1, today()));
      if (ok) { flash(`${total} sq ft is on the job — check it with the tape`); onClose(); }
    } finally { if (alive.current) setSaving(false); }
  };
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
              <p className="mb-2 text-[12px] text-inksoft">When nothing in the shot has a known size, mark one thing you do know: tap the floor and the ceiling on the wall (that's {hints.ceilingFt || 8} ft), the top and bottom of a door, or two ends of something you measured with the tape. With a ruler the number is worked out, not guessed.</p>
              <div className="grid gap-2">
                {pickedPaths.map((p) => {
                  const a = photos.find((x) => x.path === p)!;
                  return srcOf(p)
                    ? <PhotoMarker key={p} src={srcOf(p)} name={a.name} natural={null} marks={marks[p] || {}} onChange={(m) => setMarks((prev) => ({ ...prev, [p]: m }))} ceilingFt={hints.ceilingFt || 8} />
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
              <input className="field font-mono" inputMode="decimal" value={hints.ceilingFt} onChange={(e) => setHints({ ...hints, ceilingFt: Number(e.target.value) || 0 })} /></label>
            <label className="block"><span className="mb-1 block text-[11px] uppercase tracking-widest text-inksoft">Anything it should know</span>
              <input className="field" placeholder="e.g. the door is 32 in wide, the tile is 4 in" value={hints.note} onChange={(e) => setHints({ ...hints, note: e.target.value })} /></label>
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
                ? <PhotoMarker key={p} src={srcOf(p)} name={a.name} natural={null} marks={marks[p] || {}} onChange={() => null} ceilingFt={hints.ceilingFt || 8} boxes={boxes} readOnly />
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
                <>
                  <Stamp label={CONF_LABEL[a.confidence]} tone={tone(a.confidence)} />
                  <label className="flex items-center gap-1 text-[11px] uppercase tracking-widest text-inksoft">
                    <input className="field w-20 px-1.5 py-1.5 text-right font-mono" inputMode="decimal" aria-label={`Square feet for ${a.where}`} value={edits[i] ?? String(a.sq_ft)}
                      onChange={(e) => setEdits({ ...edits, [i]: e.target.value })} />sq ft
                  </label>
                </>
              )}
            </div>
          ))}
          <div className="mt-2 flex items-center justify-between border-t-2 border-ink pt-2">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-inksoft">Total</span>
            <span className="font-mono text-[15px] font-bold" data-measure-total>{total} sq ft</span>
          </div>
          <p className="mt-2 text-[12px] text-inksoft">Not the right number? Change it above. {nRulers ? "Solid rows were worked out from your ruler." : "For a solid number next time, mark a ruler on the photo."} The tape measure wins.</p>
          <div className="mt-3 text-[11px] font-semibold uppercase tracking-widest text-inksoft">Put it on</div>
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
        </div>
      )}
    </Modal>
  );
}
