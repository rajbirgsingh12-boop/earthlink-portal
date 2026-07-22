export type Role = "admin" | "office" | "foreman" | "accountant";
export interface Profile { id: string; name: string | null; role: Role; }
export interface Contract { id: string; number: string; name: string | null; }
export interface Release {
  id: string; contract_id: string; rel_number: string; location: string; buildings: string;
  ticket: string; amount: number; pre_check: string; date_completed: string;
  payroll_done: boolean; received: boolean; canceled: boolean; labor_hours: number; assigned_to: string | null;
  labor_breakdown?: { cls: string; hours: number }[] | null; address?: string;
  invoice_sent?: string | null; paid_date?: string | null;
  attachments?: { name: string; path: string }[] | null;
  crew?: string[] | null; // employee ids assigned on the Schedule tab
  start_date?: string; finish_date?: string; // schedule dates
  amount_received?: number | null; // partial payments so far
}
