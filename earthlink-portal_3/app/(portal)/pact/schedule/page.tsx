"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { sb } from "@/lib/supabase";
import { myProfile } from "@/lib/profile";
import { useLive } from "@/lib/useLive";
import { localISO, prettyDate } from "@/lib/docs";
import Stamp from "@/components/Stamp";
import PageHeader from "@/components/PageHeader";
import ActionMenu from "@/components/ActionMenu";
import JobDates, { lastNote } from "@/components/JobDates";
import Calendar, { type CalEvent, type CalView } from "@/components/Calendar";
import CrewPanel from "@/components/CrewPanel";
import { CAL_JOB_COLS, CREW_JOB_COLS, WORKER_COLS, WORKER_COLS_OLD, crewLine, crewMessage, crewState, offCalendar, rowsOfJob, siteOf, type CrewRow, type Worker } from "@/lib/pactCrew";
import { textRows, stampRows } from "@/lib/notify";
import { intakePoFile, addJobByHand } from "@/lib/pactIntake";
import { loadPrices } from "@/lib/priceBook";

// the job as the calendar reads it — CAL_JOB_COLS, never the money
interface Job {
  id: string; partner: string; po_number?: string; job_number: string; address?: string; development?: string;
  property_unit?: string; description: string; work_done: boolean; canceled: boolean;
  start_date?: string; finish_date?: string; notes?: string; created_at?: string; priced?: boolean | null;
}
type DayRow = CrewRow;
type Emp = Worker;
const appendNote = (notes: string | null | undefined, line: string) => `${(notes || "").trim()}${(notes || "").trim() ? "\n" : ""}${line}`;
// the job's name on this tab: its PO number, the way the office and the partners say it
const poOf = (j: Job) => (j.po_number || j.job_number || "").trim();
const poLabel = (j: Job) => (poOf(j) ? `PO ${poOf(j)}` : "Job");
// "PO 116843" before "PO 116850", never "PO 9" after "PO 10"
const byPo = (a: Job, b: Job) => poOf(a).localeCompare(poOf(b), undefined, { numeric: true });
const BLANK = { partner: "", po: "", address: "", apt: "", description: "", day: "" };

// The PACT calendar: every PACT job on the day its PO names, or the day you
// give it here — named by its PO number, and moved by dragging it to another
// day. POs come in here too (upload the PDF, or type one in), the same way
// they do on the Billing tab, so the schedule is one place. Nothing else is
// on it — NYCHA crews have their own Schedule tab. A priced job (the lines
// add up to more than the price list filled in on its own) drops off once
// its day has passed.
export default function PactCalendar() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [dayRows, setDayRows] = useState<DayRow[]>([]);
  const [emps, setEmps] = useState<Emp[]>([]);
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const canEdit = role === "admin" || role === "office";
  const [msg, setMsg] = useState("");
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 3500); };
  const [view, setView] = useState<CalView>("month");
  const [anchor, setAnchor] = useState(localISO(new Date()));
  const [selected, setSelected] = useState(localISO(new Date()));
  // the card whose "Who's going?" panel is open
  const [crewOpen, setCrewOpen] = useState<string | null>(null);
  // "+ Put a job on this day" — what's being typed
  const [addQ, setAddQ] = useState("");
  // a PO coming in: the PDF picker, the by-hand form, and the wait
  const poRef = useRef<HTMLInputElement>(null);
  const [handOpen, setHandOpen] = useState(false);
  const [draft, setDraft] = useState({ ...BLANK });
  const [busy, setBusy] = useState(false);
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
    // the crew, with each worker's language (RUN_ME section 18) — before it, without
    const fetchEmps = async () => {
      const r = await sb().from("employees").select(WORKER_COLS);
      if (r.error && /lang|column|schema cache/i.test(r.error.message)) return (await sb().from("employees").select(WORKER_COLS_OLD)).data;
      return r.data;
    };
    const [d, e] = await Promise.all([fetchRows(), fetchEmps()]);
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
      return { rowId: r.id, to: e?.phone || "", body: crewMessage(moved, first, r.description || "", r.texted ? { from, to } : undefined, e?.lang), first };
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
  // the calendar jumps to a day and opens it
  const goTo = (iso: string) => { setAnchor(iso); setSelected(iso); setAddQ(""); };
  // a job with no day (or the wrong one) put on the selected day by hand
  const putOnDay = async (j: Job, iso: string) => {
    const was = (j.start_date || "").trim();
    const line = was ? `📅 Moved to ${prettyDate(iso)} from the calendar (was ${prettyDate(was)})` : `📅 Put on the calendar for ${prettyDate(iso)}`;
    if (!(await save(j, { start_date: iso, notes: appendNote(j.notes, line) }))) return; // the page said why; the search stays
    setAddQ("");
    flash(`${poLabel(j)} is on ${prettyDate(iso)} — now pick who's going`);
  };
  // a PO dragged to another day on the calendar itself. The crew rows follow
  // (RUN_ME section 14's trigger) and show as needing the new day; a crew
  // that was already told is offered a text right here.
  const dragMove = async (e: CalEvent, iso: string) => {
    const j = jobs.find((x) => `pact:${x.id}` === e.id);
    if (!j || !canEdit) return;
    const was = (j.start_date || "").trim();
    if (was === iso) return;
    const line = `📅 Moved to ${prettyDate(iso)} on the calendar${was ? ` (was ${prettyDate(was)})` : ""}`;
    if (!(await save(j, { start_date: iso, notes: appendNote(j.notes, line) }))) return;
    setSelected(iso);
    const crew = rowsOfJob(dayRows, j);
    const told = crew.filter((r) => r.texted).map((r) => emps.find((x) => x.id === r.employee_id)?.name.split(" ")[0] || "").filter(Boolean);
    if (told.length) {
      // the confirm waits a beat so the bar is seen landing first
      setTimeout(() => { if (window.confirm(`${poLabel(j)} moved to ${prettyDate(iso)}. Text ${told.join(", ")} the new day?`)) void textMove(j, was, iso); }, 60);
    } else flash(`${poLabel(j)} moved to ${prettyDate(iso)}${crew.length ? " — the crew still needs the new day" : ""}`);
  };

  // ---- POs coming in ----
  const priceBook = async () => (await loadPrices()).items;
  const handlePo = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file || !canEdit) return;
    setBusy(true);
    try {
      const out = await intakePoFile(file, priceBook);
      if (out.kind === "release") { flash("That's a NYCHA blanket release — upload it on the Releases tab (Import release PDFs). PACT only takes partner POs and proposal letters."); return; }
      if (out.kind === "error") { flash(/relation|column|schema/i.test(out.message) ? "Database needs the upgrade — run supabase/RUN_ME.sql" : out.message); return; }
      await load();
      const label = out.po ? `PO ${out.po}` : "That PO";
      if (out.kind === "dupe") {
        const j = jobs.find((x) => x.id === out.id);
        const day = out.moved ? out.movedTo : j?.start_date;
        if (day) goTo(day);
        flash(out.moved ? `${label} is already here — the new PO moves it to ${prettyDate(out.movedTo!)}` : `${label} is already here${out.canceled ? " (canceled)" : ""}${day ? ` — on ${prettyDate(day)}` : " — it has no day yet"}; nothing new was created`);
        return;
      }
      const who = out.isDocx ? "our letter" : out.readBy === "claude" ? "read by Claude" : `⚠ read by the rules${out.readNote ? ` (${out.readNote})` : ""}`;
      if (out.accessDate) { goTo(out.accessDate); flash(`${label} — ${who} · on the calendar for ${prettyDate(out.accessDate)} — now pick who's going${out.attachError ? ` (the PDF didn't attach: ${out.attachError})` : ""}`); }
      else {
        // no day on the PO: it is first in the "+ Put a job on…" box, one tap from a day
        setAddQ(out.po || "");
        flash(out.unreadable
          ? `PDF attached, but no text could be read (scanned copy?) — the job is here with no name; fill it in on the Billing tab, or put it on a day below`
          : `${label} — ${who} · no date on the PO — it's in the "+ Put a job on…" box below, tap it to put it on ${prettyDate(selected)}`);
      }
    } catch (err) {
      flash(`Upload hit a snag — try again (${err instanceof Error ? err.message.slice(0, 80) : "unknown error"})`);
    } finally { setBusy(false); }
  };
  const addByHand = async () => {
    if (!draft.partner.trim() || !draft.po.trim()) { flash("The partner and the PO number are the minimum"); return; }
    setBusy(true);
    try {
      const out = await addJobByHand({
        partner: draft.partner, job_number: draft.po, description: draft.description || `PO ${draft.po.trim()}`, address: draft.address, property_unit: draft.apt,
        start_date: draft.day || undefined, notes: draft.day ? `📅 Put on the calendar for ${prettyDate(draft.day)} when it was typed in` : "",
      });
      if (out.kind === "error") { flash(/relation|column|schema/i.test(out.message) ? "Database needs the upgrade — run supabase/RUN_ME.sql" : out.message); return; }
      await load();
      if (out.kind === "dupe") {
        if (out.start_date) goTo(out.start_date);
        flash(`PO ${draft.po.trim()} is already here${out.canceled ? " (canceled)" : ""}${out.start_date ? ` — on ${prettyDate(out.start_date)}` : " — it has no day yet"}; nothing new was created`);
        return;
      }
      const day = draft.day;
      setDraft({ ...BLANK }); setHandOpen(false);
      if (day) { goTo(day); flash(`PO ${draft.po.trim()} added on ${prettyDate(day)} — now pick who's going`); }
      else { setAddQ(draft.po.trim()); flash(`PO ${draft.po.trim()} added with no day — tap it in the "+ Put a job on…" box below`); }
    } finally { setBusy(false); }
  };

  // what the calendar holds: not canceled, not priced-and-past
  const live = jobs.filter((j) => !offCalendar(j, today));
  const hit = (j: Job) => !q.trim() || `${j.partner} ${poOf(j)} ${j.address || ""} ${j.property_unit || ""} ${j.description}`.toLowerCase().includes(q.trim().toLowerCase());
  const list = live.filter(hit);
  const undated = live.filter((j) => !(j.start_date || "").trim() && !j.work_done);
  // the search's own answer: every PO that matches, on the calendar or not
  const found = q.trim() ? jobs.filter(hit).sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")) : [];

  // ---- everything on the calendar ----
  const events = useMemo<CalEvent[]>(() => list.filter((j) => (j.start_date || "").trim()).map((j) => {
    const crew = rowsOfJob(dayRows, j);
    const where = [(j.address || j.development || "").split(",")[0], j.property_unit && `Apt ${j.property_unit}`].filter(Boolean).join(" · ");
    return {
      id: `pact:${j.id}`, day: j.start_date!, kind: "pact" as const, done: j.work_done,
      title: poOf(j) ? `PO ${poOf(j)}` : where || j.partner || "Job",
      short: poOf(j) || (j.address || j.partner || "").split(",")[0],
      subtitle: [where, j.partner].filter(Boolean).join(" · "),
      people: crew.map((r) => emps.find((e) => e.id === r.employee_id)?.name.split(" ")[0] || "").filter(Boolean),
      flag: crewState(crew, j) === "not_told" ? "crew not told" : undefined,
    };
  }), [list, dayRows, emps]);

  const card = (j: Job) => {
    const crew = rowsOfJob(dayRows, j);
    const state = crewState(crew, j);
    const names = crew.map((r) => emps.find((e) => e.id === r.employee_id)?.name.split(" ")[0] || "").filter(Boolean);
    const site = siteOf(j);
    return (
      <div key={j.id} className="border-t border-rulesoft p-3.5 first:border-t-0" data-po-card={poOf(j)}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <span className="font-mono text-[15px] font-semibold">{poLabel(j)}</span>
            {site && <span className="ml-1.5 text-[14px]">{site}</span>}
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

  // a PO's one line in a list: its number, where, whose
  const poLine = (j: Job) => (
    <span className="min-w-0 truncate">
      <span className="font-mono font-semibold">{poLabel(j)}</span>
      {siteOf(j) && <span className="ml-1.5">{siteOf(j)}</span>}
      {j.partner && <span className="ml-1.5 text-[11px] text-inksoft">{j.partner}</span>}
    </span>
  );

  // the Day view and the panel under Month/Week: that day's jobs as cards, and
  // a box to put any other job on the day — the ones with no day yet come
  // first, and a priced job that slipped off the calendar can be put back
  const dayPanel = (iso: string) => {
    const pact = list.filter((j) => j.start_date === iso).sort((a, b) => Number(!!a.work_done) - Number(!!b.work_done) || byPo(a, b));
    const aq = addQ.trim().toLowerCase();
    const pick = jobs
      .filter((j) => j.start_date !== iso && !j.work_done)
      .filter((j) => !aq || `${j.partner} ${poOf(j)} ${j.address || ""} ${j.property_unit || ""} ${j.description}`.toLowerCase().includes(aq))
      .sort((a, b) => Number(!!(a.start_date || "").trim()) - Number(!!(b.start_date || "").trim()) || (b.created_at || "").localeCompare(a.created_at || ""));
    return (
      <div>
        {pact.length > 0 && <div className="divide-y divide-rulesoft">{pact.map(card)}</div>}
        {pact.length === 0 && <div className="p-5 text-[13px] text-inksoft">Nothing on {prettyDate(iso)}.{canEdit ? " Put a PO on it below, drag one here from another day, or tap another day." : ""}</div>}
        {canEdit && (
          <div className="border-t border-rulesoft p-3.5">
            <input className="field" placeholder={`+ Put a job on ${prettyDate(iso)} — type a PO #, address or partner…`} value={addQ} onChange={(e) => setAddQ(e.target.value)} />
            {aq && (
              <div className="mt-1 max-h-64 overflow-y-auto rounded-sm border border-rulesoft bg-white">
                {pick.slice(0, 12).map((j) => (
                  <button key={j.id} type="button" className="flex min-h-[44px] w-full items-center justify-between gap-2 border-b border-rulesoft px-3 py-2.5 text-left text-[13px] last:border-b-0 hover:bg-paper" onClick={() => putOnDay(j, iso)}>
                    {poLine(j)}
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
  const field = "field min-h-[44px]";

  return (
    <div>
      <PageHeader title="Schedule" sub={`PACT — ${onCal} PO${onCal === 1 ? "" : "s"} on the calendar${undated.length ? ` · ${undated.length} with no day yet` : ""}`}>
        {canEdit && (
          <ActionMenu label={busy ? "Reading the PO…" : "+ Add PO"} variant="primary" items={[
            { label: "📄 Upload a PO (PDF or letter)", title: "A partner PO or one of our proposal letters — read, filed and put on its day", onSelect: () => poRef.current?.click(), disabled: busy },
            { label: "+ Type one in", title: "The partner, the PO number, the address and the day", onSelect: () => { setHandOpen(!handOpen); setDraft({ ...BLANK, day: selected }); } },
          ]} />
        )}
        <Link className="btn btn-ghost min-h-[44px]" href="/pact">🧾 Billing</Link>
      </PageHeader>
      <input ref={poRef} type="file" accept="application/pdf,.pdf,.docx" className="hidden" onChange={handlePo} />
      {handOpen && canEdit && (
        <div className="card mb-3 border-work p-4">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">A PO, typed in</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <input className={field} placeholder="Partner (who sent the PO)" value={draft.partner} onChange={(e) => setDraft({ ...draft, partner: e.target.value })} />
            <input className={`${field} font-mono`} placeholder="PO #" value={draft.po} onChange={(e) => setDraft({ ...draft, po: e.target.value })} />
            <input className={field} placeholder="Address" value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
            <input className={field} placeholder="Apt" value={draft.apt} onChange={(e) => setDraft({ ...draft, apt: e.target.value })} />
            <input className={`${field} sm:col-span-2`} placeholder="What's the work? (optional)" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            <label className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-inksoft">Day
              <input type="date" className={`${field} font-mono`} value={draft.day} onChange={(e) => setDraft({ ...draft, day: e.target.value })} />
              {draft.day && <button type="button" className="btn btn-ghost min-h-[36px] px-2 py-1 text-[12px] normal-case tracking-normal" onClick={() => setDraft({ ...draft, day: "" })}>No day yet</button>}
            </label>
          </div>
          <div className="mt-3 flex gap-2">
            <button className="btn btn-primary" onClick={addByHand} disabled={busy}>Add PO</button>
            <button className="btn btn-ghost" onClick={() => setHandOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
      <input className="field mb-1.5" placeholder="Search POs — number, partner, address…" value={q} onChange={(e) => setQ(e.target.value)} />
      {q.trim() && (
        <div className="mb-3 max-h-72 overflow-y-auto rounded-sm border border-rulesoft bg-white" data-po-results>
          {found.slice(0, 20).map((j) => {
            const day = (j.start_date || "").trim();
            const tail = j.work_done ? `done ✓${day ? ` · ${prettyDate(day)}` : ""}` : offCalendar(j, today) ? `priced, off the calendar · ${prettyDate(day)}` : day ? `on ${prettyDate(day)} → go there` : canEdit ? `no day yet → put on ${prettyDate(selected)}` : "no day yet";
            return (
              <button key={j.id} type="button" className="flex min-h-[44px] w-full items-center justify-between gap-2 border-b border-rulesoft px-3 py-2.5 text-left text-[13px] last:border-b-0 hover:bg-paper"
                onClick={() => { if (day) { goTo(day); setQ(""); } else if (canEdit) putOnDay(j, selected); }}>
                {poLine(j)}
                <span className="shrink-0 text-[11px] text-inksoft">{tail}</span>
              </button>
            );
          })}
          {found.length === 0 && <div className="px-3 py-2.5 text-[13px] text-inksoft">No PO matches “{q.trim()}”.{canEdit ? " Add it with + Add PO." : ""}</div>}
          {found.length > 20 && <div className="px-3 py-2 text-[11px] text-inksoft">{found.length - 20} more — type more of the number</div>}
        </div>
      )}

      <Calendar events={events} view={view} onView={setView} anchor={anchor} onAnchor={(d) => { setAnchor(d); }} selected={selected}
        onSelect={(d) => { setSelected(d); setAddQ(""); if (view !== "day") setAnchor(view === "month" ? anchor : d); }}
        onMove={canEdit ? dragMove : undefined}
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
