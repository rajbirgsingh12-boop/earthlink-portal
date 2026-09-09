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
import { CAL_JOB_COLS, CREW_JOB_COLS, crewLine, crewMessage, crewState, offCalendar, rowsOfJob, type CrewRow, type Worker } from "@/lib/pactCrew";
import { textRows, stampRows } from "@/lib/notify";

// the job as the calendar reads it — CAL_JOB_COLS, never the money
interface Job {
  id: string; partner: string; po_number?: string; job_number: string; address?: string; development?: string;
  property_unit?: string; description: string; work_done: boolean; canceled: boolean;
  start_date?: string; finish_date?: string; notes?: string; created_at?: string; priced?: boolean | null;
}
type DayRow = CrewRow;
type Emp = Worker;
const appendNote = (notes: string | null | undefined, line: string) => `${(notes || "").trim()}${(notes || "").trim() ? "\n" : ""}${line}`;

// The PACT calendar: every PACT job on the day its PO names, or the day you
// give it here. Nothing else on it — NYCHA crews have their own Schedule tab.
// A priced job (the lines add up to more than the price list filled in on
// its own) drops off once its day has passed.
export default function PactCalendar() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [dayRows, setDayRows] = useState<DayRow[]>([]);
  const [emps, setEmps] = useState<Emp[]>([]);
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const canEdit = role === "admin" || role === "office";
  const [msg, setMsg] = useState("");
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 2500); };
  const [view, setView] = useState<CalView>("month");
  const [anchor, setAnchor] = useState(localISO(new Date()));
  const [selected, setSelected] = useState(localISO(new Date()));
  // the card whose "Who's going?" panel is open
  const [crewOpen, setCrewOpen] = useState<string | null>(null);
  // "+ Put a job on this day" — what's being typed
  const [addQ, setAddQ] = useState("");
  const today = localISO(new Date());

  const load = async () => {
    let res = await sb().from("pact_jobs").select(CAL_JOB_COLS).order("created_at", { ascending: false }) as { data: unknown; error: { message: string } | null };
    if (res.error && /priced|column|schema cache/i.test(res.error.message)) { // before RUN_ME section 15: every job stays on
      res = await sb().from("pact_jobs").select(CREW_JOB_COLS).order("created_at", { ascending: false });
    }
    if (res.error) { flash(/relation|column|schema/i.test(res.error.message) ? "Run supabase/RUN_ME.sql first" : res.error.message); return; }
    setJobs(((res.data || []) as Job[]).filter((j) => !j.canceled));
    // the crews — PACT rows only (no release), in pages: an unranged read stops
    // silently at 1000 rows and the oldest jobs would lose their crew
    const fetchRows = async () => {
      const out: DayRow[] = [];
      for (let from = 0; ; from += 1000) {
        const { data: d } = await sb().from("schedule_days").select("*").is("release_id", null).order("day", { ascending: false }).order("id").range(from, from + 999);
        out.push(...((d || []) as DayRow[]));
        if (!d || d.length < 1000) break;
      }
      return out;
    };
    const [d, { data: e }] = await Promise.all([fetchRows(), sb().from("employees").select("id,name,phone,active")]);
    setDayRows(d); setEmps((e || []) as Emp[]);
  };
  useEffect(() => { load(); myProfile().then((p) => setRole(p?.role || "")); }, []);
  useLive(["pact_jobs", "schedule_days", "employees"], () => load(), { skipWhileTyping: true });

  // a new start_date here moves the job's crew rows to the new day and clears
  // their TEXTED mark (RUN_ME section 14's trigger) — the cards then show who
  // needs the new day. Nothing is texted from here; that is the Move it… box.
  const save = async (j: Job, patch: Partial<Job>): Promise<boolean> => {
    setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, ...patch } : x)));
    const { error } = await sb().from("pact_jobs").update(patch).eq("id", j.id);
    if (error) { flash(/column|schema cache/i.test(error.message) ? "Run supabase/RUN_ME.sql first" : error.message); load(); return false; }
    return true;
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
  // a job with no day (or the wrong one) put on the selected day by hand
  const putOnDay = async (j: Job, iso: string) => {
    const was = (j.start_date || "").trim();
    const line = was ? `📅 Moved to ${prettyDate(iso)} from the calendar (was ${prettyDate(was)})` : `📅 Put on the calendar for ${prettyDate(iso)}`;
    if (!(await save(j, { start_date: iso, notes: appendNote(j.notes, line) }))) return; // the page said why; the search stays
    setAddQ("");
    flash(`${j.po_number || j.job_number ? `PO ${j.po_number || j.job_number}` : "Job"} is on ${prettyDate(iso)} — now pick who's going`);
  };

  // what the calendar holds: not canceled, not priced-and-past
  const live = jobs.filter((j) => !offCalendar(j, today));
  const hit = (j: Job) => !q.trim() || `${j.partner} ${j.po_number || j.job_number} ${j.address || ""} ${j.description}`.toLowerCase().includes(q.trim().toLowerCase());
  const list = live.filter(hit);
  const undated = live.filter((j) => !(j.start_date || "").trim() && !j.work_done);

  // ---- everything on the calendar ----
  const events = useMemo<CalEvent[]>(() => list.filter((j) => (j.start_date || "").trim()).map((j) => {
    const crew = rowsOfJob(dayRows, j);
    return {
      id: `pact:${j.id}`, day: j.start_date!, kind: "pact" as const, done: j.work_done,
      title: (j.address || j.development || j.partner || "").split(",")[0] + (j.property_unit ? ` · Apt ${j.property_unit}` : ""),
      subtitle: [j.partner, (j.po_number || j.job_number) && `PO ${j.po_number || j.job_number}`].filter(Boolean).join(" · "),
      people: crew.map((r) => emps.find((e) => e.id === r.employee_id)?.name.split(" ")[0] || "").filter(Boolean),
      flag: crewState(crew, j) === "not_told" ? "crew not told" : undefined,
    };
  }), [list, dayRows, emps]);

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
          <div className="flex shrink-0 items-center gap-2">
            {/* priced but still ahead: it stays until its day has passed */}
            {j.priced && <Stamp label="PRICED" tone="ok" />}
            {canEdit ? (
              <button className="btn-stamp" onClick={() => save(j, { work_done: !j.work_done })}>
                <Stamp label={j.work_done ? "COMPLETE ✓" : "MARK COMPLETE"} tone={j.work_done ? "ok" : "mute"} />
              </button>
            ) : <Stamp label={j.work_done ? "COMPLETE ✓" : "NOT COMPLETE"} tone={j.work_done ? "ok" : "mute"} />}
          </div>
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
              {crewOpen === j.id ? "Close" : `📱 Who's going?${crew.length ? ` · ${crew.length}` : ""}`}
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

  // the Day view and the panel under Month/Week: that day's jobs as cards, and
  // a box to put any other job on the day — the ones with no day yet come
  // first, and a priced job that slipped off the calendar can be put back
  const dayPanel = (iso: string) => {
    const pact = list.filter((j) => j.start_date === iso);
    const aq = addQ.trim().toLowerCase();
    const pick = jobs
      .filter((j) => j.start_date !== iso && !j.work_done)
      .filter((j) => !aq || `${j.partner} ${j.po_number || j.job_number} ${j.address || ""} ${j.property_unit || ""} ${j.description}`.toLowerCase().includes(aq))
      .sort((a, b) => Number(!!(a.start_date || "").trim()) - Number(!!(b.start_date || "").trim()) || (b.created_at || "").localeCompare(a.created_at || ""));
    return (
      <div>
        {pact.length > 0 && <div className="divide-y divide-rulesoft">{pact.map(card)}</div>}
        {pact.length === 0 && <div className="p-5 text-[13px] text-inksoft">Nothing on {prettyDate(iso)}.{canEdit ? " Put a job on it below, or tap another day." : ""}</div>}
        {canEdit && (
          <div className="border-t border-rulesoft p-3.5">
            <input className="field" placeholder={`+ Put a job on ${prettyDate(iso)} — type a PO #, address or partner…`} value={addQ} onChange={(e) => setAddQ(e.target.value)} />
            {aq && (
              <div className="mt-1 max-h-64 overflow-y-auto rounded-sm border border-rulesoft bg-white">
                {pick.slice(0, 12).map((j) => (
                  <button key={j.id} type="button" className="flex min-h-[44px] w-full items-center justify-between gap-2 border-b border-rulesoft px-3 py-2.5 text-left text-[13px] last:border-b-0 hover:bg-paper" onClick={() => putOnDay(j, iso)}>
                    <span className="min-w-0 truncate">{(j.address || j.development || j.partner || "").split(",")[0]}{j.property_unit ? ` · Apt ${j.property_unit}` : ""}{(j.po_number || j.job_number) ? <span className="ml-1.5 font-mono text-[11px] text-inksoft">PO {j.po_number || j.job_number}</span> : null}</span>
                    <span className="shrink-0 text-[11px] text-inksoft">{offCalendar(j, today) ? "priced, off the calendar → put here" : (j.start_date || "").trim() ? `on ${prettyDate(j.start_date)} → move here` : "no day yet → put here"}</span>
                  </button>
                ))}
                {pick.length === 0 && <div className="px-3 py-2 text-[13px] text-inksoft">No job matches “{addQ}”.</div>}
              </div>
            )}
            {!aq && undated.length > 0 && <div className="mt-1 text-[11px] text-inksoft">{undated.length} PO{undated.length === 1 ? " has" : "s have"} no day yet — start typing and {undated.length === 1 ? "it comes" : "they come"} up first.</div>}
          </div>
        )}
      </div>
    );
  };

  if (!role) return <div className="card p-4 text-sm text-inksoft">Checking your account…</div>;
  const onCal = events.filter((e) => !e.done).length;

  return (
    <div>
      <PageHeader title="Schedule" sub={`PACT — ${onCal} job${onCal === 1 ? "" : "s"} on the calendar${undated.length ? ` · ${undated.length} with no day yet` : ""}`}>
        <Link className="btn btn-ghost min-h-[44px]" href="/pact">🧾 Billing</Link>
      </PageHeader>
      <input className="field mb-3" placeholder="Search PO #, partner, address…" value={q} onChange={(e) => setQ(e.target.value)} />

      <Calendar events={events} view={view} onView={setView} anchor={anchor} onAnchor={(d) => { setAnchor(d); }} selected={selected}
        onSelect={(d) => { setSelected(d); setAddQ(""); if (view !== "day") setAnchor(view === "month" ? anchor : d); }}
        renderDay={dayPanel} />

      {view !== "day" && (
        <>
          <div className="mb-1.5 mt-4 flex items-baseline justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">{prettyDate(selected)}{selected === today ? " · today" : ""}</div>
            <button type="button" className="text-[11px] text-inksoft underline" onClick={() => { setAnchor(selected); setView("day"); }}>open day</button>
          </div>
          <div className="card mb-4">{dayPanel(selected)}</div>
        </>
      )}
      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
