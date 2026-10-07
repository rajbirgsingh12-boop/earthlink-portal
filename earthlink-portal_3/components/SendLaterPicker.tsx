"use client";
import { useState } from "react";
import { localStamp, sendPicks } from "@/lib/sendLater";

// "Send it later": the one box both Schedules open when a crew text should go
// out tonight or tomorrow morning instead of right now. The quick picks are
// the two times a crew is actually told; the time box takes any other time;
// one plain line says how the text will go out on this site.
export default function SendLaterPicker({ onPick, onCancel, onItsOwn, dataAttr }: {
  onPick: (iso: string) => void;      // the time chosen, as an ISO stamp
  onCancel: () => void;
  onItsOwn: boolean | null;           // true: the timer sends it; false: only an open portal does; null: not known yet
  dataAttr: "data-crew-picker" | "data-later-picker"; // which Schedule's picker this is (the e2e suites find it by this)
}) {
  // the time box starts on the first quick pick, so "Set it" works with no typing
  const [when, setWhen] = useState(() => localStamp(sendPicks()[0]?.when || new Date()));
  const [bad, setBad] = useState(false);
  const attrs = { [dataAttr]: true } as Record<string, boolean>;
  const custom = () => {
    const t = new Date(when);
    if (Number.isNaN(t.getTime())) { setBad(true); return; }
    onPick(t.toISOString());
  };
  return (
    <div className="anim-open mt-2 rounded-sm border border-work bg-white p-3" {...attrs}>
      <div className="section-label mb-1.5">When should it go out?</div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {sendPicks().map((p) => (
          <button key={p.label} type="button" className="btn btn-sm normal-case tracking-normal" onClick={() => onPick(p.when.toISOString())}>{p.label}</button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input type="datetime-local" className="field w-auto font-mono" aria-label="When the text goes out" value={when}
          onChange={(e) => { setWhen(e.target.value); setBad(false); }} />
        <button type="button" className="btn btn-primary" disabled={!when} onClick={custom}>Set it</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
      {bad && <div className="notice-alert mt-2" role="alert">That time doesn't look right</div>}
      <div className="mt-1.5 text-[12px] text-inksoft">
        The text is written when it goes out, so any change made before then goes with it.
        {onItsOwn === false ? " It goes out the next time somebody has the portal open. Settings → System check says how to have it go out on its own." : onItsOwn ? " It goes out on its own, whether or not anyone has the portal open." : ""}
      </div>
    </div>
  );
}
