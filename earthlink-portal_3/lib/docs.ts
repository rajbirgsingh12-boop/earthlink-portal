import { sb } from "./supabase";

export interface LineItem { id?: string; code: string; description: string; unit: string; qty: number; unit_price: number; sort?: number; }
export interface Org { company: string; address1: string; address2: string; phone: string; email: string; license: string; terms: string; }

export const lineTotal = (it: LineItem) => (Number(it.qty) || 0) * (Number(it.unit_price) || 0);
export const subTotal = (items: LineItem[]) => items.reduce((s, it) => s + lineTotal(it), 0);
export const grandTotal = (items: LineItem[], taxPct: number) => subTotal(items) * (1 + (Number(taxPct) || 0) / 100);

export async function nextNumber(table: "proposals" | "invoices", prefix: "PROP" | "INV") {
  const year = new Date().getFullYear();
  const { count } = await sb().from(table).select("id", { count: "exact", head: true }).like("number", `${prefix}-${year}-%`);
  return `${prefix}-${year}-${String((count || 0) + 1).padStart(3, "0")}`;
}
export const addDays = (iso: string, d: number) => {
  const dt = new Date(iso + "T00:00:00"); dt.setDate(dt.getDate() + d);
  return dt.toISOString().slice(0, 10);
};
export const prettyDate = (iso?: string | null) =>
  iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
