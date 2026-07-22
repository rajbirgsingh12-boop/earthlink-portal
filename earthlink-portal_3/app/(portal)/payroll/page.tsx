"use client";
import { useEffect, useRef, useState } from "react";
// styled fork of SheetJS — same API, plus cell borders/fonts for the export
import * as XLSX from "xlsx-js-style";
import { sb } from "@/lib/supabase";
import { askFileName } from "@/lib/format";
import { prettyDate, addDays } from "@/lib/docs";
import { canonTrade, checkLabor, aggregateLogged, type LaborResult } from "@/lib/labor";
import Stamp from "@/components/Stamp";
import ContractPicker, { contractLabel } from "@/components/ContractPicker";
import { useLive } from "@/lib/useLive";
import type { Contract } from "@/lib/types";
import { TEMPLATE_CREW } from "@/lib/crew";
import { useNumBuffer } from "@/lib/numBuffer";

interface Emp { id: string; name: string; trade: string; base_rate: number; active: boolean; }
interface Week { id: string; week_ending: string; paid_map?: Record<string, string> | null; }
interface Entry { id?: string; week_id: string; employee_id: string; job_label: string; rate: number; hours: number[]; release_id: string | null; trade?: string | null; }
interface RelRow { id: string; rel_number: string; location: string; contract_id: string; labor_hours: number; labor_breakdown: { cls: string; hours: number }[] | null; }
// the week runs Saturday → Friday, like the paper sheet; Sat & Sun are overtime days
const DAYS = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];

// Friday that ends the week containing the given date
const fridayOf = (iso: string) => {
  const d = new Date(iso + "T00:00:00");
  const add = (5 - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + add);
  return d.toISOString().slice(0, 10);
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

export default function Payroll() {
  const [emps, setEmps] = useState<Emp[]>([]);
  const [weeks, setWeeks] = useState<Week[]>([]);
  const [openWeek, setOpenWeek] = useState<Week | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [showCrew, setShowCrew] = useState(false);
  const [draft, setDraft] = useState({ name: "", trade: "", base_rate: "" });
  const [newDate, setNewDate] = useState(fridayOf(new Date().toISOString().slice(0, 10)));
  const [rels, setRels] = useState<RelRow[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [linkContract, setLinkContract] = useState("");
  const [relQ, setRelQ] = useState<Record<string, string>>({});
  const [weekCheck, setWeekCheck] = useState<{ rel: RelRow; result: LaborResult }[]>([]);
  const [msg, setMsg] = useState("");
  // one box searches the week's workers AND adds new ones by name
  const [workerQ, setWorkerQ] = useState("");
  const [workerFocus, setWorkerFocus] = useState(false);
  // day-at-a-time entry: which day of the open week is being punched (0=Sat), or the full grid
  const [view, setView] = useState<number | "week">("week");
  const [openDetail, setOpenDetail] = useState<string | null>(null);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 2500); };
  const num = useNumBuffer();

  const load = async () => {
    const { data: e } = await sb().from("employees").select("*").eq("active", true).order("name");
    setEmps((e || []) as Emp[]);
    const { data: w } = await sb().from("timesheet_weeks").select("*").order("week_ending", { ascending: false });
    setWeeks((w || []) as Week[]);
    setOpenWeek((prev) => (prev ? { ...prev, ...(((w || []) as Week[]).find((x) => x.id === prev.id) || {}) } : prev));
    const { data: r } = await sb().from("releases").select("id,rel_number,location,contract_id,labor_hours,labor_breakdown").eq("canceled", false);
    setRels(((r || []) as RelRow[]).sort((x, y) => (parseFloat(x.rel_number) || 0) - (parseFloat(y.rel_number) || 0)));
    const { data: c } = await sb().from("contracts").select("id,number,name").order("number");
    setContracts((c || []) as Contract[]);
  };
  useEffect(() => { load(); }, []);

  // live: crew, weeks (incl. paid marks), releases and contracts stay current
  useLive(["timesheet_weeks", "employees", "releases", "contracts"], () => load(), { skipWhileTyping: true });
  // live: hours entered on another device appear in the open week
  useLive(["timesheet_entries"], async () => {
    if (!openWeek) return;
    const { data } = await sb().from("timesheet_entries").select("*").eq("week_id", openWeek.id);
    setEntries(((data || []) as Entry[]).map((en) => ({ ...en, hours: (en.hours || []).map(Number) })));
  }, { enabled: !!openWeek, skipWhileTyping: true });

  // live check: for each release linked this week, are the classification
  // hours at the release's minimum yet? (counts hours from ALL weeks)
  const loadWeekCheck = async (ents: Entry[]) => {
    const ids = [...new Set(ents.map((e) => e.release_id).filter(Boolean))] as string[];
    if (ids.length === 0) { setWeekCheck([]); return; }
    // select * so the per-entry classification comes along once the column exists
    const { data: allEnts } = await sb().from("timesheet_entries").select("*").in("release_id", ids);
    const { data: allEmps } = await sb().from("employees").select("id,trade");
    const tradeById = new Map(((allEmps || []) as { id: string; trade: string }[]).map((e) => [e.id, canonTrade(e.trade)]));
    const byRel = aggregateLogged((allEnts || []) as { release_id: string | null; employee_id: string; hours: number[]; trade?: string | null }[], tradeById);
    setWeekCheck(ids
      .map((id) => rels.find((r) => r.id === id))
      .filter((r): r is RelRow => !!r)
      .map((r) => ({ rel: r, result: checkLabor(r.labor_breakdown || [], Number(r.labor_hours) || 0, byRel[r.id] || {}) })));
  };
  useEffect(() => {
    if (!openWeek) return;
    if (checkTimer.current) clearTimeout(checkTimer.current);
    checkTimer.current = setTimeout(() => loadWeekCheck(entries), 800);
    return () => { if (checkTimer.current) clearTimeout(checkTimer.current); };
  }, [entries, openWeek]); // eslint-disable-line react-hooks/exhaustive-deps

  const openW = async (w: Week) => {
    setOpenWeek(w);
    // land on today when it falls inside this week, otherwise the full grid
    const diff = Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(addDays(w.week_ending, -6))) / 86400000);
    setView(diff >= 0 && diff <= 6 ? diff : "week");
    setOpenDetail(null);
    const { data } = await sb().from("timesheet_entries").select("*").eq("week_id", w.id);
    const ents = ((data || []) as Entry[]).map((en) => ({ ...en, hours: (en.hours || []).map(Number) }));
    setEntries(ents);
    loadWeekCheck(ents);
  };
  const createWeek = async (copyLast: boolean) => {
    const we = fridayOf(newDate);
    const { data, error } = await sb().from("timesheet_weeks").insert({ week_ending: we }).select().single();
    if (error || !data) { flash(error?.message || "Failed"); return; }
    if (copyLast && weeks[0]) {
      const { data: prev } = await sb().from("timesheet_entries").select("*").eq("week_id", weeks[0].id);
      // trade rides along so per-job classifications survive the weekly copy
      if (prev?.length) await sb().from("timesheet_entries").insert(prev.map((p: Entry) => ({ week_id: data.id, employee_id: p.employee_id, job_label: p.job_label, rate: p.rate, release_id: p.release_id, trade: p.trade, hours: [0, 0, 0, 0, 0, 0, 0] })));
    }
    await load(); openW(data as Week);
  };
  const missingTradeCol = /column|schema cache/i;
  const addEntry = async (empId: string, empObj?: Emp) => {
    if (!openWeek) return;
    const emp = empObj || emps.find((e) => e.id === empId);
    const base = { week_id: openWeek.id, employee_id: empId, rate: emp?.base_rate || 0, hours: [0, 0, 0, 0, 0, 0, 0] };
    // classification starts from the worker's default and can be rewritten per entry
    let { data, error } = await sb().from("timesheet_entries").insert({ ...base, trade: emp?.trade?.trim() || null }).select().single();
    if (error && missingTradeCol.test(error.message)) {
      ({ data, error } = await sb().from("timesheet_entries").insert(base).select().single());
      if (data) flash("Run supabase/upgrade_payroll_class.sql so classifications save");
    }
    if (error) { flash(error.message); return; }
    if (data) setEntries((prev) => (prev.some((x) => x.id === (data as Entry).id) ? prev : [...prev, { ...(data as Entry), hours: ((data as Entry).hours || []).map(Number) }]));
  };
  // picking a template name adds that worker to the crew on the spot, then to the week
  const addFromTemplate = async (idx: number) => {
    const t = TEMPLATE_CREW[idx];
    if (!t) return;
    const inCrew = emps.find((e) => e.name.trim().toLowerCase() === t.name.toLowerCase());
    if (inCrew) { addEntry(inCrew.id, inCrew); return; }
    // the worker may exist deactivated — bring them back instead of duplicating
    const { data: prior } = await sb().from("employees").select("*").ilike("name", t.name).limit(1);
    const found = (prior || [])[0] as Emp | undefined;
    if (found) {
      await sb().from("employees").update({ active: true }).eq("id", found.id);
      const emp = { ...found, active: true };
      setEmps((prev) => (prev.some((e) => e.id === emp.id) ? prev : [...prev, emp].sort((a, b) => a.name.localeCompare(b.name))));
      addEntry(emp.id, emp);
      return;
    }
    const { data, error } = await sb().from("employees").insert({ name: t.name, trade: t.trade, base_rate: 0 }).select().single();
    if (error || !data) { flash(error?.message || "Couldn't add worker"); return; }
    const emp = data as Emp;
    setEmps((prev) => (prev.some((e) => e.id === emp.id) ? prev : [...prev, emp].sort((a, b) => a.name.localeCompare(b.name))));
    addEntry(emp.id, emp);
  };
  const saveEntry = async (en: Entry) => {
    const base = { job_label: en.job_label, rate: Number(en.rate) || 0, hours: en.hours.map((h) => Number(h) || 0), release_id: en.release_id || null };
    // only send trade when the entry actually carries one — a blank saves as null
    // so it falls back to the worker's default everywhere, matching the display
    const payload = typeof en.trade === "string" ? { ...base, trade: en.trade.trim() || null } : base;
    const { error } = await sb().from("timesheet_entries").update(payload).eq("id", en.id!);
    if (!error) return;
    if ("trade" in payload && missingTradeCol.test(error.message)) {
      const { error: e2 } = await sb().from("timesheet_entries").update(base).eq("id", en.id!);
      flash(e2 ? e2.message : "Run supabase/upgrade_payroll_class.sql so classifications save");
    } else flash(error.message);
  };
  const delEntry = async (id: string) => { await sb().from("timesheet_entries").delete().eq("id", id); setEntries(entries.filter((e) => e.id !== id)); };
  const deleteWeek = async (w: Week) => {
    if (!window.confirm(`Delete the payroll week ending ${prettyDate(w.week_ending)} and all its hours? This can't be undone.`)) return;
    await sb().from("timesheet_entries").delete().eq("week_id", w.id);
    const { error } = await sb().from("timesheet_weeks").delete().eq("id", w.id);
    if (error) { flash(error.message); return; }
    if (openWeek?.id === w.id) setOpenWeek(null);
    load(); flash("Week deleted");
  };

  // one PAID mark per worker per week — no more side spreadsheet
  const togglePaid = async (eid: string) => {
    if (!openWeek) return;
    const map = { ...(openWeek.paid_map || {}) };
    if (map[eid]) delete map[eid]; else map[eid] = new Date().toISOString().slice(0, 10);
    const { error } = await sb().from("timesheet_weeks").update({ paid_map: map }).eq("id", openWeek.id);
    if (error) { flash(/column/i.test(error.message) ? "Run supabase/upgrade_payroll_paid.sql first" : error.message); return; }
    setOpenWeek({ ...openWeek, paid_map: map });
  };

  const summ = summarize(entries, emps);
  const totHrs = summ.reduce((s, x) => s + x.hrs, 0);

  // ---------- weekly sheet in the paper-template layout, one tab per contract ----------
  const exportTemplate = () => {
    if (!openWeek || entries.length === 0) { flash("No hours this week yet"); return; }
    const relById = new Map(rels.map((r) => [r.id, r]));
    const groups = new Map<string, Entry[]>();
    entries.forEach((en) => {
      const cid = en.release_id ? relById.get(en.release_id)?.contract_id || "" : "";
      if (!groups.has(cid)) groups.set(cid, []);
      groups.get(cid)!.push(en);
    });
    const wb = XLSX.utils.book_new();
    const thin = { style: "thin", color: { rgb: "000000" } };
    const box = { top: thin, bottom: thin, left: thin, right: thin };
    const shade = { patternType: "solid", fgColor: { rgb: "E8E4DA" } };
    const otShade = { patternType: "solid", fgColor: { rgb: "FBE9DC" } };
    const usedNames = new Set<string>();
    for (const [cid, ents] of groups) {
      const c = contracts.find((x) => x.id === cid);
      const by: Record<string, number[]> = {};
      const tradesBy: Record<string, Map<string, string>> = {}; // per worker: lowercased → as typed
      ents.forEach((en) => {
        by[en.employee_id] ||= [0, 0, 0, 0, 0, 0, 0];
        en.hours.forEach((h, i) => (by[en.employee_id][i] += Number(h) || 0));
        const t = (en.trade ?? "").trim() || (emps.find((e) => e.id === en.employee_id)?.trade || "").trim();
        if (t) (tradesBy[en.employee_id] ||= new Map()).set(t.toLowerCase(), t);
      });
      const workers = Object.entries(by)
        .map(([eid, days]) => ({ emp: emps.find((e) => e.id === eid), days, cat: [...(tradesBy[eid]?.values() || [])].join(" / ") }))
        .sort((a, b) => (a.emp?.name || "").localeCompare(b.emp?.name || ""));
      const aoa: (string | number)[][] = [];
      aoa.push([`Earth Link General Construction`]);
      aoa.push([]);
      aoa.push(["Contract", c ? (/^\d+$/.test(c.number) ? Number(c.number) : c.number) : "(no release linked)", "", "", "Week ending", prettyDate(openWeek.week_ending)]);
      aoa.push([]);
      aoa.push(["", "", "", "Overtime", "Overtime", "", "", "", "", "", ""]);
      aoa.push(["Worker", "", "", "Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Category"]);
      workers.forEach(({ emp, days, cat }) => aoa.push([emp?.name || "?", "", "", ...days.map((d) => d || ""), cat || (emp?.trade || "").trim()]));
      const totals = [0, 0, 0, 0, 0, 0, 0];
      workers.forEach(({ days }) => days.forEach((d, i) => (totals[i] += d)));
      aoa.push(["Total", "", "", ...totals, ""]);
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = [{ wch: 24 }, { wch: 5 }, { wch: 5 }, { wch: 11 }, { wch: 11 }, { wch: 11 }, { wch: 11 }, { wch: 12 }, { wch: 11 }, { wch: 11 }, { wch: 16 }];
      const headerRow = 5, firstData = 6, totalRow = firstData + workers.length;
      ws["!merges"] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 10 } },
        ...Array.from({ length: workers.length + 1 }, (_, i) => ({ s: { r: firstData + i, c: 0 }, e: { r: firstData + i, c: 2 } })),
      ];
      const cellAt = (row: number, col: number) => ws[XLSX.utils.encode_cell({ r: row, c: col })] || (ws[XLSX.utils.encode_cell({ r: row, c: col })] = { t: "s", v: "" });
      cellAt(0, 0).s = { font: { bold: true, sz: 14 } };
      cellAt(2, 0).s = { font: { bold: true } }; cellAt(2, 4).s = { font: { bold: true } };
      for (const col of [3, 4]) cellAt(4, col).s = { font: { bold: true, color: { rgb: "B3510F" } }, alignment: { horizontal: "center" } };
      for (let row = headerRow; row <= totalRow; row++) {
        for (let col = 0; col < 11; col++) {
          const cell = cellAt(row, col);
          const s: Record<string, unknown> = { border: box };
          if (row === headerRow || row === totalRow) s.font = { bold: true };
          if (row === headerRow) s.fill = shade;
          else if (col === 3 || col === 4) s.fill = otShade; // Sat/Sun = overtime columns
          if (col >= 3 && col <= 9) s.alignment = { horizontal: "center" };
          cell.s = s;
        }
      }
      let name = (c ? c.number : "General").slice(0, 31) || "General";
      while (usedNames.has(name)) name = `${name}_`.slice(0, 31);
      usedNames.add(name);
      XLSX.utils.book_append_sheet(wb, ws, name);
    }
    const fname = askFileName(`payroll_WE_${openWeek.week_ending}.xlsx`);
    if (!fname) return;
    XLSX.writeFile(wb, fname);
  };

  const relLabel = (r: RelRow) => {
    const c = contracts.find((x) => x.id === r.contract_id);
    return `#${r.rel_number} — ${r.location}${c ? ` · ${contractLabel(c)}` : ""}`;
  };

  if (openWeek) {
    const range = `${prettyDate(addDays(openWeek.week_ending, -6))} – ${prettyDate(openWeek.week_ending)}`;
    return (
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <button className="btn btn-ghost" onClick={() => { setOpenWeek(null); load(); }}>← Weeks</button>
            <div>
              <div className="font-display text-lg font-bold uppercase leading-tight">Week of {range}</div>
              <div className="text-[11px] text-inksoft">Sat & Sun count as overtime</div>
            </div>
          </div>
          <div className="flex gap-2">
            <button className="btn" onClick={exportTemplate}>Weekly sheet (xlsx)</button>
            <button className="btn btn-primary" onClick={() => {
              // blur whatever's focused so its pending save fires, then close
              (document.activeElement as HTMLElement | null)?.blur?.();
              setTimeout(() => { setOpenWeek(null); load(); }, 120);
            }}>Save & close</button>
          </div>
        </div>

        {weekCheck.length > 0 && (
          <div className="card mb-3 p-3.5">
            <div className="mb-1 flex items-baseline justify-between">
              <div className="font-display text-sm font-semibold uppercase">Release hours check</div>
              <span className="text-[11px] text-inksoft">all weeks counted · must reach the release minimum</span>
            </div>
            {weekCheck.map(({ rel, result }) => (
              <div key={rel.id} className="border-t border-rulesoft py-2 first:border-t-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[13px]"><span className="font-mono font-semibold">#{rel.rel_number}</span> <span className="text-inksoft">{rel.location}</span></span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-xs">{result.totalLogged} / {result.totalRequired}h</span>
                    {result.ok ? <Stamp label="MEETS MIN" tone="ok" /> : <Stamp label="NEEDS MORE" tone="alert" />}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {result.rows.map((row) => (
                    <span key={row.cls} className={`rounded-sm border px-2 py-0.5 font-mono text-[11px] ${row.logged < row.required ? "border-alert text-alert" : "border-rulesoft text-inksoft"}`}>
                      {row.cls} {row.logged}/{row.required}h{row.logged < row.required ? ` · need ${row.required - row.logged} more` : ""}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="relative mb-3">
          <input className="field" placeholder="Search or add a worker — type a name…" value={workerQ}
            onChange={(e) => setWorkerQ(e.target.value)}
            onFocus={() => setWorkerFocus(true)}
            onBlur={() => setTimeout(() => setWorkerFocus(false), 150)} />
          {workerFocus && (() => {
            const query = workerQ.trim().toLowerCase();
            const inWeek = new Set(entries.map((x) => x.employee_id));
            const crewMatch = emps.filter((e) => !query || e.name.toLowerCase().includes(query)).slice(0, 8);
            const tplMatch = TEMPLATE_CREW.map((t, i) => ({ ...t, idx: i }))
              .filter((t) => !emps.some((e) => e.name.trim().toLowerCase() === t.name.toLowerCase()))
              .filter((t) => !query || t.name.toLowerCase().includes(query)).slice(0, 8);
            return (
              <div className="card absolute inset-x-0 top-full z-10 max-h-64 overflow-y-auto shadow-lg">
                {crewMatch.map((e) => (
                  <button key={e.id} className="flex w-full items-center justify-between border-b border-rulesoft p-2.5 text-left text-sm last:border-b-0"
                    onMouseDown={() => { addEntry(e.id); setWorkerQ(""); }}>
                    <span>{e.name}</span>
                    <span className="text-[11px] text-inksoft">{inWeek.has(e.id) ? "+ add again" : "+ add to week"}</span>
                  </button>
                ))}
                {tplMatch.map((t) => (
                  <button key={t.name} className="flex w-full items-center justify-between border-b border-rulesoft p-2.5 text-left text-sm last:border-b-0"
                    onMouseDown={() => { addFromTemplate(t.idx); setWorkerQ(""); }}>
                    <span>{t.name}</span>
                    <span className="text-[11px] text-inksoft">+ from template</span>
                  </button>
                ))}
                {crewMatch.length === 0 && tplMatch.length === 0 && <div className="p-2.5 text-sm text-inksoft">No one matches “{workerQ}”.</div>}
              </div>
            );
          })()}
        </div>

        <div className="mb-3 flex flex-wrap gap-1.5">
          {DAYS.map((d, i) => (
            <button key={d} className={`btn ${view === i ? "btn-primary" : "btn-ghost"} px-2.5 py-1.5 text-[12px]`} onClick={() => setView(i)}>
              {d} {Number(addDays(openWeek.week_ending, i - 6).slice(8, 10))}
            </button>
          ))}
          <button className={`btn ${view === "week" ? "btn-primary" : "btn-ghost"} px-2.5 py-1.5 text-[12px]`} onClick={() => setView("week")}>Full week</button>
        </div>
        {entries.filter((en) => {
          const query = workerQ.trim().toLowerCase();
          return !query || (emps.find((e) => e.id === en.employee_id)?.name || "").toLowerCase().includes(query);
        }).map((en) => {
          const emp = emps.find((e) => e.id === en.employee_id);
          const hrs = en.hours.reduce((s, d) => s + (Number(d) || 0), 0);
          const set = (patch: Partial<Entry>) => setEntries(entries.map((x) => (x.id === en.id ? { ...x, ...patch } : x)));
          // classification typed here is detected live against the linked release's required
          // classes; blank falls back to the worker's default — same rule the hours check uses
          const clsText = (en.trade ?? "").trim() || (emp?.trade ?? "").trim();
          const canon = canonTrade(clsText);
          const linkedRel = en.release_id ? rels.find((r) => r.id === en.release_id) : null;
          const reqClasses = (linkedRel?.labor_breakdown || []).map((b) => canonTrade(b.cls));
          const fits = reqClasses.includes(canon);
          const dayMode = view !== "week";
          const showDetail = !dayMode || openDetail === en.id;
          return (
            <div key={en.id} className="card mb-2 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button className="min-w-0 flex-1 text-left" onClick={() => dayMode && setOpenDetail(openDetail === en.id ? null : en.id!)}>
                  <b className="text-[15px]">{emp?.name}</b>
                  <div className="truncate text-[11px] text-inksoft">
                    {en.release_id ? en.job_label : "no release linked"}{clsText ? ` · ${clsText}` : ""}{dayMode ? " · tap for details" : ""}
                  </div>
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  {dayMode && (
                    <input className={`field w-20 px-1 py-2 text-center font-mono ${(view as number) < 2 ? "bg-work/5" : ""}`} inputMode="decimal" placeholder="0"
                      {...num(`${en.id}:h${view}`, Number(en.hours[view as number]) || 0,
                        (n) => { const hours = [...en.hours]; hours[view as number] = n; set({ hours }); },
                        (n) => { const hours = [...en.hours]; hours[view as number] = n; saveEntry({ ...en, hours }); })} />
                  )}
                  <span className="font-mono text-xs text-inksoft">{hrs}h wk</span>
                  {showDetail && <button className="text-xs text-alert" onClick={() => delEntry(en.id!)}>✕</button>}
                </div>
              </div>
              {showDetail && (<div className="mt-2.5 border-t border-rulesoft pt-2.5">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <input className="field w-48" placeholder="Classification (laborer, plasterer…)"
                  value={en.trade ?? emp?.trade ?? ""}
                  onChange={(e) => set({ trade: e.target.value })}
                  onBlur={() => saveEntry(en)} />
                {clsText === "" ? (
                  <span className="text-[11px] text-inksoft">write the classification for this job</span>
                ) : reqClasses.length > 0 ? (
                  fits
                    ? <Stamp label={`✓ counts as ${canon}`} tone="ok" />
                    : <Stamp label={`no ${canon} required — total hours only`} tone="work" />
                ) : (
                  <span className="font-mono text-[11px] text-inksoft">detected: {canon}</span>
                )}
              </div>
              {en.release_id ? (
                <div className="mb-2 flex items-center gap-2 text-sm">
                  <span className="stamp border-carbon text-carbon">RELEASE</span>
                  <span className="font-mono text-[13px]">{en.job_label}</span>
                  <button className="text-xs text-alert" onClick={() => { const upd = { ...en, release_id: null }; set({ release_id: null }); saveEntry(upd); }}>unlink</button>
                </div>
              ) : (
                <div className="mb-2 grid gap-2 md:grid-cols-2">
                  <ContractPicker contracts={contracts} value={linkContract} onChange={setLinkContract}
                    extra={[{ id: "", label: "All contracts" }]} placeholder="Filter by contract…" />
                  <div className="relative">
                    <input className="field" placeholder="Type release # or development to link…"
                      value={relQ[en.id!] ?? en.job_label}
                      onChange={(e) => { setRelQ({ ...relQ, [en.id!]: e.target.value }); set({ job_label: e.target.value }); }}
                      onBlur={() => setTimeout(() => { saveEntry({ ...en, job_label: relQ[en.id!] ?? en.job_label }); }, 200)} />
                    {(relQ[en.id!] || "").length > 0 && (
                      <div className="card absolute inset-x-0 top-full z-10 max-h-52 overflow-y-auto shadow-lg">
                        {rels
                          .filter((r) => !linkContract || r.contract_id === linkContract)
                          .filter((r) => relLabel(r).toLowerCase().includes((relQ[en.id!] || "").toLowerCase()))
                          .slice(0, 6).map((r) => (
                          <button key={r.id} className="block w-full border-b border-rulesoft p-2.5 text-left text-sm"
                            onMouseDown={() => { const label = `#${r.rel_number} — ${r.location}`; const upd = { ...en, release_id: r.id, job_label: label }; set({ release_id: r.id, job_label: label }); setRelQ({ ...relQ, [en.id!]: "" }); saveEntry(upd); }}>
                            {relLabel(r)}
                            {Number(r.labor_hours) > 0 && <span className="ml-1 font-mono text-[11px] text-inksoft">· needs {r.labor_hours}h</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className="grid grid-cols-7 gap-1.5">
                {DAYS.map((d, i) => (
                  <div key={d}>
                    <div className={`text-center text-[10px] uppercase tracking-wide ${i < 2 ? "font-semibold text-work" : "text-inksoft"}`}>{d}{i < 2 ? " · OT" : ""}</div>
                    <input className={`field px-1 py-2 text-center font-mono ${i < 2 ? "bg-work/5" : ""}`} inputMode="decimal" placeholder="0"
                      {...num(`${en.id}:h${i}`, Number(en.hours[i]) || 0,
                        (n) => { const hours = [...en.hours]; hours[i] = n; set({ hours }); },
                        (n) => { const hours = [...en.hours]; hours[i] = n; saveEntry({ ...en, hours }); })} />
                  </div>
                ))}
              </div>
              </div>)}
            </div>
          );
        })}
        {entries.length === 0 && <div className="card p-5 text-sm text-inksoft">Pick a worker above. Add the same worker twice if they split the week across releases — overtime still calculates per person.</div>}
        {summ.length > 0 && (
          <div className="card mt-2 overflow-x-auto">
            <table className="w-full border-collapse text-sm" style={{ minWidth: 400 }}>
              <thead><tr className="border-b-[1.5px] border-ink text-left font-display text-xs uppercase tracking-widest text-inksoft">
                <th className="p-2.5">Worker</th><th className="p-2.5 text-right">Reg</th><th className="p-2.5 text-right">OT (Sat/Sun)</th><th className="p-2.5 text-right">Total</th><th className="p-2.5 text-center">Paid</th></tr></thead>
              <tbody>
                {summ.map((x) => {
                  const paidOn = openWeek.paid_map?.[x.eid];
                  return (
                    <tr key={x.eid} className="border-b border-rulesoft">
                      <td className="p-2.5">{x.name}</td><td className="p-2.5 text-right font-mono">{x.reg}</td>
                      <td className={`p-2.5 text-right font-mono ${x.ot > 0 ? "text-work" : ""}`}>{x.ot}</td>
                      <td className="p-2.5 text-right font-mono font-semibold">{x.hrs}h</td>
                      <td className="p-2.5 text-center">
                        <button onClick={() => togglePaid(x.eid)} title={paidOn ? `Paid ${prettyDate(paidOn)}` : "Mark paid"}>
                          <Stamp label={paidOn ? "PAID" : "NOT PAID"} tone={paidOn ? "ok" : "work"} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                <tr><td className="p-2.5 font-display font-bold uppercase">Week total</td><td></td><td></td><td className="p-2.5 text-right font-mono text-[15px] font-bold">{totHrs}h</td>
                  <td className="p-2.5 text-center font-mono text-xs text-inksoft">{Object.keys(openWeek.paid_map || {}).length}/{summ.length}</td></tr>
              </tbody>
            </table>
          </div>
        )}
        {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <div className="font-display text-2xl font-bold uppercase">Payroll</div>
        <button className="btn btn-ghost" onClick={() => setShowCrew(!showCrew)}>Crew ({emps.length})</button>
      </div>
      {showCrew && (
        <div className="card mb-3 p-3.5">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            <input className="field" placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <input className="field" placeholder="Usual classification (laborer…)" value={draft.trade} onChange={(e) => setDraft({ ...draft, trade: e.target.value })} />
            <button className="btn btn-primary" onClick={async () => {
              if (!draft.name) return;
              await sb().from("employees").insert({ name: draft.name, trade: draft.trade, base_rate: 0 });
              setDraft({ name: "", trade: "", base_rate: "" }); load();
            }}>Add</button>
          </div>
          <div className="mt-2 divide-y divide-rulesoft">
            {emps.map((e) => (
              <div key={e.id} className="flex items-center justify-between py-2 text-sm">
                <span><b>{e.name}</b></span>
                <button className="text-xs text-alert" onClick={async () => { await sb().from("employees").update({ active: false }).eq("id", e.id); load(); }}>✕</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card mb-3 p-3.5">
        <div className="mb-2 text-[11px] uppercase tracking-widest text-inksoft">Start a payroll week — weeks run Saturday to Friday</div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Any day in that week</div>
            <input className="field w-44" type="date" value={newDate} onChange={(e) => setNewDate(fridayOf(e.target.value))} />
          </div>
          <button className="btn btn-ghost" onClick={() => setNewDate(fridayOf(new Date().toISOString().slice(0, 10)))}>This week</button>
          <button className="btn btn-ghost" onClick={() => setNewDate(fridayOf(addDays(new Date().toISOString().slice(0, 10), -7)))}>Last week</button>
          <button className="btn btn-primary" onClick={() => createWeek(false)}>New week</button>
          {weeks.length > 0 && <button className="btn" onClick={() => createWeek(true)}>Copy last week&apos;s crew</button>}
        </div>
        <div className="mt-2 font-mono text-xs text-inksoft">Covers {prettyDate(addDays(newDate, -6))} – {prettyDate(newDate)}</div>
      </div>

      <div className="card divide-y divide-rulesoft">
        {weeks.map((w) => (
          <div key={w.id} className="flex items-center justify-between gap-3 p-3.5">
            <button className="flex-1 text-left" onClick={() => openW(w)}>
              <span className="font-mono text-[13px] font-semibold">{prettyDate(addDays(w.week_ending, -6))} – {prettyDate(w.week_ending)}</span>
              <span className="ml-2 text-xs text-inksoft">open →</span>
            </button>
            <button className="text-xs text-alert" title="Delete this week" onClick={() => deleteWeek(w)}>✕</button>
          </div>
        ))}
        {weeks.length === 0 && <div className="p-5 text-sm text-inksoft">No payroll weeks yet. Add the crew, start a week, punch hours, download the weekly sheet.</div>}
      </div>
      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
