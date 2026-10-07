"use client";
import { useRef, useState } from "react";
import type { BoxMark, PhotoMarks } from "@/lib/measure";
import { inchesLabel } from "@/lib/photoMark";

// A photo the owner marks with a finger: two taps on the ends of something
// whose size is known make a ruler (floor to ceiling works in any room), and
// two taps on opposite corners outline the spot to measure. Marks live in
// the photo's own pixels, drawn back over it as it is shown. Read-only, it
// shows the boxes that came back, so the owner can see what got measured.
export type MarkMode = "ruler" | "box";
export const RULER_PICKS = (ceilingFt: number): { label: string; inches: number }[] => [
  { label: `Floor to ceiling · ${ceilingFt} ft`, inches: Math.round(ceilingFt * 12) },
  { label: "Door height · 80 in", inches: 80 },
  { label: "Door width · 32 in", inches: 32 },
  { label: "Outlet cover · 4½ in", inches: 4.5 },
  { label: "Wall tile · 4¼ in", inches: 4.25 },
  { label: "Floor tile · 12 in", inches: 12 },
];

export default function PhotoMarker({ src, name, natural, marks, onChange, ceilingFt, boxes = [], readOnly = false }: {
  src: string; name: string;
  natural: { width: number; height: number } | null;   // the photo's pixels — null until it has loaded
  marks: PhotoMarks; onChange: (m: PhotoMarks) => void;
  ceilingFt: number;
  boxes?: { box: BoxMark; label: string }[];             // what was measured, drawn back
  readOnly?: boolean;
}) {
  const [mode, setMode] = useState<MarkMode | null>(null);
  const [pending, setPending] = useState<{ x: number; y: number } | null>(null); // the first of two taps
  const [asking, setAsking] = useState(false);   // the ruler's two ends are down — how long is it?
  const [typed, setTyped] = useState("");
  const [size, setSize] = useState(natural);
  const box = useRef<HTMLDivElement>(null);
  const dims = natural || size;
  // a tap, in the photo's own pixels
  const at = (ev: React.MouseEvent | React.PointerEvent): { x: number; y: number } | null => {
    const el = box.current; if (!el || !dims) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(((ev.clientX - r.left) / r.width) * dims.width), y: Math.round(((ev.clientY - r.top) / r.height) * dims.height) };
  };
  // how far, in the photo's pixels, a finger's width on the screen reaches
  const fingerPx = (): number => {
    const el = box.current; if (!el || !dims) return 0;
    return (22 / el.getBoundingClientRect().width) * dims.width;
  };
  const tap = (ev: React.MouseEvent) => {
    if (readOnly || !mode) return;
    const p = at(ev); if (!p) return;
    if (!pending) { setPending(p); return; }
    // a tap back on the first dot takes it off, so a slip is one tap to fix
    if (Math.hypot(p.x - pending.x, p.y - pending.y) <= fingerPx()) { setPending(null); return; }
    if (mode === "box") { onChange({ ...marks, box: { x1: pending.x, y1: pending.y, x2: p.x, y2: p.y } }); setPending(null); setMode(null); return; }
    // a ruler: the two ends are down; the length comes next
    onChange({ ...marks, ruler: { x1: pending.x, y1: pending.y, x2: p.x, y2: p.y, inches: 0 } });
    setPending(null); setMode(null); setAsking(true);
  };
  const setLength = (inches: number) => {
    if (!marks.ruler || !(inches > 0)) return;
    onChange({ ...marks, ruler: { ...marks.ruler, inches } });
    setAsking(false); setTyped("");
  };
  const clear = () => { onChange({}); setPending(null); setMode(null); setAsking(false); };
  const start = (m: MarkMode) => { setMode(m); setPending(null); setAsking(false); if (m === "ruler") onChange({ ...marks, ruler: null }); else onChange({ ...marks, box: null }); };
  const r = marks.ruler, b = marks.box;
  const hint = mode === "ruler" ? (pending ? "Now tap the other end" : "Tap one end of something you know the size of") : mode === "box" ? (pending ? "Now tap the opposite corner" : "Tap one corner of the spot") : "";
  const lw = dims ? Math.max(3, Math.round(Math.max(dims.width, dims.height) / 350)) : 3;
  const fs = dims ? Math.max(18, Math.round(Math.max(dims.width, dims.height) / 32)) : 18;

  return (
    <div className="rounded-sm border border-rulesoft bg-white p-2" data-photo-marker={name}>
      <div ref={box} className={`relative w-full overflow-hidden rounded-[2px] ${mode ? "cursor-crosshair" : ""}`} onClick={tap} data-marker-canvas>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={name} className="block w-full select-none" draggable={false}
          onLoad={(e) => { const im = e.currentTarget; if (!natural && im.naturalWidth) setSize({ width: im.naturalWidth, height: im.naturalHeight }); }} />
        {dims && (
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${dims.width} ${dims.height}`} preserveAspectRatio="none" aria-hidden>
            {boxes.map((bx, i) => (
              <g key={i}>
                <rect x={bx.box.x1} y={bx.box.y1} width={bx.box.x2 - bx.box.x1} height={bx.box.y2 - bx.box.y1} fill="var(--color-work)" fillOpacity={0.12} stroke="var(--color-work)" strokeWidth={lw} />
                <text x={bx.box.x1 + lw * 2} y={Math.max(fs, bx.box.y1 - lw * 2)} fontSize={fs} fontWeight="bold" fill="var(--color-work)" stroke="#fff" strokeWidth={lw / 2} paintOrder="stroke">{bx.label}</text>
              </g>
            ))}
            {b && <rect x={Math.min(b.x1, b.x2)} y={Math.min(b.y1, b.y2)} width={Math.abs(b.x2 - b.x1)} height={Math.abs(b.y2 - b.y1)} fill="none" stroke="var(--color-alert)" strokeWidth={lw} strokeDasharray={`${lw * 3} ${lw * 2}`} />}
            {r && (
              <g stroke="var(--color-alert)" strokeWidth={lw} strokeLinecap="round">
                <line x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y2} />
                <circle cx={r.x1} cy={r.y1} r={lw * 2} fill="var(--color-alert)" /><circle cx={r.x2} cy={r.y2} r={lw * 2} fill="var(--color-alert)" />
                {r.inches > 0 && <text x={(r.x1 + r.x2) / 2 + lw * 3} y={(r.y1 + r.y2) / 2} fontSize={fs} fontWeight="bold" fill="var(--color-alert)" stroke="#fff" strokeWidth={lw / 2} paintOrder="stroke">{inchesLabel(r.inches)}</text>}
              </g>
            )}
            {pending && <circle cx={pending.x} cy={pending.y} r={lw * 2.5} fill="var(--color-alert)" />}
          </svg>
        )}
        {/* the instruction sits on the photo itself, where the eye already is */}
        {!readOnly && hint && <div className="pointer-events-none absolute inset-x-0 top-0 bg-ink/70 px-2 py-1.5 text-center text-[13px] font-semibold text-white" data-marker-hint>{hint}</div>}
      </div>
      {!readOnly && (
        <>
          {asking && r && (
            <div className="anim-open mt-1.5" data-marker-length>
              <div className="section-label mb-1">How long is it?</div>
              <div role="radiogroup" aria-label="How long is it?" className="flex flex-wrap gap-1.5">
                {RULER_PICKS(ceilingFt).map((p) => (
                  <button key={p.label} type="button" role="radio" aria-checked={false} className="btn btn-sm normal-case tracking-normal" onClick={() => setLength(p.inches)}>{p.label}</button>
                ))}
                <span className="inline-flex items-center gap-1">
                  <input className="field w-24 px-2 py-1.5 text-right font-mono" inputMode="decimal" placeholder="inches" aria-label="Ruler length in inches" value={typed} onChange={(e) => setTyped(e.target.value)} />
                  <button type="button" className="btn btn-sm" onClick={() => setLength(parseFloat(typed) || 0)}>Use this length</button>
                </span>
              </div>
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {!mode && !asking && (
              <>
                <button type="button" className={`btn btn-sm ${r && r.inches > 0 ? "border-work text-work" : ""}`} onClick={() => start("ruler")} disabled={!dims}>{r && r.inches > 0 ? `✓ Ruler · ${inchesLabel(r.inches)}` : "Mark a ruler"}</button>
                <button type="button" className={`btn btn-sm ${b ? "border-work text-work" : ""}`} onClick={() => start("box")} disabled={!dims}>{b ? "✓ Outline" : "Outline the spot"}</button>
                {(r || b) && <button type="button" className="btn btn-ghost btn-sm" onClick={clear}>Clear</button>}
              </>
            )}
            {(mode || asking) && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setMode(null); setPending(null); setAsking(false); if (r && !(r.inches > 0)) onChange({ ...marks, ruler: null }); }}>{pending ? "Start over" : "Cancel"}</button>}
          </div>
          {!r && !b && !mode && <div className="mt-1 text-[12px] text-inksoft">No ruler on this one. Claude will look for a door, an outlet or the floor-to-ceiling span.</div>}
        </>
      )}
    </div>
  );
}
