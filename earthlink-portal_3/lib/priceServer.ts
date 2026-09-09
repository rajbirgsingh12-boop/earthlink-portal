// The price book, read on the server — for the email intake, which has no
// signed-in person and no browser client. Same file the phone reads
// (pricebook/list-<stamp>.json in the docs bucket), same bookFrom().
import { bookFrom, EMPTY_STORE, PRICE_BOOK, type PriceItem, type PriceStore, type PriceOverrides } from "./priceBook";

const env = (k: string) => process.env[k] || "";
const base = () => env("NEXT_PUBLIC_SUPABASE_URL").replace(/\/+$/, "");
const auth = () => ({ apikey: env("SUPABASE_SERVICE_ROLE_KEY"), Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}` });
const stamped = (name: string) => Number(name.match(/^list-(\d+)\.json$/)?.[1] || 0);

export async function loadPricesServer(): Promise<{ items: PriceItem[]; ok: boolean }> {
  if (!env("SUPABASE_SERVICE_ROLE_KEY") || !base()) return { items: PRICE_BOOK, ok: false };
  try {
    const lr = await fetch(`${base()}/storage/v1/object/list/docs`, {
      method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, cache: "no-store",
      body: JSON.stringify({ prefix: "pricebook", limit: 100, sortBy: { column: "name", order: "desc" } }),
    });
    if (!lr.ok) return { items: PRICE_BOOK, ok: false };
    const listed = (await lr.json()) as { name: string }[];
    const versions = listed.filter((f) => stamped(f.name) > 0).sort((a, b) => stamped(b.name) - stamped(a.name));
    const newest = versions[0]?.name || (listed.some((f) => f.name === "list.json") ? "list.json" : null);
    if (!newest) return { items: bookFrom(EMPTY_STORE), ok: true }; // never saved any — the standard sheet
    const dr = await fetch(`${base()}/storage/v1/object/docs/pricebook/${newest}`, { headers: auth(), cache: "no-store" });
    if (!dr.ok) return { items: PRICE_BOOK, ok: false };
    const raw = (await dr.json()) as Partial<PriceStore> & PriceOverrides;
    const store: PriceStore = raw && (raw.overrides || raw.custom)
      ? { overrides: raw.overrides || {}, custom: Array.isArray(raw.custom) ? raw.custom : [], ...(raw.attn ? { attn: raw.attn } : {}) }
      : { overrides: (raw || {}) as PriceOverrides, custom: [] };
    return { items: bookFrom(store), ok: true };
  } catch { return { items: PRICE_BOOK, ok: false }; }
}
