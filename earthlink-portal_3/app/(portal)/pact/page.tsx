"use client";
import { useEffect, useRef, useState } from "react";
import { sb } from "@/lib/supabase";
import { fmt, parseNum } from "@/lib/format";
import { prettyDate } from "@/lib/docs";
import Stamp from "@/components/Stamp";

interface Job {
  id: string; partner: string; development: string; job_number: string; description: string;
  amount: number; approved: boolean; work_done: boolean; invoice_sent: string | null;
  received: boolean; paid_date: string | null; canceled: boolean;
  attachments?: { name: string; path: string }[] | null; notes: string; created_at: string;
}
const BLANK = { partner: "", development: "", job_number: "", description: "", amount: "" };

export default function Pact() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [q, setQ] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState({ ...BLANK });
  const [openId, setOpenId] = useState<string | null>(null);
  const [attachJob, setAttachJob] = useState<Job | null>(null);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 3000); };
  const upgradeHint = (m: string) => (/relation|column|schema/i.test(m) ? "Database needs the upgrade — run supabase/upgrade_pact.sql" : m);
  const today = () => new Date().toISOString().slice(0, 10);
  const isImg = (n: string) => /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(n);

  const load = async () => {
    const { data, error } = await sb().from("pact_jobs").select("*").order("created_at", { ascending: false });
    if (error) { flash(upgradeHint(error.message)); return; }
    setJobs((data || []) as Job[]);
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const addJob = async () => {
    if (!draft.partner.trim() || !draft.description.trim()) { flash("Partner and description are the minimum"); return; }
    const { error } = await sb().from("pact_jobs").insert({
      partner: draft.partner.trim(), development: draft.development.trim(), job_number: draft.job_number.trim(),
      description: draft.description.trim(), amount: parseNum(draft.amount),
    });
    if (error) { flash(upgradeHint(error.message)); return; }
    setDraft({ ...BLANK }); setAddOpen(false); load();
  };

  const patch = async (j: Job, p: Partial<Job>) => {
    setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, ...p } : x)));
    const { error } = await sb().from("pact_jobs").update(p).eq("id", j.id);
    if (error) { flash(upgradeHint(error.message)); load(); }
  };

  // ---- attachments & photos (same pattern as releases) ----
  const attachFile = async (j: Job, file: File) => {
    setBusy(true);
    const path = `pact/${j.id}/${file.name}`;
    const { error } = await sb().storage.from("docs").upload(path, file, { upsert: true });
    if (error) { setBusy(false); flash(/bucket/i.test(error.message) ? "Storage not set up — run supabase/upgrade_invoices_aging_docs.sql" : error.message); return; }
    const list = [...(j.attachments || []).filter((a) => a.path !== path), { name: file.name, path }];
    const { error: e2 } = await sb().from("pact_jobs").update({ attachments: list }).eq("id", j.id);
    if (e2) flash(e2.message);
    else {
      setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, attachments: list } : x)));
      setAttachJob((prev) => (prev && prev.id === j.id ? { ...prev, attachments: list } : prev));
    }
    setBusy(false);
  };
  const addPhotos = async (j: Job, files: File[]) => {
    for (const [i, f] of files.entries()) {
      const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "");
      const ext = (f.name.match(/\.\w+$/) || [".jpg"])[0];
      await attachFile(j, new File([f], `photo_${stamp}${files.length > 1 ? `_${i + 1}` : ""}${ext}`, { type: f.type }));
    }
  };
  const openAttachment = async (path: string) => {
    const { data, error } = await sb().storage.from("docs").createSignedUrl(path, 3600);
    if (error || !data) { flash(error?.message || "Couldn't open"); return; }
    window.open(data.signedUrl, "_blank");
  };
  const removeAttachment = async (j: Job, path: string) => {
    await sb().storage.from("docs").remove([path]);
    const list = (j.attachments || []).filter((a) => a.path !== path);
    await sb().from("pact_jobs").update({ attachments: list }).eq("id", j.id);
    setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, attachments: list } : x)));
    setAttachJob((prev) => (prev && prev.id === j.id ? { ...prev, attachments: list } : prev));
  };
  useEffect(() => {
    const imgs = (attachJob?.attachments || []).filter((a) => isImg(a.name));
    if (imgs.length === 0) { setPhotoUrls({}); return; }
    sb().storage.from("docs").createSignedUrls(imgs.map((a) => a.path), 3600).then(({ data }) => {
      const m: Record<string, string> = {};
      (data || []).forEach((d) => { if (d.signedUrl && d.path) m[d.path] = d.signedUrl; });
      setPhotoUrls(m);
    });
  }, [attachJob]); // eslint-disable-line react-hooks/exhaustive-deps

  const live = jobs.filter((j) => !j.canceled);
  const rec = live.filter((j) => j.received).reduce((s, j) => s + Number(j.amount), 0);
  const tot = live.reduce((s, j) => s + Number(j.amount), 0);
  const days = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso + "T00:00:00").getTime()) / 86400000));
  const partners = [...new Set(jobs.map((j) => j.partner).filter(Boolean))];
  const list = jobs.filter((j) => !q || `${j.partner} ${j.development} ${j.job_number} ${j.description}`.toLowerCase().includes(q.toLowerCase()));

  const pipeline = (j: Job): [string, boolean][] => [
    ["APPROVED", j.approved], ["WORK", j.work_done], ["INV", !!j.invoice_sent], ["PAID", j.received],
  ];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-display text-2xl font-bold uppercase">PACT</div>
        <button className="btn btn-primary" onClick={() => setAddOpen(!addOpen)}>+ New PACT job</button>
      </div>

      {addOpen && (
        <div className="card mb-3 border-work p-3.5">
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
            <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">PACT partner</div>
              <input className="field" list="partners" value={draft.partner} onChange={(e) => setDraft({ ...draft, partner: e.target.value })} />
              <datalist id="partners">{partners.map((p) => <option key={p} value={p} />)}</datalist></div>
            <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Development</div>
              <input className="field" value={draft.development} onChange={(e) => setDraft({ ...draft, development: e.target.value })} /></div>
            <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Job / WO #</div>
              <input className="field" value={draft.job_number} onChange={(e) => setDraft({ ...draft, job_number: e.target.value })} /></div>
            <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Amount</div>
              <input className="field" inputMode="decimal" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} /></div>
            <div className="col-span-2 md:col-span-1"><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Description</div>
              <input className="field" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></div>
          </div>
          <div className="mt-3 flex gap-2">
            <button className="btn btn-primary" onClick={addJob}>Add job</button>
            <button className="btn btn-ghost" onClick={() => setAddOpen(false)}>Cancel</button>
          </div>
        </div>
      )}

      {jobs.length > 0 && (
        <div className="mb-3 grid grid-cols-3 gap-2">
          {([["PACT total", fmt(tot), "text-ink"], ["Received", fmt(rec), "text-ok"], ["Outstanding", fmt(tot - rec), "text-work"]] as [string, string, string][]).map(([l, v, cls]) => (
            <div key={l} className="card p-3">
              <div className="text-[10px] uppercase tracking-[.12em] text-inksoft">{l}</div>
              <div className={`font-mono text-base font-semibold ${cls}`}>{v}</div>
            </div>
          ))}
        </div>
      )}

      <input className="field mb-3" placeholder="Search partner, development, job #…" value={q} onChange={(e) => setQ(e.target.value)} />

      <div className="card divide-y divide-rulesoft">
        {list.map((j) => (
          <div key={j.id} className={`p-3.5 ${j.canceled ? "opacity-50" : ""}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button className="min-w-0 text-left" onClick={() => setOpenId(openId === j.id ? null : j.id)}>
                <div className={`text-[14px] font-semibold ${j.canceled ? "line-through" : ""}`}>{j.partner}{j.development ? ` · ${j.development}` : ""}{j.job_number ? <span className="ml-1 font-mono text-xs text-inksoft">#{j.job_number}</span> : null}</div>
                <div className="max-w-[340px] truncate text-[13px] text-inksoft">{j.description}</div>
                {!j.canceled && (() => {
                  const stages = pipeline(j);
                  const current = stages.findIndex(([, done]) => !done);
                  return (
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {stages.map(([l, done], i) => (
                        <span key={l} className={`rounded-[2px] border px-1 py-px font-mono text-[9px] font-semibold ${done ? "border-ok bg-ok/10 text-ok" : i === current ? "border-work text-work" : "border-rulesoft text-rule"}`}>{l}</span>
                      ))}
                      {j.invoice_sent && !j.received && <span className="ml-1 font-mono text-[10px] text-inksoft">{days(j.invoice_sent)}d out</span>}
                    </div>
                  );
                })()}
              </button>
              <div className="flex shrink-0 items-center gap-2">
                <span className="font-mono text-sm font-semibold">{fmt(Number(j.amount))}</span>
                <button className="text-inksoft" title="Documents & photos" onClick={() => setAttachJob(j)}>📎{(j.attachments || []).length > 0 ? <span className="font-mono text-[10px]">{(j.attachments || []).length}</span> : null}</button>
                <button className={j.canceled ? "text-ok" : "text-alert"} title={j.canceled ? "Restore" : "Cancel job"} onClick={() => patch(j, { canceled: !j.canceled })}>{j.canceled ? "↺" : "✕"}</button>
              </div>
            </div>
            {openId === j.id && !j.canceled && (
              <div className="mt-3 border-t border-rulesoft pt-3">
                <div className="mb-2 flex flex-wrap gap-2">
                  <button onClick={() => patch(j, { approved: !j.approved })}><Stamp label={j.approved ? "APPROVED ✓" : "MARK APPROVED"} tone={j.approved ? "ok" : "mute"} /></button>
                  <button onClick={() => patch(j, { work_done: !j.work_done })}><Stamp label={j.work_done ? "WORK DONE ✓" : "MARK WORK DONE"} tone={j.work_done ? "ok" : "mute"} /></button>
                  <button onClick={() => patch(j, { invoice_sent: j.invoice_sent ? null : today() })}><Stamp label={j.invoice_sent ? `INVOICED ${prettyDate(j.invoice_sent)}` : "MARK INVOICED"} tone={j.invoice_sent ? "carbon" : "mute"} /></button>
                  <button onClick={() => patch(j, j.received ? { received: false, paid_date: null } : { received: true, paid_date: today() })}><Stamp label={j.received ? `PAID ${prettyDate(j.paid_date)}` : "MARK PAID"} tone={j.received ? "ok" : "work"} /></button>
                </div>
                <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
                  {([["partner", "Partner"], ["development", "Development"], ["job_number", "Job / WO #"], ["description", "Description"]] as ["partner" | "development" | "job_number" | "description", string][]).map(([k, label]) => (
                    <div key={k}><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">{label}</div>
                      <input className="field" value={j[k] || ""} onChange={(e) => setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, [k]: e.target.value } : x)))}
                        onBlur={(e) => patch(j, { [k]: e.target.value } as Partial<Job>)} /></div>
                  ))}
                  <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Amount</div>
                    <input className="field" inputMode="decimal" value={String(j.amount)} onChange={(e) => setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, amount: parseNum(e.target.value) } : x)))}
                      onBlur={(e) => patch(j, { amount: parseNum(e.target.value) })} /></div>
                  <div className="col-span-2 md:col-span-3"><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Notes</div>
                    <input className="field" value={j.notes || ""} onChange={(e) => setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, notes: e.target.value } : x)))}
                      onBlur={(e) => patch(j, { notes: e.target.value })} /></div>
                </div>
              </div>
            )}
          </div>
        ))}
        {list.length === 0 && <div className="p-5 text-sm text-inksoft">{jobs.length === 0 ? "No PACT jobs yet. Tap + New PACT job — partner, development, amount, done." : "Nothing matches."}</div>}
      </div>

      {attachJob && (
        <div className="fixed inset-0 z-40 overflow-y-auto bg-ink/50 px-2 py-10" onClick={() => setAttachJob(null)}>
          <div className="card mx-auto max-w-md bg-card p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 font-display text-base font-bold uppercase">Documents · {attachJob.partner}{attachJob.job_number ? ` #${attachJob.job_number}` : ""}</div>
            {(attachJob.attachments || []).length === 0 && <div className="mb-3 text-sm text-inksoft">Nothing attached yet — job photos and paperwork land here.</div>}
            {(attachJob.attachments || []).filter((a) => isImg(a.name)).length > 0 && (
              <div className="mb-3 grid grid-cols-3 gap-1.5">
                {(attachJob.attachments || []).filter((a) => isImg(a.name)).map((a) => (
                  <div key={a.path} className="relative">
                    <button className="block w-full" onClick={() => openAttachment(a.path)} title={a.name}>
                      {photoUrls[a.path]
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={photoUrls[a.path]} alt={a.name} className="h-24 w-full rounded-sm border border-rulesoft object-cover" />
                        : <div className="grid h-24 w-full place-items-center rounded-sm border border-rulesoft text-xs text-inksoft">…</div>}
                    </button>
                    <button className="absolute right-1 top-1 rounded-sm bg-ink/70 px-1.5 text-xs text-paper" onClick={() => removeAttachment(attachJob, a.path)}>✕</button>
                  </div>
                ))}
              </div>
            )}
            {(attachJob.attachments || []).filter((a) => !isImg(a.name)).map((a) => (
              <div key={a.path} className="mb-1.5 flex items-center gap-1">
                <button className="block w-full rounded-sm border border-rulesoft p-2.5 text-left text-sm hover:border-work" onClick={() => openAttachment(a.path)}>📄 {a.name}</button>
                <button className="shrink-0 px-1 text-xs text-alert" onClick={() => removeAttachment(attachJob, a.path)}>✕</button>
              </div>
            ))}
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="btn btn-primary" onClick={() => photoRef.current?.click()} disabled={busy}>📷 Take photo</button>
              <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>Upload file</button>
              <button className="btn btn-ghost" onClick={() => setAttachJob(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
      <input ref={fileRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f && attachJob) attachFile(attachJob, f); e.target.value = ""; }} />
      <input ref={photoRef} type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={(e) => { const fs = Array.from(e.target.files || []); if (fs.length && attachJob) addPhotos(attachJob, fs); e.target.value = ""; }} />

      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
