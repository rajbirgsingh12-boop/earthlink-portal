"use client";
import { useEffect, useRef, useState } from "react";
// styled fork of SheetJS — same API, plus cell borders/fonts for the export
import * as XLSX from "xlsx-js-style";
import { sb } from "@/lib/supabase";
import { askFileName } from "@/lib/format";
import { prettyDate, addDays, localISO } from "@/lib/docs";
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
  return localISO(d);
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
  const [rels, setRels] = useState<RelRow[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [linkContract, setLinkContract] = useState("");
  const [relQ, setRelQ] = useState<Record<string, string>>({});
  const [weekCheck, setWeekCheck] = useState<{ rel: RelRow; result: LaborResult }[]>([]);
  const [msg, setMsg] = useState("");
  const [pickDate, setPickDate] = useState(""); // calendar for opening any week
  // release-first entry: the week is organized as one card per release
  const [extraSections, setExtraSections] = useState<{ release_id: string | null; label: string }[]>([]);
  const [relPickQ, setRelPickQ] = useState(""); // the "+ Add a release" search
  const [addFor, setAddFor] = useState<string | null>(null); // section currently adding a worker
  const [addQ, setAddQ] = useState("");
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 2500); };
  const num = useNumBuffer();

  const load = async () => {
    // all employees (incl. deactivated) so past weeks still show their names
    const { data: e } = await sb().from("employees").select("*").order("name");
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
    // only classifications the user actually typed count toward the release's minimums
    const byRel = aggregateLogged((allEnts || []) as { release_id: string | null; employee_id: string; hours: number[]; trade?: string | null }[], new Map());
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
    setExtraSections([]); setRelPickQ(""); setAddFor(null); setAddQ("");
    const { data } = await sb().from("timesheet_entries").select("*").eq("week_id", w.id);
    const ents = ((data || []) as Entry[]).map((en) => ({ ...en, hours: (en.hours || []).map(Number) }));
    setEntries(ents);
    loadWeekCheck(ents);
  };
  // the one button: opens the payroll for the week containing forDate (today by
  // default), creating it first if needed — the latest week's crew comes over
  // automatically with hours reset to zero
  const makePayroll = async (forDate?: string) => {
    const we = fridayOf(forDate || localISO());
    const existing = weeks.find((w) => w.week_ending === we);
    if (existing) { openW(existing); return; }
    const { data, error } = await sb().from("timesheet_weeks").insert({ week_ending: we }).select().single();
    if (error || !data) { flash(error?.message || "Failed"); return; }
    if (weeks[0]) {
      const { data: prev } = await sb().from("timesheet_entries").select("*").eq("week_id", weeks[0].id);
      // trade rides along so per-job classifications survive the weekly copy
      if (prev?.length) await sb().from("timesheet_entries").insert(prev.map((p: Entry) => ({ week_id: data.id, employee_id: p.employee_id, job_label: p.job_label, rate: p.rate, release_id: p.release_id, trade: p.trade, hours: [0, 0, 0, 0, 0, 0, 0] })));
    }
    await load(); openW(data as Week);
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
    if (error) { flash(error.message); return; }
    if (data) setEntries((prev) => (prev.some((x) => x.id === (data as Entry).id) ? prev : [...prev, { ...(data as Entry), hours: ((data as Entry).hours || []).map(Number) }]));
  };
  // make sure everyone from the payroll template shows in the crew list
  const seedCrew = async () => {
    const { data: allEmps } = await sb().from("employees").select("id,name");
    const have = new Set(((allEmps || []) as { name: string }[]).map((e) => e.name.trim().toLowerCase()));
    const missing = TEMPLATE_CREW.filter((t) => !have.has(t.name.toLowerCase()));
    if (missing.length === 0) return;
    const { error } = await sb().from("employees").insert(missing.map((t) => ({ name: t.name, trade: t.trade, base_rate: 0 })));
    if (!error) load();
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
    if (error || !data) { flash(error?.message || "Couldn't add worker"); return; }
    const emp = data as Emp;
    setEmps((prev) => (prev.some((e) => e.id === emp.id) ? prev : [...prev, emp].sort((a, b) => a.name.localeCompare(b.name))));
    addEntry(emp.id, emp, rel);
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
  const delEntry = async (id: string) => {
    const { error } = await sb().from("timesheet_entries").delete().eq("id", id);
    if (error) { flash(error.message); return; }
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };
  const deleteWeek = async (w: Week) => {
    if (!window.confirm(`Delete the payroll week ending ${prettyDate(w.week_ending)} and ALL its hours? This can't be undone.`)) return;
    const { error: e1 } = await sb().from("timesheet_entries").delete().eq("week_id", w.id);
    if (e1) { flash(e1.message); return; }
    const { error: e2 } = await sb().from("timesheet_weeks").delete().eq("id", w.id);
    if (e2) { flash(e2.message); return; }
    // make sure it's really gone — a silently-blocked delete would leave ghost hours
    const { data: still } = await sb().from("timesheet_weeks").select("id").eq("id", w.id).limit(1);
    if (still && still.length > 0) { flash("That week wouldn't delete — check your account's role"); load(); return; }
    if (openWeek?.id === w.id) setOpenWeek(null);
    load(); flash("Week and its hours deleted");
  };

  // one PAID mark per worker per week — no more side spreadsheet
  const togglePaid = async (eid: string) => {
    if (!openWeek) return;
    const map = { ...(openWeek.paid_map || {}) };
    if (map[eid]) delete map[eid]; else map[eid] = localISO();
    // update state first so a second quick click builds on this map, not the old one
    setOpenWeek({ ...openWeek, paid_map: map });
    const { error } = await sb().from("timesheet_weeks").update({ paid_map: map }).eq("id", openWeek.id);
    if (error) { flash(/column/i.test(error.message) ? "Run supabase/upgrade_payroll_paid.sql first" : error.message); load(); }
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
        aoa.push([rel ? `Release #${rel.rel_number} — ${rel.location}` : "No release (shop, misc…)"]);
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
        const workers = Object.entries(by)
          .map(([eid, days]) => ({ eid, emp: emps.find((e) => e.id === eid), days, cat: [...(tradesBy[eid]?.values() || [])].join(" / ") }))
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
      let name = (c ? String(c.number) : "General").replace(/[\\/?*[\]:]/g, "-").slice(0, 31) || "General";
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
              // blur fires the focused field's save synchronously, then close right away
              (document.activeElement as HTMLElement | null)?.blur?.();
              setOpenWeek(null); load();
            }}>Save & close</button>
          </div>
        </div>

        {/* one card per release: pick the release, add its workers, punch their days */}
        <div className="mb-3 grid gap-2 md:grid-cols-2">
          <ContractPicker contracts={contracts} value={linkContract} onChange={setLinkContract}
            extra={[{ id: "", label: "All contracts" }]} placeholder="Filter releases by contract…" />
          <div className="relative">
            <input className="field" placeholder="+ Add a release to this week — type release # or development…"
              value={relPickQ} onChange={(e) => setRelPickQ(e.target.value)} />
            {relPickQ.trim() && (
              <div className="card absolute inset-x-0 top-full z-10 max-h-56 overflow-y-auto shadow-lg">
                {rels
                  .filter((r) => !linkContract || r.contract_id === linkContract)
                  .filter((r) => relLabel(r).toLowerCase().includes(relPickQ.trim().toLowerCase()))
                  .map((r) => (
                    <button key={r.id} className="block w-full border-b border-rulesoft p-2.5 text-left text-sm"
                      onMouseDown={(ev) => { ev.preventDefault(); setExtraSections((prev) => (prev.some((x) => x.release_id === r.id) ? prev : [...prev, { release_id: r.id, label: `#${r.rel_number} — ${r.location}` }])); setRelPickQ(""); setAddFor(r.id); setAddQ(""); }}>
                      {relLabel(r)}
                      {Number(r.labor_hours) > 0 && <span className="ml-1 font-mono text-[11px] text-inksoft">· needs {r.labor_hours}h</span>}
                    </button>
                  ))}
                <button className="block w-full p-2.5 text-left text-sm text-inksoft"
                  onMouseDown={(ev) => { ev.preventDefault(); setExtraSections((prev) => (prev.some((x) => x.release_id === null) ? prev : [...prev, { release_id: null, label: "" }])); setRelPickQ(""); setAddFor("none"); setAddQ(""); }}>
                  ＋ Hours without a release (shop, misc…)
                </button>
              </div>
            )}
          </div>
        </div>

        {(() => {
          const groups = new Map<string, { release_id: string | null; label: string }>();
          entries.forEach((en) => {
            const key = en.release_id || "none";
            if (!groups.has(key)) groups.set(key, { release_id: en.release_id || null, label: en.release_id ? en.job_label || "release" : "" });
          });
          extraSections.forEach((x) => { const key = x.release_id || "none"; if (!groups.has(key)) groups.set(key, x); });
          const allSections = [...groups.entries()].map(([key, v]) => ({ key, ...v }))
            .sort((a, b) => (a.release_id === null ? 1 : b.release_id === null ? -1 : a.label.localeCompare(b.label, undefined, { numeric: true })));
          // when a contract is picked up top, only its releases show — the rest stay saved, just hidden
          const sections = linkContract
            ? allSections.filter((s) => s.release_id !== null && rels.find((r) => r.id === s.release_id)?.contract_id === linkContract)
            : allSections;
          const hiddenCount = allSections.length - sections.length;
          if (sections.length === 0) {
            return (
              <div className="card p-5 text-sm text-inksoft">
                {hiddenCount > 0
                  ? `No hours for this contract yet — ${hiddenCount} release${hiddenCount === 1 ? "" : "s"} from other contracts ${hiddenCount === 1 ? "is" : "are"} hidden. Switch the filter back to "All contracts" to see everything.`
                  : "Pick a release above — then add its workers and type their hours for each day."}
              </div>
            );
          }
          return (<>
          {hiddenCount > 0 && (
            <div className="mb-2 text-[12px] text-inksoft">
              Showing this contract only — {hiddenCount} release{hiddenCount === 1 ? "" : "s"} from other contracts hidden.{" "}
              <button className="underline" onClick={() => setLinkContract("")}>Show all</button>
            </div>
          )}
          {sections.map((sec) => {
            const ents = entries.filter((en) => (en.release_id || "none") === sec.key);
            const rel = sec.release_id ? rels.find((r) => r.id === sec.release_id) : null;
            const check = sec.release_id ? weekCheck.find((wc) => wc.rel.id === sec.release_id) : null;
            const relInfo = rel ? { id: rel.id as string | null, label: `#${rel.rel_number} — ${rel.location}` } : { id: null as string | null, label: "" };
            const inSection = new Set(ents.map((e) => e.employee_id));
            const query = addQ.trim().toLowerCase();
            // full roster — the dropdown scrolls, so never hide anyone behind a cap
            const crewMatch = emps.filter((e) => e.active !== false).filter((e) => !query || e.name.toLowerCase().includes(query));
            const tplMatch = TEMPLATE_CREW.map((t, i) => ({ ...t, idx: i }))
              .filter((t) => !emps.some((e) => e.name.trim().toLowerCase() === t.name.toLowerCase()))
              .filter((t) => !query || t.name.toLowerCase().includes(query));
            const contract = rel ? contracts.find((x) => x.id === rel.contract_id) : null;
            return (
              <div key={sec.key} className="card mb-3 p-3.5">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <b className="font-mono text-[14px]">{rel ? `#${rel.rel_number}` : "No release"}</b>
                    {rel && <span className="ml-2 text-[14px]">{rel.location}</span>}
                    {contract && <span className="ml-1.5 text-[11px] text-inksoft">· {contractLabel(contract)}</span>}
                  </div>
                  {check && (
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-xs">{check.result.totalLogged}/{check.result.totalRequired}h</span>
                      {check.result.ok ? <Stamp label="MEETS MIN" tone="ok" /> : <Stamp label="NEEDS MORE" tone="alert" />}
                    </span>
                  )}
                </div>
                {check && check.result.rows.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {check.result.rows.map((row) => (
                      <span key={row.cls} className={`rounded-sm border px-2 py-0.5 font-mono text-[11px] ${row.logged < row.required ? "border-alert text-alert" : "border-rulesoft text-inksoft"}`}>
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
                  const empDayTot = Array.from({ length: 7 }, (_, i) =>
                    entries.filter((x) => x.employee_id === en.employee_id).reduce((s, x) => s + (Number(x.hours[i]) || 0), 0));
                  const overDays = DAYS.filter((_, i) => empDayTot[i] > 8);
                  return (
                    <div key={en.id} className="border-t border-rulesoft py-2.5 first:border-t-0">
                      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                        <b className="text-[14px]">{emp?.name || "?"}</b>
                        <div className="flex flex-wrap items-center gap-2">
                          {overDays.length > 0 && <Stamp label={`OVER 8H ${overDays.join(" ")}`} tone="alert" />}
                          <input className="field w-40 px-2 py-1.5 text-[13px]" placeholder="Classification"
                            value={en.trade ?? ""} onChange={(e) => set({ trade: e.target.value })} onBlur={() => saveEntry(en)} />
                          {clsText !== "" && reqClasses.length > 0 && (fits ? <Stamp label={`✓ ${canon}`} tone="ok" /> : <Stamp label={`no ${canon} req`} tone="work" />)}
                          <span className="font-mono text-xs text-inksoft">{hrs}h</span>
                          <button className="text-xs text-alert" title="Remove from this release" onClick={() => delEntry(en.id!)}>✕</button>
                        </div>
                      </div>
                      <div className="grid grid-cols-7 gap-1.5">
                        {DAYS.map((d, i) => (
                          <div key={d}>
                            <div className={`text-center text-[10px] uppercase tracking-wide ${empDayTot[i] > 8 ? "font-semibold text-alert" : i < 2 ? "font-semibold text-work" : "text-inksoft"}`}>{d}{i < 2 ? "·OT" : ""}</div>
                            <input className={`field px-1 py-2 text-center font-mono ${empDayTot[i] > 8 ? "bg-alert/10 ring-1 ring-alert" : i < 2 ? "bg-work/5" : ""}`} inputMode="decimal" placeholder="0"
                              {...num(`${en.id}:h${i}`, Number(en.hours[i]) || 0,
                                (n) => { const hours = [...en.hours]; hours[i] = n; set({ hours }); },
                                (n) => { const hours = [...en.hours]; hours[i] = n; saveEntry({ ...en, hours }); })} />
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {ents.length === 0 && <div className="py-2 text-[13px] text-inksoft">No workers yet — add the first one below.</div>}
                {addFor === sec.key ? (
                  <div className="relative mt-2">
                    <input className="field" autoFocus placeholder="Type a worker's name…" value={addQ}
                      onChange={(e) => setAddQ(e.target.value)}
                      onBlur={() => setTimeout(() => setAddFor((cur) => (cur === sec.key ? null : cur)), 150)} />
                    <div className="card absolute inset-x-0 top-full z-10 max-h-80 overflow-y-auto shadow-lg">
                      {crewMatch.map((e) => (
                        <button key={e.id} className="flex w-full items-center justify-between border-b border-rulesoft p-2.5 text-left text-sm last:border-b-0"
                          onMouseDown={(ev) => { ev.preventDefault(); addEntry(e.id, e, relInfo); setAddQ(""); }}>
                          <span>{e.name}</span>
                          <span className="text-[11px] text-inksoft">{inSection.has(e.id) ? "+ add again" : "+ add"}</span>
                        </button>
                      ))}
                      {tplMatch.map((t) => (
                        <button key={t.name} className="flex w-full items-center justify-between border-b border-rulesoft p-2.5 text-left text-sm last:border-b-0"
                          onMouseDown={(ev) => { ev.preventDefault(); addFromTemplate(t.idx, relInfo); setAddQ(""); }}>
                          <span>{t.name}</span>
                          <span className="text-[11px] text-inksoft">+ from template</span>
                        </button>
                      ))}
                      {crewMatch.length === 0 && tplMatch.length === 0 && <div className="p-2.5 text-sm text-inksoft">No one matches “{addQ}”.</div>}
                    </div>
                  </div>
                ) : (
                  <button className="btn btn-ghost mt-2 px-3 py-1.5 text-[13px]" onClick={() => { setAddFor(sec.key); setAddQ(""); }}>+ Add worker</button>
                )}
              </div>
            );
          })}
          </>);
        })()}
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
                  <td className="p-2.5 text-center font-mono text-xs text-inksoft">{summ.filter((x) => openWeek.paid_map?.[x.eid]).length}/{summ.length}</td></tr>
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
        <button className="btn btn-ghost" onClick={() => { const n = !showCrew; setShowCrew(n); if (n) seedCrew(); }}>Crew ({emps.filter((e) => e.active !== false).length})</button>
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
            {emps.filter((e) => e.active !== false).map((e) => (
              <div key={e.id} className="flex items-center justify-between py-2 text-sm">
                <span><b>{e.name}</b></span>
                <button className="text-xs text-alert" onClick={async () => { await sb().from("employees").update({ active: false }).eq("id", e.id); load(); }}>✕</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {(() => {
        const we = fridayOf(localISO());
        return (
          <div className="card mb-3 p-3.5">
            <button className="btn btn-primary w-full py-3.5 text-base" onClick={() => makePayroll()}>
              Make payroll · {prettyDate(addDays(we, -6))} – {prettyDate(we)}
            </button>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-widest text-inksoft">Different week? Pick any day in it</span>
              <input type="date" className="field w-44" value={pickDate} onChange={(e) => setPickDate(e.target.value)} />
              <button className="btn" disabled={!pickDate} onClick={() => makePayroll(pickDate)}>Open that week</button>
            </div>
          </div>
        );
      })()}

      <div className="card divide-y divide-rulesoft">
        {(() => { const weCounts: Record<string, number> = {}; weeks.forEach((w) => (weCounts[w.week_ending] = (weCounts[w.week_ending] || 0) + 1)); return weeks.map((w) => (
          <div key={w.id} className="flex items-center justify-between gap-3 p-3.5">
            <button className="flex-1 text-left" onClick={() => openW(w)}>
              <span className="font-mono text-[13px] font-semibold">{prettyDate(addDays(w.week_ending, -6))} – {prettyDate(w.week_ending)}</span>
              {weCounts[w.week_ending] > 1 && <span className="ml-2 rounded-[2px] border border-alert px-1 py-px font-mono text-[9px] font-semibold text-alert" title="Two payroll weeks cover the same dates — delete the one you don't need, its hours go with it">DUPLICATE</span>}
              <span className="ml-2 text-xs text-inksoft">open →</span>
            </button>
            <button className="text-xs text-alert" title="Delete this week" onClick={() => deleteWeek(w)}>✕</button>
          </div>
        )); })()}
        {weeks.length === 0 && <div className="p-5 text-sm text-inksoft">No payroll weeks yet. Add the crew, start a week, punch hours, download the weekly sheet.</div>}
      </div>
      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
