export const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(isFinite(n) ? n : 0);
export const parseNum = (v: unknown): number => {
  const n = parseFloat(String(v ?? "").replace(/\.\./g, ".").replace(/[$,\s]/g, ""));
  return isFinite(n) ? n : 0;
};


// every export asks what to call the file — default provided, cancel aborts
export const askFileName = (def: string): string | null => {
  if (typeof window === "undefined") return def;
  const n = window.prompt("Name this file:", def);
  if (n === null) return null;
  const clean = n.trim() || def;
  const ext = (def.match(/\.\w+$/) || [""])[0];
  return ext && !clean.toLowerCase().endsWith(ext.toLowerCase()) ? clean + ext : clean;
};
