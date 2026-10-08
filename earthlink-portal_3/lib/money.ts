// Whole-dollar figures for the Home band (lib/format.ts keeps the cents for every
// list and total). One formatter, built once, for the same reason as fmt.
const USD0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
export const fmt0 = (n: number) => USD0.format(isFinite(n) ? n : 0);
// short enough for a four-across legend on a phone: $92K, $1.2M, whole dollars under $10,000
export const fmtShort = (n: number) =>
  n >= 1e6 ? "$" + (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
  : n >= 1e4 ? "$" + Math.round(n / 1e3) + "K"
  : fmt0(n);
