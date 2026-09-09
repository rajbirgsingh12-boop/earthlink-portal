"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { sb } from "@/lib/supabase";
import { myProfile } from "@/lib/profile";
import { useLive } from "@/lib/useLive";
import { localISO, prettyDate } from "@/lib/docs";
import Stamp from "@/components/Stamp";
import PageHeader from "@/components/PageHeader";
import JobDates, { lastNote } from "@/components/JobDates";
import Calendar, { type CalEvent, type CalView } from "@/components/Calendar";
import CrewPanel from "@/components/CrewPanel";
import { CREW_JOB_COLS, crewLine, crewMessage, crewState, rowsOfJob, type CrewRow, type Worker } from "@/lib/pactCrew";
import { textRows, stampRows } from "@/lib/notify";

// the job as the calendar reads it — CREW_JOB_COLS, never the money
interface Job {
  id: string; partner: string; po_number?: string; job_number: string; address?: string; development?: string;
  property_unit?: string; description: string; work_done: boolean; canceled: boolean;
  start_date?: string; finish_date?: string; notes?: string;
}
// a crew day, as the day schedule stores it: one row per worker per day, on a NYCHA release or a PACT job
type DayRow = CrewRow;
interface Rel { id: string; rel_number: string; location: string; address?: string | null }
type Emp = Worker;

// The calendar: every PACT job on the day its PO names (or the day you give
// it), NYCHA crew days beside them, one view of everything the crews have on.
export default function PactCalendar() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [dayRows, setDayRows] = useState<DayRow[]>([]);
  const [rels, setRels] = useState<Rel[]>([]);
  const [emps, setEmps] = useState<Emp[]>([]);
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const canEdit = role === "admin" || role === "office";
  const [msg, setMsg] = useState("");
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 2500); };
  const [view, setView] = useState<CalView>("month");
  const [anchor, setAnchor] = useState(localISO(new Date()));
  const [selected, setSelected] = useState(localISO(new Date()));
  const [showDone, setShowDone] = useState(false);
  // the card whose "Who's going?" panel is open
  const [crewOpen, setCrewOpen] = useState<string | null>(null);

  const load = async () => {
    const { data, error } = await sb().from("pact_jobs").select(CREW_JOB_COLS).order("created_at", { ascending: false });
    if (error) { flash(/relation|column|schema/i.test(error.message) ? "Run supabase/RUN_ME.sql first" : error.message); return; }
    setJobs(((data || []) as Job[]).filter((j) => !j.canceled));
    // the NYCHA crew days, for the same calendar — quietly absent until the day schedule exists
    const [{ data: d }, { data: r }, { data: e }] = await Promise.all([
      sb().from("schedule_days").select("*"),
      sb().from("releases").select("id,rel_number,location,address").eq("canceled", false),
      sb().from("employees").select("id,name,phone,active"),
    ]);
    setDayRows((d || []) as DayRow[]); setRels((r || []) as Rel[]); setEmps((e || []) as Emp[]);
  };
  useEffect(() => { load(); myProfile().then((p) => setRole(p?.role || "")); }, []);
  useLive(["pact_jobs", "schedule_days", "employees"], () => load(), { skipWhileTyping: true });

  // a new start_date here moves the job's crew rows to the new day and clears
  // their TEXTED mark (RUN_ME section 14's trigger) — the cards then show who
  // needs the new day. Nothing is texted from here; that is the Move it… box.
  const save = async (j: Job, patch: Partial<Job>) => {
    setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, ...patch } : x)));
    const { error } = await sb().from("pact_jobs").update(patch).eq("id", j.id);
    if (error) { flash(/column|schema cache/i.test(error.message) ? "Run supabase/RUN_ME.sql first" : error.message); load(); }
  };
  // "Text the crew the new day" from the Move it… box: everyone on the job is
  // told once, as a move, from the company number
  const textMove = async (j: Job, from: string, to: string) => {
    const rows = rowsOfJob(dayRows, j);
    const moved = { ...j, start_date: to };
    const targets = rows.map((r) => {
      const e = emps.find((x) => x.id === r.employee_id);
      const first = (e?.name || "").split(" ")[0];
      // told the old day → reads as a move; never told → the plain first text
      return { rowId: r.id, to: e?.phone || "", body: crewMessage(moved, first, r.description || "", r.texted ? { from, to } : undefined), first };
    });
    // the trigger clears the old stamps; clear them here too so the server
    // doesn't skip anyone where the trigger isn't in yet
    await stampRows(rows.map((r) => r.id), false);
    const out = await textRows(targets);
    if (out.status === "fallback") {
      setTimeout(async () => {
        if (window.confirm(`Did the text${targets.length > 1 ? "s" : ""} send? OK marks ${targets.map((t) => t.first).join(", ")} TEXTED ✓`)) { await stampRows(out.rowIds); await load(); }
      }, 600);
    }
    flash(out.message);
    await load();
  };

  const hit = (j: Job) => !q.trim() || `${j.partner} ${j.po_number || j.job_number} ${j.address || ""} ${j.description}`.toLowerCase().includes(q.trim().toLowerCase());
  const list = jobs.filter(hit);
  const needsDates = list.filter((j) => !j.work_done && !(j.start_date || "").trim());
  const done = list.filter((j) => j.work_done);

  // ---- everything on the calendar ----
  const events = useMemo<CalEvent[]>(() => {
    const out: CalEvent[] = list.filter((j) => (j.start_date || "").trim()).map((j) => {
      const crew = rowsOfJob(dayRows, j);
      return {
        id: `pact:${j.id}`, day: j.start_date!, kind: "pact", done: j.work_done,
        title: (j.address || j.development || j.partner || "").split(",")[0] + (j.property_unit ? ` · Apt ${j.property_unit}` : ""),
        subtitle: [j.partner, (j.po_number || j.job_number) && `PO ${j.po_number || j.job_number}`].filter(Boolean).join(" · "),
        people: crew.map((r) => emps.find((e) => e.id === r.employee_id)?.name.split(" ")[0] || "").filter(Boolean),
        flag: crewState(crew, j) === "not_told" ? "crew not told" : undefined,
      };
    });
    // NYCHA: one bar per release per day, the crew's names on it
    const byRelDay = new Map<string, DayRow[]>();
    dayRows.filter((r) => r.release_id).forEach((r) => { const k = `${r.day}|${r.release_id}`; byRelDay.set(k, [...(byRelDay.get(k) || []), r]); });
    for (const [k, rows] of byRelDay) {
      const [day, relId] = k.split("|");
      const rel = rels.find((x) => x.id === relId);
      const people = rows.map((r) => emps.find((e) => e.id === r.employee_id)?.name.split(" ")[0] || "").filter(Boolean);
      const addr = rows.find((r) => (r.address || "").trim())?.address || rel?.address || "";
      const title = (addr || rel?.location || "NYCHA").split(",")[0];
      if (q.trim() && !`${title} ${rel?.rel_number || ""} ${rel?.location || ""} ${people.join(" ")}`.toLowerCase().includes(q.trim().toLowerCase())) continue;
      out.push({ id: `nycha:${k}`, day, kind: "nycha", title, subtitle: rel ? `Release #${rel.rel_number} · ${rel.location}` : "NYCHA", people, flag: rows.some((r) => !r.texted) && rows.length > 0 ? "not everyone texted" : undefined });
    }
    return out;
  }, [list, dayRows, rels, emps, q]);

  const card = (j: Job) => {
    const crew = rowsOfJob(dayRows, j);
    const state = crewState(crew, j);
    const names = crew.map((r) => emps.find((e) => e.id === r.employee_id)?.name.split(" ")[0] || "").filter(Boolean);
    return (
      <div key={j.id} className="border-t border-rulesoft p-3.5 first:border-t-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <span className="text-[14px] font-semibold">{j.address || j.partner}{j.property_unit ? ` · Apt ${j.property_unit}` : ""}</span>
            {(j.po_number || j.job_number) && <span className="ml-1.5 font-mono text-xs text-inksoft">PO {j.po_number || j.job_number}</span>}
            <div className="max-w-[520px] truncate text-[11px] text-inksoft">{j.partner}{j.description ? ` · ${j.description}` : ""}</div>
          </div>
          {canEdit ? (
            <button className="btn-stamp" onClick={() => save(j, { work_done: !j.work_done })}>
              <Stamp label={j.work_done ? "COMPLETE ✓" : "MARK COMPLETE"} tone={j.work_done ? "ok" : "mute"} />
            </button>
          ) : <Stamp label={j.work_done ? "COMPLETE ✓" : "NOT COMPLETE"} tone={j.work_done ? "ok" : "mute"} />}
        </div>
        <div className="mt-2">
          <JobDates job={j} canEdit={canEdit} onSave={(p) => save(j, p as Partial<Job>)} showNotes={false}
            crew={{ names, told: crew.some((r) => r.texted) }} onMoved={(from, to) => textMove(j, from, to)} />
          {lastNote(j.notes) && <div className="mt-1.5 truncate text-[11px] text-inksoft" title={j.notes || ""}>{lastNote(j.notes)}</div>}
        </div>
        {/* who's going — the one line, and the panel behind it */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className={`text-[12px] ${state === "not_told" ? "text-alert" : "text-inksoft"}`}>📱 {crewLine(crew, j, emps)}</span>
          {(canEdit || crew.length > 0) && (
            <button type="button" className={`btn min-h-[44px] px-3 py-1.5 text-[13px] ${crewOpen === j.id ? "border-work" : ""}`} onClick={() => setCrewOpen(crewOpen === j.id ? null : j.id)}
              title="Pick who's going, and text them the address, the apartment, the day and the work">
              {crewOpen === j.id ? "Close" : crew.length === 0 ? "📱 Who's going?" : state === "not_told" ? "📱 Text crew" : "📱 Crew"}
            </button>
          )}
        </div>
        {crewOpen === j.id && (
          <div className="mt-2">
            <CrewPanel job={j} rows={crew} emps={emps} canEdit={canEdit} onChange={load} flash={flash} onClose={() => setCrewOpen(null)} />
          </div>
        )}
      </div>
    );
  };

  // the Day view and the panel under Month/Week: that day's PACT jobs as cards, NYCHA days as links to the crew schedule
  const dayPanel = (iso: string) => {
    const pact = list.filter((j) => j.start_date === iso);
    const nychaEvs = events.filter((e) => e.kind === "nycha" && e.day === iso);
    return (
      <div>
        {pact.length > 0 && <div className="divide-y divide-rulesoft">{pact.map(card)}</div>}
        {nychaEvs.map((e) => (
          <Link key={e.id} href={`/schedule?day=${iso}`} className="flex items-center gap-3 border-t border-rulesoft p-3.5 first:border-t-0 hover:bg-paper">
            <span className="inline-block h-8 w-1 rounded-sm bg-carbon" />
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold">{e.title}</div>
              <div className="truncate text-[11px] text-inksoft">{e.subtitle}{e.people?.length ? ` · 👷 ${e.people.join(", ")}` : ""}{e.flag ? ` · ⚠ ${e.flag}` : ""}</div>
            </div>
            <span className="text-[12px] text-inksoft">crew schedule →</span>
          </Link>
        ))}
        {pact.length === 0 && nychaEvs.length === 0 && <div className="p-5 text-[13px] text-inksoft">Nothing on {prettyDate(iso)}. Pick a job under Need to schedule and give it a day, or tap another day.</div>}
      </div>
    );
  };

  if (!role) return <div className="card p-4 text-sm text-inksoft">Checking your account…</div>;
  const onCal = events.filter((e) => e.kind === "pact" && !e.done).length;

  return (
    <div>
      <PageHeader title="Calendar" sub={`${onCal} PACT job${onCal === 1 ? "" : "s"} on the calendar · ${needsDates.length} need to schedule · ${done.length} complete`}>
        <Link className="btn btn-ghost min-h-[44px]" href="/pact">Jobs</Link>
        <Link className="btn btn-ghost min-h-[44px]" href="/schedule">Crew schedule</Link>
      </PageHeader>
      <input className="field mb-3" placeholder="Search PO #, partner, address, release, worker…" value={q} onChange={(e) => setQ(e.target.value)} />

      <Calendar events={events} view={view} onView={setView} anchor={anchor} onAnchor={(d) => { setAnchor(d); }} selected={selected}
        onSelect={(d) => { setSelected(d); if (view !== "day") setAnchor(view === "month" ? anchor : d); }}
        onOpen={(e) => { if (e.kind === "nycha") window.location.href = `/schedule?day=${e.day}`; }}
        renderDay={dayPanel} />

      {view !== "day" && (
        <>
          <div className="mb-1.5 mt-4 flex items-baseline justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">{prettyDate(selected)}{selected === localISO(new Date()) ? " · today" : ""}</div>
            <button type="button" className="text-[11px] text-inksoft underline" onClick={() => { setAnchor(selected); setView("day"); }}>open day</button>
          </div>
          <div className="card mb-4">{dayPanel(selected)}</div>
        </>
      )}

      {needsDates.length > 0 && (
        <>
          <div className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">Need to schedule</div>
          <div className="card mb-4">{needsDates.map(card)}</div>
        </>
      )}
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
