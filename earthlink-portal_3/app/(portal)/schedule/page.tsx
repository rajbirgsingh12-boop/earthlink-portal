"use client";
// Day-by-day crew schedule: pick a date, add a release, assign workers.
// Assigning a worker with a saved number opens a prefilled text right away —
// release location and work description already written, one tap to send.
import { useEffect, useState } from "react";
import { sb } from "@/lib/supabase";
import { prettyDate, addDays, localISO } from "@/lib/docs";
import Stamp from "@/components/Stamp";
import ContractPicker, { contractLabel } from "@/components/ContractPicker";
import { useLive } from "@/lib/useLive";
import type { Contract } from "@/lib/types";
import { cleanPhone, smsHref, prettyPhone } from "@/lib/notify";

interface Emp { id: string; name: string; trade: string; active?: boolean; phone?: string | null; }
interface RelRow { id: string; rel_number: string; location: string; contract_id: string; }
interface Assign { id: string; day: string; release_id: string | null; employee_id: string; description: string; texted: boolean; }

const upgradeMsg = "Run supabase/upgrade_day_schedule.sql first";

export default function Schedule() {
  const [role, setRole] = useState("");
  const canEdit = role === "admin" || role === "office";
  const [day, setDay] = useState(localISO());
  const [emps, setEmps] = useState<Emp[]>([]);
  const [rels, setRels] = useState<RelRow[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [rows, setRows] = useState<Assign[]>([]);
  const [linkContract, setLinkContract] = useState("");
  const [relPickQ, setRelPickQ] = useState("");
  const [extraRels, setExtraRels] = useState<string[]>([]); // releases added to the day before anyone's assigned
  const [addFor, setAddFor] = useState<string | null>(null);
  const [addQ, setAddQ] = useState("");
  const [descBuf, setDescBuf] = useState<Record<string, string>>({}); // per release: work description being typed
  const [phoneBuf, setPhoneBuf] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 3000); };

  const load = async () => {
    const { data: { user } } = await sb().auth.getUser();
    if (user) {
      const { data: p } = await sb().from("profiles").select("role").eq("id", user.id).single();
      if (p) setRole((p as { role: string }).role);
    }
    const { data: e } = await sb().from("employees").select("*").order("name");
    setEmps(((e || []) as Emp[]).filter((x) => x.active !== false));
    const { data: r } = await sb().from("releases").select("id,rel_number,location,contract_id").eq("canceled", false);
    setRels(((r || []) as RelRow[]).sort((x, y) => (parseFloat(x.rel_number) || 0) - (parseFloat(y.rel_number) || 0)));
    const { data: c } = await sb().from("contracts").select("id,number,name").order("number");
    setContracts((c || []) as Contract[]);
  };
  useEffect(() => { load(); }, []);

  const loadDay = async (d: string) => {
    const { data, error } = await sb().from("schedule_days").select("*").eq("day", d).order("created_at");
    if (error) { if (/relation|column|schema cache/i.test(error.message)) flash(upgradeMsg); return; }
    setRows((data || []) as Assign[]);
  };
  useEffect(() => { setExtraRels([]); setAddFor(null); setAddQ(""); setDescBuf({}); loadDay(day); }, [day]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(["schedule_days", "employees", "releases"], () => { load(); loadDay(day); }, { skipWhileTyping: true });

  const savePhone = async (empId: string, raw: string) => {
    const phone = cleanPhone(raw) || raw.trim();
    const { error } = await sb().from("employees").update({ phone }).eq("id", empId);
    if (error) { flash(/column|schema cache/i.test(error.message) ? "Run supabase/upgrade_worker_phone.sql first" : error.message); return; }
    setEmps((prev) => prev.map((e) => (e.id === empId ? { ...e, phone } : e)));
  };

  const relLabel = (r: RelRow) => {
    const c = contracts.find((x) => x.id === r.contract_id);
    return `#${r.rel_number} — ${r.location}${c ? ` · ${contractLabel(c)}` : ""}`;
  };
  const descOf = (relId: string) =>
    descBuf[relId] ?? rows.find((x) => x.release_id === relId && (x.description || "").trim())?.description ?? "";
  const msgFor = (rel: RelRow, relId: string, who?: string) => {
    const desc = descOf(relId).trim();
    return `Earth Link:${who ? ` ${who},` : ""} you're scheduled for ${prettyDate(day)} at ${rel.location} (Release #${rel.rel_number}).${desc ? ` Work: ${desc}` : ""}`;
  };

  // assign, then text on the spot if the number's on file (the tap that assigns
  // is the same tap that opens Messages — nothing automatic happens in the background)
  const assign = async (rel: RelRow, emp: Emp) => {
    const { data, error } = await sb().from("schedule_days")
      .insert({ day, release_id: rel.id, employee_id: emp.id, description: descOf(rel.id).trim() })
      .select().single();
    if (error) { flash(/relation|column|schema cache/i.test(error.message) ? upgradeMsg : error.message); return; }
    const row = data as Assign;
    setRows((prev) => (prev.some((x) => x.id === row.id) ? prev : [...prev, row]));
    const phone = cleanPhone(emp.phone || "");
    if (phone) {
      await sb().from("schedule_days").update({ texted: true }).eq("id", row.id);
      setRows((prev) => prev.map((x) => (x.id === row.id ? { ...x, texted: true } : x)));
      window.location.href = smsHref(phone, msgFor(rel, rel.id, emp.name.split(" ")[0]));
    }
  };
  const unassign = async (id: string) => {
    const { error } = await sb().from("schedule_days").delete().eq("id", id);
    if (error) { flash(error.message); return; }
    setRows((prev) => prev.filter((x) => x.id !== id));
  };
  const markTexted = async (id: string) => {
    setRows((prev) => prev.map((x) => (x.id === id ? { ...x, texted: true } : x)));
    await sb().from("schedule_days").update({ texted: true }).eq("id", id);
  };
  const saveDesc = async (relId: string) => {
    const desc = (descBuf[relId] ?? "").trim();
    const ids = rows.filter((x) => x.release_id === relId).map((x) => x.id);
    if (ids.length === 0) return;
    setRows((prev) => prev.map((x) => (x.release_id === relId ? { ...x, description: desc } : x)));
    await sb().from("schedule_days").update({ description: desc }).in("id", ids);
  };

  // one card per release on this day (assigned rows ∪ releases just added)
  const relIds = [...new Set([...rows.map((x) => x.release_id).filter(Boolean) as string[], ...extraRels])];
  const cards = relIds
    .map((id) => rels.find((r) => r.id === id))
    .filter((r): r is RelRow => !!r)
    .filter((r) => !linkContract || r.contract_id === linkContract)
    .sort((a, b) => a.rel_number.localeCompare(b.rel_number, undefined, { numeric: true }));

  return (
    <div>
      {msg && <div className="mb-3 rounded-sm border border-work bg-work/10 p-2.5 text-sm">{msg}</div>}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="font-display text-2xl font-bold uppercase">Schedule</div>
        <div className="flex flex-wrap items-center gap-2">
          <button className={`btn ${day === localISO() ? "btn-primary" : ""}`} onClick={() => setDay(localISO())}>Today</button>
          <button className={`btn ${day === addDays(localISO(), 1) ? "btn-primary" : ""}`} onClick={() => setDay(addDays(localISO(), 1))}>Tomorrow</button>
          <input type="date" className="field w-44" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
        </div>
      </div>
      <div className="mb-1 text-[13px] text-inksoft">
        Scheduling for <b className="text-ink">{prettyDate(day)}</b> — add a release, then assign workers.
        Workers with a saved number get their text the moment you assign them (it opens ready to send).
      </div>

      {canEdit && (
        <div className="mb-3 grid gap-2 md:grid-cols-2">
          <ContractPicker contracts={contracts} value={linkContract} onChange={setLinkContract}
            extra={[{ id: "", label: "All contracts" }]} placeholder="Filter releases by contract…" />
          <div className="relative">
            <input className="field" placeholder="+ Add a release to this day — type release # or development…"
              value={relPickQ} onChange={(e) => setRelPickQ(e.target.value)} />
            {relPickQ.trim() && (
              <div className="card absolute inset-x-0 top-full z-10 max-h-72 overflow-y-auto shadow-lg">
                {rels
                  .filter((r) => !linkContract || r.contract_id === linkContract)
                  .filter((r) => relLabel(r).toLowerCase().includes(relPickQ.trim().toLowerCase()))
                  .map((r) => (
                    <button key={r.id} className="block w-full border-b border-rulesoft p-2.5 text-left text-sm last:border-b-0"
                      onMouseDown={(ev) => { ev.preventDefault(); setExtraRels((prev) => (prev.includes(r.id) ? prev : [...prev, r.id])); setRelPickQ(""); setAddFor(r.id); setAddQ(""); }}>
                      {relLabel(r)}
                    </button>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}

      {cards.length === 0 && (
        <div className="card p-5 text-sm text-inksoft">
          Nothing scheduled for {prettyDate(day)} yet{canEdit ? " — add a release above to start." : "."}
        </div>
      )}

      {cards.map((rel) => {
        const assigned = rows.filter((x) => x.release_id === rel.id);
        const inCard = new Set(assigned.map((x) => x.employee_id));
        const q = addQ.trim().toLowerCase();
        const match = emps.filter((e) => !inCard.has(e.id)).filter((e) => !q || e.name.toLowerCase().includes(q));
        const contract = contracts.find((x) => x.id === rel.contract_id);
        return (
          <div key={rel.id} className="card mb-3 p-3.5">
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <b className="font-mono text-[14px]">#{rel.rel_number}</b>
                <span className="ml-2 text-[14px]">{rel.location}</span>
                {contract && <span className="ml-1.5 text-[11px] text-inksoft">· {contractLabel(contract)}</span>}
              </div>
              <span className="font-mono text-xs text-inksoft">{assigned.length} worker{assigned.length === 1 ? "" : "s"}</span>
            </div>
            <input className="field mb-2" placeholder="Work description — goes into the text (what should they do there?)"
              value={descBuf[rel.id] ?? descOf(rel.id)} readOnly={!canEdit}
              onChange={(e) => setDescBuf((p) => ({ ...p, [rel.id]: e.target.value }))}
              onBlur={() => canEdit && saveDesc(rel.id)} />
            {assigned.map((row) => {
              const emp = emps.find((e) => e.id === row.employee_id);
              if (!emp) return null;
              const buf = phoneBuf[emp.id] ?? prettyPhone(emp.phone || "");
              const ok = !!cleanPhone(buf);
              return (
                <div key={row.id} className="flex flex-wrap items-center gap-2 border-t border-rulesoft py-2 first:border-t-0">
                  <b className="text-[14px]">{emp.name}</b>
                  {row.texted && <Stamp label="TEXTED ✓" tone="ok" />}
                  <span className="ml-auto flex flex-wrap items-center gap-2">
                    {canEdit && (
                      <input className="field w-40 px-2 py-1.5 text-[13px]" placeholder="Phone number" inputMode="tel"
                        value={buf} onChange={(ev) => setPhoneBuf((p) => ({ ...p, [emp.id]: ev.target.value }))}
                        onBlur={() => { if (cleanPhone(buf) !== cleanPhone(emp.phone || "")) savePhone(emp.id, buf); }} />
                    )}
                    {ok
                      ? <a className="btn px-3 py-1.5 text-[13px]" href={smsHref(buf, msgFor(rel, rel.id, emp.name.split(" ")[0]))}
                          onClick={() => markTexted(row.id)}>{row.texted ? "Text again 📱" : "Text 📱"}</a>
                      : <span className="text-[11px] text-inksoft">add a number to text</span>}
                    {canEdit && <button className="text-xs text-alert" title="Remove from this day" onClick={() => unassign(row.id)}>✕</button>}
                  </span>
                </div>
              );
            })}
            {assigned.length === 0 && <div className="py-1.5 text-[13px] text-inksoft">No one assigned yet.</div>}
            {canEdit && (addFor === rel.id ? (
              <div className="relative mt-2">
                <input className="field" autoFocus placeholder="Type a worker's name…" value={addQ}
                  onChange={(e) => setAddQ(e.target.value)}
                  onBlur={() => setTimeout(() => setAddFor((cur) => (cur === rel.id ? null : cur)), 150)} />
                <div className="card absolute inset-x-0 top-full z-10 max-h-80 overflow-y-auto shadow-lg">
                  {match.map((e) => (
                    <button key={e.id} className="flex w-full items-center justify-between border-b border-rulesoft p-2.5 text-left text-sm last:border-b-0"
                      onMouseDown={(ev) => { ev.preventDefault(); assign(rel, e); setAddQ(""); }}>
                      <span>{e.name}</span>
                      <span className="text-[11px] text-inksoft">{cleanPhone(e.phone || "") ? "assign + text 📱" : "assign (no number)"}</span>
                    </button>
                  ))}
                  {match.length === 0 && <div className="p-2.5 text-sm text-inksoft">No one matches “{addQ}”.</div>}
                </div>
              </div>
            ) : (
              <button className="btn btn-ghost mt-2 px-3 py-1.5 text-[13px]" onClick={() => { setAddFor(rel.id); setAddQ(""); }}>+ Assign worker</button>
            ))}
            {assigned.length > 0 && (
              <div className="mt-2 border-t border-rulesoft pt-2">
                <button className="btn btn-ghost px-3 py-1.5 text-[12px]"
                  onClick={() => { navigator.clipboard?.writeText(msgFor(rel, rel.id)); flash("Message copied — paste it into any group chat"); }}>
                  Copy message
                </button>
              </div>
            )}
          </div>
        );
      })}

      <div className="mt-1 text-[11px] text-inksoft">
        Phone numbers save to the crew list (Payroll → Crew) — enter each one once and it&apos;s one tap after that.
      </div>
    </div>
  );
}
