"use client";
import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { sb } from "@/lib/supabase";
import type { Org } from "@/lib/docs";
import type { Contract, Profile, Role } from "@/lib/types";

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
  const [newUser, setNewUser] = useState({ name: "", email: "", password: "", role: "foreman" as Role });
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
    const newId = data.user?.id;
    if (newId) {
      // the profile row is created automatically; set the display name and role
      const patch: { name?: string; role?: Role } = {};
      if (newUser.name.trim()) patch.name = newUser.name.trim();
      if (newUser.role !== "foreman") patch.role = newUser.role;
      if (Object.keys(patch).length > 0) await sb().from("profiles").update(patch).eq("id", newId);
    }
    setAdding(false); setAddOpen(false);
    setNewUser({ name: "", email: "", password: "", role: "foreman" });
    flash(`Account created — they sign in with that email and password${data.session ? "" : " (if they can't log in yet, they may need to click the confirmation email, or turn off “Confirm email” in Supabase → Authentication → Providers)"}`);
    loadUsers();
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
                    {["foreman", "office", "accountant", "admin"].map((r) => <option key={r} value={r}>{r}</option>)}
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
                <select className="field max-w-[160px]" value={p.role} onChange={(e) => setRole(p.id, e.target.value as Role)}>
                  {["admin", "office", "foreman", "accountant"].map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            ))}
          </div>
          <div className="mt-2 text-xs text-inksoft">
            To add a person: Supabase dashboard → Authentication → Add user (email + password). They appear here after first sign-in — new accounts start as foreman.
          </div>
        </>
      )}

      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
