"use client";
import { useEffect, useRef, useState } from "react";
// styled fork of SheetJS — same API, plus cell borders/fonts for the export
import * as XLSX from "xlsx-js-style";
import { sb } from "@/lib/supabase";
import { fmt, parseNum } from "@/lib/format";
import { prettyDate, addDays } from "@/lib/docs";
import { canonTrade, checkLabor, aggregateLogged, type LaborResult } from "@/lib/labor";
import Stamp from "@/components/Stamp";
import ContractPicker, { contractLabel } from "@/components/ContractPicker";
import type { Contract } from "@/lib/types";

interface Emp { id: string; name: string; trade: string; base_rate: number; active: boolean; }
interface Week { id: string; week_ending: string; paid_map?: Record<string, string> | null; }
interface Entry { id?: string; week_id: string; employee_id: string; job_label: string; rate: number; hours: number[]; release_id: string | null; }
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
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 2500); };

  const load = async () => {
    const { data: e } = await sb().from("employees").select("*").eq("active", true).order("name");
    setEmps((e || []) as Emp[]);
    const { data: w } = await sb().from("timesheet_weeks").select("*").order("week_ending", { ascending: false });
    setWeeks((w || []) as Week[]);
    const { data: r } = await sb().from("releases").select("id,rel_number,location,contract_id,labor_hours,labor_breakdown").eq("canceled", false);
    setRels(((r || []) as RelRow[]).sort((x, y) => (parseFloat(x.rel_number) || 0) - (parseFloat(y.rel_number) || 0)));
    const { data: c } = await sb().from("contracts").select("id,number,name").order("number");
    setContracts((c || []) as Contract[]);
  };
  useEffect(() => { load(); }, []);

  // live check: for each release linked this week, are the classification
  // hours at the release's minimum yet? (counts hours from ALL weeks)
  const loadWeekCheck = async (ents: Entry[]) => {
    const ids = [...new Set(ents.map((e) => e.release_id).filter(Boolean))] as string[];
    if (ids.length === 0) { setWeekCheck([]); return; }
    const { data: allEnts } = await sb().from("timesheet_entries").select("release_id,employee_id,hours").in("release_id", ids);
    const { data: allEmps } = await sb().from("employees").select("id,trade");
    const tradeById = new Map(((allEmps || []) as { id: string; trade: string }[]).map((e) => [e.id, canonTrade(e.trade)]));
    const byRel = aggregateLogged((allEnts || []) as { release_id: string | null; employee_id: string; hours: number[] }[], tradeById);
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
      if (prev?.length) await sb().from("timesheet_entries").insert(prev.map((p: Entry) => ({ week_id: data.id, employee_id: p.employee_id, job_label: p.job_label, rate: p.rate, release_id: p.release_id, hours: [0, 0, 0, 0, 0, 0, 0] })));
    }
    await load(); openW(data as Week);
  };
  const addEntry = async (empId: string) => {
    if (!openWeek) return;
    const emp = emps.find((e) => e.id === empId);
    const { data } = await sb().from("timesheet_entries").insert({ week_id: openWeek.id, employee_id: empId, rate: emp?.base_rate || 0, hours: [0, 0, 0, 0, 0, 0, 0] }).select().single();
    if (data) setEntries([...entries, { ...(data as Entry), hours: (data as Entry).hours.map(Number) }]);
  };
  const saveEntry = async (en: Entry) => {
    await sb().from("timesheet_entries").update({ job_label: en.job_label, rate: Number(en.rate) || 0, hours: en.hours.map((h) => Number(h) || 0), release_id: en.release_id || null }).eq("id", en.id!);
  };
  const delEntry = async (id: string) => { await sb().from("timesheet_entries").delete().eq("id", id); setEntries(entries.filter((e) => e.id !== id)); };

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
  const totGross = summ.reduce((s, x) => s + x.gross, 0);
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
      ents.forEach((en) => { by[en.employee_id] ||= [0, 0, 0, 0, 0, 0, 0]; en.hours.forEach((h, i) => (by[en.employee_id][i] += Number(h) || 0)); });
      const workers = Object.entries(by)
        .map(([eid, days]) => ({ emp: emps.find((e) => e.id === eid), days }))
        .sort((a, b) => (a.emp?.name || "").localeCompare(b.emp?.name || ""));
      const aoa: (string | number)[][] = [];
      aoa.push([`Earth Link General Construction`]);
      aoa.push([]);
      aoa.push(["Contract", c ? (/^\d+$/.test(c.number) ? Number(c.number) : c.number) : "(no release linked)", "", "", "Week ending", prettyDate(openWeek.week_ending)]);
      aoa.push([]);
      aoa.push(["", "", "", "Overtime", "Overtime", "", "", "", "", "", ""]);
      aoa.push(["Worker", "", "", "Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Category"]);
      workers.forEach(({ emp, days }) => aoa.push([emp?.name || "?", "", "", ...days.map((d) => d || ""), (emp?.trade || "").trim()]));
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
    XLSX.writeFile(wb, `payroll_WE_${openWeek.week_ending}.xlsx`);
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
            <button className="btn btn-primary" onClick={exportTemplate}>Weekly sheet (xlsx)</button>
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

        <select className="field mb-3" value="" onChange={(e) => e.target.value && addEntry(e.target.value)}>
          <option value="">+ Add worker to this week…</option>
          {emps.map((e) => <option key={e.id} value={e.id}>{e.name} — {e.trade}</option>)}
        </select>
        {entries.map((en) => {
          const emp = emps.find((e) => e.id === en.employee_id);
          const hrs = en.hours.reduce((s, d) => s + (Number(d) || 0), 0);
          const set = (patch: Partial<Entry>) => setEntries(entries.map((x) => (x.id === en.id ? { ...x, ...patch } : x)));
          return (
            <div key={en.id} className="card mb-2.5 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <b className="text-[15px]">{emp?.name}<span className="ml-2 text-xs font-normal text-inksoft">{emp?.trade}</span></b>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-inksoft">{hrs} hrs</span>
                  <input className="field w-20 text-right font-mono" inputMode="decimal" value={en.rate} onChange={(e) => set({ rate: parseNum(e.target.value) })} onBlur={() => saveEntry(en)} title="Rate for this job" />
                  <button className="text-xs text-alert" onClick={() => delEntry(en.id!)}>✕</button>
                </div>
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
                    <input className={`field px-1 py-2 text-center font-mono ${i < 2 ? "bg-work/5" : ""}`} inputMode="decimal" value={en.hours[i] || ""} placeholder="0"
                      onChange={(e) => { const hours = [...en.hours]; hours[i] = parseNum(e.target.value); set({ hours }); }}
                      onBlur={() => saveEntry(en)} />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {entries.length === 0 && <div className="card p-5 text-sm text-inksoft">Pick a worker above. Add the same worker twice if they split the week across releases — overtime still calculates per person.</div>}
        {summ.length > 0 && (
          <div className="card mt-2 overflow-x-auto">
            <table className="w-full border-collapse text-sm" style={{ minWidth: 460 }}>
              <thead><tr className="border-b-[1.5px] border-ink text-left font-display text-xs uppercase tracking-widest text-inksoft">
                <th className="p-2.5">Worker</th><th className="p-2.5 text-right">Reg</th><th className="p-2.5 text-right">OT (Sat/Sun)</th><th className="p-2.5 text-right">Gross</th><th className="p-2.5 text-center">Paid</th></tr></thead>
              <tbody>
                {summ.map((x) => {
                  const paidOn = openWeek.paid_map?.[x.eid];
                  return (
                    <tr key={x.eid} className="border-b border-rulesoft">
                      <td className="p-2.5">{x.name}</td><td className="p-2.5 text-right font-mono">{x.reg}</td>
                      <td className={`p-2.5 text-right font-mono ${x.ot > 0 ? "text-work" : ""}`}>{x.ot}</td>
                      <td className="p-2.5 text-right font-mono font-semibold">{fmt(x.gross)}</td>
                      <td className="p-2.5 text-center">
                        <button onClick={() => togglePaid(x.eid)} title={paidOn ? `Paid ${prettyDate(paidOn)}` : "Mark paid"}>
                          <Stamp label={paidOn ? "PAID" : "NOT PAID"} tone={paidOn ? "ok" : "work"} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                <tr><td className="p-2.5 font-display font-bold uppercase">Week total · {totHrs} hrs</td><td></td><td></td><td className="p-2.5 text-right font-mono text-[15px] font-bold">{fmt(totGross)}</td>
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
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <input className="field" placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <input className="field" placeholder="Trade (laborer, carpenter…)" value={draft.trade} onChange={(e) => setDraft({ ...draft, trade: e.target.value })} />
            <input className="field" placeholder="$/hr" inputMode="decimal" value={draft.base_rate} onChange={(e) => setDraft({ ...draft, base_rate: e.target.value })} />
            <button className="btn btn-primary" onClick={async () => {
              if (!draft.name) return;
              await sb().from("employees").insert({ name: draft.name, trade: draft.trade, base_rate: parseNum(draft.base_rate) });
              setDraft({ name: "", trade: "", base_rate: "" }); load();
            }}>Add</button>
          </div>
          <div className="mt-2 divide-y divide-rulesoft">
            {emps.map((e) => (
              <div key={e.id} className="flex items-center justify-between py-2 text-sm">
                <span><b>{e.name}</b><span className="text-inksoft"> · {e.trade || "—"}</span></span>
                <span className="flex items-center gap-3">
                  <span className="font-mono">{fmt(Number(e.base_rate))}/hr</span>
                  <button className="text-xs text-alert" onClick={async () => { await sb().from("employees").update({ active: false }).eq("id", e.id); load(); }}>✕</button>
                </span>
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
          <button key={w.id} className="flex w-full items-center justify-between p-3.5 text-left" onClick={() => openW(w)}>
            <span className="font-mono text-[13px] font-semibold">{prettyDate(addDays(w.week_ending, -6))} – {prettyDate(w.week_ending)}</span>
            <span className="text-xs text-inksoft">open →</span>
          </button>
        ))}
        {weeks.length === 0 && <div className="p-5 text-sm text-inksoft">No payroll weeks yet. Add the crew, start a week, punch hours, download the weekly sheet.</div>}
      </div>
      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
