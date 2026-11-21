"use client";
import { useEffect, useRef, useState } from "react";
import { sb } from "@/lib/supabase";
import { cleanPhone, prettyPhone, textRows, stampRows, textMachine } from "@/lib/notify";
import { prettyDate } from "@/lib/docs";
import { crewMessageFor, crewPreview, daysOfJob, normText, rowNeedsText, saveWorkerLang, siteOf, workOf, type CrewJob, type CrewRow, type Worker } from "@/lib/pactCrew";
import { spanishKnown, spanishWork } from "@/lib/spanish";
import { langOf, LANG_LABEL, withJobAsk, type Lang } from "@/lib/crewText";
import { daysAsk, jobAsk } from "@/lib/jobFlow";
import { dayPassed, goesOnItsOwn, isQueued, isLate, prettyWhen, queueRows, queuedTooLate, sendLaterOpen, TOO_LATE_WORDS, unqueueRows } from "@/lib/sendLater";
import { threadNote, threadPreview } from "@/lib/groupWords";
import LangToggle from "@/components/LangToggle";
import Stamp from "@/components/Stamp";
import Disclosure from "@/components/Disclosure";
import SendLaterPicker from "@/components/SendLaterPicker";
import { RowActions } from "@/components/ActionMenu";

// a save that didn't land, in the office's words (never the database's)
const SAVE_FAILED = "Couldn't save. Check your signal and try again.";

// "Who's going?": the crew on a PACT job. Add names from the crew list, and
// "Text crew" sends each one the address, the apartment, the day and the
// work from the company number; every row shows whether that person has been
// told. Same rows, same stamps, same guard as the NYCHA day schedule.
export default function CrewPanel({ job, rows, emps, canEdit, onChange, onClose, flash }: {
  job: CrewJob; rows: CrewRow[]; emps: Worker[]; canEdit: boolean;
  onChange: () => void | Promise<void>;      // rows changed: the parent reloads
  onClose?: () => void;
  flash: (m: string) => void;
}) {
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingNow = useRef(false); // guards a double tap on Text crew: nobody is texted twice
  // "Send it later": whether the picker is open
  const [later, setLaterOpen] = useState(false);
  const [onItsOwn, setOnItsOwn] = useState<boolean | null>(null); // does the timer send it, or the open portal?
  useEffect(() => { goesOnItsOwn().then(setOnItsOwn); }, []);
  const [phoneBuf, setPhoneBuf] = useState<Record<string, string>>({});
  const [machine, setMachine] = useState(true); // company number set up? (else a group text opens on this phone)
  const [photosIn, setPhotosIn] = useState(false); // photos texted back go on the job: the text asks for them
  const [group, setGroup] = useState(false); // crew texts go into one thread with the owner (TEXT_COPY_TO and a local number)
  useEffect(() => { textMachine().then((m) => { setMachine(m.configured); setPhotosIn(m.photosIn); setGroup(!!m.group); }); }, []);
  // the ask exactly as this job's text will carry it (before photos, then after
  // photos; the plain form stands in until the server answers)
  const [askFor, setAskFor] = useState<{ en: string; es: string } | null>(null);
  useEffect(() => {
    if (!machine || !photosIn || !job.id) return;
    fetch(`/api/text?job=${encodeURIComponent(job.id)}`).then((r) => r.json()).then((j: { ask?: { en: string; es: string } }) => { if (j.ask) setAskFor(j.ask); }).catch(() => null);
  }, [machine, photosIn, job.id]);
  const addingNow = useRef<Set<string>>(new Set()); // guards a double-tap on the same name
  const day = (job.start_date || "").trim();
  // a job of more days: its work days, Monday to Saturday (lib/workDays), and every day's two steps
  const days = daysOfJob(job);
  const lastDay = days[days.length - 1] || day;
  const span = days.length > 1 ? `${prettyDate(day)} to ${prettyDate(lastDay)} (${days.length} days)` : day ? prettyDate(day) : "";
  const askOf = (lang: Lang) => (days.length > 1 ? daysAsk(lang) : askFor ? askFor[lang] : jobAsk(lang, true));
  // the job's days are behind us: nobody is texted about them
  const passed = !!lastDay && dayPassed(lastDay);
  // the day a text set for later is about: the job's first day still ahead or
  // under way (a helper added on day 2 of 3 is texted for day 2's morning)
  const sendDay = days.find((d) => sendLaterOpen(d)) || days.find((d) => !dayPassed(d)) || day;
  // the work the crew is told: the rows' saved wording, else the PO's own
  const savedWork = rows.find((r) => (r.description || "").trim())?.description || "";
  const [work, setWork] = useState(savedWork || workOf(job));
  // the preview: open to start with (it is what the crew gets), and in the
  // language of the first worker on the job until it's switched
  const [previewOpen, setPreviewOpen] = useState(true);
  const [previewLang, setPreviewLang] = useState<Lang | null>(null);
  const shownLang: Lang = previewLang ?? langOf(emps.find((e) => rows[0] && e.id === rows[0].employee_id)?.lang);
  // the work line in Spanish, asked of Claude as soon as anyone here reads
  // Spanish (or the preview is switched to it), so the text and the preview
  // carry the real translation, not just the glossary's
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
    // the crew was told the OLD wording: a real change puts them back in the to-send pile
    const resend = rows.some((r) => r.texted);
    const { error } = await sb().from("schedule_days").update(resend ? { description: w, texted: false } : { description: w }).in("id", rows.map((r) => r.id));
    if (error) { flash(SAVE_FAILED); return; }
    if (resend) flash("Work changed. Tap Text crew again so the crew gets it");
    await onChange();
  };
  const onJob = new Set(rows.map((r) => r.employee_id));
  const need = passed ? [] : rows.filter((r) => rowNeedsText(r, job));
  const untold = rows.filter((r) => rowNeedsText(r, job));
  const waiting = rows.filter((r) => isQueued(r));
  const nextWhen = waiting.map((r) => r.send_at || "").sort()[0] || "";
  const late = waiting.length > 0 && isLate(waiting[0]);
  const tooLate = waiting.some((r) => queuedTooLate(r, sendDay));
  // set the whole crew's texts up for a time: the ones still to tell
  const setLater0 = async (t: Date) => {
    const ids = (need.length ? need : rows).map((r) => r.id);
    if (ids.length === 0) { flash("Nobody on the job yet"); return; }
    if (!day) { flash("Give the job a day first: the crew is texted the day"); return; }
    const bad = await queueRows(ids, t, sendDay);
    if (bad) { flash(bad); return; }
    setLaterOpen(false);
    flash(`${ids.length === 1 ? "The text goes" : `${ids.length} texts go`} out ${prettyWhen(t.toISOString())}`);
    await onChange();
  };
  const dropLater = async () => {
    const bad = await unqueueRows(waiting.map((r) => r.id));
    if (bad) { flash(bad); return; }
    flash("The text that was set up is called off. Nothing goes out on its own");
    await onChange();
  };
  const cq = q.trim().toLowerCase();
  const pick = emps.filter((e) => e.active !== false && !onJob.has(e.id)).filter((e) => !cq || e.name.toLowerCase().includes(cq));

  const addWorker = async (e: Worker) => {
    if (!day) { flash("Give the job a day first: the Start box above"); return; }
    if (!(job.address || job.development || "").trim()) { flash("Give the job an address first: the crew is texted where to go"); return; }
    if (addingNow.current.has(e.id) || onJob.has(e.id)) return;
    addingNow.current.add(e.id);
    setAdding(true);
    // always with the link to the job: that is what keeps the crew on a job
    // when its day moves. Before RUN_ME section 14 there is no link column, so
    // no crew is written at all rather than one that would go missing later.
    const { error } = await sb().from("schedule_days").insert({ day, employee_id: e.id, description: work.trim() || workOf(job), address: siteOf(job), pact_job_id: job.id });
    setAdding(false);
    addingNow.current.delete(e.id);
    if (error) { flash(/relation|column|schema cache/i.test(error.message) ? "A crew can't be saved until the database update is run (Settings → System check)" : SAVE_FAILED); return; }
    setQ("");
    await onChange();
  };
  // the row menu asked first when the worker was already texted
  const remove = async (r: CrewRow) => {
    const { error } = await sb().from("schedule_days").delete().eq("id", r.id);
    if (error) { flash(SAVE_FAILED); return; }
    await onChange();
  };
  // a TEXTED mark that landed without a text really going out (a group
  // message nobody sent, say) comes off here
  const clearTexted = async (r: CrewRow) => {
    const { error } = await sb().from("schedule_days").update({ texted: false }).eq("id", r.id);
    if (error) { flash(SAVE_FAILED); return; }
    await onChange();
  };
  const savePhone = async (e: Worker, raw: string) => {
    const phone = cleanPhone(raw) || raw.trim();
    if (cleanPhone(phone) === cleanPhone(e.phone || "")) return;
    const { error } = await sb().from("employees").update({ phone }).eq("id", e.id);
    if (error) flash(SAVE_FAILED); else await onChange();
  };
  // rows that need a text: a worker told a different day is told again as a move
  const send = async (only?: CrewRow) => {
    if (sendingNow.current) return;
    sendingNow.current = true;
    setSending(true);
    try {
      const targets = await Promise.all((only ? [only] : need).map(async (r) => {
        const e = emps.find((x) => x.id === r.employee_id);
        const first = (e?.name || "").split(" ")[0];
        // told one day, the job on another now: the text says it moved (the
        // day they were told is kept on the row, RUN_ME section 23)
        const told = (r.told_day || "").trim();
        const moved = told && told !== day ? { from: told, to: day } : r.texted && r.day !== day ? { from: r.day, to: day } : undefined;
        const body = await crewMessageFor(job, first, work.trim(), moved, e?.lang);
        // a job of more days asks for both piles every day (the server adds the one-day ask to the rest)
        return { rowId: r.id, to: e?.phone || "", body: photosIn && days.length > 1 ? withJobAsk(body, daysAsk(e?.lang)) : body, first, lang: e?.lang };
      }));
      if (targets.some((t) => !cleanPhone(t.to))) { flash("Someone here has no number. Add it in the box beside their name"); return; }
      // a worker told a different day carries a stale TEXTED mark until RUN_ME's
      // trigger clears it; clear it here too, so the server doesn't skip them
      const stale = (only ? [only] : need).filter((r) => r.texted).map((r) => r.id);
      if (stale.length) await stampRows(stale, false);
      const out = await textRows(targets);
      if (out.status === "fallback") {
        setTimeout(async () => {
          if (window.confirm(`Did the text${targets.length > 1 ? "s" : ""} send? OK marks ${targets.map((t) => t.first).join(", ")} TEXTED ✓`)) { await stampRows(out.rowIds); await onChange(); }
        }, 600);
        flash(out.message); return;
      }
      flash(out.message);
      await onChange();
    } finally { sendingNow.current = false; setSending(false); }
  };
  // the preview, as the first worker on the job gets it (the thread's ask, before
  // photos then after photos, goes on the end once photos texted back land on the job)
  const withAsk = (lang: Lang, t: string) => (machine && photosIn ? withJobAsk(t, askOf(lang)) : t);
  const preview = () => withAsk(shownLang, crewPreview(job, (emps.find((e) => rows[0] && e.id === rows[0].employee_id)?.name || "Name").split(" ")[0], work.trim(), undefined, shownLang));
  // …or, when the crew's texts go into one thread with the owner, that one message
  const empOf = (id: string) => emps.find((e) => e.id === id);
  const thread = group ? threadPreview(
    rows.map((r) => empOf(r.employee_id)).filter((e): e is Worker => !!e && e.active !== false && !!cleanPhone(e.phone || "")).map((e) => ({ id: e.id, first: e.name.split(" ")[0] })),
    (need.length ? need : rows).map((r) => ({ id: r.employee_id, lang: langOf(empOf(r.employee_id)?.lang) })),
    (lang) => withAsk(lang, crewPreview(job, "Name", work.trim(), undefined, lang)),
  ) : null;

  return (
    <div className="rounded-sm border border-rulesoft bg-paper p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="section-label">Who's going? {span ? `· ${span}` : "· no day yet"}</div>
        {onClose && <button type="button" className="btn-icon btn-icon-quiet" aria-label="Close" onClick={onClose}>✕</button>}
      </div>
      {!day && <div className="notice-alert mb-2">No day yet. Put the job on a day first; the crew is texted the day.</div>}
      <input className="field mb-2" placeholder="The work: what should they do there?" value={work} readOnly={!canEdit}
        onChange={(e) => setWork(e.target.value)} onBlur={() => canEdit && saveWork()} />
      {/* the preview header and its language switch sit side by side (never one inside the other) */}
      <div className="mb-2">
        <div className="flex items-center justify-between gap-2">
          <Disclosure label="What they get" open={previewOpen} onToggle={() => setPreviewOpen(!previewOpen)} className="min-w-0 flex-1">{null}</Disclosure>
          {!thread && <LangToggle value={shownLang} onChange={setPreviewLang} full name="Preview language" />}
        </div>
        {previewOpen && (
          <div className="anim-open rounded-sm border border-rulesoft bg-white px-3 py-2 whitespace-pre-line text-[12px] text-inksoft [overflow-wrap:anywhere]" data-preview-lang={shownLang}>
            {thread ? thread.parts.join("\n\n") : preview()}
            <span className="mt-1 block text-[11px]">{thread ? threadNote(thread) : "Each worker gets it in the language beside their name."}</span>
          </div>
        )}
      </div>
      {rows.map((r) => {
        const e = emps.find((x) => x.id === r.employee_id);
        const name = e?.name || "?";
        const first = name.split(" ")[0];
        const needs = rowNeedsText(r, job);
        const hasPhone = !!cleanPhone(e?.phone || "");
        const buf = phoneBuf[r.employee_id] ?? prettyPhone(e?.phone || "");
        return (
          <div key={r.id} className="anim-row flex flex-wrap items-center gap-2 border-t border-rulesoft py-1.5 first:border-t-0">
            <b className="text-[13px]">{name}</b>
            {e && <LangToggle value={langOf(e.lang)} onChange={(l) => setLang(e, l)} disabled={!canEdit} name={`Language for ${name}`} />}
            {r.texted && !needs && <Stamp label="TEXTED ✓" tone="ok" />}
            {needs && isQueued(r) && (queuedTooLate(r, sendDay)
              ? <Stamp label={`TOO LATE · ${prettyWhen(r.send_at)}`} tone="alert" />
              : <Stamp label={`${isLate(r) ? "STILL WAITING · " : "GOES OUT "}${prettyWhen(r.send_at)}`} tone={isLate(r) ? "alert" : "work"} />)}
            {r.texted && needs && !isQueued(r) && <Stamp label="NEEDS THE NEW DAY" tone="alert" />}
            {!r.texted && !isQueued(r) && <Stamp label="NOT TEXTED" tone="mute" />}
            {canEdit && (
              <span className="ml-auto flex items-center gap-1">
                {needs && hasPhone && !passed && <button type="button" className="btn-link text-inksoft" disabled={sending} onClick={() => send(r)}>Send</button>}
                {!needs && hasPhone && !passed && <button type="button" className="btn-link text-inksoft" disabled={sending} onClick={() => send(r)}>Resend</button>}
                <RowActions items={[
                  { label: "Clear TEXTED mark", hidden: !r.texted, confirm: `Clear the TEXTED mark for ${first}? Do this if the message never really went out.`, onSelect: () => void clearTexted(r) },
                  { label: "Take off this job", destructive: true, confirm: r.texted ? `${first} was already texted about this job. Take them off anyway? (You'll want to tell them.)` : undefined, onSelect: () => void remove(r) },
                ]} />
              </span>
            )}
            {!hasPhone && canEdit && (
              <input className="field basis-full px-2 py-1.5 text-[13px]" placeholder={`${first}'s phone number (saves to the crew list)`} inputMode="tel" value={buf}
                onChange={(ev) => setPhoneBuf((p) => ({ ...p, [r.employee_id]: ev.target.value }))} onBlur={() => e && savePhone(e, buf)} />
            )}
          </div>
        );
      })}
      {rows.length === 0 && <div className="empty my-1.5">No one on this job yet.</div>}
      {canEdit && (
        <>
          <input className="field mt-2" placeholder="+ Add a worker: type a name" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} disabled={!day || adding} />
          {cq && (
            <div className="popover static max-h-48 overflow-y-auto">
              {pick.slice(0, 12).map((e) => (
                // the pick lands on pointer down so the box keeps its focus; the keyboard's Enter still works (a click with no pointer)
                <button key={e.id} type="button" className="row-btn border-b border-rulesoft px-3 py-2.5 text-[13px] last:border-b-0" disabled={adding}
                  onPointerDown={(ev) => { ev.preventDefault(); void addWorker(e); }} onClick={(ev) => { if (ev.detail === 0) void addWorker(e); }}>
                  {e.name}{langOf(e.lang) === "es" ? <span className="chip ml-1.5 text-inksoft">ES</span> : null}{cleanPhone(e.phone || "") ? "" : <span className="ml-2 text-[11px] text-inksoft">no number yet</span>}
                </button>
              ))}
              {pick.length === 0 && <div className="px-3 py-2 text-[13px] text-inksoft">No one matches “{q}”.</div>}
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {/* the words stay while it sends (the kit draws the spinner over them, so the row never shifts under the finger) */}
            {need.length > 0 ? (
              <button type="button" className={`btn btn-primary${sending ? " btn-busy" : ""}`} aria-busy={sending || undefined} disabled={sending || !day} onClick={() => send()}>
                {need.length === 1 ? "📱 Text worker" : `📱 Text crew (${need.length})`}
              </button>
            ) : passed && untold.length > 0 ? <span className="text-[13px] text-inksoft">This job's days have passed. Move the job to a day ahead to text the crew.</span>
              : rows.length > 0 ? <Stamp label="CREW UP TO DATE ✓" tone="ok" /> : null}
            {machine && need.length > 0 && !later && sendLaterOpen(sendDay) && (
              <button type="button" className="btn btn-ghost" disabled={sending || !day} onClick={() => setLaterOpen(true)} data-crew-later>Send it later…</button>
            )}
          </div>
          <div className="mt-1 text-[12px] text-inksoft">{machine ? "From the company number" : "Opens a group text on this phone"} · each person once</div>
          {waiting.length > 0 && (
            <div className="anim-open mt-2 flex flex-wrap items-center gap-2 rounded-sm border border-rulesoft bg-white px-3 py-2 text-[13px]" data-crew-waiting>
              <span>{late || tooLate ? "⚠ " : "📅 "}{waiting.length === 1 ? "A text is" : `${waiting.length} texts are`} set to go out {prettyWhen(nextWhen)}.{late ? " It hasn't gone yet." : ""}{tooLate ? ` ${TOO_LATE_WORDS}.` : ""}</span>
              <span className="ml-auto flex items-center gap-1">
                {!passed && <button type="button" className="btn-link text-inksoft" disabled={sending} onClick={() => send()}>Send it now</button>}
                <button type="button" className="btn-link text-alert" onClick={dropLater}>Call it off</button>
              </span>
            </div>
          )}
          {later && <SendLaterPicker dataAttr="data-crew-picker" day={sendDay} onItsOwn={onItsOwn} onCancel={() => setLaterOpen(false)} onPick={(iso) => void setLater0(new Date(iso))} />}
        </>
      )}
    </div>
  );
}
