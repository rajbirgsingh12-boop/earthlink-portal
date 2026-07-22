"use client";
import { useEffect, useState } from "react";
import { sb } from "@/lib/supabase";
import type { Contract, Release } from "@/lib/types";
import { useLive } from "@/lib/useLive";
import { TEMPLATE_CREW } from "@/lib/crew";
import { contractLabel } from "@/components/ContractPicker";
import Stamp from "@/components/Stamp";

interface Emp { id: string; name: string; trade: string; base_rate: number; active: boolean; }

// Who's working what: assign crew to each open release. Assignments live on
// the release itself (releases.crew), so everything stays in one place.
export default function Schedule() {
  const [rels, setRels] = useState<Release[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [emps, setEmps] = useState<Emp[]>([]);
  const [q, setQ] = useState("");
  const [pickFor, setPickFor] = useState<string | null>(null); // release id whose worker search is open
  const [pickQ, setPickQ] = useState("");
  const [msg, setMsg] = useState("");
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 2500); };

  const load = async () => {
    const { data: c } = await sb().from("contracts").select("id,number,name").order("number");
    setContracts((c || []) as Contract[]);
    const { data: e } = await sb().from("employees").select("*").eq("active", true).order("name");
    setEmps((e || []) as Emp[]);
    const all: Release[] = [];
    let from = 0;
    for (;;) {
      const { data } = await sb().from("releases").select("*").eq("canceled", false).eq("received", false).order("id").range(from, from + 999);
      if (!data || data.length === 0) break;
      all.push(...(data as Release[]));
      if (data.length < 1000) break;
      from += 1000;
    }
    all.sort((a, b) => (parseFloat(a.rel_number) || 0) - (parseFloat(b.rel_number) || 0));
    setRels(all);
  };
  useEffect(() => { load(); }, []);
  useLive(["releases", "employees", "contracts"], () => load(), { skipWhileTyping: true });

  const save = async (r: Release, patch: Partial<Release>) => {
    setRels((prev) => prev.map((x) => (x.id === r.id ? { ...x, ...patch } : x)));
    const { error } = await sb().from("releases").update(patch).eq("id", r.id);
    if (error) flash(/column|schema cache/i.test(error.message) ? "Run supabase/upgrade_schedule.sql first" : error.message);
  };
  const saveCrew = (r: Release, crew: string[]) => save(r, { crew });

  const addWorker = async (r: Release, empId: string) => {
    const crew = [...new Set([...(r.crew || []), empId])];
    setPickQ("");
    saveCrew(r, crew);
  };
  // template names can be assigned before they're ever in the crew table
  const addFromTemplate = async (r: Release, idx: number) => {
    const t = TEMPLATE_CREW[idx];
    if (!t) return;
    const { data: prior } = await sb().from("employees").select("*").ilike("name", t.name).limit(1);
    let emp = (prior || [])[0] as Emp | undefined;
    if (emp) {
      if (!emp.active) await sb().from("employees").update({ active: true }).eq("id", emp.id);
    } else {
      const { data, error } = await sb().from("employees").insert({ name: t.name, trade: t.trade, base_rate: 0 }).select().single();
      if (error || !data) { flash(error?.message || "Couldn't add worker"); return; }
      emp = data as Emp;
    }
    setEmps((prev) => (prev.some((e) => e.id === emp!.id) ? prev : [...prev, { ...emp!, active: true }].sort((a, b) => a.name.localeCompare(b.name))));
    addWorker(r, emp.id);
  };

  const nameOf = (id: string) => emps.find((e) => e.id === id)?.name || "?";
  const contractOf = (r: Release) => { const c = contracts.find((x) => x.id === r.contract_id); return c ? contractLabel(c) : ""; };

  // search matches release info AND assigned worker names
  const list = rels.filter((r) => {
    if (!q.trim()) return true;
    const crewNames = (r.crew || []).map(nameOf).join(" ");
    return `${r.rel_number} ${r.location} ${r.buildings} ${r.address || ""} ${contractOf(r)} ${crewNames}`.toLowerCase().includes(q.toLowerCase());
  });
  const assigned = list.filter((r) => (r.crew || []).length > 0);
  const unassigned = list.filter((r) => (r.crew || []).length === 0);

  const pickerMatches = (r: Release) => {
    const query = pickQ.trim().toLowerCase();
    const crewIds = new Set(r.crew || []);
    const crewMatch = emps.filter((e) => !crewIds.has(e.id) && (!query || e.name.toLowerCase().includes(query)));
    const tplMatch = TEMPLATE_CREW.map((t, i) => ({ ...t, idx: i }))
      .filter((t) => !emps.some((e) => e.name.trim().toLowerCase() === t.name.toLowerCase()))
      .filter((t) => !query || t.name.toLowerCase().includes(query));
    return { crewMatch: crewMatch.slice(0, 8), tplMatch: tplMatch.slice(0, 8) };
  };

  const card = (r: Release) => (
    <div key={r.id} className="border-t border-rulesoft p-3.5 first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="font-mono text-[13px] font-semibold">#{r.rel_number}</span>
          <span className="ml-2 text-[14px]">{r.location}</span>
          <div className="max-w-[420px] truncate text-[11px] text-inksoft">{r.buildings || r.address || ""}{contractOf(r) ? ` · ${contractOf(r)}` : ""}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button onClick={() => save(r, { date_completed: (r.date_completed || "").trim() ? "" : new Date().toISOString().slice(0, 10) })}
            title="Marks the work complete — lights the WORK stage on the Releases tab too">
            <Stamp label={(r.date_completed || "").trim() ? "COMPLETE ✓" : "MARK COMPLETE"} tone={(r.date_completed || "").trim() ? "ok" : "mute"} />
          </button>
          <button className="btn btn-ghost px-3 py-1.5 text-[13px]" onClick={() => { setPickFor(pickFor === r.id ? null : r.id); setPickQ(""); }}>
            {pickFor === r.id ? "Done" : "+ Assign worker"}
          </button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-inksoft">Start
          <input type="date" className="rounded-sm border border-rulesoft bg-white p-1.5 font-mono text-xs" value={r.start_date || ""}
            onChange={(e) => save(r, { start_date: e.target.value })} />
        </label>
        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-inksoft">Finish
          <input type="date" className="rounded-sm border border-rulesoft bg-white p-1.5 font-mono text-xs" value={r.finish_date || ""}
            onChange={(e) => save(r, { finish_date: e.target.value })} />
        </label>
      </div>
      {(r.crew || []).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(r.crew || []).map((id) => (
            <span key={id} className="flex items-center gap-1.5 rounded-sm border border-rulesoft bg-white px-2 py-1 text-[13px]">
              {nameOf(id)}
              <button className="text-alert" title="Remove from this release" onClick={() => saveCrew(r, (r.crew || []).filter((x) => x !== id))}>✕</button>
            </span>
          ))}
        </div>
      )}
      {pickFor === r.id && (() => {
        const { crewMatch, tplMatch } = pickerMatches(r);
        return (
          <div className="relative mt-2">
            <input className="field" autoFocus placeholder="Type a name…" value={pickQ} onChange={(e) => setPickQ(e.target.value)} />
            <div className="card mt-1 max-h-56 overflow-y-auto">
              {crewMatch.map((e) => (
                <button key={e.id} className="block w-full border-b border-rulesoft p-2.5 text-left text-sm last:border-b-0" onMouseDown={() => addWorker(r, e.id)}>{e.name}</button>
              ))}
              {tplMatch.map((t) => (
                <button key={t.name} className="block w-full border-b border-rulesoft p-2.5 text-left text-sm last:border-b-0" onMouseDown={() => addFromTemplate(r, t.idx)}>
                  {t.name} <span className="text-[11px] text-inksoft">· from template</span>
                </button>
              ))}
              {crewMatch.length === 0 && tplMatch.length === 0 && <div className="p-2.5 text-sm text-inksoft">No one matches “{pickQ}”.</div>}
            </div>
          </div>
        );
      })()}
    </div>
  );

  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <div className="font-display text-2xl font-bold uppercase">Schedule</div>
        <span className="text-xs text-inksoft">{assigned.length} staffed · {unassigned.length} open</span>
      </div>
      <input className="field mb-3" placeholder="Search release #, development, address, or worker name…" value={q} onChange={(e) => setQ(e.target.value)} />

      {assigned.length > 0 && (
        <>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">Staffed</div>
          <div className="card mb-4">{assigned.map(card)}</div>
        </>
      )}
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">Needs a crew</div>
      <div className="card">
        {unassigned.map(card)}
        {unassigned.length === 0 && <div className="p-5 text-sm text-inksoft">{rels.length === 0 ? "No open releases yet — import releases on the Releases tab first." : "Every open release has a crew. 👌"}</div>}
      </div>
      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
