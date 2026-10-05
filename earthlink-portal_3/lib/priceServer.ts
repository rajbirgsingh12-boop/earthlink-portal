// Server-only: the price book as Settings saved it, for a line the portal
// adds on its own — the Plaster line a worker's "plaster 120 sf" brings into
// being on a job that had none. The browser reads the same file
// (lib/priceBook readStore); here it is read with the portal's own key,
// since nobody is signed in when Twilio calls. The built-in list's price
// stands in when the file can't be read, so the line is never left at $0.
import { bookFrom, PRICE_BOOK, type PriceStore } from "./priceBook";

const env = (k: string) => process.env[k] || "";
const stamped = (n: string) => Number(n.match(/^list-(\d+)\.json$/)?.[1] || 0);

export async function bookPrice(key: string): Promise<number> {
  const fallback = PRICE_BOOK.find((p) => p.key === key)?.price || 0;
  const url = env("NEXT_PUBLIC_SUPABASE_URL"), svc = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !svc) return fallback;
  const H = { apikey: svc, Authorization: `Bearer ${svc}` };
  try {
    // the newest saved list wins, as the Settings page reads it
    const signal = AbortSignal.timeout(4_000);
    const listed = await fetch(`${url}/storage/v1/object/list/docs`, {
      method: "POST", headers: { ...H, "Content-Type": "application/json" }, signal, cache: "no-store",
      body: JSON.stringify({ prefix: "pricebook", limit: 100, sortBy: { column: "name", order: "desc" } }),
    });
    if (!listed.ok) return fallback;
    const names = ((await listed.json()) as { name?: string }[]).map((f) => f.name || "");
    const newest = names.filter((n) => stamped(n) > 0).sort((a, b) => stamped(b) - stamped(a))[0] || (names.includes("list.json") ? "list.json" : "");
    if (!newest) return fallback;
    const file = await fetch(`${url}/storage/v1/object/docs/pricebook/${newest}`, { headers: H, signal, cache: "no-store" });
    if (!file.ok) return fallback;
    const raw = (await file.json()) as (Partial<PriceStore> & Record<string, unknown>) | null;
    // the first version of this file was just {key: {price}} — still readable
    const store: PriceStore = raw && (raw.overrides || raw.custom)
      ? { overrides: raw.overrides || {}, custom: Array.isArray(raw.custom) ? raw.custom : [] }
      : { overrides: (raw || {}) as PriceStore["overrides"], custom: [] };
    const price = bookFrom(store).find((p) => p.key === key)?.price;
    return typeof price === "number" && price > 0 ? price : fallback;
  } catch { return fallback; }
}
