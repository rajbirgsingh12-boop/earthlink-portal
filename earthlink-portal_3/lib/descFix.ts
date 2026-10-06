// A PO description that was cut short on intake (the first version kept
// 120 characters) against the PO read again: the fresh read replaces it
// only when it plainly continues what was kept — never when the office has
// since written something of its own there.
export const CUT_AT = 120;
const squash = (s: string) => (s || "").replace(/\s+/g, " ").trim();
// could this description be one the intake cut? (exactly the cut length, or a hair under after trimming)
export const looksCut = (d: string): boolean => { const n = squash(d).length; return n >= CUT_AT - 6 && n <= CUT_AT; };
export function betterDescription(old: string, fresh0: string): string | null {
  const fresh = squash(fresh0).slice(0, 600);
  const was = squash(old).replace(/[\s.…,;:-]+$/, "");
  if (!fresh || fresh.length <= squash(old).length) return null;
  const head = was.slice(0, Math.min(was.length, 100)).toLowerCase();
  if (!head || !fresh.toLowerCase().startsWith(head)) return null;
  return fresh;
}
