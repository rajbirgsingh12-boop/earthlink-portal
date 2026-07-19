"use client";
import { useEffect, useState } from "react";
import { sb } from "@/lib/supabase";
import type { Profile, Role } from "@/lib/types";

export default function Admin() {
  const [me, setMe] = useState<Profile | null>(null);
  const [people, setPeople] = useState<Profile[]>([]);
  const [msg, setMsg] = useState("");

  const load = async () => {
    const { data: { user } } = await sb().auth.getUser();
    if (!user) return;
    const { data: p } = await sb().from("profiles").select("id,name,role").eq("id", user.id).single();
    setMe(p as Profile);
    const { data: all } = await sb().from("profiles").select("id,name,role").order("name");
    setPeople((all || []) as Profile[]);
  };
  useEffect(() => { load(); }, []);

  const setRole = async (id: string, role: Role) => {
    const { error } = await sb().from("profiles").update({ role }).eq("id", id);
    setMsg(error ? error.message : "Updated");
    load();
  };

  if (me && me.role !== "admin") return <div className="text-sm text-inksoft">Admins only.</div>;

  return (
    <div>
      <div className="mb-3 font-display text-2xl font-bold uppercase">Users</div>
      <div className="card divide-y divide-rulesoft">
        {people.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-3 p-3">
            <div className="text-sm font-medium">{p.name || p.id.slice(0, 8)}</div>
            <select className="field max-w-[160px]" value={p.role} onChange={(e) => setRole(p.id, e.target.value as Role)}>
              {["admin", "office", "foreman", "accountant"].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        ))}
      </div>
      {msg && <div className="mt-3 text-sm text-inksoft">{msg}</div>}
      <div className="mt-4 text-xs text-inksoft">
        To add a person: Supabase dashboard → Authentication → Add user (email + password). They appear here after first sign-in; set their role above. New accounts default to foreman.
      </div>
    </div>
  );
}
