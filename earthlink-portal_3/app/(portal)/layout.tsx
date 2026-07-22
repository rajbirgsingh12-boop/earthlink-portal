"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { sb } from "@/lib/supabase";
import type { Profile } from "@/lib/types";

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [pactOpen, setPactOpen] = useState(false); // PACT sub-menu (Jobs / Schedule)
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
    tabs.push(["/items", "Price Book"], ["/proposals", "Proposals"], ["/pact", "PACT"], ["/payroll", "Payroll"], ["/statements", "Invoices & Statements"], ["/settings", "Settings"]);
  } else if (role === "accountant") {
    tabs.push(["/pact", "PACT"], ["/payroll", "Payroll"], ["/statements", "Invoices & Statements"]);
  }
  tabs.push(["/help", "Help"]);

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
      <div className="sticky top-[57px] z-10 border-b-[1.5px] border-ink bg-card" onMouseLeave={() => setPactOpen(false)}>
        <div className="overflow-x-auto">
          <div className="mx-auto flex max-w-5xl">
            {tabs.map(([href, label]) => {
              const cls = `whitespace-nowrap px-4 py-3 font-display text-[15px] font-semibold uppercase tracking-wider transition-colors duration-150 ${(href === "/pact" ? path.startsWith("/pact") : path === href) ? "border-b-[3px] border-work text-work" : "text-inksoft hover:text-ink"}`;
              // the sub-row shows only while the mouse is over PACT (or the row
              // itself); hovering any other tab closes it, clicking navigates
              return (
                <a key={href} href={href} className={cls}
                  onMouseEnter={() => setPactOpen(href === "/pact")}>
                  {label}{href === "/pact" ? " ▾" : ""}
                </a>
              );
            })}
          </div>
        </div>
        {pactOpen && (
          <div className="border-t border-rulesoft bg-paper" onMouseLeave={() => setPactOpen(false)}>
            <div className="mx-auto flex max-w-5xl gap-1 px-2">
              {([["/pact", "Jobs"], ["/pact/schedule", "Schedule"]] as [string, string][]).map(([h, l]) => (
                <a key={h} href={h}
                  className={`whitespace-nowrap px-3 py-2 font-display text-[13px] font-semibold uppercase tracking-wider ${path === h ? "text-work" : "text-inksoft hover:text-ink"}`}>
                  {l}
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="mx-auto max-w-5xl px-4 pb-24 pt-5">{children}</div>
    </div>
  );
}
