"use client";
import { useEffect, useState } from "react";
import { sb } from "@/lib/supabase";
import { cleanPhone, prettyPhone, smsHref, sendServerTexts, textMachineReady } from "@/lib/notify";
import { prettyDate, localISO } from "@/lib/docs";

// Pick a worker, the message writes itself — the job site, the apartment, the
// day, the work — and it goes out from the company's number (Twilio). Until
// the number is set up in Vercel it opens the phone's own Messages app with
// the text ready instead. Every send is written on the job ("📱 Texted …")
// so the calendar shows who was sent where.
export type TextableJob = {
  id: string; po_number?: string | null; job_number?: string | null; address?: string | null; development?: string | null;
  property_unit?: string | null; description?: string | null; start_date?: string | null; notes?: string | null;
  items?: { description: string; key?: string }[] | null;
};
type Worker = { id: string; name: string; phone?: string | null; active?: boolean };

// what the crew is going there to do, from the priced lines when there are any
export const workOf = (j: TextableJob) => {
  const lines = [...new Set((j.items || []).map((it) => (it.description || "").trim()).filter(Boolean))];
  return lines.length ? lines.join(", ") : (j.description || "").trim();
};
export const siteOf = (j: TextableJob) => [j.address || j.development || "", j.property_unit && `Apt ${j.property_unit}`].filter(Boolean).join(", ");
// "📱 Texted Jose · Sep 9, 2026" lines on the job, newest last
export const textedTo = (notes?: string | null) => (notes || "").split("\n").filter((l) => l.startsWith("📱 Texted ")).map((l) => l.replace(/^📱 Texted /, ""));

export default function TextWorker({ job, onNote, onClose }: {
  job: TextableJob;
  onNote: (line: string) => Promise<void> | void;   // appends to the job's notes
  onClose?: () => void;
}) {
  const [crew, setCrew] = useState<Worker[]>([]);
  const [q, setQ] = useState("");
  const [work, setWork] = useState(workOf(job));
  const [phoneBuf, setPhoneBuf] = useState<Record<string, string>>({});
  const [machine, setMachine] = useState<boolean | null>(null);
  const [sending, setSending] = useState("");
  const [msg, setMsg] = useState("");
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 3500); };

  useEffect(() => {
    sb().from("employees").select("*").order("name").then(({ data }) => setCrew(((data || []) as Worker[]).filter((e) => e.active !== false)));
    textMachineReady().then(setMachine);
  }, []);

  const site = siteOf(job);
  const when = job.start_date ? prettyDate(job.start_date) : "";
  const po = job.po_number || job.job_number || "";
  const body = (first?: string) =>
    `Earth Link:${first ? ` ${first},` : ""} you're on a job at ${site || "(no address on file)"}${when ? ` on ${when}` : ""}.${work.trim() ? ` Work: ${work.trim()}.` : ""}${po ? ` PO ${po}.` : ""} Reply here with any questions.`;

  const savePhone = async (e: Worker, raw: string) => {
    const phone = cleanPhone(raw) || raw.trim();
    if (cleanPhone(phone) === cleanPhone(e.phone || "")) return;
    const { error } = await sb().from("employees").update({ phone }).eq("id", e.id);
    if (error) { flash(error.message); return; }
    setCrew((prev) => prev.map((x) => (x.id === e.id ? { ...x, phone } : x)));
  };
  const send = async (e: Worker, phone: string) => {
    const first = e.name.split(" ")[0];
    const text = body(first);
    const stamp = `📱 Texted ${e.name} · ${prettyDate(localISO(new Date()))}${site ? ` · ${site}` : ""}`;
    if (machine) {
      setSending(e.id);
      const { data: { session } } = await sb().auth.getSession();
      const r = await sendServerTexts([{ to: cleanPhone(phone), body: text }], session?.access_token || null);
      setSending("");
      if (r.ok && (r.sent || 0) > 0) { await onNote(stamp); flash(`Sent to ${first} from the company number`); return; }
      if (r.status === 501) { setMachine(false); flash("Company number isn't set up — opening your Messages app instead"); }
      else { flash(`Couldn't send (${r.failed?.[0]?.error || r.error || r.status}) — opening your Messages app instead`); }
    }
    // no company number: the phone's own Messages app, text already typed
    await onNote(stamp);
    window.location.href = smsHref(phone, text);
  };

  const cq = q.trim().toLowerCase();
  const match = crew.filter((e) => !cq || e.name.toLowerCase().includes(cq));
  return (
    <div className="rounded-sm border border-rulesoft bg-paper p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-widest text-inksoft">Text a worker</div>
        {onClose && <button type="button" className="btn-icon border-0 text-inksoft" aria-label="Close" onClick={onClose}>✕</button>}
      </div>
      <div className="mb-2 rounded-sm border border-rulesoft bg-white px-3 py-2 text-[12px] text-inksoft">{body("Name")}</div>
      <input className="field mb-1.5" placeholder="What they're going there to do" value={work} onChange={(e) => setWork(e.target.value)} />
      <input className="field mb-1.5" placeholder="Find a worker by name…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="max-h-64 overflow-y-auto">
        {match.map((e) => {
          const buf = phoneBuf[e.id] ?? prettyPhone(e.phone || "");
          const ok = !!cleanPhone(buf);
          return (
            <div key={e.id} className="flex flex-wrap items-center gap-2 border-t border-rulesoft py-1.5 first:border-t-0">
              <b className="text-[13px]">{e.name}</b>
              <input className="field w-44 px-2 py-1.5 text-[13px]" placeholder="Phone number" inputMode="tel"
                value={buf} onChange={(ev) => setPhoneBuf((p) => ({ ...p, [e.id]: ev.target.value }))} onBlur={() => savePhone(e, buf)} />
              {ok
                ? <button type="button" className="btn btn-primary min-h-[44px] px-3 py-1.5 text-[13px]" disabled={sending === e.id} onClick={() => send(e, buf)}>{sending === e.id ? "Sending…" : machine ? "Send" : "Text"}</button>
                : <span className="text-[11px] text-inksoft">add a number to text them</span>}
            </div>
          );
        })}
        {crew.length === 0 && <div className="py-2 text-[13px] text-inksoft">No workers on the crew list yet — add them on the Payroll tab.</div>}
        {crew.length > 0 && match.length === 0 && <div className="py-2 text-[13px] text-inksoft">No one matches “{q}”.</div>}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 border-t border-rulesoft pt-2">
        <button type="button" className="btn btn-ghost min-h-[40px] px-3 py-1.5 text-[13px]" onClick={() => { navigator.clipboard?.writeText(body()); flash("Message copied"); }}>Copy message</button>
        <span className="text-[11px] text-inksoft">{machine === null ? "" : machine ? "sends from the company number" : "opens your Messages app (company number not set up)"}</span>
      </div>
      {msg && <div className="mt-2 text-[12px] text-inksoft">{msg}</div>}
    </div>
  );
}
