"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { matches } from "@/lib/search";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { sb } from "@/lib/supabase";
import { useProfile } from "@/lib/profile";
import { cached, forget, onCacheUser, remember } from "@/lib/cache";
import { useLive } from "@/lib/useLive";
import { localISO, prettyDate } from "@/lib/docs";
import { scrollTo } from "@/lib/motion";
import Stamp from "@/components/Stamp";
import PageHeader from "@/components/PageHeader";
import ActionMenu from "@/components/ActionMenu";
import { Toast, useFlash } from "@/components/Toast";
import JobDates, { lastNote } from "@/components/JobDates";
import Calendar, { type CalEvent, type CalView } from "@/components/Calendar";
import CrewPanel from "@/components/CrewPanel";
import TextedPhotos from "@/components/TextedPhotos";
import { CAL_JOB_COLS, CREW_JOB_COLS, WORKER_COLS, WORKER_COLS_OLD, crewLine, crewMessageFor, crewState, offCalendar, siteOf, type CrewRow, type Worker } from "@/lib/pactCrew";
import { textRows, stampRows } from "@/lib/notify";
import { intakePoFile, addJobByHand } from "@/lib/pactIntake";
import { loadPrices } from "@/lib/priceBook";
import { sendDueNow } from "@/lib/sendLater";

// the job as the calendar reads it: CAL_JOB_COLS, never the money
interface Job {
  id: string; partner: string; po_number?: string; job_number: string; address?: string; development?: string;
  property_unit?: string; description: string; work_done: boolean; canceled: boolean;
  start_date?: string; finish_date?: string; notes?: string; created_at?: string; priced?: boolean | null;
}
type DayRow = CrewRow;
type Emp = Worker;
// the New York day of a moment ("2026-09-22T02:10Z" is still the 21st there)
const nyDayOf = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const appendNote = (notes: string | null | undefined, line: string) => `${(notes || "").trim()}${(notes || "").trim() ? "\n" : ""}${line}`;
// the job's name on this tab: its PO number, the way the office and the partners say it
const poOf = (j: Job) => (j.po_number || j.job_number || "").trim();
const poLabel = (j: Job) => (poOf(j) ? `PO ${poOf(j)}` : "Job");
// "PO 116843" before "PO 116850", never "PO 9" after "PO 10"
const byPo = (a: Job, b: Job) => poOf(a).localeCompare(poOf(b), undefined, { numeric: true });
const BLANK = { partner: "", po: "", address: "", apt: "", description: "", day: "" };
// words from another part of the app (the intake, the texting) shown here: their dashes become plain punctuation
const plain = (s: string) => s.replace(/\s+[\u2014\u2013]\s+/g, ": ").replace(/[\u2014\u2013]/g, "-");
// a save that didn't land, and a database behind the app, in the office's words
const SAVE_FAILED = "Couldn't save. Check your signal and try again.";
const NEEDS_UPDATE = "can't be saved until the database update is run (Settings → System check)";
// a scan nobody could read: no number, no partner, no address; nothing typed here can find it
const nameless = (j: Job) => !poOf(j) && !(j.partner || "").trim() && !(j.address || "").trim() && !(j.description || "").trim();
// what this page remembers on the phone between opens (lib/cache): the calendar paints from it at once
const CACHE = { jobs: "cal:jobs", days: "cal:days", emps: "cal:emps", nobody: "cal:nobody" } as const;
// when this device last asked the server to send the texts whose time has come: once in five minutes is plenty
const DUE_KEY = "elgc-text-due-at";
const DUE_EVERY = 5 * 60_000;
// the remembered calendar lands before the first frame in the browser (a plain effect on the server, which has no frame)
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

// The PACT calendar: every PACT job on the day its PO names, or the day you
// give it here, named by its PO number, and moved by dragging it to another
// day. POs come in here too (upload the PDF, or type one in), the same way
// they do on the Billing tab, so the schedule is one place. Nothing else is
// on it: NYCHA crews have their own Schedule tab. A priced job (the lines
// add up to more than the price list filled in on its own) drops off once
// its day has passed.
export default function PactCalendar() {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loaded, setLoaded] = useState(false); // the jobs are in (remembered or fresh): the calendar can draw
  const jobsRef = useRef<Job[]>([]); // the list as last loaded, for a handler that just called load()
  // priced jobs whose day has passed are off the calendar; a search can show one anyway
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [dayRows, setDayRows] = useState<DayRow[]>([]);
  const [emps, setEmps] = useState<Emp[]>([]);
  // which lists the database has answered for on this visit: a remembered copy never paints over a fresh one
  const got = useRef({ jobs: false, days: false, emps: false, nobody: false });
  const [q, setQ] = useState("");
  // who is signed in: the remembered copy paints the calendar at once, the database confirms it one round trip
  // later. There is no money on this page (CAL_JOB_COLS), so nothing here waits for the confirmed role; the
  // database refuses a write the remembered role could not make anyway.
  const { hint, fresh: me } = useProfile();
  const role = (me || hint)?.role || "";
  const canEdit = role === "admin" || role === "office";
  const { msg, flash: show, progress } = useFlash();
  const flash = (m: string) => show(plain(m));
  const [view, setView] = useState<CalView>("month");
  const [anchor, setAnchor] = useState(localISO(new Date()));
  const [selected, setSelected] = useState(localISO(new Date()));
  // the card whose "Who's going?" panel is open, and the card whose notes are unfolded
  const [crewOpen, setCrewOpen] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState<string | null>(null);
  // "+ Put a job on this day": what's being typed
  const [addQ, setAddQ] = useState("");
  // a PO coming in: the PDF picker, the by-hand form, and the wait
  const poRef = useRef<HTMLInputElement>(null);
  const [handOpen, setHandOpen] = useState(false);
  const [draft, setDraft] = useState({ ...BLANK });
  const [busy, setBusy] = useState(false);
  const busyNow = useRef(false); // guards a double tap on Add PO (and a second PDF while one is read)
  const hold = () => { if (busyNow.current) return false; busyNow.current = true; setBusy(true); return true; };
  const release = () => { busyNow.current = false; setBusy(false); };
  const today = localISO(new Date());

  // the three reads leave together and each paints as it lands, the jobs first;
  // every answer is remembered on this device for the next open
  const load = async () => {
    const fetchJobs = async () => {
      let res = await sb().from("pact_jobs").select(CAL_JOB_COLS).order("created_at", { ascending: false }) as { data: unknown; error: { message: string } | null };
      if (res.error && /priced|column|schema cache/i.test(res.error.message)) { // before RUN_ME section 15: every job stays on
        res = await sb().from("pact_jobs").select(CREW_JOB_COLS).order("created_at", { ascending: false });
      }
      if (res.error) { flash(/relation|column|schema/i.test(res.error.message) ? "The calendar can't load until the database update is run (Settings → System check)" : "Couldn't load the calendar. Check your signal and try again."); setLoaded(true); return; }
      const fresh = ((res.data || []) as Job[]).filter((j) => !j.canceled);
      got.current.jobs = true;
      jobsRef.current = fresh;
      remember(CACHE.jobs, fresh);
      setJobs(fresh);
      setLoaded(true);
    };
    // the crews: PACT rows only (no release), in pages, since an unranged read
    // stops silently at 1000 rows and the oldest jobs would lose their crew
    const fetchRows = async () => {
      const out: DayRow[] = [];
      let whole = true;
      for (let from = 0; ; from += 1000) {
        const { data: d, error } = await sb().from("schedule_days").select("*").is("release_id", null).order("day", { ascending: false }).order("id").range(from, from + 999);
        if (error) { whole = false; break; }
        out.push(...((d || []) as DayRow[]));
        if (!d || d.length < 1000) break;
      }
      got.current.days = true;
      if (whole) remember(CACHE.days, out);
      setDayRows(out);
    };
    // the crew, with each worker's language (RUN_ME section 18); before it, without
    const fetchEmps = async () => {
      const r0 = await sb().from("employees").select(WORKER_COLS);
      const r = r0.error && /lang|column|schema cache/i.test(r0.error.message) ? await sb().from("employees").select(WORKER_COLS_OLD) : r0;
      if (r.error) return; // bad signal: the names already showing stay
      const e = (r.data || []) as Emp[];
      got.current.emps = true;
      remember(CACHE.emps, e);
      setEmps(e);
    };
    await Promise.all([fetchJobs(), fetchRows(), fetchEmps()]);
  };
  // the remembered calendar paints the moment the signed-in user is known (at
  // once on a tab-to-tab move, one session read after a cold open); the
  // database's answers, already on their way, replace it as they land
  useBeforePaint(() => onCacheUser(() => {
    const cj = cached<Job[]>(CACHE.jobs);
    if (cj && !got.current.jobs) { jobsRef.current = cj; setJobs(cj); setLoaded(true); }
    const cd = cached<DayRow[]>(CACHE.days);
    if (cd && !got.current.days) setDayRows(cd);
    const ce = cached<Emp[]>(CACHE.emps);
    if (ce && !got.current.emps) setEmps(ce);
  }), []);
  // a text set up for later whose time has come goes out now: the catch-up for
  // when the timer isn't set up; with it, this finds nothing to do. It waits for
  // the calendar's own reads, and asks once in five minutes per device (the
  // stamp is shared by every tab), not on every open
  useEffect(() => {
    let stop = false;
    let first: ReturnType<typeof setTimeout> | null = null;
    let every: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      try {
        if (Date.now() - Number(localStorage.getItem(DUE_KEY) || 0) < DUE_EVERY - 1000) return;
        localStorage.setItem(DUE_KEY, String(Date.now()));
      } catch { /* private mode: ask every time */ }
      const out = await sendDueNow();
      if (stop || !out) return;
      if (out.sent > 0) flash(`${out.sent} text${out.sent === 1 ? "" : "s"} that ${out.sent === 1 ? "was" : "were"} set up just went out ✓`);
      else if (out.failed > 0) flash(`${out.failed} text${out.failed === 1 ? "" : "s"} set up for earlier didn't go through: ${out.errors?.[0]?.error || "see Settings → System check"}`);
      else if (out.missed > 0) flash(`${out.missed} text${out.missed === 1 ? "" : "s"} set up for earlier didn't go out (no number, or that day has passed). The crew shows as not told`);
      if (out.sent > 0 || out.missed > 0 || out.failed > 0) load();
    };
    void load().finally(() => {
      if (stop) return;
      first = setTimeout(() => { void tick(); every = setInterval(tick, DUE_EVERY); }, 0);
    });
    return () => { stop = true; if (first) clearTimeout(first); if (every) clearInterval(every); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(["pact_jobs", "schedule_days", "employees"], () => load(), { skipWhileTyping: true });
  // jobs a worker texted "nobody home" about, waiting for a new day (RUN_ME
  // section 21 clears the mark once the job's day changes)
  const [nobody, setNobody] = useState<Map<string, string>>(new Map());
  // and each job's thread by text (lib/jobFlow): before photos in, the square
  // feet texted, after photos in: the marks on the card
  type Thread = { beforeN: number; afterN: number; measured: string };
  const [thread, setThread] = useState<Map<string, Thread>>(new Map());
  type Marks = { nobody: [string, string][]; thread: [string, Thread][] };
  const loadNobody = async () => {
    type Row = { pact_job_id: string; status: string; created_at: string; photos?: { name: string }[] | null; note?: string | null };
    // one read for both: the nobody-home marks still waiting and the thread
    // marks (pictures and measurements), two months back, newest first
    const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const read = (cols: string) => sb().from("texted_photos").select(cols).in("status", ["nobody", "filed", "measure"]).not("pact_job_id", "is", null).gte("created_at", since).order("created_at", { ascending: false }).limit(1000);
    let res = await read("pact_job_id,status,created_at,photos,note");
    if (res.error) res = await read("pact_job_id,status,created_at,photos"); // before section 21
    if (res.error) return; // before section 20
    let rows = (res.data || []) as unknown as Row[];
    if (rows.length >= 1000) {
      // a busy two months filled the page: the nobody-home marks on their own,
      // however old, so none is missed (they come off with the job's new day, so they stay few)
      const marks = await sb().from("texted_photos").select("pact_job_id,status,created_at").eq("status", "nobody").not("pact_job_id", "is", null).order("created_at", { ascending: false }).limit(1000);
      if (!marks.error) rows = rows.concat((marks.data || []) as unknown as Row[]);
    }
    const nb = new Map<string, string>();
    const t = new Map<string, Thread>();
    for (const r of rows) {
      // newest first, so the first seen is the latest
      if (r.status === "nobody") { if (!nb.has(r.pact_job_id)) nb.set(r.pact_job_id, r.created_at); continue; }
      const cur = t.get(r.pact_job_id) || { beforeN: 0, afterN: 0, measured: "" };
      if (r.status === "filed") (r.photos || []).forEach((p) => { if (/^before/i.test(p?.name || "")) cur.beforeN += 1; else if (/^after/i.test(p?.name || "")) cur.afterN += 1; });
      // "📏 Tue Sep 29 9:14 AM · Plaster 120 sq ft · texted by Jose" → the middle
      if (r.status === "measure" && !cur.measured) cur.measured = ((r.note || "").split(" · ")[1] || "").trim() || "texted";
      t.set(r.pact_job_id, cur);
    }
    got.current.nobody = true;
    remember(CACHE.nobody, { nobody: Array.from(nb), thread: Array.from(t) } as Marks);
    setNobody(nb);
    setThread(t);
  };
  // admin and office only: the notices are theirs (the database says so too).
  // The marks as last seen paint first; the read starts from the remembered role
  useEffect(() => {
    if (!canEdit) return;
    const c = cached<Marks>(CACHE.nobody);
    if (c && !got.current.nobody) { setNobody(new Map(c.nobody)); setThread(new Map(c.thread)); }
    loadNobody();
  }, [canEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(["texted_photos"], () => loadNobody(), { enabled: canEdit });

  // what the calendar holds (not canceled, not priced-and-past unless a search
  // showed it), the search's own answer and the ones with no day: figured once
  // per change, not on every keystroke, toast tick or drag move
  const { list, undated, unread, found } = useMemo(() => {
    const live = jobs.filter((j) => !offCalendar(j, today) || shown.has(j.id));
    const hit = (j: Job) => matches(q, j.partner, poOf(j), j.address, j.property_unit, j.description);
    return {
      list: live.filter(hit),
      undated: live.filter((j) => !(j.start_date || "").trim() && !j.work_done && !nameless(j)),
      unread: jobs.filter((j) => nameless(j) && !j.work_done).length,
      // every PO that matches, on the calendar or not
      found: q.trim() ? jobs.filter(hit).sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")) : [],
    };
  }, [jobs, q, shown, today]);
  // each job's crew rows, and each worker by id: one pass per change instead of
  // a scan of every crew row per bar and per card (rows are linked to their job,
  // so a moved job keeps its crew: RUN_ME section 14)
  const rowsByJob = useMemo(() => {
    const m = new Map<string, DayRow[]>();
    for (const r of dayRows) {
      if (!r.pact_job_id) continue;
      const a = m.get(r.pact_job_id);
      if (a) a.push(r); else m.set(r.pact_job_id, [r]);
    }
    return m;
  }, [dayRows]);
  const empById = useMemo(() => new Map(emps.map((e) => [e.id, e] as const)), [emps]);
  const crewOf = (j: Job): DayRow[] => rowsByJob.get(j.id) || [];
  const firstName = (empId: string) => (empById.get(empId)?.name || "").split(" ")[0];
  // "Give it a new day…" on a notice (or ?job= from the other Schedule tab):
  // the calendar opens on the job's day, at its card
  const showJob = (id: string) => {
    const j = jobsRef.current.find((x) => x.id === id);
    if (!j) { flash("That PO isn't on the calendar any more"); return; }
    if (!(j.start_date || "").trim()) { flash(`${poLabel(j)} has no day yet. Give it one below`); setQ(poOf(j)); return; }
    // on the calendar even when a search is typed, or it's a priced job whose day has passed
    setQ("");
    if (offCalendar(j, today)) setShown((prev) => new Set(prev).add(j.id));
    goTo(j.start_date!);
    let tries = 0;
    const scroll = () => {
      const el = document.querySelector(`[data-po-card="${poOf(j)}"]`);
      if (el) scrollTo(el);
      else if (++tries < 12) setTimeout(scroll, 150);
    };
    setTimeout(scroll, 150);
  };
  const jobParamDone = useRef(false);
  useEffect(() => {
    // the calendar draws once the sign-in is known: wait for both
    if (jobParamDone.current || jobs.length === 0 || !role) return;
    jobParamDone.current = true;
    const id = new URLSearchParams(window.location.search).get("job") || "";
    if (id) showJob(id);
  }, [jobs, role]); // eslint-disable-line react-hooks/exhaustive-deps

  // a new start_date here moves the job's crew rows to the new day and clears
  // their TEXTED mark (RUN_ME section 14's trigger); the cards then show who
  // needs the new day. Nothing is texted from here; that is the Move it… box.
  const save = async (j: Job, patch: Partial<Job>): Promise<boolean> => {
    const next = jobsRef.current.map((x) => (x.id === j.id ? { ...x, ...patch } : x));
    jobsRef.current = next;
    setJobs(next);
    forget(CACHE.jobs); // a write half done is never what the next open paints
    const { error } = await sb().from("pact_jobs").update(patch).eq("id", j.id);
    if (error) { flash(/column|schema cache/i.test(error.message) ? `This change ${NEEDS_UPDATE}` : SAVE_FAILED); load(); return false; }
    remember(CACHE.jobs, jobsRef.current);
    return true;
  };
  // "Text the crew the new day" from the Move it… box: everyone on the job is
  // told once, as a move, from the company number
  const textMove = async (j: Job, from: string, to: string) => {
    const rows = crewOf(j);
    const moved = { ...j, start_date: to };
    const targets = await Promise.all(rows.map(async (r) => {
      const e = empById.get(r.employee_id);
      const first = (e?.name || "").split(" ")[0];
      // told the old day → reads as a move; never told → the plain first text
      return { rowId: r.id, to: e?.phone || "", body: await crewMessageFor(moved, first, r.description || "", r.texted ? { from, to } : undefined, e?.lang), first, lang: e?.lang };
    }));
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
    flash(`${poLabel(j)} is on ${prettyDate(iso)}. Now pick who's going`);
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
    const crew = crewOf(j);
    const told = crew.filter((r) => r.texted).map((r) => firstName(r.employee_id)).filter(Boolean);
    if (told.length) {
      // the confirm waits a beat so the bar is seen landing first
      setTimeout(() => { if (window.confirm(`${poLabel(j)} moved to ${prettyDate(iso)}. Text ${told.join(", ")} the new day?`)) void textMove(j, was, iso); }, 60);
    } else flash(`${poLabel(j)} moved to ${prettyDate(iso)}${crew.length ? ". The crew still needs the new day" : ""}`);
  };

  // ---- POs coming in ----
  // the partner price list, and a note for the flash when the saved list
  // couldn't be read and the standard sheet priced the PO instead
  const bookNote = useRef("");
  const priceBook = async () => {
    const { items, ok } = await loadPrices();
    bookNote.current = ok ? "" : "⚠ your saved price list couldn't be read, so the standard sheet priced it. Check the prices on the Billing tab";
    return items;
  };
  // the intake's own words when it says nothing was made; the update hint when the database is behind
  const intakeError = (m: string) => (/nothing was created/i.test(m) ? `${plain(m)}${/relation|column|schema/i.test(m) ? ". Run the database update first (Settings → System check)" : ""}`
    : /relation|column|schema/i.test(m) ? `The PO ${NEEDS_UPDATE}` : plain(m));
  const handlePo = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file || !canEdit || !hold()) return;
    try {
      const out = await intakePoFile(file, priceBook);
      if (out.kind === "release") { flash("That's a NYCHA release. Upload it on the Releases tab: + Add release, then From release PDFs. PACT only takes partner POs and proposal letters."); return; }
      if (out.kind === "error") { flash(intakeError(out.message)); return; }
      await load();
      const label = out.po ? `PO ${out.po}` : "That PO";
      const tail = [out.kind === "made" && out.attachError ? `(the PDF didn't attach: ${plain(out.attachError)})` : "", bookNote.current].filter(Boolean).map((t) => ` · ${t}`).join("");
      if (out.kind === "dupe") {
        // a canceled job is off this calendar: nothing to jump to
        if (out.canceled) { flash(`${label} is already here, but canceled. Nothing new was created. Restore it on the Billing tab (⋯ → Restore) to use it again.`); return; }
        const j = jobsRef.current.find((x) => x.id === out.id);
        const day = out.moved ? out.movedTo : j?.start_date;
        if (day) goTo(day);
        flash(out.moved ? `${label} is already here. The new PO moves it to ${prettyDate(out.movedTo!)}` : `${label} is already here${day ? `, on ${prettyDate(day)}` : " with no day yet"}; nothing new was created`);
        return;
      }
      if (out.unreadable) {
        // a scan with no text: the job has no number, so nothing here can find it; the Billing tab can
        flash(`${out.attachError ? "No text could be read from that PDF, and it didn't attach" : "PDF attached, but no text could be read"} (scanned copy?). The job is on the Billing tab with no name yet. Type its PO number in there, then it can go on a day here.`);
        return;
      }
      const who = out.isDocx ? "our letter" : out.readBy === "claude" ? "read by Claude" : `⚠ read by the portal's own reader${out.readNote ? ` (${out.readNote})` : ""}`;
      if (out.accessDate) { goTo(out.accessDate); flash(`${label} · ${who} · on the calendar for ${prettyDate(out.accessDate)}. Now pick who's going${tail}`); }
      else {
        // no day on the PO: it is first in the "+ Put a job on…" box, one tap from a day
        setAddQ(out.po || "");
        flash(`${label} · ${who} · no date on the PO. It's in the "+ Put a job on…" box below, tap it to put it on ${prettyDate(selected)}${tail}`);
      }
    } catch (err) {
      flash(`Couldn't read that PO. Try again (${err instanceof Error ? plain(err.message.slice(0, 80)) : "unknown error"})`);
    } finally { release(); }
  };
  const addByHand = async () => {
    if (!draft.partner.trim() || !draft.po.trim()) { flash("The partner and the PO number are the minimum"); return; }
    if (!hold()) return; // a second tap while the first is saving adds nothing twice
    try {
      const out = await addJobByHand({
        partner: draft.partner, job_number: draft.po, description: draft.description || `PO ${draft.po.trim()}`, address: draft.address, property_unit: draft.apt,
        start_date: draft.day || undefined, notes: draft.day ? `📅 Put on the calendar for ${prettyDate(draft.day)} when it was typed in` : "",
      });
      if (out.kind === "error") { flash(intakeError(out.message)); return; }
      await load();
      if (out.kind === "dupe") {
        if (out.canceled) { flash(`PO ${draft.po.trim()} is already here, but canceled. Nothing new was created. Restore it on the Billing tab (⋯ → Restore) to use it again.`); return; }
        if (out.start_date) goTo(out.start_date);
        flash(`PO ${draft.po.trim()} is already here${out.start_date ? `, on ${prettyDate(out.start_date)}` : " with no day yet"}; nothing new was created`);
        return;
      }
      const day = draft.day;
      setDraft({ ...BLANK }); setHandOpen(false);
      if (day) { goTo(day); flash(`PO ${draft.po.trim()} added on ${prettyDate(day)}. Now pick who's going`); }
      else { setAddQ(draft.po.trim()); flash(`PO ${draft.po.trim()} added with no day. Tap it in the "+ Put a job on…" box below`); }
    } finally { release(); }
  };

  // ---- everything on the calendar: rebuilt only when the jobs, the crews, the names or the marks change ----
  const events = useMemo<CalEvent[]>(() => list.filter((j) => (j.start_date || "").trim()).map((j) => {
    const crew = rowsByJob.get(j.id) || [];
    const where = [(j.address || j.development || "").split(",")[0], j.property_unit && `Apt ${j.property_unit}`].filter(Boolean).join(" · ");
    return {
      id: `pact:${j.id}`, day: j.start_date!, kind: "pact" as const, done: j.work_done,
      title: poOf(j) ? `PO ${poOf(j)}` : where || j.partner || "Job",
      short: poOf(j) || (j.address || j.partner || "").split(",")[0],
      subtitle: [where, j.partner].filter(Boolean).join(" · "),
      people: crew.map((r) => (empById.get(r.employee_id)?.name || "").split(" ")[0]).filter(Boolean),
      flag: nobody.has(j.id) ? "nobody home, needs a new day" : crewState(crew, j) === "not_told" ? "crew not told" : undefined,
    };
  }), [list, rowsByJob, empById, nobody]);

  const card = (j: Job) => {
    const crew = crewOf(j);
    const state = crewState(crew, j);
    const names = crew.map((r) => firstName(r.employee_id)).filter(Boolean);
    const site = siteOf(j);
    const open = crewOpen === j.id;
    const unfolded = notesOpen === j.id;
    return (
      <div key={j.id} className="border-t border-rulesoft p-3.5 first:border-t-0" data-po-card={poOf(j)}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <span className="font-mono text-[15px] font-semibold">{poLabel(j)}</span>
            {site && <span className="ml-1.5 text-[14px]">{site}</span>}
            <div className="max-w-[520px] truncate text-[12px] text-inksoft">{j.partner}{j.description ? ` · ${j.description}` : ""}</div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {nobody.has(j.id) && <span data-nobody-stamp><Stamp label="⚠ NOBODY HOME" tone="alert" /></span>}
            {/* priced but still ahead: it stays until its day has passed */}
            {j.priced && <Stamp label="PRICED" tone="ok" />}
            {/* the work-done flag: a ghost button until it's set, then the stamp (a tap takes it back off) */}
            {j.work_done ? (canEdit
              ? <button type="button" className="btn-stamp" onClick={() => save(j, { work_done: false })}><Stamp label="WORK DONE ✓" tone="ok" /></button>
              : <Stamp label="WORK DONE ✓" tone="ok" />)
              : canEdit && <button type="button" className="btn btn-ghost btn-sm btn-stamp" onClick={() => save(j, { work_done: true })}>Mark work done</button>}
          </div>
        </div>
        <div className="mt-2">
          <JobDates job={j} canEdit={canEdit} onSave={(p) => save(j, p as Partial<Job>)} showNotes={false}
            crew={{ names, told: crew.some((r) => r.texted) }} onMoved={(from, to) => textMove(j, from, to)} />
          {/* the last note on one line; a tap unfolds the whole history */}
          {lastNote(j.notes) && (
            <>
              <button type="button" className="row-btn mt-1 truncate px-1 text-[12px] text-inksoft" aria-expanded={unfolded} onClick={() => setNotesOpen(unfolded ? null : j.id)}>
                <span aria-hidden className={`mr-1 inline-block text-[11px] transition-transform duration-150 ${unfolded ? "rotate-90" : ""}`}>▸</span>{lastNote(j.notes)}
              </button>
              {unfolded && <div className="anim-open mt-1 whitespace-pre-wrap rounded-sm border border-rulesoft bg-paper px-3 py-2 text-[12px] text-inksoft">{j.notes}</div>}
            </>
          )}
        </div>
        {/* who's going: the one line, and the panel behind it */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className={`text-[12px] ${state === "not_told" ? "text-alert" : "text-inksoft"}`}>📱 {crewLine(crew, j, emps)}</span>
          {thread.has(j.id) && (() => {
            const t = thread.get(j.id)!;
            const parts = [t.beforeN ? `📷 before ${t.beforeN}` : "", t.measured ? `📏 ${t.measured}` : "", t.afterN ? `📷 after ${t.afterN}` : ""].filter(Boolean);
            return parts.length ? <span className="text-[12px] text-ok" data-thread={j.id}>{parts.join(" · ")}</span> : null;
          })()}
          {(canEdit || crew.length > 0) && (
            <button type="button" className={`btn btn-sm ${open ? "border-work" : ""}`} aria-expanded={open} onClick={() => setCrewOpen(open ? null : j.id)}>
              📱 Who's going?{crew.length ? ` · ${crew.length}` : ""}
            </button>
          )}
        </div>
        {open && (
          <div className="anim-open mt-2">
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
  const rowCls = "row-btn flex items-center justify-between gap-2 border-b border-rulesoft px-3 py-2.5 text-[13px] last:border-b-0";

  // the Day view and the panel under Month/Week: that day's jobs as cards, and
  // a box to put any other job on the day; the ones with no day yet come
  // first, and a priced job that slipped off the calendar can be put back
  const dayPanel = (iso: string) => {
    const pact = list.filter((j) => j.start_date === iso).sort((a, b) => Number(!!a.work_done) - Number(!!b.work_done) || byPo(a, b));
    const aq = addQ.trim().toLowerCase();
    const pick = jobs
      .filter((j) => j.start_date !== iso && !j.work_done)
      .filter((j) => matches(aq, j.partner, poOf(j), j.address, j.property_unit, j.description))
      .sort((a, b) => Number(!!(a.start_date || "").trim()) - Number(!!(b.start_date || "").trim()) || (b.created_at || "").localeCompare(a.created_at || ""));
    return (
      <div>
        {pact.length > 0 && <div className="divide-y divide-rulesoft">{pact.map(card)}</div>}
        {pact.length === 0 && <div className="empty m-3.5">Nothing on {prettyDate(iso)}.{canEdit ? " Put a PO on it below, or drag one here from another day." : ""}</div>}
        {canEdit && (
          <div className="border-t border-rulesoft p-3.5">
            <input className="field" type="search" enterKeyHint="search" autoComplete="off" placeholder={`+ Put a job on ${prettyDate(iso)}: PO #, address or partner`} value={addQ} onChange={(e) => setAddQ(e.target.value)} />
            {aq && (
              <div className="popover static max-h-64 overflow-y-auto">
                {pick.slice(0, 12).map((j) => (
                  <button key={j.id} type="button" className={rowCls} onClick={() => putOnDay(j, iso)}>
                    {poLine(j)}
                    <span className="shrink-0 text-[11px] text-inksoft">{offCalendar(j, today) ? "priced, off the calendar → put here" : (j.start_date || "").trim() ? `on ${prettyDate(j.start_date)} → move here` : "no day yet → put here"}</span>
                  </button>
                ))}
                {pick.length === 0 && <div className="px-3 py-2 text-[13px] text-inksoft">No job matches “{addQ}”.</div>}
              </div>
            )}
            {!aq && undated.length > 0 && <div className="mt-1 text-[12px] text-inksoft">{undated.length} PO{undated.length === 1 ? " has" : "s have"} no day yet. Start typing and {undated.length === 1 ? "it comes" : "they come"} up first.</div>}
            {!aq && unread > 0 && <div className="mt-1 text-[12px] text-inksoft">{unread} PDF{unread === 1 ? "" : "s"} with no number yet. Give {unread === 1 ? "it its" : "them their"} PO number on the Billing tab, then {unread === 1 ? "it" : "they"} can go on a day here.</div>}
          </div>
        )}
      </div>
    );
  };

  // until the sign-in is known (the remembered one counts) and the jobs are in (the remembered
  // ones count too): the header, and the month's shape shimmering under it
  if (!role || !loaded) return (
    <div>
      <PageHeader title="PACT Schedule" />
      <div className="card p-3" aria-busy="true">
        <div className="mb-2 flex items-center gap-2"><div className="skeleton h-11 w-20" /><div className="skeleton h-11 w-24" /><div className="skeleton ml-auto h-11 w-40" /></div>
        <div className="grid grid-cols-7 gap-[2px]">{Array.from({ length: 35 }, (_, i) => <div key={i} className="skeleton h-[52px] md:h-[96px]" />)}</div>
      </div>
    </div>
  );
  const onCal = events.filter((e) => !e.done).length;

  return (
    <div>
      {busy && <div className="busy-bar" aria-busy="true" aria-label="Working" />}
      <PageHeader title="PACT Schedule" sub={`${onCal} PO${onCal === 1 ? "" : "s"} on the calendar${undated.length ? ` · ${undated.length} with no day yet` : ""}`}
        primary={canEdit ? (
          <ActionMenu label="+ Add PO" variant="primary" busy={busy} items={[
            { glyph: "📄", label: "Upload a PO (PDF or letter)", onSelect: () => poRef.current?.click(), disabled: busy },
            { glyph: "✎", label: "+ Type one in", onSelect: () => { setHandOpen(!handOpen); setDraft({ ...BLANK, day: selected }); } },
          ]} />
        ) : undefined}>
        <Link className="btn btn-ghost" href="/pact">🏢 Billing</Link>
      </PageHeader>
      <input ref={poRef} type="file" accept="application/pdf,.pdf,.docx" className="hidden" onChange={handlePo} />
      <TextedPhotos canEdit={canEdit} flash={flash} onShow={(b) => {
        if (b.pact_job_id) showJob(b.pact_job_id);
        else if (b.release_id) router.push(`/schedule?day=${nyDayOf(b.created_at)}&release=${b.release_id}`); // in the app, not a reload
      }} onReschedule={async (b, iso) => {
        // nobody home → a new day from the notice itself: the job moves (its
        // crew rows follow and the ⚠ clears, RUN_ME 14 and 21), the crew is texted the change
        const j = jobsRef.current.find((x) => x.id === b.pact_job_id);
        if (!j) { flash("That PO isn't on the calendar any more"); return; }
        const was = (j.start_date || "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || iso === was) { flash("Pick a different day"); return; }
        if (!(await save(j, { start_date: iso, notes: appendNote(j.notes, `📅 Moved to ${prettyDate(iso)} after nobody home${was ? ` (was ${prettyDate(was)})` : ""}`) }))) return;
        if (crewOf(j).length) await textMove({ ...j, start_date: iso }, was, iso);
        else flash(`${poLabel(j)} moved to ${prettyDate(iso)}. Now pick who's going`);
        loadNobody();
      }} />
      {handOpen && canEdit && (
        <form className="card anim-open card-pad mb-3 border-work" onSubmit={(e) => { e.preventDefault(); void addByHand(); }}>
          <div className="section-label mb-2">Type in a PO</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <input className="field" autoFocus placeholder="Partner (who sent the PO)" value={draft.partner} onChange={(e) => setDraft({ ...draft, partner: e.target.value })} />
            <input className="field font-mono" placeholder="PO #" value={draft.po} onChange={(e) => setDraft({ ...draft, po: e.target.value })} />
            <input className="field" placeholder="Address" value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
            <input className="field" placeholder="Apt" autoCapitalize="characters" value={draft.apt} onChange={(e) => setDraft({ ...draft, apt: e.target.value })} />
            <input className="field sm:col-span-2" placeholder="What's the work? (optional)" enterKeyHint="done" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            <div className="flex items-center gap-2">
              <label htmlFor="po-by-hand-day" className="section-label">Day</label>
              <input id="po-by-hand-day" type="date" className="field min-w-0 font-mono" value={draft.day} onChange={(e) => setDraft({ ...draft, day: e.target.value })} />
              {draft.day && <button type="button" className="btn btn-ghost btn-sm shrink-0 whitespace-nowrap normal-case tracking-normal" onClick={() => setDraft({ ...draft, day: "" })}>No day yet</button>}
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <button type="submit" className={`btn btn-primary${busy ? " btn-busy" : ""}`} aria-busy={busy || undefined} disabled={busy}>Add PO</button>
            <button type="button" className="btn btn-ghost" onClick={() => setHandOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
      <input className="field mb-1.5" type="search" enterKeyHint="search" autoComplete="off" placeholder="Search POs: number, partner, address…" value={q} onChange={(e) => setQ(e.target.value)} />
      {q.trim() && (
        <div className="popover static mb-3 max-h-72 overflow-y-auto" data-po-results>
          {found.slice(0, 20).map((j) => {
            const day = (j.start_date || "").trim();
            const off = offCalendar(j, today) && !shown.has(j.id);
            const tail = off ? `priced, off the calendar · ${prettyDate(day)} → show it` : j.work_done ? `done ✓${day ? ` · ${prettyDate(day)} → go there` : " · no day"} ` : day ? `on ${prettyDate(day)} → go there` : canEdit ? `no day yet → put on ${prettyDate(selected)}` : "no day yet";
            return (
              <button key={j.id} type="button" className={rowCls}
                onClick={() => {
                  if (off) { setShown((prev) => new Set(prev).add(j.id)); if (day) goTo(day); setQ(""); } // back on its day to look at, nothing written
                  else if (day) { goTo(day); setQ(""); }
                  else if (j.work_done) flash(`${poLabel(j)} is marked work done and never had a day: nothing to put on the calendar. It's on the Billing tab.`);
                  else if (canEdit) putOnDay(j, selected);
                }}>
                {poLine(j)}
                <span className="shrink-0 text-[11px] text-inksoft">{tail}</span>
              </button>
            );
          })}
          {found.length === 0 && <div className="px-3 py-2.5 text-[13px] text-inksoft">No PO matches “{q.trim()}”.{canEdit ? " Add it with + Add PO." : ""}</div>}
          {found.length > 20 && <div className="px-3 py-2 text-[12px] text-inksoft">{found.length - 20} more: type more of the number</div>}
        </div>
      )}

      <Calendar events={events} view={view} onView={(v) => { if (v === "day") setAnchor(selected); setView(v); }} anchor={anchor} onAnchor={(d) => { setAnchor(d); }} selected={selected}
        onSelect={(d) => { setSelected(d); setAddQ(""); if (view !== "day") setAnchor(view === "month" ? anchor : d); }}
        onMove={canEdit ? dragMove : undefined}
        renderDay={dayPanel} />

      {view !== "day" && (
        <>
          <div className="section-label mb-1.5 mt-4">{prettyDate(selected)}{selected === today ? " · today" : ""}</div>
          <div className="card mb-4">{dayPanel(selected)}</div>
        </>
      )}
      <Toast msg={msg} progress={progress} />
    </div>
  );
}
