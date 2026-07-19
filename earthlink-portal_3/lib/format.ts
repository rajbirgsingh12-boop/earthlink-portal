export const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(isFinite(n) ? n : 0);
export const parseNum = (v: unknown): number => {
  const n = parseFloat(String(v ?? "").replace(/\.\./g, ".").replace(/[$,\s]/g, ""));
  return isFinite(n) ? n : 0;
};
