// A crew text whose time has come: whether it should still go out, and what
// it says. Pure — no database, no Twilio — so the rule that a text never
// arrives about a day that has already passed can be tested on its own.
import { crewText } from "./crewText";

export interface DueRow { id: string; day?: string | null; send_at?: string | null; description?: string | null; address?: string | null }
export interface DueEmp { name?: string | null; phone?: string | null; lang?: string | null }
export interface DueJob {
  po_number?: string | null; job_number?: string | null; address?: string | null; development?: string | null;
  property_unit?: string | null; description?: string | null; start_date?: string | null;
  canceled?: boolean; work_done?: boolean;
}
// the same cut lib/pactCrew's workOf makes, kept here so a server route never
// has to pull in the browser's half of the app
const WORK_MAX = 400;
const workOf = (j: DueJob): string => {
  const w = (j.description || "").replace(/\s+/g, " ").trim();
  if (w.length <= WORK_MAX) return w;
  const cut = w.slice(0, WORK_MAX - 1);
  return `${(cut.lastIndexOf(" ") > WORK_MAX - 60 ? cut.slice(0, cut.lastIndexOf(" ")) : cut).trimEnd()}…`;
};
export interface DueRel { rel_number?: string | null; location?: string | null; address?: string | null; canceled?: boolean }
export const LATE_MS = 24 * 3600_000;         // a text more than a day late is never sent
const GONE_MS = 36 * 3600_000;                // …nor one for a work day this far behind us

export const dueDay = (row: DueRow, job?: DueJob | null): string => ((job?.start_date || row.day || "") as string).trim();
// "" when it should go out; otherwise why it shouldn't, in plain words
export function dueSkip(row: DueRow, ctx: { emp?: DueEmp | null; job?: DueJob | null; rel?: DueRel | null; phone?: string; now: Date }): string {
  if (!ctx.emp) return "the worker isn't in the crew list any more";
  if (!(ctx.phone || "").trim()) return "no phone number for them";
  if (ctx.job?.canceled || ctx.rel?.canceled) return "the job was canceled";
  if (ctx.job?.work_done) return "the work is already done";
  const at = new Date(row.send_at || 0).getTime();
  if (!at || at < ctx.now.getTime() - LATE_MS) return "it was more than a day late";
  const day = dueDay(row, ctx.job);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < new Date(ctx.now.getTime() - GONE_MS).toISOString().slice(0, 10)) return "that work day has passed";
  return "";
}
// the text itself, written at the moment it goes out — so a job that moved
// since it was set up says the new day
export function dueBody(row: DueRow, ctx: { emp: DueEmp; job?: DueJob | null; rel?: DueRel | null; work: string; moved?: { from: string; to: string } | null }): string {
  const { emp, job, rel } = ctx;
  return crewText({
    first: (emp.name || "").split(" ")[0],
    day: dueDay(row, job),
    moved: ctx.moved || null,
    work: ctx.work,
    lang: emp.lang,
    street: (job ? job.address : row.address || rel?.address) || "",
    building: job ? job.development : rel?.location,
    apt: job?.property_unit,
    po: job ? (job.po_number || job.job_number || "") : "",
    release: rel ? rel.rel_number || "" : "",
  });
}
// what the crew is going there to do: the wording saved on the row, else the job's own
export const dueWork = (row: DueRow, job?: DueJob | null): string => (row.description || "").trim() || (job ? workOf(job) : "");
