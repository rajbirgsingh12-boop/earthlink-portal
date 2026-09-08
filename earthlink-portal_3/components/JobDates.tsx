"use client";
import { useState } from "react";
import { addDays, localISO, prettyDate } from "@/lib/docs";

// The dates on a job, built for a business where the tenant doesn't open the
// door: move it a day or a week with one tap, log a no-access visit with the
// reason and the new date, clear it back to "Need to schedule", and keep
// free-form notes on the job. Every move is written into the notes so the
// history is there when the partner asks how many trips were made.
export type DatedJob = {
  id: string; start_date?: string | null; finish_date?: string | null; notes?: string | null; work_done?: boolean;
};
export const MOVE_REASONS = ["No access — nobody home", "Tenant asked to move it", "Partner moved it", "Crew tied up elsewhere", "Weather", "Other"];
// visits that ended at a closed door, counted off the notes
export const noAccessCount = (notes?: string | null) => (notes || "").split("\n").filter((l) => /^⛔ No access/.test(l)).length;
// the last thing written on the job, for the list view
export const lastNote = (notes?: string | null) => (notes || "").trim().split("\n").filter(Boolean).pop() || "";

const appendNote = (notes: string | null | undefined, line: string) => `${(notes || "").trim()}${(notes || "").trim() ? "\n" : ""}${line}`;

export default function JobDates({ job, canEdit, onSave, showNotes = true }: {
  job: DatedJob;
  canEdit: boolean;
  onSave: (patch: Partial<DatedJob>) => void;
  showNotes?: boolean;
}) {
  const [moving, setMoving] = useState(false);
  const [to, setTo] = useState("");
  const [why, setWhy] = useState(MOVE_REASONS[0]);
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const today = localISO(new Date());
  const trips = noAccessCount(job.notes);

  const bump = (days: number) => onSave({ start_date: addDays(job.start_date || today, days) });
  const openMove = () => { setTo(addDays(job.start_date || today, 7)); setWhy(MOVE_REASONS[0]); setNote(""); setMoving(true); };
  const move = () => {
    const was = job.start_date ? ` — was ${prettyDate(job.start_date)}` : "";
    const next = to ? `moved to ${prettyDate(to)}` : "needs a new date";
    const line = `⛔ ${why} · ${prettyDate(today)}${was} → ${next}${note.trim() ? ` · ${note.trim()}` : ""}`;
    onSave({ start_date: to, notes: appendNote(job.notes, line) });
    setMoving(false);
  };
  const clear = () => onSave({ start_date: "", notes: appendNote(job.notes, `📅 Date cleared ${prettyDate(today)}${job.start_date ? ` (was ${prettyDate(job.start_date)})` : ""} — back to Need to schedule`) });

  const dateBox = "rounded-sm border border-rulesoft bg-white p-1.5 font-mono text-xs min-h-[36px]";
  return (
    <div className="text-[13px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-inksoft">Start
          <input type="date" className={dateBox} value={job.start_date || ""} readOnly={!canEdit} title="The day the crew goes"
            onChange={(e) => canEdit && onSave({ start_date: e.target.value })} />
        </label>
        <label className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-inksoft">Finish
          <input type="date" className={dateBox} value={job.finish_date || ""} readOnly={!canEdit}
            onChange={(e) => canEdit && onSave({ finish_date: e.target.value })} />
        </label>
        {trips > 0 && <span className="chip text-alert" title="Visits that ended at a closed door">⛔ No access ×{trips}</span>}
        {!job.start_date && !job.work_done && <span className="chip text-inksoft">Need to schedule</span>}
      </div>
      {canEdit && !job.work_done && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button type="button" className="btn btn-ghost min-h-[36px] px-2.5 py-1 text-[12px]" onClick={openMove} title="Log a no-access visit or any other reason, and pick the new day">⛔ Move it…</button>
          <button type="button" className="btn btn-ghost min-h-[36px] px-2.5 py-1 text-[12px]" onClick={() => bump(1)}>+1 day</button>
          <button type="button" className="btn btn-ghost min-h-[36px] px-2.5 py-1 text-[12px]" onClick={() => bump(7)}>+1 week</button>
          {job.start_date && <button type="button" className="btn btn-ghost min-h-[36px] px-2.5 py-1 text-[12px]" onClick={clear} title="No date — the job goes back under Need to schedule">Clear date</button>}
        </div>
      )}
      {moving && (
        <div className="mt-2 rounded-sm border border-rulesoft bg-paper p-3">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-inksoft">What happened?</div>
          <select className="field mb-2" value={why} onChange={(e) => setWhy(e.target.value)}>
            {MOVE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-inksoft">New day
              <input type="date" className={dateBox} value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
            <button type="button" className="btn btn-ghost min-h-[36px] px-2.5 py-1 text-[12px]" onClick={() => setTo("")} title="Leave it without a date for now">No date yet</button>
          </div>
          <input className="field mb-2" placeholder="Note (optional) — who you spoke to, what they said…" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary min-h-[40px]" onClick={move}>{to ? `Move to ${prettyDate(to)}` : "Log it, no date"}</button>
            <button type="button" className="btn btn-ghost min-h-[40px]" onClick={() => setMoving(false)}>Cancel</button>
          </div>
        </div>
      )}
      {showNotes && (
        <div className="mt-2">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-inksoft">Job notes</div>
          {canEdit ? (
            <textarea className="field min-h-[72px] whitespace-pre-wrap text-[12px]" placeholder="Anything about this job — calls, no-shows, what the tenant said…"
              value={draft ?? (job.notes || "")}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => { if (draft !== null && draft !== (job.notes || "")) onSave({ notes: draft }); setDraft(null); }} />
          ) : (
            <div className="whitespace-pre-wrap rounded-sm border border-rulesoft bg-paper px-3 py-2 text-[12px] text-inksoft">{job.notes || "—"}</div>
          )}
        </div>
      )}
    </div>
  );
}
