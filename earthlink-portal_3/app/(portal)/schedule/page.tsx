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
import { cleanPhone, smsHref, sendServerTexts, textMachineReady } from "@/lib/notify";

interface Emp { id: string; name: string; trade: string; active?: boolean; phone?: string | null; }
interface RelRow { id: string; rel_number: string; location: string; contract_id: string; address?: string | null; }
interface Assign { id: string; day: string; release_id: string | null; employee_id: string; description: string; texted: boolean; address?: string | null; }

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
  const [addrBuf, setAddrBuf] = useState<Record<string, string>>({}); // per release: address being typed
  // the mini map window: which release it's picking for, the committed search, and the box being typed
  const [mapFor, setMapFor] = useState<string | null>(null);
  const [mapQ, setMapQ] = useState("");
  const [mapInput, setMapInput] = useState("");
  const [msg, setMsg] = useState("");
  const [machine, setMachine] = useState(false); // company Twilio number configured?
  const [sending, setSending] = useState<string | null>(null); // release currently texting
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 4000); };
  useEffect(() => { textMachineReady().then(setMachine); }, []);

  const load = async () => {
    const { data: { user } } = await sb().auth.getUser();
    if (user) {
      const { data: p } = await sb().from("profiles").select("role").eq("id", user.id).single();
      if (p) setRole((p as { role: string }).role);
    }
    const { data: e } = await sb().from("employees").select("*").order("name");
    setEmps(((e || []) as Emp[]).filter((x) => x.active !== false));
    const { data: r } = await sb().from("releases").select("*").eq("canceled", false);
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

  const relLabel = (r: RelRow) => {
    const c = contracts.find((x) => x.id === r.contract_id);
    return `#${r.rel_number} — ${r.location}${c ? ` · ${contractLabel(c)}` : ""}`;
  };
  const descOf = (relId: string) =>
    descBuf[relId] ?? rows.find((x) => x.release_id === relId && (x.description || "").trim())?.description ?? "";
  // the address: what's typed now → what's saved on the day's rows → the release's own address
  const addrOf = (relId: string) =>
    addrBuf[relId] ?? rows.find((x) => x.release_id === relId && (x.address || "").trim())?.address
    ?? (rels.find((r) => r.id === relId)?.address || "");
  const mapLink = (addr: string) => `https://maps.google.com/?q=${encodeURIComponent(addr)}`;
  const msgFor = (rel: RelRow, relId: string, who?: string) => {
    const desc = descOf(relId).trim();
    const addr = addrOf(relId).trim();
    return `Earth Link:${who ? ` ${who},` : ""} you're scheduled for ${prettyDate(day)} at ${addr || rel.location} (Release #${rel.rel_number}).`
      + `${desc ? ` Work: ${desc}` : ""}${addr ? ` Map: ${mapLink(addr)}` : ""}`;
  };

  // + Add worker just adds them to the day — no message goes out until Assign & text
  const addWorker = async (rel: RelRow, emp: Emp) => {
    const base = { day, release_id: rel.id, employee_id: emp.id, description: descOf(rel.id).trim() };
    let { data, error } = await sb().from("schedule_days").insert({ ...base, address: addrOf(rel.id).trim() }).select().single();
    if (error && /column|schema cache/i.test(error.message)) {
      ({ data, error } = await sb().from("schedule_days").insert(base).select().single());
      if (data) flash("Re-run supabase/upgrade_day_schedule.sql so addresses save");
    }
    if (error) { flash(/relation|column|schema cache/i.test(error.message) ? upgradeMsg : error.message); return; }
    const row = data as Assign;
    setRows((prev) => (prev.some((x) => x.id === row.id) ? prev : [...prev, row]));
  };

  // Assign & text: one tap messages the whole crew on this release.
  // With the company number set up (Twilio keys in Vercel) the texts go out
  // silently from that number; otherwise it opens a group text on this phone.
  const textCrew = async (rel: RelRow) => {
    const assigned = rows.filter((x) => x.release_id === rel.id);
    const targets = assigned
      .map((row) => ({ row, emp: emps.find((e) => e.id === row.employee_id) }))
      .filter((t): t is { row: Assign; emp: Emp } => !!t.emp)
      .map((t) => ({ ...t, phone: cleanPhone(t.emp.phone || "") }))
      .filter((t) => t.phone);
    if (targets.length === 0) { flash("No saved numbers on this crew — add them in Payroll → Crew first"); return; }
    if (!descOf(rel.id).trim() && !window.confirm("No work description yet — send the assignments anyway?")) return;
    const markAll = async () => {
      const ids = targets.map((t) => t.row.id);
      setRows((prev) => prev.map((x) => (ids.includes(x.id) ? { ...x, texted: true } : x)));
      await sb().from("schedule_days").update({ texted: true }).in("id", ids);
    };
    setSending(rel.id);
    const res = await sendServerTexts(
      targets.map((t) => ({ to: t.phone, body: msgFor(rel, rel.id, t.emp.name.split(" ")[0]) })),
      (await sb().auth.getSession()).data.session?.access_token || null
    );
    setSending(null);
    if (res.ok) {
      await markAll();
      const fails = res.failed || [];
      flash(fails.length === 0
        ? `Sent ${res.sent} text${res.sent === 1 ? "" : "s"} from the company number ✓`
        : `Sent ${res.sent}, but ${fails.length} didn't go through — check those numbers in Payroll → Crew`);
    } else if (res.status === 501) {
      // no company number yet — group text from this phone instead
      await markAll();
      window.location.href = `sms:${targets.map((t) => t.phone).join(",")}?&body=${encodeURIComponent(msgFor(rel, rel.id))}`;
    } else {
      flash(res.error || "Couldn't send — try again");
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
  const saveAddr = async (relId: string, value?: string) => {
    const addr = (value ?? addrBuf[relId] ?? "").trim();
    if (value !== undefined) setAddrBuf((p) => ({ ...p, [relId]: addr }));
    const ids = rows.filter((x) => x.release_id === relId).map((x) => x.id);
    if (ids.length === 0) return;
    setRows((prev) => prev.map((x) => (x.release_id === relId ? { ...x, address: addr } : x)));
    const { error } = await sb().from("schedule_days").update({ address: addr }).in("id", ids);
    if (error && /column|schema cache/i.test(error.message)) flash("Re-run supabase/upgrade_day_schedule.sql so addresses save");
  };
  const openMap = (relId: string) => {
    const start = addrOf(relId).trim() || (rels.find((r) => r.id === relId)?.location || "");
    setMapFor(relId); setMapInput(start); setMapQ(start);
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
        Scheduling for <b className="text-ink">{prettyDate(day)}</b> — add a release, write the description, add workers, then <b className="text-ink">Assign &amp; text</b> messages the whole crew at once
        {machine ? " from the company number." : " (opens a group text on this phone)."}
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
            <input className="field mb-2" placeholder="Work description (what should they do there?)"
              value={descBuf[rel.id] ?? descOf(rel.id)} readOnly={!canEdit}
              onChange={(e) => setDescBuf((p) => ({ ...p, [rel.id]: e.target.value }))}
              onBlur={() => canEdit && saveDesc(rel.id)} />
            <div className="mb-2 flex gap-2">
              <input className="field flex-1" placeholder="Address — where they should show up"
                value={addrBuf[rel.id] ?? addrOf(rel.id)} readOnly={!canEdit}
                onChange={(e) => setAddrBuf((p) => ({ ...p, [rel.id]: e.target.value }))}
                onBlur={() => canEdit && saveAddr(rel.id)} />
              {canEdit && <button className="btn shrink-0 px-3" title="Find it on the map" onClick={() => openMap(rel.id)}>🗺 Map</button>}
            </div>
            {assigned.map((row) => {
              const emp = emps.find((e) => e.id === row.employee_id);
              if (!emp) return null;
              const ok = !!cleanPhone(emp.phone || "");
              return (
                <div key={row.id} className="flex flex-wrap items-center gap-2 border-t border-rulesoft py-2 first:border-t-0">
                  <b className="text-[14px]">{emp.name}</b>
                  {row.texted && <Stamp label="TEXTED ✓" tone="ok" />}
                  {!ok && <span className="text-[11px] text-inksoft">no number in the crew list</span>}
                  <span className="ml-auto flex items-center gap-2.5">
                    {ok && !machine && (
                      <a className="text-[11px] text-inksoft underline" title="Opens their text on this phone"
                        href={smsHref(emp.phone || "", msgFor(rel, rel.id, emp.name.split(" ")[0]))}
                        onClick={() => markTexted(row.id)}>resend</a>
                    )}
                    {ok && machine && canEdit && (
                      <button className="text-[11px] text-inksoft underline" title="Resend from the company number"
                        onClick={async () => {
                          const res = await sendServerTexts(
                            [{ to: cleanPhone(emp.phone || ""), body: msgFor(rel, rel.id, emp.name.split(" ")[0]) }],
                            (await sb().auth.getSession()).data.session?.access_token || null);
                          if (res.ok && (res.failed || []).length === 0) { markTexted(row.id); flash(`Texted ${emp.name.split(" ")[0]} ✓`); }
                          else flash(res.failed?.[0]?.error || res.error || "Couldn't send");
                        }}>resend</button>
                    )}
                    {canEdit && <button className="text-xs text-alert" title="Remove from this day" onClick={() => unassign(row.id)}>✕</button>}
                  </span>
                </div>
              );
            })}
            {assigned.length === 0 && <div className="py-1.5 text-[13px] text-inksoft">No one added yet — add workers, then hit Assign & text.</div>}
            {canEdit && addFor === rel.id && (
              <div className="relative mt-2">
                <input className="field" autoFocus placeholder="Type a worker's name…" value={addQ}
                  onChange={(e) => setAddQ(e.target.value)}
                  onBlur={() => setTimeout(() => setAddFor((cur) => (cur === rel.id ? null : cur)), 150)} />
                <div className="card absolute inset-x-0 top-full z-10 max-h-80 overflow-y-auto shadow-lg">
                  {match.map((e) => (
                    <button key={e.id} className="flex w-full items-center justify-between border-b border-rulesoft p-2.5 text-left text-sm last:border-b-0"
                      onMouseDown={(ev) => { ev.preventDefault(); addWorker(rel, e); setAddQ(""); }}>
                      <span>{e.name}</span>
                      <span className="text-[11px] text-inksoft">{cleanPhone(e.phone || "") ? "+ add" : "+ add (no number)"}</span>
                    </button>
                  ))}
                  {match.length === 0 && <div className="p-2.5 text-sm text-inksoft">No one matches “{addQ}”.</div>}
                </div>
              </div>
            )}
            {canEdit && addFor !== rel.id && (
              <div className="mt-2 flex flex-wrap gap-2">
                <button className="btn px-3 py-1.5 text-[13px]" onClick={() => { setAddFor(rel.id); setAddQ(""); }}>+ Add worker</button>
                {assigned.length > 0 && (
                  <button className="btn btn-primary px-3 py-1.5 text-[13px]" disabled={sending === rel.id}
                    onClick={() => textCrew(rel)}>
                    {sending === rel.id ? "Sending…" : `Assign & text ${assigned.length === 1 ? "worker" : "crew"} 📱`}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      <div className="mt-1 text-[11px] text-inksoft">
        Phone numbers live in the crew list (Payroll → Crew) — enter each one once.
        {machine
          ? " Company texting number is connected ✓"
          : " Want texts to come from a company number instead of your phone? Add the TWILIO keys in Vercel → Settings → Environment Variables."}
      </div>

      {/* mini map window: type the place, check the pin, use it — the text
          the workers get includes a tap-to-navigate Google Maps link */}
      {mapFor && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-ink/60 p-4" onClick={() => setMapFor(null)}>
          <div className="card w-full max-w-lg p-3.5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 font-display text-lg font-bold uppercase">Pick the location</div>
            <div className="mb-2 flex gap-2">
              <input className="field flex-1" autoFocus placeholder="Type the address or place…"
                value={mapInput} onChange={(e) => setMapInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") setMapQ(mapInput.trim()); }} />
              <button className="btn shrink-0" onClick={() => setMapQ(mapInput.trim())}>Search</button>
            </div>
            {mapQ ? (
              <iframe title="map" className="h-72 w-full rounded-sm border border-rulesoft"
                src={`https://www.google.com/maps?q=${encodeURIComponent(mapQ)}&output=embed`} />
            ) : (
              <div className="flex h-72 items-center justify-center rounded-sm border border-rulesoft bg-paper text-sm text-inksoft">
                Type an address above and hit Search to see it on the map.
              </div>
            )}
            <div className="mt-2.5 flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={() => setMapFor(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={!mapInput.trim()}
                onClick={() => { saveAddr(mapFor, mapInput.trim()); setMapFor(null); }}>
                Use this location
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
