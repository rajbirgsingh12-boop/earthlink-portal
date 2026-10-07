"use client";
import { useState } from "react";
import { addDays, localISO, prettyDate } from "@/lib/docs";

// The days on a job, built for a business where the tenant doesn't open the
// door: move it a day or a week, log a no-access visit with the reason and
// the new day, clear it off the calendar, and keep free-form notes on the
// job. Every move is written into the notes so the history is there when the
// partner asks how many trips were made.
export type DatedJob = {
  id: string; start_date?: string | null; finish_date?: string | null; notes?: string | null; work_done?: boolean;
};
export const MOVE_REASONS = ["No access, nobody home", "Tenant asked to move it", "Partner moved it", "Crew tied up elsewhere", "Weather", "Other"];
// visits that ended at a closed door, counted off the notes
export const noAccessCount = (notes?: string | null) => (notes || "").split("\n").filter((l) => /^⛔ No access/.test(l)).length;
// the last thing written on the job, for the list view
export const lastNote = (notes?: string | null) => (notes || "").trim().split("\n").filter(Boolean).pop() || "";

const appendNote = (notes: string | null | undefined, line: string) => `${(notes || "").trim()}${(notes || "").trim() ? "\n" : ""}${line}`;

export default function JobDates({ job, canEdit, onSave, showNotes = true, crew, onMoved }: {
  job: DatedJob;
  canEdit: boolean;
  // may answer false when the save was refused: then nothing else happens
  onSave: (patch: Partial<DatedJob>) => void | boolean | Promise<void | boolean>;
  showNotes?: boolean;
  // the crew on the job, when there is one: the Move it… box offers to text them the new day
  crew?: { names: string[]; told: boolean };
  onMoved?: (from: string, to: string) => Promise<void> | void;
}) {
  const [moving, setMoving] = useState(false);
  const [to, setTo] = useState("");
  const [why, setWhy] = useState(MOVE_REASONS[0]);
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const [tellCrew, setTellCrew] = useState(true);
  // the Finish box is shown once there is a finish day, the work is done, or somebody asked for it
  const [finishOpen, setFinishOpen] = useState(false);
  const today = localISO(new Date());
  const trips = noAccessCount(job.notes);
  const base = job.start_date || today;

  const openMove = () => { setTo(addDays(base, 7)); setWhy(MOVE_REASONS[0]); setNote(""); setTellCrew(!!crew?.told); setMoving(true); };
  const move = async () => {
    const was = job.start_date ? ` (was ${prettyDate(job.start_date)})` : "";
    const next = to ? `moved to ${prettyDate(to)}` : "needs a new day";
    const line = `⛔ ${why} · ${prettyDate(today)}: ${next}${was}${note.trim() ? ` · ${note.trim()}` : ""}`;
    // the save lands first: the crew rows follow the new day through RUN_ME's
    // pact_job_follows trigger (never moved here), and only then is anyone texted
    const ok = await onSave({ start_date: to, notes: appendNote(job.notes, line) });
    if (ok === false) return; // refused: the box stays open, the page said why
    setMoving(false);
    if (tellCrew && to && to !== (job.start_date || "") && crew?.names.length && onMoved) await onMoved(job.start_date || "", to);
  };
  // off the calendar, with its own note; the crew rows follow through the same trigger
  const clear = async () => {
    const ok = await onSave({ start_date: "", notes: appendNote(job.notes, `📅 Day cleared ${prettyDate(today)}${job.start_date ? ` (was ${prettyDate(job.start_date)})` : ""}, off the calendar until it gets a day`) });
    if (ok !== false) setMoving(false);
  };

  const dateBox = "rounded-sm border border-rulesoft bg-white px-2 py-1.5 font-mono text-[12px] min-h-[44px]";
  const quick = "btn btn-ghost btn-sm min-h-[44px]";
  const showFinish = !!job.finish_date || !!job.work_done || finishOpen;
  return (
    <div className="text-[13px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-inksoft">Start
          <input type="date" className={dateBox} value={job.start_date || ""} readOnly={!canEdit}
            onChange={(e) => canEdit && onSave({ start_date: e.target.value })} />
        </label>
        {showFinish && (
          <label className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-inksoft">Finish
            <input type="date" className={dateBox} value={job.finish_date || ""} readOnly={!canEdit}
              onChange={(e) => canEdit && onSave({ finish_date: e.target.value })} />
          </label>
        )}
        {trips > 0 && <span className="chip text-alert">⛔ No access ×{trips}</span>}
        {!job.start_date && !job.work_done && <span className="chip text-inksoft">No day yet</span>}
        {canEdit && !job.work_done && (
          <button type="button" className={quick} aria-expanded={moving} onClick={() => (moving ? setMoving(false) : openMove())}>📅 Move it…</button>
        )}
      </div>
      {moving && (
        <div className="anim-open mt-2 rounded-sm border border-rulesoft bg-paper p-3">
          <div className="section-label mb-1.5">What happened?</div>
          <select className="field mb-2" value={why} onChange={(e) => setWhy(e.target.value)}>
            {MOVE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-inksoft">New day
              <input type="date" className={dateBox} value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
            <button type="button" className={quick} onClick={() => setTo("")}>No day yet</button>
          </div>
          {/* the quick picks fill the new day in, so the move still writes its note */}
          <div className="mb-2 flex flex-wrap gap-1.5">
            <button type="button" className={quick} onClick={() => setTo(addDays(base, 1))}>+1 day</button>
            <button type="button" className={quick} onClick={() => setTo(addDays(base, 7))}>+1 week</button>
            {job.start_date && <button type="button" className={quick} onClick={clear}>Clear the day</button>}
            {!showFinish && <button type="button" className={quick} onClick={() => setFinishOpen(true)}>Set the finish day</button>}
          </div>
          <input className="field mb-2" placeholder="Note (optional): who you spoke to, what they said" value={note} onChange={(e) => setNote(e.target.value)} />
          {crew && crew.names.length > 0 && (
            <label className="mb-2 flex min-h-[44px] items-center gap-2 text-[13px]">
              <input type="checkbox" className="h-5 w-5" checked={tellCrew && !!to} disabled={!to} onChange={(e) => setTellCrew(e.target.checked)} />
              <span>{to ? `Text ${crew.names.join(", ")} the new day` : `${crew.names.join(", ")} come off the schedule: tell them to hold`}</span>
            </label>
          )}
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary" onClick={move}>{to ? `Move to ${prettyDate(to)}` : "Log it, no day"}</button>
            <button type="button" className="btn btn-ghost" onClick={() => setMoving(false)}>Cancel</button>
          </div>
        </div>
      )}
      {showNotes && (
        <div className="mt-2">
          <div className="section-label mb-1">Job notes</div>
          {canEdit ? (
            <textarea className="field min-h-[72px] whitespace-pre-wrap text-[12px]" placeholder="Anything about this job: calls, no-shows, what the tenant said"
              value={draft ?? (job.notes || "")}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => { if (draft !== null && draft !== (job.notes || "")) onSave({ notes: draft }); setDraft(null); }} />
          ) : (
            <div className="whitespace-pre-wrap rounded-sm border border-rulesoft bg-paper px-3 py-2 text-[12px] text-inksoft">{job.notes || "No notes yet"}</div>
          )}
        </div>
      )}
    </div>
  );
}
