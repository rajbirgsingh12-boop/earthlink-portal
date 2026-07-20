"use client";
import { useEffect, useState } from "react";
import * as XLSX from "xlsx";
import { sb } from "@/lib/supabase";
import { fmt, parseNum } from "@/lib/format";
import { prettyDate } from "@/lib/docs";
import { canonTrade, checkLabor, aggregateLogged, type LaborResult } from "@/lib/labor";
import Stamp from "@/components/Stamp";

interface Emp { id: string; name: string; trade: string; base_rate: number; active: boolean; }
interface Week { id: string; week_ending: string; }
interface Entry { id?: string; week_id: string; employee_id: string; job_label: string; rate: number; hours: number[]; release_id: string | null; }
interface RelLite { id: string; rel_number: string; location: string; }
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function summarize(entries: Entry[], emps: Emp[]) {
  const by: Record<string, { hrs: number; base: number; jobs: string[]; days: number[] }> = {};
  entries.forEach((en) => {
    const hrs = en.hours.reduce((s, d) => s + (Number(d) || 0), 0);
    if (!by[en.employee_id]) by[en.employee_id] = { hrs: 0, base: 0, jobs: [], days: [0, 0, 0, 0, 0, 0, 0] };
    by[en.employee_id].hrs += hrs;
    by[en.employee_id].base += hrs * (Number(en.rate) || 0);
    if (en.job_label) by[en.employee_id].jobs.push(en.job_label);
    en.hours.forEach((d, i) => (by[en.employee_id].days[i] += Number(d) || 0));
  });
  return Object.entries(by).map(([eid, v]) => {
    const emp = emps.find((e) => e.id === eid);
    const reg = Math.min(40, v.hrs), ot = Math.max(0, v.hrs - 40);
    const avg = v.hrs > 0 ? v.base / v.hrs : 0;
    const premium = ot * 0.5 * avg;
    return { eid, name: emp?.name || "?", trade: emp?.trade || "", jobs: [...new Set(v.jobs)].join(", "), days: v.days, hrs: v.hrs, reg, ot, avg, premium, gross: v.base + premium };
  });
}

export default function Payroll() {
  const [emps, setEmps] = useState<Emp[]>([]);
  const [weeks, setWeeks] = useState<Week[]>([]);
  const [openWeek, setOpenWeek] = useState<Week | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [showCrew, setShowCrew] = useState(false);
  const [draft, setDraft] = useState({ name: "", trade: "", base_rate: "" });
  const [newDate, setNewDate] = useState(new Date().toISOString().slice(0, 10));
  const [rels, setRels] = useState<RelLite[]>([]);
  const [relQ, setRelQ] = useState<Record<string, string>>({});
  const [check, setCheck] = useState<{ id: string; rel_number: string; location: string; payroll_done: boolean; result: LaborResult }[] | null>(null);
  const [checkOpen, setCheckOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 2500); };

  const load = async () => {
    const { data: e } = await sb().from("employees").select("*").eq("active", true).order("name");
    setEmps((e || []) as Emp[]);
    const { data: w } = await sb().from("timesheet_weeks").select("*").order("week_ending", { ascending: false });
    setWeeks((w || []) as Week[]);
    const { data: r } = await sb().from("releases").select("id,rel_number,location").eq("canceled", false);
    setRels(((r || []) as RelLite[]).sort((x, y) => (parseFloat(x.rel_number) || 0) - (parseFloat(y.rel_number) || 0)));
  };
  useEffect(() => { load(); }, []);

  const openW = async (w: Week) => {
    setOpenWeek(w);
    const { data } = await sb().from("timesheet_entries").select("*").eq("week_id", w.id);
    setEntries(((data || []) as Entry[]).map((en) => ({ ...en, hours: (en.hours || []).map(Number) })));
  };
  const createWeek = async (copyLast: boolean) => {
    const { data, error } = await sb().from("timesheet_weeks").insert({ week_ending: newDate }).select().single();
    if (error || !data) { flash(error?.message || "Failed"); return; }
    if (copyLast && weeks[0]) {
      const { data: prev } = await sb().from("timesheet_entries").select("*").eq("week_id", weeks[0].id);
      if (prev?.length) await sb().from("timesheet_entries").insert(prev.map((p: Entry) => ({ week_id: data.id, employee_id: p.employee_id, job_label: p.job_label, rate: p.rate, hours: p.hours })));
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

  // release cross-check: logged hours must meet the release's labor minimum,
  // per classification and in total — more is fine, less never is
  const loadCheck = async () => {
    setCheckOpen(true); setCheck(null);
    const { data: allRels } = await sb().from("releases")
      .select("id,rel_number,location,labor_hours,labor_breakdown,payroll_done,canceled").eq("canceled", false);
    type RelRow = { id: string; rel_number: string; location: string; labor_hours: number; labor_breakdown: { cls: string; hours: number }[] | null; payroll_done: boolean };
    const withReq = ((allRels || []) as RelRow[]).filter((r) => Number(r.labor_hours) > 0 || (r.labor_breakdown || []).length > 0);
    const { data: ents } = await sb().from("timesheet_entries").select("release_id,employee_id,hours");
    const { data: allEmps } = await sb().from("employees").select("id,trade");
    const tradeById = new Map(((allEmps || []) as { id: string; trade: string }[]).map((e) => [e.id, canonTrade(e.trade)]));
    const byRel = aggregateLogged((ents || []) as { release_id: string | null; employee_id: string; hours: number[] }[], tradeById);
    setCheck(withReq
      .map((r) => ({ id: r.id, rel_number: r.rel_number, location: r.location, payroll_done: r.payroll_done, result: checkLabor(r.labor_breakdown || [], Number(r.labor_hours) || 0, byRel[r.id] || {}) }))
      .sort((a, b) => Number(a.result.ok) - Number(b.result.ok) || (parseFloat(a.rel_number) || 0) - (parseFloat(b.rel_number) || 0)));
  };

  const summ = summarize(entries, emps);
  const totGross = summ.reduce((s, x) => s + x.gross, 0);
  const totHrs = summ.reduce((s, x) => s + x.hrs, 0);
  const byJob: Record<string, number> = {};
  entries.forEach((en) => { const h = en.hours.reduce((s, d) => s + (Number(d) || 0), 0); const j = en.job_label || "(no job)"; byJob[j] = (byJob[j] || 0) + h * (Number(en.rate) || 0); });

  const exportXlsx = () => {
    if (!openWeek) return;
    const rows: Record<string, string | number>[] = summ.map((x) => ({
      "Week Ending": openWeek.week_ending, Name: x.name, Trade: x.trade, "Job(s)": x.jobs,
      Mon: x.days[0], Tue: x.days[1], Wed: x.days[2], Thu: x.days[3], Fri: x.days[4], Sat: x.days[5], Sun: x.days[6],
      "Total Hrs": x.hrs, "Reg Hrs": x.reg, "OT Hrs": x.ot, "Avg Rate": +x.avg.toFixed(2), "OT Premium": +x.premium.toFixed(2), "Gross Pay": +x.gross.toFixed(2),
    }));
    rows.push({ "Week Ending": "", Name: "TOTAL", Trade: "", "Job(s)": "", Mon: "", Tue: "", Wed: "", Thu: "", Fri: "", Sat: "", Sun: "", "Total Hrs": totHrs, "Reg Hrs": "", "OT Hrs": "", "Avg Rate": "", "OT Premium": "", "Gross Pay": +totGross.toFixed(2) });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Payroll");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(Object.entries(byJob).map(([j, v]) => ({ Job: j, "Labor Cost": +v.toFixed(2) }))), "Labor by Job");
    XLSX.writeFile(wb, `payroll-WE-${openWeek.week_ending}.xlsx`);
  };

  if (openWeek) {
    return (
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <button className="btn btn-ghost" onClick={() => { setOpenWeek(null); load(); }}>← Weeks</button>
            <span className="font-display text-lg font-bold uppercase">W/E {prettyDate(openWeek.week_ending)}</span>
          </div>
          <button className="btn btn-primary" onClick={exportXlsx}>Export for accountant</button>
        </div>
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
                <b className="text-[15px]">{emp?.name}</b>
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
                <div className="relative mb-2">
                  <input className="field" placeholder="Job — type a release # or location to link, or free text"
                    value={relQ[en.id!] ?? en.job_label}
                    onChange={(e) => { setRelQ({ ...relQ, [en.id!]: e.target.value }); set({ job_label: e.target.value }); }}
                    onBlur={() => setTimeout(() => { saveEntry({ ...en, job_label: relQ[en.id!] ?? en.job_label }); }, 200)} />
                  {(relQ[en.id!] || "").length > 0 && (
                    <div className="card absolute inset-x-0 top-full z-10 max-h-52 overflow-y-auto shadow-lg">
                      {rels.filter((r) => `${r.rel_number} ${r.location}`.toLowerCase().includes((relQ[en.id!] || "").toLowerCase())).slice(0, 6).map((r) => (
                        <button key={r.id} className="block w-full border-b border-rulesoft p-2.5 text-left text-sm"
                          onMouseDown={() => { const label = `#${r.rel_number} — ${r.location}`; const upd = { ...en, release_id: r.id, job_label: label }; set({ release_id: r.id, job_label: label }); setRelQ({ ...relQ, [en.id!]: "" }); saveEntry(upd); }}>
                          <span className="font-mono text-[11px] text-inksoft">#{r.rel_number}</span> {r.location}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="grid grid-cols-7 gap-1.5">
                {DAYS.map((d, i) => (
                  <div key={d}>
                    <div className="text-center text-[10px] uppercase tracking-wide text-inksoft">{d}</div>
                    <input className="field px-1 py-2 text-center font-mono" inputMode="decimal" value={en.hours[i] || ""} placeholder="0"
                      onChange={(e) => { const hours = [...en.hours]; hours[i] = parseNum(e.target.value); set({ hours }); }}
                      onBlur={() => saveEntry(en)} />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {entries.length === 0 && <div className="card p-5 text-sm text-inksoft">Pick a worker above. Add the same worker twice if they split the week across jobs — overtime still calculates per person.</div>}
        {summ.length > 0 && (
          <div className="card mt-2 overflow-x-auto">
            <table className="w-full border-collapse text-sm" style={{ minWidth: 460 }}>
              <thead><tr className="border-b-[1.5px] border-ink text-left font-display text-xs uppercase tracking-widest text-inksoft">
                <th className="p-2.5">Worker</th><th className="p-2.5 text-right">Reg</th><th className="p-2.5 text-right">OT</th><th className="p-2.5 text-right">Gross</th></tr></thead>
              <tbody>
                {summ.map((x) => (
                  <tr key={x.eid} className="border-b border-rulesoft">
                    <td className="p-2.5">{x.name}</td><td className="p-2.5 text-right font-mono">{x.reg}</td>
                    <td className={`p-2.5 text-right font-mono ${x.ot > 0 ? "text-work" : ""}`}>{x.ot}</td>
                    <td className="p-2.5 text-right font-mono font-semibold">{fmt(x.gross)}</td>
                  </tr>
                ))}
                <tr><td className="p-2.5 font-display font-bold uppercase">Week total · {totHrs} hrs</td><td></td><td></td><td className="p-2.5 text-right font-mono text-[15px] font-bold">{fmt(totGross)}</td></tr>
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
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-display text-2xl font-bold uppercase">Payroll</div>
        <div className="flex gap-2">
          <button className="btn btn-ghost" onClick={() => (checkOpen ? setCheckOpen(false) : loadCheck())}>Release check</button>
          <button className="btn btn-ghost" onClick={() => setShowCrew(!showCrew)}>Crew ({emps.length})</button>
        </div>
      </div>
      {checkOpen && (
        <div className="card mb-3 p-3.5">
          <div className="mb-2 flex items-baseline justify-between">
            <div className="font-display text-base font-semibold uppercase">Payroll vs release minimums</div>
            <span className="text-[11px] text-inksoft">hours can be more than the release, never less</span>
          </div>
          {check === null && <div className="text-sm text-inksoft">Checking…</div>}
          {check !== null && check.length === 0 && <div className="text-sm text-inksoft">No releases with labor-hour requirements yet — import release PDFs and their HOUR lines land here.</div>}
          {(check || []).map((r) => (
            <div key={r.id} className="border-t border-rulesoft py-2.5 first:border-t-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span><span className="font-mono text-[13px] font-semibold">#{r.rel_number}</span><span className="ml-2 text-[13px] text-inksoft">{r.location}</span></span>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-xs">{r.result.totalLogged} / {r.result.totalRequired}h</span>
                  {r.payroll_done
                    ? <Stamp label="DONE" tone="ok" />
                    : r.result.ok ? <Stamp label="MEETS MIN" tone="ok" /> : <Stamp label={`SHORT ${Math.max(r.result.totalRequired - r.result.totalLogged, r.result.shorts.reduce((s, x) => s + (x.required - x.logged), 0))}H`} tone="alert" />}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {r.result.rows.map((row) => (
                  <span key={row.cls} className={`rounded-sm border px-2 py-0.5 font-mono text-[11px] ${row.logged < row.required ? "border-alert text-alert" : "border-rulesoft text-inksoft"}`}>
                    {row.cls} {row.logged}/{row.required}h
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {showCrew && (
        <div className="card mb-3 p-3.5">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <input className="field" placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <input className="field" placeholder="Trade" value={draft.trade} onChange={(e) => setDraft({ ...draft, trade: e.target.value })} />
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
      <div className="card mb-3 flex flex-wrap items-end gap-2 p-3.5">
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Week ending</div>
          <input className="field w-44" type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
        </div>
        <button className="btn btn-primary" onClick={() => createWeek(false)}>New week</button>
        {weeks.length > 0 && <button className="btn" onClick={() => createWeek(true)}>Start from last week</button>}
      </div>
      <div className="card divide-y divide-rulesoft">
        {weeks.map((w) => (
          <button key={w.id} className="flex w-full items-center justify-between p-3.5 text-left" onClick={() => openW(w)}>
            <span className="font-mono text-[13px] font-semibold">W/E {prettyDate(w.week_ending)}</span>
            <span className="text-xs text-inksoft">open →</span>
          </button>
        ))}
        {weeks.length === 0 && <div className="p-5 text-sm text-inksoft">No payroll weeks yet. Add the crew, start a week, punch hours, export for the accountant.</div>}
      </div>
      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
