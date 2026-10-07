"use client";
import { useEffect, useRef, useState } from "react";
import { matches } from "@/lib/search";
// styled fork of SheetJS — same API, plus cell borders/fonts for the export
// the export engine is heavy — it loads on demand, never with the page itself
let XLSX!: typeof import("xlsx-js-style");
const ensureXLSX = async () => { XLSX = XLSX || (await import("xlsx-js-style")); };
import Link from "next/link";
import { sb } from "@/lib/supabase";
import { myProfile } from "@/lib/profile";
import { askFileName } from "@/lib/format";
import { prettyDate, addDays, localISO } from "@/lib/docs";
import { canonTrade, checkLabor, aggregateLogged, type LaborResult } from "@/lib/labor";
import Stamp from "@/components/Stamp";
import ContractPicker, { contractLabel } from "@/components/ContractPicker";
import { useLive } from "@/lib/useLive";
import type { Contract } from "@/lib/types";
import { TEMPLATE_CREW } from "@/lib/crew";
import { useNumBuffer } from "@/lib/numBuffer";
import PageHeader from "@/components/PageHeader";
import Disclosure from "@/components/Disclosure";
import { RowActions } from "@/components/ActionMenu";
import Toast, { useFlash } from "@/components/Toast";

interface Emp { id: string; name: string; trade: string; base_rate: number; active: boolean; phone?: string | null; }
interface Week { id: string; week_ending: string; paid_map?: Record<string, string> | null; }
interface Entry { id?: string; week_id: string; employee_id: string; job_label: string; rate: number; hours: number[]; release_id: string | null; trade?: string | null; }
interface RelRow { id: string; rel_number: string; location: string; contract_id: string; labor_hours: number; labor_breakdown: { cls: string; hours: number }[] | null; canceled?: boolean; }
// the week runs Saturday → Friday, like the paper sheet; Sat & Sun are overtime days
const DAYS = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];

// Friday that ends the week containing the given date
const fridayOf = (iso: string) => {
  const d = new Date(iso + "T00:00:00");
  const add = (5 - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + add);
  return localISO(d);
};
// "Oct 3": the short form of a day, for a range or a paid mark
const shortDay = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
// the week as people say it: "Oct 3 to Oct 9, 2026", the year once (twice only when the week straddles New Year)
const weekRange = (we: string) => {
  const start = addDays(we, -6);
  return start.slice(0, 4) === we.slice(0, 4) ? `${shortDay(start)} to ${prettyDate(we)}` : `${prettyDate(start)} to ${prettyDate(we)}`;
};

function summarize(entries: Entry[], emps: Emp[]) {
  const by: Record<string, { hrs: number; base: number; ot: number; days: number[] }> = {};
  entries.forEach((en) => {
    const hrs = en.hours.reduce((s, d) => s + (Number(d) || 0), 0);
    if (!by[en.employee_id]) by[en.employee_id] = { hrs: 0, base: 0, ot: 0, days: [0, 0, 0, 0, 0, 0, 0] };
    by[en.employee_id].hrs += hrs;
    by[en.employee_id].base += hrs * (Number(en.rate) || 0);
    by[en.employee_id].ot += (Number(en.hours[0]) || 0) + (Number(en.hours[1]) || 0); // Sat + Sun
    en.hours.forEach((d, i) => (by[en.employee_id].days[i] += Number(d) || 0));
  });
  return Object.entries(by).map(([eid, v]) => {
    const emp = emps.find((e) => e.id === eid);
    const avg = v.hrs > 0 ? v.base / v.hrs : 0;
    const premium = v.ot * 0.5 * avg; // Sat/Sun paid time-and-a-half
    return { eid, name: emp?.name || "?", trade: emp?.trade || "", days: v.days, hrs: v.hrs, reg: v.hrs - v.ot, ot: v.ot, premium, gross: v.base + premium };
  });
}

// the one line a failed save shows; the real error never reaches the office
const SIGNAL = "Check your signal and try again.";

export default function Payroll() {
  const [emps, setEmps] = useState<Emp[]>([]);
  const [weeks, setWeeks] = useState<Week[]>([]);
  const [openWeek, setOpenWeek] = useState<Week | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [rels, setRels] = useState<RelRow[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [linkContract, setLinkContract] = useState("");
  const [weekCheck, setWeekCheck] = useState<{ rel: RelRow; result: LaborResult }[]>([]);
  const { msg, flash } = useFlash();
  const [pickDate, setPickDate] = useState(""); // calendar for opening any week
  const [loaded, setLoaded] = useState(false); // the first read of the weeks list is back: skeleton rows until then
  const [loadingWeek, setLoadingWeek] = useState(false); // an opened week's hours are on their way: skeleton cards until then
  const [making, setMaking] = useState(false); // Make payroll is busy, so the button reads "Opening…" and can't be tapped again
  // release-first entry: the week is organized as one card per release
  const [extraSections, setExtraSections] = useState<{ release_id: string | null; label: string }[]>([]);
  const [relPickQ, setRelPickQ] = useState(""); // the "+ Add a release" search
  const [addFor, setAddFor] = useState<string | null>(null); // section currently adding a worker
  const [addQ, setAddQ] = useState("");
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const makingWeek = useRef(false); // guards Make payroll against double-taps (state alone is a render behind a quick second tap)
  // which week the screen is asking about — a slower answer for a week the user
  // has already navigated away from is thrown away instead of being shown
  const openReq = useRef(0);
  const paidChain = useRef<Promise<void>>(Promise.resolve()); // PAID marks save one at a time
  const weekRef = useRef<Week | null>(null); // the open week as of right now, for queued saves
  const num = useNumBuffer();
  // the accountant can read everything here but the database won't accept their
  // writes — show a view-only page instead of edits that silently don't save
  const [role, setRole] = useState("");
  const readOnly = role === "accountant";
  useEffect(() => {
    myProfile().then((p) => setRole(p?.role || ""));
  }, []);

  const load = async (only?: string[]) => {
    // the four reads don't depend on each other — they go out together; a
    // realtime event names its table so everything else is skipped
    const want = (t: string) => !only || only.includes(t);
    const fetchRels = async () => {
      const allR: RelRow[] = [];
      for (let from = 0; ; from += 1000) { // paginated — an unranged select stops silently at 1000
        // canceled releases stay in the list (flagged) so hours already punched on
        // them keep their release name — the pickers below filter them out
        const { data: r } = await sb().from("releases").select("id,rel_number,location,contract_id,labor_hours,labor_breakdown,canceled").order("id").range(from, from + 999);
        allR.push(...((r || []) as RelRow[]));
        if (!r || r.length < 1000) break;
      }
      return allR;
    };
    const [e, w, allR, c] = await Promise.all([
      // all employees (incl. deactivated) so past weeks still show their names
      want("employees") ? sb().from("employees").select("*").order("name").then((r) => r.data) : null,
      want("timesheet_weeks") ? sb().from("timesheet_weeks").select("*").order("week_ending", { ascending: false }).then((r) => r.data) : null,
      want("releases") ? fetchRels() : null,
      want("contracts") ? sb().from("contracts").select("id,number,name").order("number").then((r) => r.data) : null,
    ]);
    if (e) setEmps(e as Emp[]);
    if (w) {
      setWeeks(w as Week[]);
      setOpenWeek((prev) => (prev ? { ...prev, ...((w as Week[]).find((x) => x.id === prev.id) || {}) } : prev));
    }
    if (allR) setRels(allR.sort((x, y) => (parseFloat(x.rel_number) || 0) - (parseFloat(y.rel_number) || 0)));
    if (c) setContracts(c as Contract[]);
    if (!only) setLoaded(true); // a full load has answered: the list can show its rows (or say there are none)
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { weekRef.current = openWeek; }, [openWeek]);

  // live: crew, weeks (incl. paid marks), releases and contracts stay current —
  // refetching only the table the event came from
  useLive(["timesheet_weeks", "employees", "releases", "contracts"], (changed) => load(changed), { skipWhileTyping: true });
  // live: hours entered on another device appear in the open week
  useLive(["timesheet_entries"], async () => {
    if (!openWeek) return;
    const req = openReq.current;
    const wid = openWeek.id;
    const { data } = await sb().from("timesheet_entries").select("*").eq("week_id", wid);
    if (openReq.current !== req) return; // a different week is open now
    setEntries(((data || []) as Entry[])
      .filter((en) => en.week_id === wid)
      .map((en) => ({ ...en, hours: (en.hours || []).map(Number) })));
  }, { enabled: !!openWeek, skipWhileTyping: true });

  // live check: for each release linked this week, are the classification
  // hours at the release's minimum yet? (counts hours from ALL weeks)
  const loadWeekCheck = async (ents: Entry[]) => {
    const ids = [...new Set(ents.map((e) => e.release_id).filter(Boolean))] as string[];
    if (ids.length === 0) { setWeekCheck([]); return; }
    // select * so the per-entry classification comes along once the column exists;
    // typed classifications win, the worker's usual trade fills the blanks —
    // the same rule the Releases and Home checks use for the same release
    // (paginated — an unranged select stops silently at 1000 and undercounts)
    const allEnts: { release_id: string | null; employee_id: string; hours: number[]; trade?: string | null }[] = [];
    for (let f = 0; ; f += 1000) {
      const { data: chunk } = await sb().from("timesheet_entries").select("*").in("release_id", ids).order("id").range(f, f + 999);
      allEnts.push(...((chunk || []) as typeof allEnts));
      if (!chunk || chunk.length < 1000) break;
    }
    // only classifications the user actually typed count toward the release's minimums
    const byRel = aggregateLogged(allEnts, new Map(emps.map((e) => [e.id, canonTrade(e.trade)])));
    setWeekCheck(ids
      .map((id) => rels.find((r) => r.id === id))
      .filter((r): r is RelRow => !!r && !r.canceled)
      .map((r) => ({ rel: r, result: checkLabor(r.labor_breakdown || [], Number(r.labor_hours) || 0, byRel[r.id] || {}) })));
  };
  useEffect(() => {
    if (!openWeek) return;
    if (checkTimer.current) clearTimeout(checkTimer.current);
    checkTimer.current = setTimeout(() => loadWeekCheck(entries), 800);
    return () => { if (checkTimer.current) clearTimeout(checkTimer.current); };
  }, [entries, openWeek]); // eslint-disable-line react-hooks/exhaustive-deps

  const openW = async (w: Week) => {
    const req = (openReq.current += 1);
    setOpenWeek(w);
    // last week's rows come off the screen FIRST — otherwise they are still
    // showing while the new week loads, and hours typed into them save
    // themselves into the week the user just left
    setEntries([]); setWeekCheck([]);
    setExtraSections([]); setRelPickQ(""); setAddFor(null); setAddQ("");
    setLoadingWeek(true);
    const { data } = await sb().from("timesheet_entries").select("*").eq("week_id", w.id);
    if (openReq.current !== req) return; // the user moved on — this answer is stale
    setLoadingWeek(false);
    const ents = ((data || []) as Entry[])
      .filter((en) => en.week_id === w.id)
      .map((en) => ({ ...en, hours: (en.hours || []).map(Number) }));
    setEntries(ents);
    loadWeekCheck(ents);
  };
  // back to the weeks list. The focused box saves itself on blur, so blurring
  // first puts the hours being typed in before the week closes.
  const closeWeek = () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    openReq.current += 1; setOpenWeek(null); setEntries([]); setWeekCheck([]); setLoadingWeek(false); load();
  };
  // the one button: opens the payroll for the week containing forDate (today by
  // default), creating it first if needed — the latest week's crew comes over
  // automatically with hours reset to zero
  const makePayroll = async (forDate?: string) => {
    if (makingWeek.current) return; // double-taps must not create the week twice
    makingWeek.current = true;
    setMaking(true);
    try {
    const we = fridayOf(forDate || localISO());
    const existing = weeks.find((w) => w.week_ending === we);
    if (existing) { openW(existing); return; }
    // the on-screen list can be stale (another phone may have just made it) — check the database
    const { data: fresh } = await sb().from("timesheet_weeks").select("*").eq("week_ending", we).limit(1);
    if (fresh && fresh[0]) { await load(); openW(fresh[0] as Week); return; }
    const { data, error } = await sb().from("timesheet_weeks").insert({ week_ending: we }).select().single();
    if (error || !data) { flash(`Couldn't open that week. ${SIGNAL}`); return; }
    // if two devices raced past the check, the OLDEST copy wins — only the loser
    // deletes its own; the winner sees itself first and keeps it
    const { data: all } = await sb().from("timesheet_weeks").select("*").eq("week_ending", we).order("created_at");
    if (all && all.length > 1 && (all[0] as Week).id !== (data as Week).id) {
      await sb().from("timesheet_weeks").delete().eq("id", (data as Week).id);
      await load(); openW(all[0] as Week); return;
    }
    if (weeks[0]) {
      const { data: prev } = await sb().from("timesheet_entries").select("*").eq("week_id", weeks[0].id);
      // trade rides along so per-job classifications survive the weekly copy
      if (prev?.length) await sb().from("timesheet_entries").insert(prev.map((p: Entry) => ({ week_id: data.id, employee_id: p.employee_id, job_label: p.job_label, rate: p.rate, release_id: p.release_id, trade: p.trade, hours: [0, 0, 0, 0, 0, 0, 0] })));
    }
    await load(); openW(data as Week);
    } finally { makingWeek.current = false; setMaking(false); }
  };
  const missingTradeCol = /column|schema cache/i;
  const addEntry = async (empId: string, empObj?: Emp, rel?: { id: string | null; label: string }) => {
    if (!openWeek) return;
    const emp = empObj || emps.find((e) => e.id === empId);
    const base = {
      week_id: openWeek.id, employee_id: empId, rate: emp?.base_rate || 0,
      release_id: rel?.id ?? null, job_label: rel?.label ?? "", hours: [0, 0, 0, 0, 0, 0, 0],
    };
    // classification starts empty — the user types it per release and it's cross-checked live
    const { data, error } = await sb().from("timesheet_entries").insert(base).select().single();
    if (error) { flash(`Couldn't add that worker. ${SIGNAL}`); return; }
    if (data) setEntries((prev) => (prev.some((x) => x.id === (data as Entry).id) ? prev : [...prev, { ...(data as Entry), hours: ((data as Entry).hours || []).map(Number) }]));
  };
  // picking a template name adds that worker to the crew on the spot, then to the week
  const addFromTemplate = async (idx: number, rel?: { id: string | null; label: string }) => {
    const t = TEMPLATE_CREW[idx];
    if (!t) return;
    const inCrew = emps.find((e) => e.name.trim().toLowerCase() === t.name.toLowerCase());
    if (inCrew) {
      if (inCrew.active === false) {
        await sb().from("employees").update({ active: true }).eq("id", inCrew.id);
        setEmps((prev) => prev.map((e) => (e.id === inCrew.id ? { ...e, active: true } : e)));
      }
      addEntry(inCrew.id, inCrew, rel); return;
    }
    // the worker may exist deactivated — bring them back instead of duplicating
    const { data: prior } = await sb().from("employees").select("*").ilike("name", t.name).limit(1);
    const found = (prior || [])[0] as Emp | undefined;
    if (found) {
      await sb().from("employees").update({ active: true }).eq("id", found.id);
      const emp = { ...found, active: true };
      setEmps((prev) => (prev.some((e) => e.id === emp.id) ? prev : [...prev, emp].sort((a, b) => a.name.localeCompare(b.name))));
      addEntry(emp.id, emp, rel);
      return;
    }
    const { data, error } = await sb().from("employees").insert({ name: t.name, trade: t.trade, base_rate: 0 }).select().single();
    if (error || !data) { flash(`Couldn't add that worker. ${SIGNAL}`); return; }
    const emp = data as Emp;
    setEmps((prev) => (prev.some((e) => e.id === emp.id) ? prev : [...prev, emp].sort((a, b) => a.name.localeCompare(b.name))));
    addEntry(emp.id, emp, rel);
  };
  // each blur saves ONLY its own field — a whole-row save from this device's
  // state could silently revert a day someone else just punched on another phone
  const saveTrade = async (en: Entry) => {
    // a blank saves as null so it falls back to the worker's default everywhere
    const trade = (en.trade ?? "").trim() || null;
    const { error } = await sb().from("timesheet_entries").update({ trade }).eq("id", en.id!);
    if (!error) return;
    flash(missingTradeCol.test(error.message) ? "Classifications can't be saved until the database update is run (Settings → System check)" : `Couldn't save that classification. ${SIGNAL}`);
  };
  const dayChain = useRef<Promise<void>>(Promise.resolve()); // fallback saves run one at a time
  const saveDay = (en: Entry, i: number, n: number) => {
    const run = dayChain.current.then(() => saveDayNow(en, i, n)).catch(() => {});
    dayChain.current = run;
    return run;
  };
  const saveDayNow = async (en: Entry, i: number, n: number) => {
    // one atomic write of just that day (run supabase/upgrade_speed.sql) —
    // two phones on different days of the same worker can never collide
    const { data: updated, error: rpcErr } = await sb().rpc("set_day_hours", { eid: en.id!, di: i, val: n });
    if (!rpcErr && Array.isArray(updated)) {
      const hours = (updated as number[]).map((h) => Number(h) || 0);
      setEntries((prev) => prev.map((x) => (x.id === en.id ? { ...x, hours } : x)));
      return;
    }
    // fallback: merge the one day onto the row as the database has it right now
    const { data } = await sb().from("timesheet_entries").select("hours").eq("id", en.id!).single();
    const hours = ((((data as { hours?: number[] } | null)?.hours) || en.hours) as number[]).map((h) => Number(h) || 0);
    hours[i] = n;
    setEntries((prev) => prev.map((x) => (x.id === en.id ? { ...x, hours } : x)));
    const { error } = await sb().from("timesheet_entries").update({ hours }).eq("id", en.id!);
    if (error) flash(`Couldn't save those hours. ${SIGNAL}`);
  };
  const delEntry = async (id: string) => {
    const { error } = await sb().from("timesheet_entries").delete().eq("id", id);
    if (error) { flash(`Couldn't remove that worker. ${SIGNAL}`); return; }
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };
  const deleteWeek = async (w: Week) => {
    if (!window.confirm(`Delete the payroll week ending ${prettyDate(w.week_ending)} and ALL its hours? This can't be undone.`)) return;
    const { error: e1 } = await sb().from("timesheet_entries").delete().eq("week_id", w.id);
    if (e1) { flash(`Couldn't delete that week. ${SIGNAL}`); return; }
    const { error: e2 } = await sb().from("timesheet_weeks").delete().eq("id", w.id);
    if (e2) { flash(`Couldn't delete that week. ${SIGNAL}`); return; }
    // make sure it's really gone — a silently-blocked delete would leave ghost hours
    const { data: still } = await sb().from("timesheet_weeks").select("id").eq("id", w.id).limit(1);
    if (still && still.length > 0) { flash("That week wouldn't delete. Check your account's role in Settings."); load(); return; }
    if (openWeek?.id === w.id) { openReq.current += 1; setOpenWeek(null); setEntries([]); setWeekCheck([]); setLoadingWeek(false); }
    load(); flash("Week and its hours deleted");
  };

  // one PAID mark per worker per week — no more side spreadsheet
  const togglePaid = (eid: string) => {
    if (!openWeek) return;
    const wid = openWeek.id;
    // marks go one at a time: tapping two workers quickly used to have both
    // read the same starting list, so the second write dropped the first mark
    paidChain.current = paidChain.current.then(async () => {
      // start from the row as the database has it — writing this device's copy
      // wholesale would erase a PAID mark just made on another phone, and letting
      // this device's stale copy win could resurrect a mark someone just cleared
      const { data: fresh } = await sb().from("timesheet_weeks").select("paid_map").eq("id", wid).single();
      const stored = ((fresh as { paid_map?: Record<string, string> | null } | null)?.paid_map) || null;
      // the previous mark in the chain has already been written, so what comes
      // back is the whole truth; the on-screen copy is only the fallback
      const map = { ...(stored || (weekRef.current?.id === wid ? weekRef.current.paid_map : null) || {}) };
      if (map[eid]) delete map[eid]; else map[eid] = localISO();
      setOpenWeek((prev) => (prev && prev.id === wid ? { ...prev, paid_map: map } : prev));
      const { error } = await sb().from("timesheet_weeks").update({ paid_map: map }).eq("id", wid);
      if (error) { flash(/column/i.test(error.message) ? "PAID marks can't be saved until the database update is run (Settings → System check)" : `Couldn't save that PAID mark. ${SIGNAL}`); load(); }
    }).catch(() => {});
  };

  const summ = summarize(entries, emps);
  const totHrs = summ.reduce((s, x) => s + x.hrs, 0);

  // ---------- weekly sheet in the paper-template layout, one tab per contract ----------
  const exportTemplate = async () => {
    try { await ensureXLSX(); } catch { flash("Couldn't load the Excel engine. Check your signal and try again."); return; }
    if (!openWeek || entries.length === 0) { flash("No hours this week yet"); return; }
    const relById = new Map(rels.map((r) => [r.id, r]));
    const groups = new Map<string, Entry[]>();
    entries.forEach((en) => {
      const cid = en.release_id ? relById.get(en.release_id)?.contract_id || "" : "";
      if (!groups.has(cid)) groups.set(cid, []);
      groups.get(cid)!.push(en);
    });
    // a worker's real day total spans every release they touched that day — used for the over-8h flag
    const dayTotByEmp = new Map<string, number[]>();
    entries.forEach((en) => {
      const arr = dayTotByEmp.get(en.employee_id) || [0, 0, 0, 0, 0, 0, 0];
      en.hours.forEach((h, i) => (arr[i] += Number(h) || 0));
      dayTotByEmp.set(en.employee_id, arr);
    });
    const wb = XLSX.utils.book_new();
    const thin = { style: "thin", color: { rgb: "000000" } };
    const box = { top: thin, bottom: thin, left: thin, right: thin };
    const shade = { patternType: "solid", fgColor: { rgb: "E8E4DA" } };
    const otShade = { patternType: "solid", fgColor: { rgb: "FBE9DC" } };
    const bandShade = { patternType: "solid", fgColor: { rgb: "F3F0E8" } };
    const overShade = { patternType: "solid", fgColor: { rgb: "FDE2E2" } };
    const usedNames = new Set<string>();
    // day headers carry the actual dates for the week (Sat … Fri, ending Friday)
    const dayNames = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
    const shortDate = (iso: string) => { const dt = new Date(iso + "T00:00:00"); return `${dt.getMonth() + 1}/${dt.getDate()}`; };
    const dayHeads = dayNames.map((n, i) => `${n} ${shortDate(addDays(openWeek.week_ending, i - 6))}${i < 2 ? " (OT)" : ""}`);
    const legend = "Red = worker over 8 hours that day (all releases combined)";
    // ---- Total Hours tab: every worker's real day totals across all contracts ----
    {
      const aoa: (string | number)[][] = [];
      aoa.push(["Earth Link General Construction — Total Hours"]);
      aoa.push([]);
      aoa.push(["Week ending", prettyDate(openWeek.week_ending)]);
      aoa.push([]);
      aoa.push(["Worker", "", "", ...dayHeads, "Total Hrs"]);
      const headerRow = 4, firstData = 5;
      const workers = [...dayTotByEmp.entries()]
        .map(([eid, days]) => ({ eid, name: emps.find((e) => e.id === eid)?.name || "?", days }))
        .sort((a, b) => a.name.localeCompare(b.name));
      workers.forEach((w) => aoa.push([w.name, "", "", ...w.days, w.days.reduce((s, d) => s + d, 0)]));
      const lastRow = aoa.length - 1;
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = [{ wch: 24 }, { wch: 5 }, { wch: 5 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 14 }, { wch: 13 }, { wch: 13 }, { wch: 10 }];
      ws["!merges"] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 10 } },
        { s: { r: 2, c: 1 }, e: { r: 2, c: 3 } },
        ...workers.map((_, i) => ({ s: { r: firstData + i, c: 0 }, e: { r: firstData + i, c: 2 } })),
      ];
      const cellAt = (row: number, col: number) => ws[XLSX.utils.encode_cell({ r: row, c: col })] || (ws[XLSX.utils.encode_cell({ r: row, c: col })] = { t: "s", v: "" });
      cellAt(0, 0).s = { font: { bold: true, sz: 14 }, alignment: { vertical: "center" } };
      cellAt(2, 0).s = { font: { bold: true } }; cellAt(2, 1).s = { font: { bold: true }, alignment: { horizontal: "left" } };
      const overCells = new Set<string>();
      workers.forEach((w, i) => { for (let d = 0; d < 7; d++) if ((w.days[d] || 0) > 8) overCells.add(`${firstData + i}:${d + 3}`); });
      for (let row = headerRow; row <= lastRow; row++) {
        for (let col = 0; col < 11; col++) {
          const cell = cellAt(row, col);
          const s: Record<string, unknown> = { border: box, alignment: { vertical: "center", horizontal: col >= 3 ? "center" : "left", wrapText: row === headerRow } };
          if (row === headerRow || col === 10) s.font = { bold: true };
          if (row === headerRow) { s.fill = shade; if (col === 3 || col === 4) s.font = { bold: true, color: { rgb: "B3510F" } }; }
          else if (overCells.has(`${row}:${col}`)) { s.fill = overShade; s.font = { bold: true, color: { rgb: "B42318" } }; }
          else if (col === 3 || col === 4) s.fill = otShade;
          cell.s = s;
        }
      }
      if (overCells.size > 0) {
        const noteCell = cellAt(lastRow + 2, 0);
        noteCell.v = legend;
        noteCell.s = { font: { italic: true, color: { rgb: "B42318" }, sz: 10 } };
        ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow + 2, c: 10 } });
      }
      ws["!rows"] = [];
      ws["!rows"][0] = { hpt: 24 };
      ws["!rows"][headerRow] = { hpt: 30 };
      for (let row = firstData; row <= lastRow; row++) ws["!rows"][row] = { hpt: 19 };
      XLSX.utils.book_append_sheet(wb, ws, "Total Hours");
      usedNames.add("Total Hours");
    }
    // ---- one tab per contract: release band, then that release's header + workers ----
    for (const [cid, ents] of groups) {
      const c = contracts.find((x) => x.id === cid);
      const byRel = new Map<string, Entry[]>();
      ents.forEach((en) => {
        const k = en.release_id || "";
        if (!byRel.has(k)) byRel.set(k, []);
        byRel.get(k)!.push(en);
      });
      const relOrder = [...byRel.keys()].sort((a, b) =>
        String(relById.get(a)?.rel_number ?? "").localeCompare(String(relById.get(b)?.rel_number ?? ""), undefined, { numeric: true }));
      const aoa: (string | number)[][] = [];
      aoa.push([`Earth Link General Construction`]);
      aoa.push([]);
      // contract number stays a text cell — a numeric cell shows long NYCHA numbers in scientific notation
      const contractText = c ? (c.name && c.name !== c.number ? `${c.number} — ${c.name}` : String(c.number)) : "(no release linked)";
      aoa.push(["Contract", contractText, "", "", "Week ending", prettyDate(openWeek.week_ending)]);
      aoa.push([]);
      const bandRows: number[] = [];
      const headerRows: number[] = [];
      const nameRows: { row: number; eid: string }[] = [];
      for (const rid of relOrder) {
        const rel = relById.get(rid);
        bandRows.push(aoa.length);
        // a canceled release is no longer in the picker list, but hours already
        // punched on it keep its name on the sheet instead of melting into "No release"
        const gone = rid ? byRel.get(rid)![0]?.job_label : "";
        aoa.push([rel ? `Release #${rel.rel_number} — ${rel.location}${rel.canceled ? " (canceled)" : ""}` : gone ? `${gone} (deleted release)` : "No release (shop, misc…)"]);
        headerRows.push(aoa.length);
        aoa.push(["Worker", "", "", ...dayHeads, "Category", "Total Hrs"]);
        const by: Record<string, number[]> = {};
        const tradesBy: Record<string, Map<string, string>> = {}; // per worker: lowercased → as typed
        byRel.get(rid)!.forEach((en) => {
          by[en.employee_id] ||= [0, 0, 0, 0, 0, 0, 0];
          en.hours.forEach((h, i) => (by[en.employee_id][i] += Number(h) || 0));
          const t = (en.trade ?? "").trim(); // only what the user typed — no defaults
          if (t) (tradesBy[en.employee_id] ||= new Map()).set(t.toLowerCase(), t);
        });
        // on the printed sheet a blank Category is useless to the payroll company —
        // where nothing was typed the worker's usual trade from Settings fills in.
        // (the release minimums check above still counts only what was typed.)
        const workers = Object.entries(by)
          .map(([eid, days]) => {
            const emp = emps.find((e) => e.id === eid);
            const typed = [...(tradesBy[eid]?.values() || [])].join(" / ");
            return { eid, emp, days, cat: typed || (emp?.trade || "").trim() };
          })
          .sort((a, b) => (a.emp?.name || "").localeCompare(b.emp?.name || ""));
        workers.forEach(({ eid, emp, days, cat }) => {
          nameRows.push({ row: aoa.length, eid });
          // zeros stay visible — an empty box reads as "forgot", a 0 reads as "didn't work"
          aoa.push([emp?.name || "?", "", "", ...days, cat, days.reduce((s, d) => s + d, 0)]);
        });
      }
      const lastRow = aoa.length - 1;
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = [{ wch: 24 }, { wch: 5 }, { wch: 5 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 14 }, { wch: 13 }, { wch: 13 }, { wch: 16 }, { wch: 10 }];
      // flag any day where the worker's combined hours (all releases together) run past 8
      const overCells = new Set<string>();
      nameRows.forEach(({ row, eid }) => {
        const tot = dayTotByEmp.get(eid) || [];
        for (let i = 0; i < 7; i++) if ((tot[i] || 0) > 8) overCells.add(`${row}:${i + 3}`);
      });
      ws["!merges"] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 11 } },
        { s: { r: 2, c: 1 }, e: { r: 2, c: 3 } },  // contract number spans B–D so it never gets cut off
        { s: { r: 2, c: 5 }, e: { r: 2, c: 6 } },  // week-ending date spans F–G
        ...bandRows.map((row) => ({ s: { r: row, c: 0 }, e: { r: row, c: 11 } })),
        ...nameRows.map(({ row }) => ({ s: { r: row, c: 0 }, e: { r: row, c: 2 } })),
      ];
      const cellAt = (row: number, col: number) => ws[XLSX.utils.encode_cell({ r: row, c: col })] || (ws[XLSX.utils.encode_cell({ r: row, c: col })] = { t: "s", v: "" });
      cellAt(0, 0).s = { font: { bold: true, sz: 14 }, alignment: { vertical: "center" } };
      cellAt(2, 0).s = { font: { bold: true } }; cellAt(2, 4).s = { font: { bold: true } };
      cellAt(2, 1).s = { font: { bold: true }, alignment: { horizontal: "left" } };
      cellAt(2, 1).t = "s"; // force text so Excel never re-reads the number as scientific notation
      cellAt(2, 5).s = { font: { bold: true } };
      const bandSet = new Set(bandRows);
      const headSet = new Set(headerRows);
      for (let row = 4; row <= lastRow; row++) {
        const isBand = bandSet.has(row);
        const isHead = headSet.has(row);
        for (let col = 0; col < 12; col++) {
          const cell = cellAt(row, col);
          const s: Record<string, unknown> = { border: box, alignment: { vertical: "center", horizontal: !isBand && ((col >= 3 && col <= 9) || col === 11) ? "center" : "left", wrapText: isHead } };
          if (isHead || isBand || col === 11) s.font = { bold: true };
          if (isHead) { s.fill = shade; if (col === 3 || col === 4) s.font = { bold: true, color: { rgb: "B3510F" } }; }
          else if (isBand) s.fill = bandShade;
          else if (overCells.has(`${row}:${col}`)) { s.fill = overShade; s.font = { bold: true, color: { rgb: "B42318" } }; }
          else if (col === 3 || col === 4) s.fill = otShade; // Sat/Sun = overtime columns
          cell.s = s;
        }
      }
      if (overCells.size > 0) {
        const noteCell = cellAt(lastRow + 2, 0);
        noteCell.v = legend;
        noteCell.s = { font: { italic: true, color: { rgb: "B42318" }, sz: 10 } };
        ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow + 2, c: 11 } });
      }
      ws["!rows"] = [];
      ws["!rows"][0] = { hpt: 24 };
      headerRows.forEach((row) => (ws["!rows"]![row] = { hpt: 30 }));
      nameRows.forEach(({ row }) => (ws["!rows"]![row] = { hpt: 19 }));
      const base = (c ? String(c.number) : "General").replace(/[\\/?*[\]:]/g, "-").slice(0, 31) || "General";
      let name = base;
      let n = 2;
      while (usedNames.has(name)) name = `${base.slice(0, 28)}~${n++}`; // suffix survives the 31-char cap
      usedNames.add(name);
      XLSX.utils.book_append_sheet(wb, ws, name);
    }
    const fname = askFileName(`payroll_WE_${openWeek.week_ending}.xlsx`);
    if (!fname) return;
    XLSX.writeFile(wb, fname);
  };

  const relLabel = (r: RelRow) => {
    const c = contracts.find((x) => x.id === r.contract_id);
    return `#${r.rel_number} · ${r.location}${c ? ` · ${contractLabel(c)}` : ""}`;
  };

  if (openWeek) {
    const we = openWeek.week_ending;
    // the releases the "+ Add a release" box is offering right now (Enter takes the first)
    const relMatches = relPickQ.trim()
      ? rels
        .filter((r) => !r.canceled)
        .filter((r) => !linkContract || r.contract_id === linkContract)
        .filter((r) => relLabel(r).toLowerCase().includes(relPickQ.trim().toLowerCase()))
        .slice(0, 40)
      : [];
    // a picked release gets its own card, opened on the worker box
    const pickRel = (r: RelRow) => {
      setExtraSections((prev) => (prev.some((x) => x.release_id === r.id) ? prev : [...prev, { release_id: r.id, label: `#${r.rel_number} — ${r.location}` }]));
      setRelPickQ(""); setAddFor(r.id); setAddQ("");
    };
    const pickNoRelease = () => {
      setExtraSections((prev) => (prev.some((x) => x.release_id === null) ? prev : [...prev, { release_id: null, label: "" }]));
      setRelPickQ(""); setAddFor("none"); setAddQ("");
    };
    return (
      <div key={openWeek.id} className="page-enter">
        {loadingWeek && <div className="busy-bar" aria-busy="true" aria-label="Working" />}
        <PageHeader title={`Week ending ${prettyDate(we)}`} sub={`Sat ${shortDay(addDays(we, -6))} to Fri ${shortDay(we)} · Sat and Sun are overtime`}
          back={{ label: "Weeks", onClick: closeWeek }}
          primary={<button type="button" className="btn btn-primary" onClick={exportTemplate}>⬇ Weekly sheet (Excel)</button>} />

        {/* one card per release: pick the release, add its workers, punch their days */}
        <div className="mb-3 grid gap-2 md:grid-cols-2">
          <ContractPicker contracts={contracts} value={linkContract} onChange={setLinkContract}
            extra={[{ id: "", label: "All contracts" }]} />
          {!readOnly && <div className="relative">
            <input className="field" placeholder="+ Add a release (number or development)" autoComplete="off" enterKeyHint="done"
              value={relPickQ} onChange={(e) => setRelPickQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); if (relMatches[0]) pickRel(relMatches[0]); }
                else if (e.key === "Escape") { e.preventDefault(); setRelPickQ(""); }
              }} />
            {relPickQ.trim() && (
              <div className="popover max-h-72 overflow-y-auto">
                {relMatches.map((r) => (
                  <button key={r.id} type="button" className="row-btn border-b border-rulesoft px-3 py-2.5 text-[15px]"
                    onPointerDown={(ev) => { ev.preventDefault(); pickRel(r); }}>
                    {relLabel(r)}
                    {Number(r.labor_hours) > 0 && <span className="ml-1 font-mono text-[11px] text-inksoft">· needs {r.labor_hours}h</span>}
                  </button>
                ))}
                <button type="button" className="row-btn px-3 py-2.5 text-[15px] text-inksoft"
                  onPointerDown={(ev) => { ev.preventDefault(); pickNoRelease(); }}>
                  + Hours without a release (shop, misc)
                </button>
              </div>
            )}
          </div>}
        </div>

        {(() => {
          const groups = new Map<string, { release_id: string | null; label: string }>();
          // one pass over all entries for the per-worker day totals (the >8h
          // flag) — computing this inside every row made typing sluggish on
          // big weeks — and one lookup map instead of scanning rels per section
          const dayTotAll = new Map<string, number[]>();
          entries.forEach((en) => {
            const arr = dayTotAll.get(en.employee_id) || [0, 0, 0, 0, 0, 0, 0];
            en.hours.forEach((h, i) => (arr[i] += Number(h) || 0));
            dayTotAll.set(en.employee_id, arr);
          });
          const relById2 = new Map(rels.map((r) => [r.id, r]));
          entries.forEach((en) => {
            const key = en.release_id || "none";
            if (!groups.has(key)) groups.set(key, { release_id: en.release_id || null, label: en.release_id ? en.job_label || "release" : "" });
          });
          extraSections.forEach((x) => { const key = x.release_id || "none"; if (!groups.has(key)) groups.set(key, x); });
          const allSections = [...groups.entries()].map(([key, v]) => ({ key, ...v }))
            .sort((a, b) => (a.release_id === null ? 1 : b.release_id === null ? -1 : a.label.localeCompare(b.label, undefined, { numeric: true })));
          // when a contract is picked up top, only its releases show — the rest stay saved, just hidden.
          // shop/misc hours belong to no contract, so they are never what the filter
          // is hiding — without this the "Hours without a release" button opens a
          // section the filter immediately swallows and nothing appears to happen
          const sections = linkContract
            ? allSections.filter((s) => s.release_id === null || relById2.get(s.release_id)?.contract_id === linkContract)
            : allSections;
          const hiddenCount = allSections.length - sections.length;
          const hiddenLine = hiddenCount === 1 ? "1 release from another contract is hidden." : `${hiddenCount} releases from other contracts are hidden.`;
          if (sections.length === 0) {
            // the week's hours are still on their way: two placeholder cards hold the spot
            if (loadingWeek) {
              return (<>{[0, 1].map((i) => <div key={`sk${i}`} className="card mb-3 card-pad"><div className="skeleton h-24 w-full" /></div>)}</>);
            }
            return (
              <div className="empty anim-fade">
                {hiddenCount > 0
                  ? `No hours on this contract yet. ${hiddenLine} Switch the filter to All contracts to see them.`
                  : readOnly ? "No hours this week yet." : "Add a release above, then its workers, then each day's hours."}
              </div>
            );
          }
          return (<div className="anim-fade">
          {hiddenCount > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px] text-inksoft">
              <span>Showing this contract only. {hiddenLine}</span>
              <button type="button" className="btn btn-ghost btn-sm min-h-[44px]" onClick={() => setLinkContract("")}>Show all</button>
            </div>
          )}
          {sections.map((sec) => {
            const ents = entries.filter((en) => (en.release_id || "none") === sec.key);
            const rel = sec.release_id ? relById2.get(sec.release_id) ?? null : null;
            const check = sec.release_id ? weekCheck.find((wc) => wc.rel.id === sec.release_id) : null;
            // how many hours the release is still short, by class or in total, whichever is bigger
            const short = check ? Math.max(check.result.totalRequired - check.result.totalLogged, check.result.shorts.reduce((s, r) => s + (r.required - r.logged), 0)) : 0;
            const relInfo = rel ? { id: rel.id as string | null, label: `#${rel.rel_number} — ${rel.location}` } : { id: null as string | null, label: "" };
            const inSection = new Set(ents.map((e) => e.employee_id));
            const query = addQ.trim().toLowerCase();
            // full roster — the dropdown scrolls, so never hide anyone behind a cap
            const crewMatch = emps.filter((e) => e.active !== false).filter((e) => matches(query, e.name));
            // a name only drops off the template list once it is on the ACTIVE crew —
            // otherwise someone taken off the crew shows in neither list and can
            // never be put back on
            const tplMatch = TEMPLATE_CREW.map((t, i) => ({ ...t, idx: i }))
              .filter((t) => !emps.some((e) => e.active !== false && e.name.trim().toLowerCase() === t.name.toLowerCase()))
              .filter((t) => matches(query, t.name));
            const contract = rel ? contracts.find((x) => x.id === rel.contract_id) : null;
            // Enter in the worker box takes the first name offered: the crew first, then the template
            const pickFirstWorker = () => {
              if (crewMatch[0]) { addEntry(crewMatch[0].id, crewMatch[0], relInfo); setAddQ(""); }
              else if (tplMatch[0]) { addFromTemplate(tplMatch[0].idx, relInfo); setAddQ(""); }
            };
            return (
              <div key={sec.key} className="card mb-3 card-pad">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <b className="font-mono text-[14px]">{rel ? `#${rel.rel_number}${rel.canceled ? " (canceled)" : ""}` : "No release (shop, misc)"}</b>
                    {rel && <span className="ml-2 text-[14px]">{rel.location}</span>}
                    {contract && <span className="ml-1.5 text-[12px] text-inksoft">· {contractLabel(contract)}</span>}
                  </div>
                  {check && (
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-xs">{check.result.totalLogged}/{check.result.totalRequired}h</span>
                      {check.result.ok ? <Stamp label="HOURS OK" tone="ok" /> : <Stamp label={`SHORT ${Math.round(short * 10) / 10}H`} tone="alert" />}
                    </span>
                  )}
                </div>
                {check && check.result.rows.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {check.result.rows.map((row) => (
                      <span key={row.cls} className={`chip-outline px-2 py-0.5 ${row.logged < row.required ? "border-alert text-alert" : "border-rulesoft text-inksoft"}`}>
                        {row.cls} {row.logged}/{row.required}h{row.logged < row.required ? ` · need ${row.required - row.logged} more` : ""}
                      </span>
                    ))}
                  </div>
                )}
                {ents.map((en) => {
                  const emp = emps.find((e) => e.id === en.employee_id);
                  const set = (patch: Partial<Entry>) => setEntries((prev) => prev.map((x) => (x.id === en.id ? { ...x, ...patch } : x)));
                  const hrs = en.hours.reduce((sum, d) => sum + (Number(d) || 0), 0);
                  const clsText = (en.trade ?? "").trim();
                  const canon = canonTrade(clsText);
                  const reqClasses = (rel?.labor_breakdown || []).map((b) => canonTrade(b.cls));
                  const fits = reqClasses.includes(canon);
                  // combined day totals across every release this worker is on — >8h in a day gets flagged
                  const empDayTot = dayTotAll.get(en.employee_id) || [0, 0, 0, 0, 0, 0, 0];
                  return (
                    <div key={en.id} className="anim-row border-t border-rulesoft py-2.5 first:border-t-0">
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <b className="min-w-0 truncate text-[14px]">{emp?.name || "?"}</b>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="font-mono text-xs text-inksoft">{hrs}h</span>
                          {!readOnly && <button type="button" className="btn-icon text-alert" aria-label={`Remove ${emp?.name || "this worker"} from this release`} onClick={() => { if (hrs > 0 && !window.confirm(`Remove ${emp?.name || "this worker"} from this release? Their ${hrs}h here will be deleted.`)) return; delEntry(en.id!); }}>✕</button>}
                        </div>
                      </div>
                      <div className="mb-1.5 flex flex-wrap items-center gap-2">
                        <input className="field w-40 px-2 py-1.5 text-[13px]" placeholder="Classification" readOnly={readOnly} aria-label="Classification"
                          value={en.trade ?? ""} onChange={(e) => set({ trade: e.target.value })} onBlur={() => saveTrade(en)} />
                        {clsText !== "" && reqClasses.length > 0 && (fits ? <Stamp label={`✓ ${canon}`} tone="ok" /> : <Stamp label={`${canon} NOT ON RELEASE`} tone="work" />)}
                      </div>
                      <div className="grid grid-cols-7 gap-1.5">
                        {DAYS.map((d, i) => (
                          <div key={d}>
                            <div className={`text-center text-[11px] uppercase tracking-wide ${empDayTot[i] > 8 ? "font-semibold text-alert" : i < 2 ? "font-semibold text-work" : "text-inksoft"}`}>{d}</div>
                            <input className={`field px-1 py-2.5 text-center font-mono ${empDayTot[i] > 8 ? "bg-alert/10 ring-1 ring-alert" : i < 2 ? "bg-work/5" : ""}`} inputMode="decimal" placeholder="0" readOnly={readOnly} aria-label={`${d} hours`}
                              {...num(`${en.id}:h${i}`, Number(en.hours[i]) || 0,
                                (n) => { const hours = [...en.hours]; hours[i] = n; set({ hours }); },
                                (n) => saveDay(en, i, n))} />
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {ents.length === 0 && <div className="empty my-2">{readOnly ? "No workers on this release yet." : "No workers yet. Add the first one below."}</div>}
                {readOnly ? null : addFor === sec.key ? (
                  <div className="relative mt-2">
                    <input className="field" autoFocus autoComplete="off" enterKeyHint="done" placeholder="Type a worker's name…" value={addQ}
                      onChange={(e) => setAddQ(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); pickFirstWorker(); }
                        else if (e.key === "Escape") { e.preventDefault(); setAddFor(null); }
                      }}
                      onBlur={() => setTimeout(() => setAddFor((cur) => (cur === sec.key ? null : cur)), 150)} />
                    <div className="popover max-h-72 overflow-y-auto">
                      {crewMatch.map((e) => (
                        <button key={e.id} type="button" className="row-btn flex items-center justify-between border-b border-rulesoft px-3 py-2.5 text-[15px] last:border-b-0"
                          onPointerDown={(ev) => { ev.preventDefault(); addEntry(e.id, e, relInfo); setAddQ(""); }}>
                          <span>{e.name}</span>
                          <span className="text-[11px] text-inksoft">{inSection.has(e.id) ? "+ another row" : "+ add"}</span>
                        </button>
                      ))}
                      {tplMatch.map((t) => (
                        <button key={t.name} type="button" className="row-btn flex items-center justify-between border-b border-rulesoft px-3 py-2.5 text-[15px] last:border-b-0"
                          onPointerDown={(ev) => { ev.preventDefault(); addFromTemplate(t.idx, relInfo); setAddQ(""); }}>
                          <span>{t.name}</span>
                          <span className="text-[11px] text-inksoft">+ add to crew</span>
                        </button>
                      ))}
                      {crewMatch.length === 0 && tplMatch.length === 0 && <div className="p-2.5 text-sm text-inksoft">No one matches “{addQ}”.</div>}
                    </div>
                  </div>
                ) : (
                  <button type="button" className="btn btn-ghost btn-sm mt-2 min-h-[44px]" onClick={() => { setAddFor(sec.key); setAddQ(""); }}>+ Add worker</button>
                )}
              </div>
            );
          })}
          </div>);
        })()}
        {summ.length > 0 && (
          <div className="card mt-2 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead><tr className="border-b-[1.5px] border-ink text-left font-display text-xs uppercase tracking-widest text-inksoft">
                <th className="p-2">Worker</th><th className="p-2 text-right">Reg</th><th className="p-2 text-right">OT</th><th className="p-2 text-right">Total</th><th className="p-2 text-center">Paid</th></tr></thead>
              <tbody>
                {summ.map((x) => {
                  const paidOn = openWeek.paid_map?.[x.eid];
                  // a day over 8 hours across every release the worker touched is flagged once, here
                  const overDays = DAYS.filter((_, i) => x.days[i] > 8);
                  return (
                    <tr key={x.eid} className="border-b border-rulesoft">
                      <td className="p-2">
                        <span className="flex flex-wrap items-center gap-1.5">{x.name}{overDays.length > 0 && <Stamp label={`OVER 8H ${overDays.join(" ")}`} tone="alert" />}</span>
                      </td>
                      <td className="p-2 text-right font-mono">{x.reg}h</td>
                      <td className={`p-2 text-right font-mono ${x.ot > 0 ? "text-work" : ""}`}>{x.ot}h</td>
                      <td className="p-2 text-right font-mono font-semibold">{x.hrs}h</td>
                      <td className="p-2 text-center">
                        {readOnly ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Stamp label={paidOn ? "PAID" : "NOT PAID"} tone={paidOn ? "ok" : "work"} />
                            {paidOn && <span className="text-[11px] text-inksoft">{shortDay(paidOn)}</span>}
                          </span>
                        ) : (
                          <button type="button" className="btn-stamp inline-flex min-h-[44px] items-center gap-1.5" onClick={() => togglePaid(x.eid)}>
                            <Stamp label={paidOn ? "PAID" : "NOT PAID"} tone={paidOn ? "ok" : "work"} />
                            {paidOn && <span className="text-[11px] text-inksoft">{shortDay(paidOn)}</span>}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                <tr><td className="p-2 font-display font-bold uppercase">Week total</td><td></td><td></td><td className="p-2 text-right font-mono text-[15px] font-bold">{totHrs}h</td>
                  <td className="p-2 text-center font-mono text-xs text-inksoft">{summ.filter((x) => openWeek.paid_map?.[x.eid]).length} of {summ.length} paid</td></tr>
              </tbody>
            </table>
          </div>
        )}
        <Toast msg={msg} />
      </div>
    );
  }

  const thisWeek = fridayOf(localISO());
  const activeCrew = emps.filter((e) => e.active !== false).length;
  return (
    <div key="weeks" className="page-enter">
      {making && <div className="busy-bar" aria-busy="true" aria-label="Working" />}
      <PageHeader title="Payroll">
        <Link className="btn btn-ghost btn-sm whitespace-nowrap" href="/payroll/certified" title="Turn certified payroll PDFs into a CSV for eComply">Certified payroll</Link>
        <Link className="btn btn-ghost btn-sm whitespace-nowrap" href="/settings#crew" title="Edit the crew in Settings">Crew list ({activeCrew}) →</Link>
      </PageHeader>

      {!readOnly && (
        <div className="card mb-3 card-pad">
          <button type="button" className="btn btn-primary w-full py-3.5 text-base" disabled={making} onClick={() => makePayroll()}>
            {making ? "Opening…" : `Make payroll · ${weekRange(thisWeek)}`}
          </button>
          <Disclosure label="Open a different week" className="mt-1.5">
            <form className="flex flex-wrap items-center gap-2 pb-1.5" onSubmit={(e) => { e.preventDefault(); if (pickDate) makePayroll(pickDate); }}>
              <label className="flex flex-wrap items-center gap-2 text-[12px] text-inksoft">
                Pick any day in the week
                <input type="date" className="field w-44 min-h-[44px]" value={pickDate} onChange={(e) => setPickDate(e.target.value)} />
              </label>
              <button type="submit" className="btn" disabled={!pickDate || making}>Open that week</button>
            </form>
          </Disclosure>
        </div>
      )}

      <div className="card divide-y divide-rulesoft">
        {!loaded && [0, 1, 2].map((i) => (
          <div key={`sk${i}`} className="flex min-h-[44px] items-center p-3"><div className="skeleton h-4 w-44" /></div>
        ))}
        {loaded && (() => {
          // two weeks on the same dates is a mistake worth flagging on both rows
          const weCounts: Record<string, number> = {};
          weeks.forEach((w) => (weCounts[w.week_ending] = (weCounts[w.week_ending] || 0) + 1));
          return weeks.map((w) => (
            <div key={w.id} className="anim-fade flex items-center gap-2 pr-2">
              <button type="button" className="row-btn min-w-0 flex-1 p-3 transition-colors duration-150" onClick={() => openW(w)}>
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[14px] font-semibold">{weekRange(w.week_ending)}</span>
                  {weCounts[w.week_ending] > 1 && <Stamp label="DUPLICATE" tone="alert" />}
                </span>
                {weCounts[w.week_ending] > 1 && <span className="mt-0.5 block text-[12px] text-inksoft">Two weeks cover these dates. Delete the one you don&apos;t need (its hours go with it).</span>}
              </button>
              {!readOnly && <RowActions items={[{ label: "Delete week…", destructive: true, onSelect: () => deleteWeek(w) }]} />}
            </div>
          ));
        })()}
        {loaded && weeks.length === 0 && (
          <div className="p-3"><div className="empty anim-fade">{readOnly ? "No payroll weeks yet." : "No payroll weeks yet. Tap Make payroll to start this week."}</div></div>
        )}
      </div>
      <Toast msg={msg} />
    </div>
  );
}
