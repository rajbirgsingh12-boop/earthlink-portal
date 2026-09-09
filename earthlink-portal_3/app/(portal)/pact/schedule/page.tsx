"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { sb } from "@/lib/supabase";
import { myProfile } from "@/lib/profile";
import { useLive } from "@/lib/useLive";
import Stamp from "@/components/Stamp";
import PageHeader from "@/components/PageHeader";
import JobDates, { lastNote } from "@/components/JobDates";
import MonthCalendar from "@/components/MonthCalendar";
import TextWorker, { textedTo } from "@/components/TextWorker";
import { localISO, prettyDate } from "@/lib/docs";

interface Job {
  id: string; partner: string; po_number?: string; job_number: string; address?: string; development?: string;
  property_unit?: string; description: string; work_done: boolean; canceled: boolean;
  start_date?: string; finish_date?: string; notes?: string; items?: { description: string; key?: string }[] | null;
}

// The PACT calendar: every PO gets a start and finish date and a complete mark.
export default function PactSchedule() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [q, setQ] = useState("");
  // accountants can look but not touch (their writes are silent no-ops under RLS)
  const [role, setRole] = useState("");
  const canEdit = role === "admin" || role === "office";
  const [msg, setMsg] = useState("");
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 2500); };
  const [month, setMonth] = useState(localISO(new Date()).slice(0, 7));
  const [day, setDay] = useState(localISO(new Date()));
  const [texting, setTexting] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);

  const load = async () => {
    const { data, error } = await sb().from("pact_jobs").select("*").order("created_at", { ascending: false });
    if (error) { flash(/relation|column|schema/i.test(error.message) ? "Run supabase/upgrade_pact.sql first" : error.message); return; }
    setJobs(((data || []) as Job[]).filter((j) => !j.canceled));
  };
  useEffect(() => {
    load();
    myProfile().then((p) => setRole(p?.role || ""));
  }, []);
  useLive(["pact_jobs"], () => load(), { skipWhileTyping: true });

  const save = async (j: Job, patch: Partial<Job>) => {
    setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, ...patch } : x)));
    const { error } = await sb().from("pact_jobs").update(patch).eq("id", j.id);
    // on failure the optimistic date must snap back — a screen showing a saved
    // date that never reached the database means a crew that never gets scheduled
    if (error) { flash(/column|schema cache/i.test(error.message) ? "Run supabase/upgrade_schedule.sql first" : error.message); load(); }
  };

  // a text sent is written on the job, so the calendar shows who was sent where
  const noteLine = async (j: Job, line: string) => {
    const notes = `${(j.notes || "").trim()}${(j.notes || "").trim() ? "\n" : ""}${line}`;
    await save(j, { notes });
  };

  const list = jobs.filter((j) => !q.trim() ||
    `${j.partner} ${j.po_number || j.job_number} ${j.address || ""} ${j.description}`.toLowerCase().includes(q.trim().toLowerCase()));
  const needsDates = list.filter((j) => !j.work_done && !(j.start_date || "").trim());
  const scheduled = list.filter((j) => !j.work_done && (j.start_date || "").trim());
  const done = list.filter((j) => j.work_done);
  // the calendar: every job with a day, done or not, by its day
  const byDay: Record<string, Job[]> = {};
  list.filter((j) => (j.start_date || "").trim()).forEach((j) => { (byDay[j.start_date!] ||= []).push(j); });
  const onDay = byDay[day] || [];

  const card = (j: Job) => (
    <div key={j.id} className="border-t border-rulesoft p-3.5 first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="text-[14px] font-semibold">{j.address || j.partner}</span>
          {(j.po_number || j.job_number) && <span className="ml-1.5 font-mono text-xs text-inksoft">PO {j.po_number || j.job_number}</span>}
          <div className="max-w-[420px] truncate text-[11px] text-inksoft">{j.partner}{j.description ? ` · ${j.description}` : ""}</div>
        </div>
        {canEdit ? (
          <button className="btn-stamp" onClick={() => save(j, { work_done: !j.work_done })}>
            <Stamp label={j.work_done ? "COMPLETE ✓" : "MARK COMPLETE"} tone={j.work_done ? "ok" : "mute"} />
          </button>
        ) : (
          <Stamp label={j.work_done ? "COMPLETE ✓" : "NOT COMPLETE"} tone={j.work_done ? "ok" : "mute"} />
        )}
      </div>
      <div className="mt-2">
        <JobDates job={j} canEdit={canEdit} onSave={(p) => save(j, p as Partial<Job>)} showNotes={false} />
        {textedTo(j.notes).length > 0 && <div className="mt-1.5 text-[11px] text-inksoft">📱 Texted {textedTo(j.notes).map((t) => t.split(" · ")[0]).join(", ")}</div>}
        {lastNote(j.notes) && !lastNote(j.notes).startsWith("📱") && <div className="mt-1.5 truncate text-[11px] text-inksoft" title={j.notes || ""}>{lastNote(j.notes)}</div>}
        {canEdit && !j.work_done && (
          <div className="mt-2">
            {texting === j.id
              ? <TextWorker job={j} onNote={(line) => noteLine(j, line)} onClose={() => setTexting(null)} />
              : <button type="button" className="btn btn-ghost min-h-[40px] px-3 py-1.5 text-[13px]" onClick={() => setTexting(j.id)}>📱 Text a worker</button>}
          </div>
        )}
      </div>
    </div>
  );

  // closed, not open, while the profile is still loading
  if (!role) return <div className="card p-4 text-sm text-inksoft">Checking your account…</div>;

  return (
    <div>
      <PageHeader title="PACT Calendar" sub={`${scheduled.length} on the calendar · ${needsDates.length} need to schedule · ${done.length} complete`}>
        <Link className="btn btn-ghost min-h-[44px]" href="/pact">Jobs</Link>
      </PageHeader>
      <input className="field mb-3" placeholder="Search PO #, partner, address…" value={q} onChange={(e) => setQ(e.target.value)} />

      {/* a PO with an access date lands here on its own; the rest wait below */}
      <div className="mb-3">
        <MonthCalendar month={month} onMonth={setMonth} byDay={byDay} selected={day} onSelect={setDay}
          label={(j) => `${(j.address || j.partner || "").split(",")[0]}${j.property_unit ? ` ${j.property_unit}` : ""}`} />
      </div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">{prettyDate(day)}{day === localISO(new Date()) ? " · today" : ""}</div>
        <div className="font-mono text-[11px] text-inksoft">{onDay.length} job{onDay.length === 1 ? "" : "s"}</div>
      </div>
      <div className="card mb-4">
        {onDay.map(card)}
        {onDay.length === 0 && <div className="p-5 text-sm text-inksoft">Nothing on this day. Pick a job under Need to schedule and set its start date, or tap another day.</div>}
      </div>

      {needsDates.length > 0 && (
        <>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">Need to schedule</div>
          <div className="card mb-4">{needsDates.map(card)}</div>
        </>
      )}
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">Coming up</div>
      <div className="card mb-4">
        {scheduled.filter((j) => (j.start_date || "") >= localISO(new Date())).sort((a, b) => (a.start_date || "").localeCompare(b.start_date || "")).slice(0, 20).map(card)}
        {scheduled.filter((j) => (j.start_date || "") >= localISO(new Date())).length === 0 && <div className="p-5 text-sm text-inksoft">{jobs.length === 0 ? "No PACT jobs yet — upload a PO on the PACT tab first." : "Nothing coming up — set a start date on a job above."}</div>}
      </div>
      {done.length > 0 && (
        <>
          <button type="button" className="mb-1.5 flex min-h-[44px] items-center gap-2 text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft" onClick={() => setShowDone(!showDone)}>
            <span className={`transition-transform ${showDone ? "rotate-90" : ""}`}>▸</span> Complete ({done.length})
          </button>
          {showDone && <div className="card">{done.map(card)}</div>}
        </>
      )}
      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
