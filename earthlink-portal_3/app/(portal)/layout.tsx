"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { sb } from "@/lib/supabase";
import type { Profile } from "@/lib/types";

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const path = usePathname();

  useEffect(() => {
    (async () => {
      const { data: { user } } = await sb().auth.getUser();
      if (!user) { window.location.href = "/login"; return; }
      const { data } = await sb().from("profiles").select("id,name,role").eq("id", user.id).single();
      if (data) setProfile(data as Profile);
    })();
  }, []);

  const role = profile?.role;
  const tabs: [string, string][] = [["/", "Home"], ["/releases", "Releases"]];
  if (role === "admin" || role === "office") {
    tabs.push(["/items", "Price Book"], ["/proposals", "Proposals"], ["/payroll", "Payroll"], ["/statements", "Statements"], ["/settings", "Settings"]);
  } else if (role === "accountant") {
    tabs.push(["/payroll", "Payroll"], ["/statements", "Statements"]);
  }
  if (role === "admin") tabs.push(["/admin", "Users"]);

  return (
    <div className="min-h-screen">
      <div className="sticky top-0 z-20 bg-ink px-4 py-3 text-paper">
        <div className="mx-auto flex max-w-5xl items-baseline justify-between">
          <div>
            <div className="font-display text-2xl font-bold uppercase leading-none">Earth Link</div>
            <div className="text-[10px] uppercase tracking-[.25em] text-[#A9A69C]">Field Office</div>
          </div>
          <div className="flex items-center gap-3 text-xs text-[#A9A69C]">
            <span>{profile?.name || ""} · {profile?.role || ""}</span>
            <button className="underline" onClick={async () => { await sb().auth.signOut(); window.location.href = "/login"; }}>Sign out</button>
          </div>
        </div>
      </div>
      <div className="sticky top-[57px] z-10 overflow-x-auto border-b-[1.5px] border-ink bg-card">
        <div className="mx-auto flex max-w-5xl">
          {tabs.map(([href, label]) => (
            <a key={href} href={href}
              className={`whitespace-nowrap px-4 py-3 font-display text-[15px] font-semibold uppercase tracking-wider ${path === href ? "border-b-[3px] border-work text-work" : "text-inksoft"}`}>
              {label}
            </a>
          ))}
        </div>
      </div>
      <div className="mx-auto max-w-5xl px-4 pb-24 pt-5">{children}</div>
    </div>
  );
}
