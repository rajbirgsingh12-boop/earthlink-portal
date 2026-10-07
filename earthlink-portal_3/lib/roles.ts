import type { Role } from "./types";

// The one place a role gets its on-screen name. The database keeps the short
// keys; people see these words, in the header, in Settings and in Help.
export const ROLE_LABEL: Record<string, string> = { admin: "Admin 1", office: "Admin 2", accountant: "Accountant", foreman: "Foreman" };

// the roles Settings offers when a user is added or changed, each with what it can do
export const ROLE_OPTIONS: [Role, string][] = [
  ["admin", "Admin 1 (full access)"],
  ["office", "Admin 2 (PACT, no prices)"],
  ["accountant", "Accountant"],
];
