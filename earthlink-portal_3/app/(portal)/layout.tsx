"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { sb } from "@/lib/supabase";
import type { Profile } from "@/lib/types";

// The nav is split by line of business: everything NYCHA lives under one menu,
// everything PACT under another; the day-to-day tabs (Schedule, Payroll) stay
// at the top level.
type Group = { key: "nycha" | "pact"; label: string; items: [string, string][] };

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [menu, setMenu] = useState<"nycha" | "pact" | null>(null);
  const path = usePathname();
  // tapping anywhere outside the nav closes an open menu (phones have no hover-out)
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || !t.closest("[data-navwrap]")) setMenu(null);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menu]);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await sb().auth.getUser();
      if (!user) { window.location.href = "/login"; return; }
      const { data } = await sb().from("profiles").select("id,name,role").eq("id", user.id).single();
      if (data) setProfile(data as Profile);
    })();
  }, []);

  const role = profile?.role;
  const NYCHA: Group = {
    key: "nycha", label: "NYCHA",
    items: [["/releases", "Releases"], ["/items", "Price Book"], ["/proposals", "Proposals"], ["/statements", "Invoices & Statements"]],
  };
  const PACT: Group = { key: "pact", label: "PACT", items: [["/pact", "Jobs"], ["/pact/schedule", "Schedule"]] };
  // entries render in order: plain links and group menus mixed
  const entries: (["link", string, string] | ["group", Group])[] = [["link", "/home", "Home"]];
  if (role === "admin" || role === "office") {
    entries.push(["group", NYCHA], ["group", PACT], ["link", "/schedule", "Schedule"], ["link", "/payroll", "Payroll"], ["link", "/settings", "Settings"]);
  } else if (role === "accountant") {
    entries.push(["link", "/releases", "Releases"], ["link", "/pact", "PACT"], ["link", "/payroll", "Payroll"], ["link", "/statements", "Invoices & Statements"]);
  } else {
    entries.push(["link", "/releases", "Releases"]);
  }
  entries.push(["link", "/help", "Help"]);

  const groupActive = (g: Group) =>
    g.key === "pact" ? path.startsWith("/pact") : g.items.some(([h]) => path === h);
  const tabCls = (active: boolean) =>
    `whitespace-nowrap px-4 py-3 font-display text-[15px] font-semibold uppercase tracking-wider transition-colors duration-150 ${active ? "border-b-[3px] border-work text-work" : "text-inksoft hover:text-ink"}`;
  const openGroup = entries.find((e): e is ["group", Group] => e[0] === "group" && e[1].key === menu)?.[1] || null;

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
      <div className="sticky top-[57px] z-10 border-b-[1.5px] border-ink bg-card" data-navwrap>
        <div className="overflow-x-auto">
          <div className="mx-auto flex max-w-5xl">
            {entries.map((e) => {
              if (e[0] === "link") {
                const [, href, label] = e;
                // hovering a plain tab closes any open menu, same as before
                return (
                  <Link key={href} href={href} prefetch={false} className={tabCls(path === href)}
                    onPointerEnter={(ev) => { if (ev.pointerType === "mouse") setMenu(null); }}>
                    {label}
                  </Link>
                );
              }
              const g = e[1];
              // a tap (phones have no hover) toggles the menu; hover opens it
              return (
                <button key={g.key} type="button" className={tabCls(groupActive(g))}
                  onPointerEnter={(ev) => { if (ev.pointerType === "mouse") setMenu(g.key); }}
                  onClick={() => setMenu((cur) => (cur === g.key ? null : g.key))}>
                  {g.label} ▾
                </button>
              );
            })}
          </div>
        </div>
        {openGroup && (
          /* one slim row in the page flow: nothing gets covered and the page
             barely moves — the menu itself is only as tall as one tab */
          <div className="border-t border-rulesoft bg-paper">
            <div className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-2">
              {openGroup.items.map(([h, l]) => (
                <Link key={h} href={h} prefetch={false} onClick={() => setMenu(null)}
                  className={`whitespace-nowrap px-3 py-2.5 font-display text-[13px] font-semibold uppercase tracking-wider ${path === h ? "text-work" : "text-inksoft hover:text-ink"}`}>
                  {l}
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="mx-auto max-w-5xl px-4 pb-24 pt-5">{children}</div>
    </div>
  );
}
