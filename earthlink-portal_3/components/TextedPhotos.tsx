"use client";
// Photos the crew texted back to the company number (/api/sms-in). Most go
// straight onto the job the worker is on; this card shows the office the
// ones the portal couldn't place (two jobs that day, no job, a phone not on
// the crew list) to pick a job for, and the ones it placed lately, so a batch
// on the wrong job moves in one tap. Admin and office only — no money here.
import { useEffect, useMemo, useState } from "react";
import { sb } from "@/lib/supabase";
import { useLive } from "@/lib/useLive";
import { prettyPhone } from "@/lib/notify";
import { useDebounced } from "@/lib/useDebounced";

interface Photo { name: string; path: string }
interface Batch {
  id: string; employee_id?: string | null; from_phone?: string | null; body?: string | null; photos?: Photo[] | null;
  status: string; pact_job_id?: string | null; release_id?: string | null; created_at: string;
}
interface Spot { kind: "pact" | "rel"; id: string; label: string; sub: string }
const LATELY_DAYS = 3;
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
const photosN = (n: number) => `${n} photo${n === 1 ? "" : "s"}`;
const pactSpot = (j: { id: string; po_number?: string | null; job_number?: string | null; address?: string | null; development?: string | null }): Spot =>
  ({ kind: "pact", id: j.id, label: `PO ${(j.po_number || j.job_number || "").trim().replace(/^(p\.?\s*o\.?\s*#?|#)\s*/i, "")}`, sub: (j.address || j.development || "").trim() });
const relSpot = (r: { id: string; rel_number?: string | null; location?: string | null }): Spot =>
  ({ kind: "rel", id: r.id, label: `Release ${(r.rel_number || "").trim().replace(/^(release\s*#?|rel\.?\s*#?|#)\s*/i, "")}`, sub: (r.location || "").trim() });
const dayOf = (iso: string, back: number) => {
  const d = new Date(iso); d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export default function TextedPhotos({ canEdit, flash }: { canEdit: boolean; flash: (m: string) => void }) {
  const [rows, setRows] = useState<Batch[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [spots, setSpots] = useState<Record<string, Spot>>({});
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [picking, setPicking] = useState<string | null>(null); // the batch whose job is being picked
  const [lately, setLately] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const since = new Date(Date.now() - LATELY_DAYS * 86_400_000).toISOString();
    const cols = "id,employee_id,from_phone,body,photos,status,pact_job_id,release_id,created_at";
    // the waiting ones on their own: a busy few days of placed ones never push one off
    const [h, f] = await Promise.all([
      sb().from("texted_photos").select(cols).eq("status", "held").order("created_at", { ascending: false }).limit(200),
      sb().from("texted_photos").select(cols).eq("status", "filed").gte("created_at", since).order("created_at", { ascending: false }).limit(40),
    ]);
    if (h.error) { setRows([]); return; } // before RUN_ME section 20 — nothing to show
    const list = ([...(h.data || []), ...(f.data || [])] as Batch[]).filter((b) => Array.isArray(b.photos) && b.photos.length > 0);
    setRows(list);
    const emp = [...new Set(list.map((b) => b.employee_id).filter(Boolean) as string[])];
    const pIds = [...new Set(list.map((b) => b.pact_job_id).filter(Boolean) as string[])];
    const rIds = [...new Set(list.map((b) => b.release_id).filter(Boolean) as string[])];
    const paths = list.flatMap((b) => (b.photos || []).slice(0, 8).map((p) => p.path));
    const [e, p, r, s] = await Promise.all([
      emp.length ? sb().from("employees").select("id,name").in("id", emp) : Promise.resolve({ data: [] }),
      pIds.length ? sb().from("pact_jobs").select("id,po_number,job_number,address,development").in("id", pIds) : Promise.resolve({ data: [] }),
      rIds.length ? sb().from("releases").select("id,rel_number,location").in("id", rIds) : Promise.resolve({ data: [] }),
      paths.length ? sb().storage.from("docs").createSignedUrls(paths, 3600) : Promise.resolve({ data: [] }),
    ]);
    setNames(Object.fromEntries(((e.data || []) as { id: string; name: string }[]).map((x) => [x.id, x.name])));
    setSpots(Object.fromEntries([
      ...((p.data || []) as Parameters<typeof pactSpot>[0][]).map((j) => [j.id, pactSpot(j)]),
      ...((r.data || []) as Parameters<typeof relSpot>[0][]).map((x) => [x.id, relSpot(x)]),
    ]));
    const t: Record<string, string> = {};
    ((s.data || []) as { path: string | null; signedUrl: string }[]).forEach((d) => { if (d.path && d.signedUrl) t[d.path] = d.signedUrl; });
    setThumbs(t);
  };
  useEffect(() => {
    if (!canEdit) return;
    load();
    // the picture links last an hour: fresh ones every half hour for a tab left open
    const t = setInterval(load, 30 * 60_000);
    return () => clearInterval(t);
  }, [canEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(["texted_photos"], () => load(), { enabled: canEdit });

  const act = async (b: Batch, body: Record<string, string>) => {
    setBusy(true);
    try {
      const token = (await sb().auth.getSession()).data.session?.access_token || "";
      const res = await fetch("/api/texted-photos", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ id: b.id, ...body }) });
      const j = (await res.json().catch(() => ({}))) as { error?: string; n?: number; label?: string };
      if (!res.ok) { flash(j.error || "Couldn't do that — try again"); return; }
      flash(body.action === "throw" ? "Thrown away" : `${photosN(j.n || 0)} on ${j.label} ✓`);
      setPicking(null);
      await load();
    } finally { setBusy(false); }
  };

  const held = rows.filter((b) => b.status === "held");
  const filed = rows.filter((b) => b.status === "filed");
  if (!canEdit || rows.length === 0) return null;
  const who = (b: Batch) => (b.employee_id && names[b.employee_id]) || (b.employee_id ? "A worker" : `${prettyPhone(b.from_phone || "")} (not on the crew list)`);
  // a fresh link every time; the window opens on the tap itself, so a phone doesn't block it
  const open = async (path: string) => {
    const w = window.open("", "_blank");
    const url = (await sb().storage.from("docs").createSignedUrl(path, 600)).data?.signedUrl;
    if (url && w) w.location.href = url;
    else { w?.close(); flash("Couldn't open that photo"); }
  };
  const strip = (b: Batch) => (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {(b.photos || []).slice(0, 8).map((p) => (
        <button key={p.path} className="block h-16 w-16 overflow-hidden rounded-sm border border-rulesoft" onClick={() => open(p.path)} title={p.name}>
          {thumbs[p.path]
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={thumbs[p.path]} alt={p.name} className="h-full w-full object-cover" />
            : <span className="grid h-full w-full place-items-center text-xs text-inksoft">…</span>}
        </button>
      ))}
      {(b.photos || []).length > 8 && <span className="grid h-16 place-items-center px-1 text-[12px] text-inksoft">+{(b.photos || []).length - 8}</span>}
    </div>
  );

  return (
    <div className="card mb-3 p-3" data-texted-photos>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-widest text-inksoft">📱 Photos texted in</div>
        {held.length > 0 && <span className="stamp border-alert text-alert" data-texted-waiting>{held.length} need a job</span>}
      </div>
      {held.map((b) => (
        <div key={b.id} className="border-t border-rulesoft py-2.5" data-held={b.id}>
          <div className="text-[14px]"><b>{who(b)}</b> texted {photosN((b.photos || []).length)} · {when(b.created_at)}</div>
          {(b.body || "").trim() && <div className="text-[12px] text-inksoft [overflow-wrap:anywhere]">“{(b.body || "").trim()}”</div>}
          {strip(b)}
          {picking === b.id
            ? <JobPick batch={b} busy={busy} onPick={(s) => act(b, { action: "file", ...(s.kind === "pact" ? { pact_job_id: s.id } : { release_id: s.id }) })} onCancel={() => setPicking(null)} />
            : (
              <div className="mt-2 flex flex-wrap gap-2">
                <button className="btn btn-primary min-h-[44px] px-3 py-1.5 text-[13px]" onClick={() => setPicking(b.id)} disabled={busy} data-pick-job>Put them on a job…</button>
                <button className="btn btn-ghost min-h-[44px] px-3 py-1.5 text-[13px]" onClick={() => { if (window.confirm(`Throw away ${photosN((b.photos || []).length)} from ${who(b)}?`)) act(b, { action: "throw" }); }} disabled={busy} data-throw>✕ Throw away</button>
              </div>
            )}
        </div>
      ))}
      {filed.length > 0 && (
        <div className="border-t border-rulesoft pt-2">
          <button className="min-h-[44px] w-full text-left text-[13px] text-inksoft" onClick={() => setLately(!lately)} data-texted-lately>
            {lately ? "▾" : "▸"} Put on jobs by themselves lately ({filed.length})
          </button>
          {lately && filed.map((b) => {
            const at = spots[b.pact_job_id || b.release_id || ""];
            return (
              <div key={b.id} className="border-t border-rulesoft py-2" data-filed={b.id}>
                <div className="flex flex-wrap items-center gap-x-2 text-[13px]">
                  <span><b>{who(b)}</b> · {photosN((b.photos || []).length)} → <b>{at ? at.label : "a job"}</b> · {when(b.created_at)}</span>
                  {picking !== b.id && <button className="min-h-[44px] px-1 text-[12px] font-semibold text-work underline" onClick={() => setPicking(b.id)} disabled={busy} data-move>Wrong job?</button>}
                </div>
                {picking === b.id && (
                  <>
                    {strip(b)}
                    <JobPick batch={b} busy={busy} onPick={(s) => act(b, { action: "file", ...(s.kind === "pact" ? { pact_job_id: s.id } : { release_id: s.id }) })} onCancel={() => setPicking(null)} />
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Which job: the ones the worker was on around the time they texted, first;
// or type a PO or release number
function JobPick({ batch, busy, onPick, onCancel }: { batch: Batch; busy: boolean; onPick: (s: Spot) => void; onCancel: () => void }) {
  const [near, setNear] = useState<Spot[]>([]);
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 300);
  const [found, setFound] = useState<Spot[]>([]);
  useEffect(() => {
    if (!batch.employee_id) return;
    (async () => {
      let r = await sb().from("schedule_days").select("pact_job_id,release_id").eq("employee_id", batch.employee_id!)
        .gte("day", dayOf(batch.created_at, 3)).lte("day", dayOf(batch.created_at, -1)) as { data: { pact_job_id?: string | null; release_id?: string | null }[] | null; error: unknown };
      if (r.error) r = await sb().from("schedule_days").select("release_id").eq("employee_id", batch.employee_id!).gte("day", dayOf(batch.created_at, 3)).lte("day", dayOf(batch.created_at, -1)) as typeof r;
      const rows = r.data || [];
      const pIds = [...new Set(rows.map((x) => x.pact_job_id).filter(Boolean) as string[])];
      const rIds = [...new Set(rows.map((x) => x.release_id).filter(Boolean) as string[])];
      const [p, rl] = await Promise.all([
        pIds.length ? sb().from("pact_jobs").select("id,po_number,job_number,address,development").in("id", pIds) : Promise.resolve({ data: [] }),
        rIds.length ? sb().from("releases").select("id,rel_number,location").in("id", rIds) : Promise.resolve({ data: [] }),
      ]);
      setNear([...((p.data || []) as Parameters<typeof pactSpot>[0][]).map(pactSpot), ...((rl.data || []) as Parameters<typeof relSpot>[0][]).map(relSpot)]);
    })();
  }, [batch.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const n = dq.replace(/^(po|p\.o\.|release|rel)\s*#?\s*/i, "").replace(/[^0-9a-z-]/gi, "");
    if (!n) { setFound([]); return; }
    let stale = false;
    (async () => {
      const [p, r] = await Promise.all([
        sb().from("pact_jobs").select("id,po_number,job_number,address,development").or(`po_number.ilike.*${n}*,job_number.ilike.*${n}*`).not("canceled", "is", true).limit(6),
        sb().from("releases").select("id,rel_number,location").eq("rel_number", n).limit(6),
      ]);
      if (stale) return;
      setFound([...((p.data || []) as Parameters<typeof pactSpot>[0][]).map(pactSpot), ...((r.data || []) as Parameters<typeof relSpot>[0][]).map(relSpot)]);
    })();
    return () => { stale = true; };
  }, [dq]);
  const choices = useMemo(() => {
    const seen = new Set<string>();
    return [...near, ...found].filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  }, [near, found]);
  return (
    <div className="mt-2 rounded-sm border border-rule bg-white p-2" data-job-pick>
      {near.length > 0 && <div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Where they were working</div>}
      <input className="field mb-2 min-h-[44px] py-2 font-mono" inputMode="text" placeholder="Or type a PO or release number" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="grid gap-1.5">
        {choices.map((s) => (
          <button key={s.id} className="min-h-[44px] rounded-sm border border-rulesoft px-3 py-2 text-left text-[14px] hover:border-work" onClick={() => onPick(s)} disabled={busy} data-spot={s.id}>
            <b>{s.label}</b>{s.sub && <span className="text-inksoft"> · {s.sub}</span>}
          </button>
        ))}
        {choices.length === 0 && <div className="text-[12px] text-inksoft">{dq ? "No job with that number." : "Type the number from the PO or the release."}</div>}
      </div>
      <button className="btn btn-ghost mt-2 min-h-[44px] px-3 py-1.5 text-[13px]" onClick={onCancel}>Cancel</button>
    </div>
  );
}
