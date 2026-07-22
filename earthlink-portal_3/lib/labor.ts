// Matching payroll hours against a release's required labor, by classification.
// Trade names are free text on both sides ("General Laborer Tier A" vs "laborer"),
// so both are collapsed to a canonical keyword before comparing.
const KEYWORDS = ["laborer", "carpenter", "painter", "plumber", "electrician", "plasterer", "bricklayer", "tile", "mason", "roofer", "glazier"];

export const canonTrade = (s: string): string => {
  const t = (s || "").toLowerCase();
  for (const k of KEYWORDS) if (t.includes(k)) return k;
  return t.trim() || "other";
};

export interface LaborRow { cls: string; required: number; logged: number; }
export interface LaborResult { rows: LaborRow[]; totalLogged: number; totalRequired: number; shorts: LaborRow[]; ok: boolean; }

// The rule: logged hours may exceed the release's requirement, never fall short —
// per classification and in total.
export function checkLabor(
  required: { cls: string; hours: number }[],
  totalRequired: number,
  loggedByClass: Record<string, number>
): LaborResult {
  const reqBy: Record<string, number> = {};
  required.forEach((b) => { const c = canonTrade(b.cls); reqBy[c] = (reqBy[c] || 0) + (Number(b.hours) || 0); });
  const classes = [...new Set([...Object.keys(reqBy), ...Object.keys(loggedByClass)])];
  const rows = classes.map((c) => ({ cls: c, required: reqBy[c] || 0, logged: loggedByClass[c] || 0 }));
  const totalLogged = Object.values(loggedByClass).reduce((s, v) => s + v, 0);
  const totReq = (Number(totalRequired) || 0) || Object.values(reqBy).reduce((s, v) => s + v, 0);
  const shorts = rows.filter((r) => r.logged < r.required);
  return { rows, totalLogged, totalRequired: totReq, shorts, ok: shorts.length === 0 && totalLogged >= totReq };
}

// Aggregates timesheet hours for one or all releases into {releaseId: {class: hours}}.
// A classification typed on the entry itself wins over the worker's default trade —
// the same person can count as a laborer on one job and a plasterer on another.
export function aggregateLogged(
  entries: { release_id: string | null; employee_id: string; hours: number[]; trade?: string | null }[],
  tradeById: Map<string, string>
): Record<string, Record<string, number>> {
  const byRel: Record<string, Record<string, number>> = {};
  entries.forEach((en) => {
    if (!en.release_id) return;
    const cls = (en.trade ?? "").trim() ? canonTrade(en.trade!) : tradeById.get(en.employee_id) || "other";
    const h = (en.hours || []).reduce((s, d) => s + (Number(d) || 0), 0);
    if (h <= 0) return;
    (byRel[en.release_id] ||= {})[cls] = (byRel[en.release_id][cls] || 0) + h;
  });
  return byRel;
}
