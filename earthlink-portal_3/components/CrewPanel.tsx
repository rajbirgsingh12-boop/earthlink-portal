"use client";
import { useEffect, useRef, useState } from "react";
import { sb } from "@/lib/supabase";
import { cleanPhone, prettyPhone, textRows, stampRows, textMachine } from "@/lib/notify";
import { prettyDate } from "@/lib/docs";
import { crewMessageFor, crewPreview, normText, rowNeedsText, saveWorkerLang, siteOf, workOf, type CrewJob, type CrewRow, type Worker } from "@/lib/pactCrew";
import { spanishKnown, spanishWork } from "@/lib/spanish";
import { langOf, LANG_LABEL, withPhotoInvite, type Lang } from "@/lib/crewText";
import { goesOnItsOwn, isQueued, isLate, localStamp, prettyWhen, queueRows, sendPicks, unqueueRows } from "@/lib/sendLater";
import LangToggle from "@/components/LangToggle";
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
  // "Send later": the picker being open, and the time typed into it
  const [later, setLaterOpen] = useState(false);
  const [when, setWhen] = useState("");
  const [onItsOwn, setOnItsOwn] = useState<boolean | null>(null); // does the timer send it, or the open portal?
  useEffect(() => { goesOnItsOwn().then(setOnItsOwn); }, []);
  const [phoneBuf, setPhoneBuf] = useState<Record<string, string>>({});
  const [machine, setMachine] = useState(true); // company number set up? (else a group text opens on this phone)
  const [photosIn, setPhotosIn] = useState(false); // photos texted back go on the job — the text asks for them
  useEffect(() => { textMachine().then((m) => { setMachine(m.configured); setPhotosIn(m.photosIn); }); }, []);
  const addingNow = useRef<Set<string>>(new Set()); // guards a double-tap on the same name
  const day = (job.start_date || "").trim();
  // the work the crew is told — the rows' saved wording, else the PO's own
  const savedWork = rows.find((r) => (r.description || "").trim())?.description || "";
  const [work, setWork] = useState(savedWork || workOf(job));
  // the preview's language: what the first worker on the job gets, until it's switched
  const [previewLang, setPreviewLang] = useState<Lang | null>(null);
  const shownLang: Lang = previewLang ?? langOf(emps.find((e) => rows[0] && e.id === rows[0].employee_id)?.lang);
  // the work line in Spanish, asked of Claude as soon as anyone here reads
  // Spanish (or the preview is switched to it), so the text — and the
  // preview — carry the real translation, not just the glossary's
  const [, bump] = useState(0);
  const wantsEs = shownLang === "es" || rows.some((r) => langOf(emps.find((e) => e.id === r.employee_id)?.lang) === "es");
  useEffect(() => {
    const w = work.trim();
    if (!wantsEs || !w || spanishKnown(w)) return;
    const t = setTimeout(() => { spanishWork(w).then(() => bump((n) => n + 1)); }, 500);
    return () => clearTimeout(t);
  }, [work, wantsEs]);
  // one tap on a row: that worker's texts, from now on, in that language
  const setLang = async (e: Worker, lang: Lang) => {
    const bad = await saveWorkerLang(sb(), e.id, lang);
    if (bad) { flash(bad); return; }
    flash(`${e.name.split(" ")[0]} gets texts in ${LANG_LABEL[lang]}`);
    await onChange();
  };
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
  const waiting = rows.filter((r) => isQueued(r));
  const nextWhen = waiting.map((r) => r.send_at || "").sort()[0] || "";
  // set the whole crew's texts up for a time — the ones still to tell
  const setLater0 = async (t: Date) => {
    const ids = (need.length ? need : rows).map((r) => r.id);
    if (ids.length === 0) { flash("Nobody on the job yet"); return; }
    if (!day) { flash("Give the job a day first — the crew is texted the day"); return; }
    const bad = await queueRows(ids, t);
    if (bad) { flash(bad); return; }
    setLaterOpen(false); setWhen("");
    flash(`${ids.length === 1 ? "The text goes" : `${ids.length} texts go`} out ${prettyWhen(t.toISOString())}`);
    await onChange();
  };
  const dropLater = async () => {
    const bad = await unqueueRows(waiting.map((r) => r.id));
    if (bad) { flash(bad); return; }
    flash("The text that was set up is called off — nothing goes out on its own");
    await onChange();
  };
  const cq = q.trim().toLowerCase();
  const pick = emps.filter((e) => e.active !== false && !onJob.has(e.id)).filter((e) => !cq || e.name.toLowerCase().includes(cq));

  const addWorker = async (e: Worker) => {
    if (!day) { flash("Give the job a day first — the start date above"); return; }
    if (!(job.address || job.development || "").trim()) { flash("Give the job an address first — the crew is texted where to go"); return; }
    if (addingNow.current.has(e.id) || onJob.has(e.id)) return;
    addingNow.current.add(e.id);
    setAdding(true);
    // always with the link to the job — that is what keeps the crew on a job
    // when its day moves. Before RUN_ME section 14 there is no link column, so
    // no crew is written at all rather than one that would go missing later.
    const { error } = await sb().from("schedule_days").insert({ day, employee_id: e.id, description: work.trim() || workOf(job), address: siteOf(job), pact_job_id: job.id });
    setAdding(false);
    addingNow.current.delete(e.id);
    if (error) { flash(/relation|column|schema cache/i.test(error.message) ? "Run supabase/RUN_ME.sql first — the Schedule needs it to keep a crew on each job" : error.message); return; }
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
    const targets = await Promise.all((only ? [only] : need).map(async (r) => {
      const e = emps.find((x) => x.id === r.employee_id);
      const first = (e?.name || "").split(" ")[0];
      const moved = r.texted && r.day !== day ? { from: r.day, to: day } : undefined;
      return { rowId: r.id, to: e?.phone || "", body: await crewMessageFor(job, first, work.trim(), moved, e?.lang), first, lang: e?.lang };
    }));
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
      {!day && <div className="mb-2 text-[12px] text-alert">No day yet — put the job on a day first. The crew is texted the day.</div>}
      <input className="field mb-2" placeholder="Work (what should they do there?)" value={work} readOnly={!canEdit}
        onChange={(e) => setWork(e.target.value)} onBlur={() => canEdit && saveWork()} />
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-widest text-inksoft">What they get</span>
        <LangToggle value={shownLang} onChange={setPreviewLang} full name="Preview language" />
      </div>
      <div className="mb-2 rounded-sm border border-rulesoft bg-white px-3 py-2 whitespace-pre-line text-[12px] text-inksoft [overflow-wrap:anywhere]" data-preview-lang={shownLang}>{(() => { const t = crewPreview(job, (emps.find((e) => rows[0] && e.id === rows[0].employee_id)?.name || "Name").split(" ")[0], work.trim(), undefined, shownLang); return machine && photosIn ? withPhotoInvite(t) : t; })()}<span className="mt-1 block text-[11px]">Each worker gets it in the language beside their name.</span></div>
      {rows.map((r) => {
        const e = emps.find((x) => x.id === r.employee_id);
        const name = e?.name || "?";
        const needs = rowNeedsText(r, job);
        const buf = phoneBuf[r.employee_id] ?? prettyPhone(e?.phone || "");
        return (
          <div key={r.id} className="flex flex-wrap items-center gap-2 border-t border-rulesoft py-1.5 first:border-t-0">
            <b className="text-[13px]">{name}</b>
            {e && <LangToggle value={langOf(e.lang)} onChange={(l) => setLang(e, l)} disabled={!canEdit} name={`Language for ${name}`} />}
            {r.texted && !needs && <Stamp label="TEXTED ✓" tone="ok" />}
            {needs && isQueued(r) && <Stamp label={`${isLate(r) ? "STILL WAITING · " : "GOES OUT "}${prettyWhen(r.send_at)}`} tone={isLate(r) ? "alert" : "work"} />}
            {r.texted && needs && !isQueued(r) && <Stamp label="NEEDS THE NEW DAY" tone="alert" />}
            {!r.texted && !isQueued(r) && <Stamp label="NOT TEXTED" tone="mute" />}
            {canEdit && (
              <span className="ml-auto flex items-center gap-2">
                {needs && cleanPhone(e?.phone || "") && <button type="button" className="inline-flex min-h-[44px] items-center text-[13px] text-inksoft underline" disabled={sending} onClick={() => send(r)}>send</button>}
                {!needs && cleanPhone(e?.phone || "") && <button type="button" className="inline-flex min-h-[44px] items-center text-[13px] text-inksoft underline" disabled={sending} onClick={() => send(r)}>resend</button>}
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
                <button key={e.id} type="button" className="block min-h-[44px] w-full border-b border-rulesoft px-3 py-2.5 text-left text-[13px] last:border-b-0 hover:bg-paper" disabled={adding} onClick={() => addWorker(e)}>
                  {e.name}{langOf(e.lang) === "es" ? <span className="chip ml-1.5 text-inksoft" title="Texted in Spanish">ES</span> : null}{cleanPhone(e.phone || "") ? "" : <span className="ml-2 text-[11px] text-inksoft">no number yet</span>}
                </button>
              ))}
              {pick.length === 0 && <div className="px-3 py-2 text-[13px] text-inksoft">No one matches “{q}”.</div>}
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary min-h-[44px]" disabled={sending || need.length === 0 || !day} onClick={() => send()}>
              {sending ? "Sending…" : need.length ? `📱 Text crew (${need.length})` : "Crew is up to date ✓"}
            </button>
            {machine && need.length > 0 && !later && (
              <button type="button" className="btn min-h-[44px]" disabled={sending || !day} onClick={() => { setLaterOpen(true); setWhen(localStamp(sendPicks()[0]?.when || new Date())); }} data-crew-later>📅 Send it later…</button>
            )}
            <span className="text-[11px] text-inksoft">{machine ? "from the company number" : "opens a group text on this phone"} · each person once</span>
          </div>
          {waiting.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-sm border border-rulesoft bg-white px-3 py-2 text-[13px]" data-crew-waiting>
              <span>{isLate(waiting[0]) ? "⚠ " : "📅 "}{waiting.length === 1 ? "A text is" : `${waiting.length} texts are`} set to go out {prettyWhen(nextWhen)}{isLate(waiting[0]) ? " — it hasn't gone yet" : ""}.</span>
              <span className="ml-auto flex items-center gap-2">
                <button type="button" className="inline-flex min-h-[44px] items-center text-[13px] text-inksoft underline" disabled={sending} onClick={() => send()}>send it now</button>
                <button type="button" className="inline-flex min-h-[44px] items-center text-[13px] text-alert underline" onClick={dropLater}>call it off</button>
              </span>
            </div>
          )}
          {later && (
            <div className="mt-2 rounded-sm border border-work bg-white p-3" data-crew-picker>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-inksoft">When should it go out?</div>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {sendPicks().map((p) => (
                  <button key={p.label} type="button" className="btn min-h-[44px] px-3 py-1.5 text-[12px] normal-case tracking-normal" onClick={() => void setLater0(p.when)}>{p.label}</button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input type="datetime-local" className="field min-h-[44px] w-auto font-mono" aria-label="When the text goes out" value={when} onChange={(e) => setWhen(e.target.value)} />
                <button type="button" className="btn btn-primary min-h-[44px]" disabled={!when} onClick={() => { const t = new Date(when); if (Number.isNaN(t.getTime())) { flash("That time doesn't look right"); return; } void setLater0(t); }}>Set it</button>
                <button type="button" className="btn btn-ghost min-h-[44px]" onClick={() => setLaterOpen(false)}>Cancel</button>
              </div>
              <div className="mt-1.5 text-[11px] text-inksoft">
                The text is written when it goes out, so if the job moves it says the new day.
                {onItsOwn === false ? " It goes out the next time somebody has the portal open — Settings → System check says how to have it go out on its own." : onItsOwn ? " It goes out on its own, whether or not anyone has the portal open." : ""}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
