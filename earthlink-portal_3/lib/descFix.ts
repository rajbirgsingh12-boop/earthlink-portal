// A PO description that was cut short on intake (the first version kept
// 120 characters) against the PO read again: the fresh read replaces it
// only when it plainly continues what was kept, never when the office has
// since written something of its own there. Imported by the browser too, so
// nothing here leans on the server.
export const CUT_AT = 120;
export const squash = (s: string) => (s || "").replace(/\s+/g, " ").trim();
// letters and digits only, so "Repairs - the" and "Repairs: the" read the
// same, and a curly apostrophe against a straight one
export const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
// the fewest letters the kept text has to share with the fresh read before it counts as the same PO
const MIN_HEAD = 60;
// could this description be one the intake cut? Exactly the cut length, or
// one under it (the cut landed on a space that trimming took off). A hair
// under that only when the raw text has a doubled space or a line break,
// which squashing would have shortened: a description that was simply typed
// to 116 characters is not cut.
export const looksCut = (d: string): boolean => {
  const n = squash(d).length;
  if (n === CUT_AT || n === CUT_AT - 1) return true;
  return n >= CUT_AT - 6 && n < CUT_AT - 1 && /\s{2,}|\n/.test(d || "");
};
// the kept text with its last word taken off (the cut usually fell mid-word), letters and digits only
const headOf = (old: string) => norm(squash(old).replace(/\S*$/, ""));
export function betterDescription(old: string, fresh0: string): string | null {
  const fresh = squash(fresh0).slice(0, 600);
  if (!fresh) return null;
  const nf = norm(fresh), no = norm(old);
  if (nf.length <= no.length) return null;
  const head = headOf(old);
  if (head.length < MIN_HEAD || !nf.startsWith(head)) return null;
  return fresh;
}
// why the fresh read was not taken, in the office's words (only asked when betterDescription said no)
export function keptWhy(old: string, fresh0: string): string {
  const fresh = squash(fresh0);
  if (!fresh) return "nothing readable on the PDF";
  const nf = norm(fresh), no = norm(old);
  if (nf === no) return "the PDF says the same thing";
  if (nf.length < no.length) return "the PDF reads shorter than what's on the job";
  return "the PDF's wording doesn't continue what's on the job, left as it is";
}
