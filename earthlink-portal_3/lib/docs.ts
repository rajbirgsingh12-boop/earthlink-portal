import { sb } from "./supabase";

export interface LineItem { id?: string; code: string; description: string; unit: string; qty: number; unit_price: number; sort?: number; }
export interface Org { company: string; address1: string; address2: string; phone: string; email: string; license: string; terms: string; }

export const lineTotal = (it: LineItem) => (Number(it.qty) || 0) * (Number(it.unit_price) || 0);
export const subTotal = (items: LineItem[]) => items.reduce((s, it) => s + lineTotal(it), 0);
export const grandTotal = (items: LineItem[], taxPct: number) => subTotal(items) * (1 + (Number(taxPct) || 0) / 100);

// local calendar date as YYYY-MM-DD — toISOString() is UTC, which would roll
// to tomorrow's date during New York evenings
export const localISO = (d: Date = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export async function nextNumber(table: "proposals" | "invoices", prefix: "PROP" | "INV") {
  const year = new Date().getFullYear();
  // number is UNIQUE and rows can be deleted, so count+1 can collide — use max+1
  const { data } = await sb().from(table).select("number").like("number", `${prefix}-${year}-%`)
    .order("number", { ascending: false }).limit(1);
  const top = (data || [])[0] as { number?: string } | undefined;
  const last = top?.number ? parseInt(top.number.split("-").pop() || "0", 10) : 0;
  return `${prefix}-${year}-${String((isFinite(last) ? last : 0) + 1).padStart(3, "0")}`;
}
export const addDays = (iso: string, d: number) => {
  const dt = new Date(iso + "T00:00:00"); dt.setDate(dt.getDate() + d);
  return localISO(dt);
};
export const prettyDate = (iso?: string | null) =>
  iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
