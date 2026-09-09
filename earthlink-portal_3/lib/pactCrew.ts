// A PACT job's crew lives in schedule_days, the same table the NYCHA day
// schedule has always used: one row per worker per day, with the TEXTED mark.
// These helpers read that crew for a job and write the text a worker gets.
import { prettyDate } from "./docs";

export interface CrewRow {
  id: string; day: string; release_id: string | null; pact_job_id?: string | null;
  employee_id: string; description: string; texted: boolean; address?: string | null;
}
export interface CrewJob {
  id: string; po_number?: string | null; job_number?: string | null; partner?: string | null;
  address?: string | null; development?: string | null; property_unit?: string | null;
  description?: string | null; start_date?: string | null;
}
export interface Worker { id: string; name: string; phone?: string | null; active?: boolean }

// the columns a page may read from pact_jobs for crew work — never the money
export const CREW_JOB_COLS = "id,po_number,job_number,partner,address,development,property_unit,description,start_date,finish_date,work_done,canceled,notes,created_at";

export const normText = (s: string) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
const squash = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// the site, byte-identical to RUN_ME's pact_site(): "street, city, Apt 4B"
export const siteOf = (j: CrewJob): string => {
  const where = (j.address || "").trim() || (j.development || "").trim();
  const unit = (j.property_unit || "").trim();
  return [where, unit && `Apt ${unit}`].filter(Boolean).join(", ");
};
// what the crew is going there to do — the PO's own words, one text long
export const workOf = (j: CrewJob): string => {
  const w = (j.description || "").replace(/\s+/g, " ").trim();
  return w.length > 120 ? `${w.slice(0, 117).trimEnd()}…` : w;
};
export const mapLink = (addr: string) => `https://maps.google.com/?q=${encodeURIComponent(addr)}`;

// the text itself. "moved" makes it read as a change, not a repeat.
export const crewMessage = (j: CrewJob, first: string, work: string, moved?: { from: string; to: string }): string => {
  const site = siteOf(j) || "(no address on file)";
  const po = j.po_number || j.job_number || "";
  const tag = [po && `PO ${po}`, (j.partner || "").trim()].filter(Boolean).join(" · ");
  const head = moved
    ? `Earth Link:${first ? ` ${first},` : ""} the job at ${site} moved to ${prettyDate(moved.to)}${moved.from ? ` (was ${prettyDate(moved.from)})` : ""}.`
    : `Earth Link:${first ? ` ${first},` : ""} you're scheduled for ${j.start_date ? prettyDate(j.start_date) : "a day to be set"} at ${site}${tag ? ` (${tag})` : ""}.`;
  return `${head}${work ? ` Work: ${work}.` : ""}${(j.address || j.development) ? ` Map: ${mapLink(siteOf(j))}` : ""}`;
};

// this job's crew rows. Until RUN_ME section 14 is run the rows carry no job
// link, so a row on this job's day at this job's site (and belonging to no
// release) is taken as this job's.
export const rowsOfJob = (rows: CrewRow[], j: CrewJob): CrewRow[] => {
  const linked = rows.filter((r) => r.pact_job_id === j.id);
  if (linked.length) return linked;
  const site = squash(siteOf(j));
  if (!site || !j.start_date) return [];
  return rows.filter((r) => !r.release_id && !r.pact_job_id && r.day === j.start_date && squash(r.address || "") === site);
};
// a worker who hasn't been told, or was told a different day — computed here,
// so a mismatch shows even where the database trigger isn't in yet
export const rowNeedsText = (r: CrewRow, j: CrewJob) => !r.texted || (!!j.start_date && r.day !== j.start_date);
export const crewState = (rows: CrewRow[], j: CrewJob): "none" | "told" | "not_told" =>
  rows.length === 0 ? "none" : rows.some((r) => rowNeedsText(r, j)) ? "not_told" : "told";
// "Jose TEXTED ✓ · Luis not told" — the one wording every screen uses
export const crewLine = (rows: CrewRow[], j: CrewJob, emps: Worker[]): string =>
  rows.length === 0 ? "No one sent yet" : rows.map((r) => {
    const first = (emps.find((e) => e.id === r.employee_id)?.name || "?").split(" ")[0];
    return `${first} ${!r.texted ? "not told" : j.start_date && r.day !== j.start_date ? "needs the new day" : "TEXTED ✓"}`;
  }).join(" · ");
