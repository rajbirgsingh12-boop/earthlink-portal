// Searching a list on this portal. A price book, a job or a release can
// carry an empty column — a spreadsheet cell nobody filled in comes back as
// nothing at all — and asking a nothing for its letters stops the whole
// search: the box looks broken and the list looks empty. Everything a search
// reads goes through here first.
export const words = (...parts: unknown[]): string =>
  parts.map((p) => (p === null || p === undefined ? "" : String(p))).join(" ").toLowerCase();
// does this row answer what was typed? Nothing typed matches everything.
export const matches = (q: string, ...parts: unknown[]): boolean => {
  const t = (q || "").trim().toLowerCase();
  return t === "" || words(...parts).includes(t);
};
