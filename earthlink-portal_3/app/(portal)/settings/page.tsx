"use client";
import { useEffect, useState } from "react";
import { sb } from "@/lib/supabase";
import type { Org } from "@/lib/docs";

const FIELDS: [keyof Org, string][] = [
  ["company", "Company name"], ["address1", "Street address"], ["address2", "City, State ZIP"],
  ["phone", "Phone"], ["email", "Email"], ["license", "License # (shows on documents)"], ["terms", "Payment terms (e.g. Net 30)"],
];

export default function Settings() {
  const [org, setOrg] = useState<Org | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => { sb().from("org").select("*").single().then(({ data }) => data && setOrg(data as Org)); }, []);
  const save = async (k: keyof Org, v: string) => {
    if (!org) return;
    const { error } = await sb().from("org").update({ [k]: v }).eq("id", 1);
    setMsg(error ? error.message : "Saved"); setTimeout(() => setMsg(""), 2000);
  };
  if (!org) return <div className="text-sm text-inksoft">Loading…</div>;
  return (
    <div>
      <div className="mb-3 font-display text-2xl font-bold uppercase">Settings</div>
      <div className="card grid gap-3 p-4 md:grid-cols-2">
        {FIELDS.map(([k, label]) => (
          <div key={k}>
            <div className="mb-1 text-[11px] uppercase tracking-widest text-inksoft">{label}</div>
            <input className="field" value={org[k] || ""} onChange={(e) => setOrg({ ...org, [k]: e.target.value })} onBlur={(e) => save(k, e.target.value)} />
          </div>
        ))}
      </div>
      <div className="mt-3 text-xs text-inksoft">Fill the letterhead once — every proposal, invoice, and statement carries it. Fields save when you tap out of them.</div>
      {msg && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-ink px-4 py-2 text-sm text-paper">{msg}</div>}
    </div>
  );
}
