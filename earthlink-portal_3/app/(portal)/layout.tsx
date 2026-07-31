"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { sb } from "@/lib/supabase";
import type { Profile } from "@/lib/types";

// The nav is split by line of business: everything NYCHA lives under one menu,
// everything PACT under another; the day-to-day tabs (Schedule, Payroll) stay
// at the top level.
type Group = { key: "nycha" | "pact"; label: string; items: [string, string, string][] };

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [menu, setMenu] = useState<"nycha" | "pact" | null>(null);
  const [menuX, setMenuX] = useState(8);
  const path = usePathname();
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menu]);
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
    items: [["/releases", "Releases", "📄"], ["/items", "Price Book", "📗"], ["/proposals", "Proposals", "📋"], ["/statements", "Invoices & Statements", "🧾"]],
  };
  const PACT: Group = { key: "pact", label: "PACT", items: [["/pact", "Jobs", "🏢"], ["/pact/schedule", "Schedule", "📅"]] };
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
  // the panel sits under its own tab; the position is measured when it opens
  const openAt = (key: "nycha" | "pact", el: HTMLElement) => {
    const wrap = el.closest("[data-navwrap]") as HTMLElement | null;
    const x = wrap ? el.getBoundingClientRect().left - wrap.getBoundingClientRect().left : 8;
    setMenuX(Math.max(8, Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 9999) - 268)));
    setMenu(key);
  };
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
      <div className="sticky top-[57px] z-10 border-b-[1.5px] border-ink bg-card relative" data-navwrap>
        <div className="overflow-x-auto">
          <div className="mx-auto flex max-w-5xl">
            {entries.map((e) => {
              if (e[0] === "link") {
                const [, href, label] = e;
                // hovering a plain tab closes any open menu, same as before
                return (
                  <Link key={href} href={href} className={tabCls(path === href)}
                    onPointerEnter={(ev) => { if (ev.pointerType === "mouse") setMenu(null); }}>
                    {label}
                  </Link>
                );
              }
              const g = e[1];
              // a tap (phones have no hover) toggles the menu; hover opens it
              return (
                <button key={g.key} type="button" className={`${tabCls(groupActive(g))} inline-flex items-center gap-1.5`}
                  aria-expanded={menu === g.key} aria-haspopup="menu"
                  onPointerEnter={(ev) => { if (ev.pointerType === "mouse") openAt(g.key, ev.currentTarget); }}
                  onClick={(ev) => (menu === g.key ? setMenu(null) : openAt(g.key, ev.currentTarget))}>
                  {g.label}
                  <span className={`text-[10px] transition-transform duration-150 ${menu === g.key ? "rotate-180" : ""}`}>▾</span>
                </button>
              );
            })}
          </div>
        </div>
        {openGroup && (
          /* floating panel anchored under its tab — the page never shifts and a
             tap outside (or Esc, or picking a page) dismisses it */
          <div role="menu" className="absolute top-full z-30 w-64 border-[1.5px] border-ink bg-paper shadow-xl"
            style={{ left: menuX }}>
            {openGroup.items.map(([h, l, icon]) => {
              const active = path === h;
              return (
                <Link key={h} href={h} role="menuitem" onClick={() => setMenu(null)}
                  className={`flex items-center gap-2.5 border-b border-rulesoft px-4 py-3 font-display text-[14px] font-semibold uppercase tracking-wider transition-colors last:border-b-0 ${active ? "border-l-[3px] border-l-work bg-work/5 text-work" : "border-l-[3px] border-l-transparent text-inksoft hover:bg-card hover:text-ink"}`}>
                  <span className="text-base leading-none">{icon}</span>
                  {l}
                </Link>
              );
            })}
          </div>
        )}
      </div>
      <div className="mx-auto max-w-5xl px-4 pb-24 pt-5">{children}</div>
    </div>
  );
}
