"use client";
import { useEffect, useRef, useState } from "react";
import { fmt } from "@/lib/format";
import { useNumBuffer } from "@/lib/numBuffer";
import { unitFor } from "@/lib/priceBook";
import { scrollTo } from "@/lib/motion";

// The PACT work lines: one editor for the job card and the invoice dialog.
// Each line stacks: the description on its own row, the numbers in a fixed
// grid under it, so nothing scrolls sideways on a phone. Every keystroke goes
// to onChange (running totals); a blur goes to onCommit (the save). Prices,
// amounts and the sales tax are Admin 1's alone, so the office never sees a
// dollar here (canPrice). Removing a line is one tap, with an Undo toast.
export interface WorkLine { description: string; qty: number; unit: string; unit_price: number; key?: string; base?: string }

export default function WorkLines({ items, canPrice, bufferKey, onChange, onCommit, flashWithUndo, taxPct, onTax, extra }: {
  items: WorkLine[];
  canPrice: boolean;
  bufferKey: string; // keeps this editor's typed numbers apart from another's (the card and the dialog)
  onChange: (items: WorkLine[]) => void; // every keystroke, for the running totals
  onCommit: (items: WorkLine[]) => void; // on blur: the save
  flashWithUndo: (msg: string, undo: () => void) => void;
  taxPct?: number; // with onTax, draws the stacked "Sales tax %" field (Admin 1 only)
  onTax?: (pct: number) => void;
  extra?: React.ReactNode; // more buttons beside "+ Add line" (Price from list)
}) {
  const num = useNumBuffer();
  const wrap = useRef<HTMLDivElement>(null);
  // the row that was just added slides in; the others never re-animate
  const [fresh, setFresh] = useState<number | null>(null);
  const focusNew = useRef(false);
  // the latest lines, for an Undo tapped after more typing
  const latest = useRef(items);
  latest.current = items;

  const update = (i: number, patch: Partial<WorkLine>, commit = false) => {
    const next = [...items];
    next[i] = { ...next[i], ...patch };
    (commit ? onCommit : onChange)(next);
  };
  const remove = (i: number) => {
    const gone = items[i];
    onCommit(items.filter((_, x) => x !== i));
    flashWithUndo("Line removed", () => {
      const back = [...latest.current];
      back.splice(Math.min(i, back.length), 0, gone);
      onCommit(back);
    });
  };
  const add = () => {
    setFresh(items.length);
    focusNew.current = true;
    onCommit([...items, { description: "", qty: 1, unit: "EACH", unit_price: 0 }]);
  };
  // once the new row is on screen, the cursor is in its description
  useEffect(() => {
    if (!focusNew.current) return;
    focusNew.current = false;
    requestAnimationFrame(() => {
      const all = wrap.current?.querySelectorAll<HTMLInputElement>("[data-line-desc]");
      const last = all && all[all.length - 1];
      if (!last) return;
      last.focus({ preventScroll: true });
      scrollTo(last, "nearest");
    });
  }, [items.length]);

  return (
    <div ref={wrap}>
      {items.map((it, i) => (
        <div key={i} data-line className={`mb-2 flex flex-wrap items-start gap-1.5 rounded-sm border border-rulesoft p-2 ${i === fresh ? "anim-row" : ""}`}>
          <input data-line-desc className="field min-w-0 flex-1" placeholder="What was done: door, plaster, paint…" aria-label="What was done" value={it.description}
            onChange={(e) => {
              // the unit follows the words until someone sets it by hand
              const auto = unitFor(e.target.value);
              update(i, { description: e.target.value, unit: it.unit === unitFor(it.description) || !it.unit ? auto : it.unit });
            }}
            onBlur={() => onCommit(items)} />
          <button type="button" className="btn-icon btn-icon-quiet text-alert" aria-label="Remove line" onClick={() => remove(i)}>✕</button>
          <div className={`grid basis-full items-start gap-1.5 ${canPrice ? "grid-cols-4" : "grid-cols-2"}`}>
            <div><div className="section-label">Qty</div>
              <input className="field px-1.5 py-1.5 text-right font-mono" inputMode="decimal" aria-label="Quantity"
                {...num(`${bufferKey}:${i}:q`, Number(it.qty) || 0, (n) => update(i, { qty: n }), (n) => update(i, { qty: n }, true))} /></div>
            <div><div className="section-label">Unit</div>
              <input className="field px-1 py-1.5 text-center font-mono" autoCapitalize="characters" spellCheck={false} aria-label="Unit" value={it.unit}
                onChange={(e) => update(i, { unit: e.target.value })}
                onBlur={() => onCommit(items)} /></div>
            {canPrice && (
              <div><div className="section-label">Unit price</div>
                <input className="field px-1.5 py-1.5 text-right font-mono" inputMode="decimal" title="Price per unit, before sales tax" aria-label="Unit price"
                  {...num(`${bufferKey}:${i}:p`, Number(it.unit_price) || 0, (n) => update(i, { unit_price: n }), (n) => update(i, { unit_price: n }, true))} /></div>
            )}
            {canPrice && (
              <div><div className="section-label">Amount</div>
                <div className="field flex items-center justify-end bg-paper px-2 py-1.5 text-right font-mono">{fmt((Number(it.qty) || 0) * (Number(it.unit_price) || 0))}</div></div>
            )}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-end gap-2">
        <button type="button" className="btn btn-ghost btn-sm" onClick={add}>+ Add line</button>
        {extra}
        {canPrice && onTax && (
          <label className="ml-auto block">
            <span className="section-label mb-1">Sales tax %</span>
            <input className="field w-24 px-1.5 py-1.5 text-right font-mono" inputMode="decimal"
              {...num(`${bufferKey}:tax`, taxPct ?? 0, () => null, onTax, { showZero: true })} />
          </label>
        )}
      </div>
    </div>
  );
}
