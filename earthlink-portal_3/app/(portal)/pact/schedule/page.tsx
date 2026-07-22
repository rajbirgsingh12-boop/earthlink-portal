"use client";
import { useEffect, useState } from "react";
import { sb } from "@/lib/supabase";
import { useLive } from "@/lib/useLive";
import Stamp from "@/components/Stamp";

interface Job {
  id: string; partner: string; po_number?: string; job_number: string; address?: string;
  property_unit?: string; description: string; work_done: boolean; canceled: boolean;
  start_date?: string; finish_date?: string;
}

// The PACT calendar: every PO gets a start and finish date and a complete mark.
export default function PactSchedule() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 2500); };

  const load = async () => {
    const { data, error } = await sb().from("pact_jobs").select("*").order("created_at", { ascending: false });
    if (error) { flash(/relation|column|schema/i.test(error.message) ? "Run supabase/upgrade_pact.sql first" : error.message); return; }
    setJobs(((data || []) as Job[]).filter((j) => !j.canceled));
  };
  useEffect(() => { load(); }, []);
  useLive(["pact_jobs"], () => load(), { skipWhileTyping: true });

  const save = async (j: Job, patch: Partial<Job>) => {
    setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, ...patch } : x)));
    const { error } = await sb().from("pact_jobs").update(patch).eq("id", j.id);
    if (error) flash(/column|schema cache/i.test(error.message) ? "Run supabase/upgrade_schedule.sql first" : error.message);
  };

  const list = jobs.filter((j) => !q.trim() ||
    `${j.partner} ${j.po_number || j.job_number} ${j.address || ""} ${j.description}`.toLowerCase().includes(q.trim().toLowerCase()));
  const needsDates = list.filter((j) => !j.work_done && !(j.start_date || "").trim());
  const scheduled = list.filter((j) => !j.work_done && (j.start_date || "").trim());
  const done = list.filter((j) => j.work_done);

  const card = (j: Job) => (
    <div key={j.id} className="border-t border-rulesoft p-3.5 first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="text-[14px] font-semibold">{j.address || j.partner}</span>
          {(j.po_number || j.job_number) && <span className="ml-1.5 font-mono text-xs text-inksoft">PO {j.po_number || j.job_number}</span>}
          <div className="max-w-[420px] truncate text-[11px] text-inksoft">{j.partner}{j.description ? ` · ${j.description}` : ""}</div>
        </div>
        <button onClick={() => save(j, { work_done: !j.work_done })}>
          <Stamp label={j.work_done ? "COMPLETE ✓" : "MARK COMPLETE"} tone={j.work_done ? "ok" : "mute"} />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-inksoft">Start
          <input type="date" className="rounded-sm border border-rulesoft bg-white p-1.5 font-mono text-xs" value={j.start_date || ""}
            onChange={(e) => save(j, { start_date: e.target.value })} />
        </label>
        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-inksoft">Finish
          <input type="date" className="rounded-sm border border-rulesoft bg-white p-1.5 font-mono text-xs" value={j.finish_date || ""}
            onChange={(e) => save(j, { finish_date: e.target.value })} />
        </label>
      </div>
    </div>
  );

  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <div className="font-display text-2xl font-bold uppercase">PACT Schedule</div>
        <span className="text-xs text-inksoft">{scheduled.length} scheduled · {needsDates.length} need dates · {done.length} complete</span>
      </div>
      <input className="field mb-3" placeholder="Search PO #, partner, address…" value={q} onChange={(e) => setQ(e.target.value)} />

      {needsDates.length > 0 && (
        <>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">Needs dates</div>
          <div className="card mb-4">{needsDates.map(card)}</div>
        </>
      )}
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">Scheduled</div>
      <div className="card mb-4">
        {scheduled.sort((a, b) => (a.start_date || "").localeCompare(b.start_date || "")).map(card)}
        {scheduled.length === 0 && <div className="p-5 text-sm text-inksoft">{jobs.length === 0 ? "No PACT jobs yet — upload a PO on the PACT tab first." : "Nothing scheduled — set a start date on a job above."}</div>}
      </div>
      {done.length > 0 && (
        <>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">Complete</div>
          <div className="card">{done.map(card)}</div>
        </>
      )}
      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
