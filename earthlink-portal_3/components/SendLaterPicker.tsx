"use client";
import { useState } from "react";
import { latestSend, localStamp, morningRun, sendPicks, sendTimeWhy } from "@/lib/sendLater";

// "Send it later": the one box both Schedules open when a crew text should go
// out tonight or tomorrow morning instead of right now. The quick picks are
// the two times a crew is actually told; the time box takes any other time;
// one plain line says how the text will go out on this site. Given the work
// day, it offers nothing later than noon that day (lib/sendLater's rule) and
// says so, and a typed time past that is refused in plain words.
export default function SendLaterPicker({ onPick, onCancel, onItsOwn, dataAttr, day }: {
  onPick: (iso: string) => void;      // the time chosen, as an ISO stamp
  onCancel: () => void;
  onItsOwn: boolean | null;           // true: the timer sends it; false: only an open portal does; null: not known yet
  dataAttr: "data-crew-picker" | "data-later-picker"; // which Schedule's picker this is (the e2e suites find it by this)
  day?: string;                       // the work day the text is about ("YYYY-MM-DD"): no time after its morning
}) {
  const picks = sendPicks(new Date(), day);
  const last = day !== undefined ? latestSend(day) : null;
  // the time box starts on the first quick pick, so "Set it" works with no
  // typing; with none left (the job is this morning), on the next quarter
  // hour, which the rule still allows
  const [when, setWhen] = useState(() => {
    if (picks[0]) return localStamp(picks[0].when);
    const t = new Date(Math.ceil((Date.now() + 60_000) / 900_000) * 900_000);
    return localStamp(last && t.getTime() >= last.getTime() ? new Date(last.getTime() - 60_000) : t);
  });
  const [bad, setBad] = useState("");
  const attrs = { [dataAttr]: true } as Record<string, boolean>;
  const custom = () => {
    const t = new Date(when);
    if (Number.isNaN(t.getTime())) { setBad("That time doesn't look right"); return; }
    const why = day !== undefined ? sendTimeWhy(day, t) : "";
    if (why) { setBad(why); return; }
    onPick(t.toISOString());
  };
  // "Friday, Nov 20": the job's day, the way the line below says it
  const dayWords = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" }) : "";
  return (
    <div className="anim-open mt-2 rounded-sm border border-work bg-white p-3" {...attrs}>
      <div className="section-label mb-1.5">When should it go out?</div>
      {picks.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {picks.map((p) => (
            <button key={p.label} type="button" className="btn btn-sm normal-case tracking-normal" onClick={() => onPick(p.when.toISOString())}>{p.label}</button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input type="datetime-local" className="field w-auto font-mono" aria-label="When the text goes out" value={when}
          max={last ? localStamp(new Date(last.getTime() - 60_000)) : undefined}
          onChange={(e) => { setWhen(e.target.value); setBad(""); }} />
        <button type="button" className="btn btn-primary" disabled={!when} onClick={custom}>Set it</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
      {bad && <div className="notice-alert mt-2" role="alert">{bad}</div>}
      <div className="mt-1.5 text-[12px] text-inksoft">
        {dayWords ? `It has to go out before noon on ${dayWords}, the job's day. ` : ""}
        The text is written when it goes out, so any change made before then goes with it.
        {onItsOwn === false
          ? " It goes out the next time somebody has the portal open. Settings → System check says how to have it go out on its own."
          : onItsOwn
            ? ` The portal's morning run sends it on its own, ${morningRun(day)}: a text set ahead for the job's morning goes then, even if a later time was picked. One for any other time goes the next time somebody has the portal open after that time, or else with the next morning's run, if the job's day hasn't passed by then.`
            : ""}
      </div>
    </div>
  );
}
