export type Role = "admin" | "office" | "foreman" | "accountant";
export interface Profile { id: string; name: string | null; role: Role; }
export interface Contract { id: string; number: string; name: string | null; }
export interface Release {
  id: string; contract_id: string; rel_number: string; location: string; buildings: string;
  ticket: string; amount: number; pre_check: string; date_completed: string;
  payroll_done: boolean; received: boolean; canceled: boolean; labor_hours: number; assigned_to: string | null;
}
