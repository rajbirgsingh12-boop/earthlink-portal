"use client";
import { useState } from "react";
import { sb } from "@/lib/supabase";
import { cleanPhone, prettyPhone, textRows, stampRows } from "@/lib/notify";
import { prettyDate } from "@/lib/docs";
import { crewMessage, normText, rowNeedsText, siteOf, workOf, type CrewJob, type CrewRow, type Worker } from "@/lib/pactCrew";
import Stamp from "@/components/Stamp";

// "Who's going?" — the crew on a PACT job. Add names from the crew list, and
// "Text crew" sends each one the address, the apartment, the day and the
// work from the company number; every row shows whether that person has been
// told. Same rows, same stamps, same guard as the NYCHA day schedule.
export default function CrewPanel({ job, rows, emps, canEdit, onChange, onClose, flash }: {
  job: CrewJob; rows: CrewRow[]; emps: Worker[]; canEdit: boolean;
  onChange: () => void | Promise<void>;      // rows changed — parent reloads
  onClose?: () => void;
  flash: (m: string) => void;
}) {
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [sending, setSending] = useState(false);
  const [phoneBuf, setPhoneBuf] = useState<Record<string, string>>({});
  const day = (job.start_date || "").trim();
  // the work the crew is told — the rows' saved wording, else the PO's own
  const savedWork = rows.find((r) => (r.description || "").trim())?.description || "";
  const [work, setWork] = useState(savedWork || workOf(job));
  const saveWork = async () => {
    const w = work.trim();
    if (rows.length === 0 || normText(w) === normText(savedWork || workOf(job))) return;
    // the crew was told the OLD wording — a real change puts them back in the to-send pile
    const resend = rows.some((r) => r.texted);
    const { error } = await sb().from("schedule_days").update(resend ? { description: w, texted: false } : { description: w }).in("id", rows.map((r) => r.id));
    if (error) { flash(error.message); return; }
    if (resend) flash("Work changed — hit Text crew again so the crew gets it");
    await onChange();
  };
  const onJob = new Set(rows.map((r) => r.employee_id));
  const need = rows.filter((r) => rowNeedsText(r, job));
  const cq = q.trim().toLowerCase();
  const pick = emps.filter((e) => e.active !== false && !onJob.has(e.id)).filter((e) => !cq || e.name.toLowerCase().includes(cq));

  const addWorker = async (e: Worker) => {
    if (!day) { flash("Give the job a day first — the start date above"); return; }
    setAdding(true);
    const base = { day, employee_id: e.id, description: work.trim() || workOf(job), address: siteOf(job) };
    let { error } = await sb().from("schedule_days").insert({ ...base, pact_job_id: job.id });
    if (error && /column|schema cache/i.test(error.message)) {
      // before RUN_ME section 14 the row has no job link — it still texts
      ({ error } = await sb().from("schedule_days").insert(base));
      if (!error) flash("Run supabase/RUN_ME.sql so the calendar remembers who's on each job");
    }
    setAdding(false);
    if (error) { flash(/relation|schema cache/i.test(error.message) ? "Run supabase/RUN_ME.sql first (day schedule)" : error.message); return; }
    setQ("");
    await onChange();
  };
  const remove = async (r: CrewRow, name: string) => {
    if (r.texted && !window.confirm(`${name.split(" ")[0]} was already texted about this job. Take them off anyway? (You'll want to tell them.)`)) return;
    const { error } = await sb().from("schedule_days").delete().eq("id", r.id);
    if (error) { flash(error.message); return; }
    await onChange();
  };
  const savePhone = async (e: Worker, raw: string) => {
    const phone = cleanPhone(raw) || raw.trim();
    if (cleanPhone(phone) === cleanPhone(e.phone || "")) return;
    const { error } = await sb().from("employees").update({ phone }).eq("id", e.id);
    if (error) flash(error.message); else await onChange();
  };
  // rows that need a text — a worker told a different day is told again as a move
  const send = async (only?: CrewRow) => {
    const targets = (only ? [only] : need).map((r) => {
      const e = emps.find((x) => x.id === r.employee_id);
      const first = (e?.name || "").split(" ")[0];
      const moved = r.texted && r.day !== day ? { from: r.day, to: day } : undefined;
      return { rowId: r.id, to: e?.phone || "", body: crewMessage(job, first, work.trim(), moved), first };
    });
    if (targets.some((t) => !cleanPhone(t.to))) { flash("Someone here has no number — add it in the box beside their name"); return; }
    setSending(true);
    // a worker told a different day carries a stale TEXTED mark until RUN_ME's
    // trigger clears it — clear it here too, so the server doesn't skip them
    const stale = (only ? [only] : need).filter((r) => r.texted).map((r) => r.id);
    if (stale.length) await stampRows(stale, false);
    const out = await textRows(targets);
    setSending(false);
    if (out.status === "fallback") {
      setTimeout(async () => {
        if (window.confirm(`Did the text${targets.length > 1 ? "s" : ""} send? OK marks ${targets.map((t) => t.first).join(", ")} TEXTED ✓`)) { await stampRows(out.rowIds); await onChange(); }
      }, 600);
      flash(out.message); return;
    }
    flash(out.message);
    await onChange();
  };

  return (
    <div className="rounded-sm border border-rulesoft bg-paper p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-widest text-inksoft">Who's going? {day ? `· ${prettyDate(day)}` : "· no day yet"}</div>
        {onClose && <button type="button" className="btn-icon border-0 text-inksoft" aria-label="Close" onClick={onClose}>✕</button>}
      </div>
      {!day && <div className="mb-2 text-[12px] text-alert">No date yet — set one on the calendar first. The crew is texted the day.</div>}
      <input className="field mb-2" placeholder="Work (what should they do there?)" value={work} readOnly={!canEdit}
        onChange={(e) => setWork(e.target.value)} onBlur={() => canEdit && saveWork()} />
      <div className="mb-2 rounded-sm border border-rulesoft bg-white px-3 py-2 text-[12px] text-inksoft [overflow-wrap:anywhere]">{crewMessage(job, "Name", work.trim())}</div>
      {rows.map((r) => {
        const e = emps.find((x) => x.id === r.employee_id);
        const name = e?.name || "?";
        const needs = rowNeedsText(r, job);
        const buf = phoneBuf[r.employee_id] ?? prettyPhone(e?.phone || "");
        return (
          <div key={r.id} className="flex flex-wrap items-center gap-2 border-t border-rulesoft py-1.5 first:border-t-0">
            <b className="text-[13px]">{name}</b>
            {r.texted && !needs && <Stamp label="TEXTED ✓" tone="ok" />}
            {r.texted && needs && <Stamp label={r.pact_job_id ? "NEEDS THE NEW DAY" : "WRONG DAY — RUN RUN_ME.SQL"} tone="alert" />}
            {!r.texted && <Stamp label="NOT TEXTED" tone="mute" />}
            {canEdit && (
              <span className="ml-auto flex items-center gap-2">
                {needs && cleanPhone(e?.phone || "") && <button type="button" className="text-[13px] text-inksoft underline" disabled={sending} onClick={() => send(r)}>send</button>}
                {!needs && cleanPhone(e?.phone || "") && <button type="button" className="text-[13px] text-inksoft underline" disabled={sending} onClick={() => send(r)}>resend</button>}
                <button type="button" className="btn-icon border-0 bg-transparent text-[15px] text-alert shadow-none" title="Take off this job" onClick={() => remove(r, name)}>✕</button>
              </span>
            )}
            {!cleanPhone(e?.phone || "") && canEdit && (
              <input className="field basis-full px-2 py-1.5 text-[13px]" placeholder={`${name.split(" ")[0]}'s phone number — saves to the crew list`} inputMode="tel" value={buf}
                onChange={(ev) => setPhoneBuf((p) => ({ ...p, [r.employee_id]: ev.target.value }))} onBlur={() => e && savePhone(e, buf)} />
            )}
          </div>
        );
      })}
      {rows.length === 0 && <div className="py-1.5 text-[13px] text-inksoft">No one sent yet.</div>}
      {canEdit && (
        <>
          <input className="field mt-2" placeholder="+ Add a worker — type a name…" value={q} onChange={(e) => setQ(e.target.value)} disabled={!day || adding} />
          {cq && (
            <div className="max-h-48 overflow-y-auto rounded-sm border border-rulesoft bg-white">
              {pick.slice(0, 12).map((e) => (
                <button key={e.id} type="button" className="block w-full border-b border-rulesoft px-3 py-2.5 text-left text-[13px] last:border-b-0 hover:bg-paper" onClick={() => addWorker(e)}>
                  {e.name}{cleanPhone(e.phone || "") ? "" : <span className="ml-2 text-[11px] text-inksoft">no number yet</span>}
                </button>
              ))}
              {pick.length === 0 && <div className="px-3 py-2 text-[13px] text-inksoft">No one matches “{q}”.</div>}
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary min-h-[44px]" disabled={sending || need.length === 0 || !day} onClick={() => send()}>
              {sending ? "Sending…" : need.length ? `📱 Text crew (${need.length})` : "Crew is up to date ✓"}
            </button>
            <span className="text-[11px] text-inksoft">from the company number · each person once</span>
          </div>
        </>
      )}
    </div>
  );
}
