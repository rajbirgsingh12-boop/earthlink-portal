// One PO is one job. "8388", "PO 8388", "#8388", "PO-08388" and "8388 " are
// the same PO, so every door a PO can come through — the phone, the email
// intake, a typed job, a folder — matches on this stripped form. And when
// the number was misread or missing, the same place for the same money is
// still the same job.

export const normPo = (v: string | null | undefined): string =>
  String(v || "").toLowerCase()
    // every label in front of the number goes: "Purchase Order No: 4471" → "4471"
    .replace(/^\s*(?:(?:purchase\s*order|p\.?\s*o\.?|work\s*order|w\.?o\.?|order|no\.?|number|#)\s*[:#.\-–]*\s*)+/i, "")
    .replace(/[^a-z0-9]/g, "")
    .replace(/^0+(?=[a-z0-9])/, "");

export const samePo = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = normPo(a), y = normPo(b);
  return !!x && x === y;
};

// "756 Stanley Avenue, Brooklyn" and "756 stanley ave" are one address
export const normAddr = (v: string | null | undefined): string =>
  String(v || "").toLowerCase()
    .replace(/\b(?:apartment|apt\.?|unit|#)\s*[\w-]+/g, "")
    .replace(/\bavenue\b/g, "ave").replace(/\bstreet\b/g, "st").replace(/\bboulevard\b/g, "blvd")
    .replace(/\broad\b/g, "rd").replace(/\bplace\b/g, "pl").replace(/\bdrive\b/g, "dr").replace(/\bcourt\b/g, "ct")
    .replace(/\bparkway\b/g, "pkwy").replace(/\bterrace\b/g, "ter").replace(/\blane\b/g, "ln")
    .replace(/\b(?:east|e)\b/g, "e").replace(/\b(?:west|w)\b/g, "w").replace(/\b(?:north|n)\b/g, "n").replace(/\b(?:south|s)\b/g, "s")
    .replace(/[^a-z0-9]/g, "");

export type PoLike = {
  po_number?: string | null; job_number?: string | null;
  address?: string | null; property_unit?: string | null; amount?: number | string | null; canceled?: boolean | null;
};
export type PoProbe = { po?: string | null; address?: string | null; property_unit?: string | null; amount?: number | null };

export const sameSite = (a: PoLike, b: PoProbe): boolean => {
  const x = normAddr(a.address), y = normAddr(b.address);
  if (x.length < 6 || y.length < 6) return false;
  if (!(x === y || x.startsWith(y) || y.startsWith(x))) return false;
  if (normAddr(a.property_unit) !== normAddr(b.property_unit)) return false;
  const am = Number(a.amount || 0), bm = Number(b.amount || 0);
  return bm > 0 && Math.abs(am - bm) < 0.02;
};

// the job this PO already is, if any — a live job before a canceled one
export function findDupe<T extends PoLike>(rows: T[], probe: PoProbe): T | undefined {
  const ordered = [...rows.filter((r) => !r.canceled), ...rows.filter((r) => !!r.canceled)];
  if (probe.po && normPo(probe.po)) {
    const byPo = ordered.find((r) => samePo(r.po_number, probe.po) || samePo(r.job_number, probe.po));
    if (byPo) return byPo;
  }
  if (probe.address) return ordered.find((r) => sameSite(r, probe));
  return undefined;
}

// the columns findDupe needs — one select shared by every path
export const DUPE_COLS = "id,po_number,job_number,address,property_unit,amount,canceled,attachments,description";
