"use client";
import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx-js-style";
import { useLive } from "@/lib/useLive";
import { sb } from "@/lib/supabase";
import { askFileName } from "@/lib/format";
import type { Org } from "@/lib/docs";
import type { Contract, Profile, Role } from "@/lib/types";

// the two roles: Admin 1 sees everything; Admin 2 sees everything except
// PACT invoices (internally these are the existing admin/office roles)
const ROLE_OPTIONS: [Role, string][] = [
  ["admin", "Admin 1 — full access"],
  ["office", "Admin 2 — no PACT invoices"],
];

const FIELDS: [keyof Org, string][] = [
  ["company", "Company name"], ["address1", "Street address"], ["address2", "City, State ZIP"],
  ["phone", "Phone"], ["email", "Email"], ["license", "License # (shows on documents)"], ["terms", "Payment terms (e.g. Net 30)"],
];

export default function Settings() {
  const [org, setOrg] = useState<Org | null>(null);
  const [me, setMe] = useState<Profile | null>(null);
  const [people, setPeople] = useState<Profile[]>([]);
  const [msg, setMsg] = useState("");
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 2000); };

  const loadUsers = async () => {
    const { data: { user } } = await sb().auth.getUser();
    if (!user) return;
    const { data: p } = await sb().from("profiles").select("id,name,role").eq("id", user.id).single();
    setMe(p as Profile);
    if ((p as Profile)?.role === "admin") {
      const { data: all } = await sb().from("profiles").select("id,name,role").order("name");
      setPeople((all || []) as Profile[]);
    }
  };
  const [contracts, setContracts] = useState<Contract[]>([]);
  useEffect(() => {
    sb().from("org").select("*").single().then(({ data }) => data && setOrg(data as Org));
    sb().from("contracts").select("id,number,name").order("number").then(({ data }) => setContracts((data || []) as Contract[]));
    loadUsers();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // live: user list and contract names stay current across devices
  useLive(["profiles", "contracts"], () => {
    loadUsers();
    sb().from("contracts").select("id,number,name").order("number").then(({ data }) => setContracts((data || []) as Contract[]));
  }, { skipWhileTyping: true });

  const renameContract = async (c: Contract, name: string) => {
    const clean = name.trim() || c.number; // blank = back to the number
    const { error } = await sb().from("contracts").update({ name: clean }).eq("id", c.id);
    flash(error ? error.message : "Contract name saved");
    setContracts((prev) => prev.map((x) => (x.id === c.id ? { ...x, name: clean } : x)));
  };

  const save = async (k: keyof Org, v: string) => {
    if (!org) return;
    const { error } = await sb().from("org").update({ [k]: v }).eq("id", 1);
    flash(error ? error.message : "Saved");
  };
  const setRole = async (id: string, role: Role) => {
    const { error } = await sb().from("profiles").update({ role }).eq("id", id);
    flash(error ? error.message : "Role updated");
    loadUsers();
  };

  const [addOpen, setAddOpen] = useState(false);
  const [newUser, setNewUser] = useState({ name: "", email: "", password: "", role: "office" as Role });
  const [adding, setAdding] = useState(false);
  const addUser = async () => {
    if (!newUser.email || newUser.password.length < 6) { flash("Enter an email and a password of at least 6 characters"); return; }
    setAdding(true);
    // separate throwaway client so creating the account never touches YOUR login
    const temp = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data, error } = await temp.auth.signUp({ email: newUser.email.trim(), password: newUser.password });
    if (error) { setAdding(false); flash(error.message); return; }
    // Supabase hides duplicate emails behind a fake user with no identities
    if (data.user && (data.user.identities?.length ?? 0) === 0) {
      setAdding(false); flash("That email already has an account — change their role in the list below instead."); return;
    }
    const newId = data.user?.id;
    if (newId) {
      // the profile row is created automatically; set the display name and role
      const patch: { name?: string; role?: Role } = {};
      if (newUser.name.trim()) patch.name = newUser.name.trim();
      patch.role = newUser.role;
      if (Object.keys(patch).length > 0) await sb().from("profiles").update(patch).eq("id", newId);
    }
    setAdding(false); setAddOpen(false);
    setNewUser({ name: "", email: "", password: "", role: "office" });
    flash(`Account created — they sign in with that email and password${data.session ? "" : " (if they can't log in yet, they may need to click the confirmation email, or turn off “Confirm email” in Supabase → Authentication → Providers)"}`);
    loadUsers();
  };

  // ---------- system check: is every upgrade in place? ----------
  // ---------- full backup: the whole business in one workbook ----------
  const [backingUp, setBackingUp] = useState(false);
  const allOf = async (table: string): Promise<Record<string, unknown>[]> => {
    const out: Record<string, unknown>[] = [];
    let from = 0;
    for (;;) {
      const { data } = await sb().from(table).select("*").range(from, from + 999);
      if (!data || data.length === 0) break;
      out.push(...(data as Record<string, unknown>[]));
      if (data.length < 1000) break;
      from += 1000;
    }
    return out;
  };
  const downloadBackup = async () => {
    setBackingUp(true);
    try {
      const [cs, rels, emps, wks, ents, pact, props] = await Promise.all([
        allOf("contracts"), allOf("releases"), allOf("employees"),
        allOf("timesheet_weeks"), allOf("timesheet_entries"), allOf("pact_jobs"), allOf("proposals"),
      ]);
      const cNum = new Map(cs.map((c) => [c.id, `${c.number}`]));
      const eName = new Map(emps.map((e) => [e.id, `${e.name}`]));
      const wEnd = new Map(wks.map((w) => [w.id, `${w.week_ending}`]));
      const wb = XLSX.utils.book_new();
      const add = (name: string, rows: Record<string, unknown>[]) =>
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ note: "nothing here yet" }]), name);
      add("Contracts", cs.map((c) => ({ Contract: c.number, Name: c.name })));
      add("Releases", rels.map((r) => ({
        Contract: cNum.get(r.contract_id as string) || "", Release: r.rel_number, Development: r.location,
        Address: r.buildings || r.address || "", Ticket: r.ticket, Amount: Number(r.amount) || 0,
        Received: r.received ? "yes" : "", "Paid date": r.paid_date || "",
        Invoiced: r.invoice_sent || "", "Payroll done": r.payroll_done ? "yes" : "", "Labor hrs": Number(r.labor_hours) || 0,
        Start: r.start_date || "", Finish: r.finish_date || "", Canceled: r.canceled ? "yes" : "",
      })));
      add("Payroll", ents.map((en) => {
        const hours = ((en.hours as number[]) || []).map((h) => Number(h) || 0);
        return {
          "Week ending": wEnd.get(en.week_id as string) || "", Worker: eName.get(en.employee_id as string) || "?",
          Classification: (en.trade as string) || "", Job: en.job_label || "",
          Sat: hours[0] || 0, Sun: hours[1] || 0, Mon: hours[2] || 0, Tue: hours[3] || 0,
          Wed: hours[4] || 0, Thu: hours[5] || 0, Fri: hours[6] || 0,
          Total: hours.reduce((s, h) => s + h, 0),
        };
      }).sort((a, b) => `${a["Week ending"]}${a.Worker}`.localeCompare(`${b["Week ending"]}${b.Worker}`)));
      add("Crew", emps.filter((e) => e.active !== false).map((e) => ({ Name: e.name, Classification: e.trade || "" })));
      add("PACT", pact.map((j) => ({
        Partner: j.partner, PO: j.po_number || j.job_number || "", Address: j.address || "",
        Description: j.description || "", Amount: Number(j.amount) || 0, Approved: j.approved ? "yes" : "",
        "Work done": j.work_done ? "yes" : "", Invoiced: j.invoice_sent || "", Paid: j.received ? "yes" : "",
        Start: j.start_date || "", Finish: j.finish_date || "", Canceled: j.canceled ? "yes" : "",
      })));
      add("Walk sheets", props.map((p) => ({
        Number: p.number, Name: p.job || "", Contract: cNum.get(p.contract_id as string) || "",
        Development: p.development || "", "Release #": p.release_number || "", Status: p.status, Total: Number(p.total) || 0,
      })));
      const fname = askFileName(`earthlink_backup_${new Date().toISOString().slice(0, 10)}.xlsx`);
      if (fname) XLSX.writeFile(wb, fname);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Backup failed");
    }
    setBackingUp(false);
  };

  type CheckResult = { label: string; fix: string; ok: boolean };
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [checking, setChecking] = useState(false);
  const runSystemCheck = async () => {
    setChecking(true); setChecks(null);
    const probes: { label: string; fix: string; probe: () => Promise<boolean> }[] = [
      { label: "Release line items", fix: "upgrade_invoices_aging_docs.sql", probe: async () => !(await sb().from("release_items").select("id").limit(1)).error },
      { label: "Release aging & attachments", fix: "upgrade_invoices_aging_docs.sql", probe: async () => !(await sb().from("releases").select("invoice_sent,paid_date,attachments,address").limit(1)).error },
      { label: "Document & photo storage", fix: "upgrade_invoices_aging_docs.sql", probe: async () => !(await sb().storage.from("docs").list("", { limit: 1 })).error },
      { label: "Contract price books", fix: "upgrade_proposal_creator.sql", probe: async () => !(await sb().from("contract_items").select("id").limit(1)).error },
      { label: "Walk sheet fields & autosave", fix: "upgrade_proposal_creator.sql", probe: async () => !(await sb().from("proposals").select("qty_map,nycha_staff,start_date,release_number,total").limit(1)).error },
      { label: "Price book line numbers", fix: "upgrade_proposal_creator.sql", probe: async () => !(await sb().from("price_items").select("line").limit(1)).error },
      { label: "Payroll paid marks", fix: "upgrade_payroll_paid.sql", probe: async () => !(await sb().from("timesheet_weeks").select("paid_map").limit(1)).error },
      { label: "Payroll entry classifications", fix: "upgrade_payroll_class.sql", probe: async () => !(await sb().from("timesheet_entries").select("trade").limit(1)).error },
      { label: "Schedule (crew & start/finish dates)", fix: "upgrade_schedule.sql", probe: async () => !(await sb().from("releases").select("crew,start_date,finish_date").limit(1)).error && !(await sb().from("pact_jobs").select("start_date,finish_date").limit(1)).error },
      { label: "PACT jobs & invoicing", fix: "upgrade_pact.sql", probe: async () => !(await sb().from("pact_jobs").select("id,po_number,items,tax_pct,invoice_number").limit(1)).error },
    ];
    const results: CheckResult[] = [];
    for (const p of probes) {
      let ok = false;
      try { ok = await p.probe(); } catch { ok = false; }
      results.push({ label: p.label, fix: p.fix, ok });
    }
    setChecks(results); setChecking(false);
  };

  if (!org) return <div className="text-sm text-inksoft">Loading…</div>;
  return (
    <div>
      <div className="mb-3 font-display text-2xl font-bold uppercase">Settings</div>

      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">Company letterhead</div>
      <div className="card grid gap-3 p-4 md:grid-cols-2">
        {FIELDS.map(([k, label]) => (
          <div key={k}>
            <div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">{label}</div>
            <input className="field" value={org[k] || ""} onChange={(e) => setOrg({ ...org, [k]: e.target.value })} onBlur={(e) => save(k, e.target.value)} />
          </div>
        ))}
      </div>
      <div className="mt-2 text-xs text-inksoft">Every proposal, SOS, and statement carries this letterhead. Fields save when you tap out of them.</div>

      {contracts.length > 0 && (
        <>
          <div className="mb-2 mt-6 text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">Contract names</div>
          <div className="card divide-y divide-rulesoft">
            {contracts.map((c) => (
              <div key={c.id} className="flex items-center gap-3 p-3">
                <span className="w-28 shrink-0 font-mono text-[13px] font-semibold">{c.number}</span>
                <input className="field" placeholder={`e.g. Queensbridge IDIQ`} defaultValue={c.name && c.name !== c.number ? c.name : ""}
                  onBlur={(e) => renameContract(c, e.target.value)} />
              </div>
            ))}
          </div>
          <div className="mt-2 text-xs text-inksoft">Give contracts a name you recognize — dropdowns everywhere show the name instead of just the number. Leave blank to show the number.</div>
        </>
      )}

      {me?.role === "admin" && (
        <>
          <div className="mb-2 mt-6 flex items-baseline justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">Users &amp; roles</div>
            <button className="btn btn-ghost px-3 py-1.5 text-[13px]" onClick={() => setAddOpen(!addOpen)}>+ Add user</button>
          </div>
          {addOpen && (
            <div className="card mb-3 border-work p-3.5">
              <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
                <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Name</div>
                  <input className="field" value={newUser.name} onChange={(e) => setNewUser({ ...newUser, name: e.target.value })} /></div>
                <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Email</div>
                  <input className="field" inputMode="email" autoCapitalize="none" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} /></div>
                <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Password</div>
                  <input className="field" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} /></div>
                <div><div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">Role</div>
                  <select className="field" value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value as Role })}>
                    {ROLE_OPTIONS.map(([r, label]) => <option key={r} value={r}>{label}</option>)}
                  </select></div>
              </div>
              <div className="mt-3 flex gap-2">
                <button className="btn btn-primary" onClick={addUser} disabled={adding}>{adding ? "Creating…" : "Create account"}</button>
                <button className="btn btn-ghost" onClick={() => setAddOpen(false)}>Cancel</button>
              </div>
              <div className="mt-2 text-xs text-inksoft">Give them this email + password to sign in. You can change their role any time below.</div>
            </div>
          )}
          <div className="card divide-y divide-rulesoft">
            {people.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 p-3">
                <div className="text-sm font-medium">{p.name || p.id.slice(0, 8)}{p.id === me.id && <span className="ml-2 text-[11px] text-inksoft">(you)</span>}</div>
                <select className="field max-w-[220px]" value={p.role} onChange={(e) => setRole(p.id, e.target.value as Role)}>
                  {ROLE_OPTIONS.map(([r, label]) => <option key={r} value={r}>{label}</option>)}
                  {!ROLE_OPTIONS.some(([r]) => r === p.role) && <option value={p.role}>{p.role} (legacy)</option>}
                </select>
              </div>
            ))}
          </div>
          <div className="mt-2 text-xs text-inksoft">
            To add a person: Supabase dashboard → Authentication → Add user (email + password). They appear here after first sign-in — new accounts start as foreman.
          </div>
        </>
      )}

      <div className="mb-2 mt-6 flex items-baseline justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">Backup</div>
        <button className="btn btn-ghost px-3 py-1.5 text-[13px]" onClick={downloadBackup} disabled={backingUp}>{backingUp ? "Building…" : "Download full backup (xlsx)"}</button>
      </div>
      <div className="card p-3.5 text-sm text-inksoft">
        One Excel workbook with everything — contracts, releases (with payments), every payroll week, the crew, PACT jobs, and walk sheets. Worth downloading every Friday and keeping somewhere safe.
      </div>

      <div className="mb-2 mt-6 flex items-baseline justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-[.15em] text-inksoft">System check</div>
        <button className="btn btn-ghost px-3 py-1.5 text-[13px]" onClick={runSystemCheck} disabled={checking}>{checking ? "Checking…" : "Run system check"}</button>
      </div>
      <div className="card p-3.5">
        {checks === null && !checking && <div className="text-sm text-inksoft">Verifies the database has every upgrade. If something&apos;s missing it names the exact SQL file to paste into Supabase — or just run <span className="font-mono">supabase/RUN_ME.sql</span> to apply everything at once.</div>}
        {checking && <div className="text-sm text-inksoft">Checking…</div>}
        {checks !== null && (
          <>
            {checks.map((c) => (
              <div key={c.label} className="flex items-center justify-between gap-2 border-t border-rulesoft py-2 text-sm first:border-t-0">
                <span>{c.ok ? "✅" : "❌"} {c.label}</span>
                {!c.ok && <span className="font-mono text-xs text-alert">run {c.fix}</span>}
              </div>
            ))}
            <div className="mt-2 border-t border-rulesoft pt-2 text-sm font-semibold">
              {checks.every((c) => c.ok)
                ? <span className="text-ok">Everything is set up — all upgrades are in place. ✓</span>
                : <span className="text-alert">{checks.filter((c) => !c.ok).length} item(s) missing — easiest fix: paste supabase/RUN_ME.sql into the Supabase SQL Editor and Run.</span>}
            </div>
            <div className="mt-1 text-xs text-inksoft">Live updates can&apos;t be auto-verified from here — if screens don&apos;t refresh on their own after everything above is green, run upgrade_realtime.sql (it&apos;s included in RUN_ME.sql).</div>
          </>
        )}
      </div>

      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
