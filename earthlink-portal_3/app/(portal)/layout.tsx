"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { sb } from "@/lib/supabase";
import { myProfile, useProfile, clearMyProfile } from "@/lib/profile";
import { ROLE_LABEL } from "@/lib/roles";
import type { Profile } from "@/lib/types";

// The nav is split by line of business: everything NYCHA lives under one menu,
// everything PACT under another; the day-to-day tabs (Schedule, Payroll) stay
// at the top level.
type Group = { key: "nycha" | "pact"; label: string; items: [string, string, string][] };

// what the browser tab says on each page: the page's own name. The more
// specific route comes before the one above it.
const TITLES: [string, string][] = [
  ["/home", "Home"], ["/releases", "Releases"], ["/items", "Price Book"], ["/proposals", "Proposals"], ["/package", "Invoice Package"],
  ["/pact/schedule", "PACT Schedule"], ["/pact", "PACT Billing"], ["/schedule", "Schedule"],
  ["/payroll/certified", "Certified payroll"], ["/payroll", "Payroll"], ["/settings", "Settings"], ["/admin", "Settings"], ["/help", "Help"],
];

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  // the remembered profile paints the right tabs the moment the page is up; the
  // database's answer corrects them if the role changed
  const { hint, fresh } = useProfile();
  const profile = (fresh || hint) as Profile | null;
  const [menu, setMenu] = useState<"nycha" | "pact" | null>(null);
  const [menuX, setMenuX] = useState(8);
  const [out, setOut] = useState(false);
  // a hover-opened panel closes a beat after the mouse leaves, not the instant it strays
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // the tab under the mouse opened its panel by hovering: the click that follows keeps it open
  const byHover = useRef(false);
  // the panel was opened by a finger: a tap anywhere else closes it and does nothing more
  const touchOpen = useRef(false);
  const path = usePathname();
  const router = useRouter();
  // a page is under a tab when it is that route or one beneath it (Certified payroll lights Payroll)
  const under = (h: string) => path === h || (h !== "/home" && path.startsWith(h + "/"));
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menu]);
  // a click anywhere outside the nav closes an open menu (a finger's tap lands
  // on the backdrop below instead, so nothing under it fires)
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
    // truly signed out: back to the door
    myProfile().then((p) => { if (!p) window.location.href = "/login"; });
  }, []);

  // the browser tab carries the page's name (a print preview takes it over while it is up)
  useEffect(() => {
    const label = TITLES.find(([h]) => under(h))?.[1];
    document.title = label ? `${label} · Earth Link` : "Earth Link Field Office";
  }, [path]);

  // on a phone the strip scrolls sideways: the lit tab is brought into view
  useEffect(() => {
    document.querySelector("[data-navwrap] .text-work")?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [path, profile]);

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  const role = profile?.role;
  const NYCHA: Group = {
    key: "nycha", label: "NYCHA",
    items: [["/releases", "Releases", "📄"], ["/items", "Price Book", "📗"], ["/proposals", "Proposals", "📋"], ["/package", "Invoice Package", "🧾"]],
  };
  // two tabs, kept apart: Billing (POs, prices, invoices) and Schedule (the calendar and the crews)
  const PACT: Group = { key: "pact", label: "PACT", items: [["/pact", "Billing", "🏢"], ["/pact/schedule", "Schedule", "📅"]] };
  // entries render in order: plain links and group menus mixed
  const entries: (["link", string, string] | ["group", Group])[] = [["link", "/home", "Home"]];
  if (role === "admin" || role === "office") {
    // both admins see PACT: Admin 2 works it without prices or invoices
    entries.push(["group", NYCHA], ["group", PACT], ["link", "/schedule", "Schedule"], ["link", "/payroll", "Payroll"], ["link", "/settings", "Settings"]);
  } else if (role === "accountant") {
    entries.push(["link", "/releases", "Releases"], ["link", "/pact", "PACT Billing"], ["link", "/payroll", "Payroll"], ["link", "/package", "Invoice Package"]);
  } else {
    entries.push(["link", "/releases", "Releases"]);
  }
  entries.push(["link", "/help", "Help"]);

  // every page this role can reach is fetched ahead once the page is idle (the
  // group menus' links only exist while a menu is open, and the tabs off the
  // edge of a phone's strip are never seen, so Next's own prefetch misses them):
  // the first tap into Billing, Schedule, Settings or Help then has its chunks
  // and its shell already here
  useEffect(() => {
    if (!role) return;
    const hrefs = entries.flatMap((e) => (e[0] === "link" ? [e[1]] : e[1].items.map(([h]) => h))).filter((h) => h !== path);
    const go = () => { for (const h of hrefs) router.prefetch(h); };
    if (typeof window.requestIdleCallback === "function") {
      const t = window.requestIdleCallback(go, { timeout: 2500 });
      return () => window.cancelIdleCallback(t);
    }
    const t = setTimeout(go, 800);
    return () => clearTimeout(t);
  }, [role]); // eslint-disable-line react-hooks/exhaustive-deps

  const groupActive = (g: Group) => g.items.some(([h]) => under(h));
  // the panel sits under its own tab; the position is measured when it opens
  const openAt = (key: "nycha" | "pact", el: HTMLElement) => {
    const wrap = el.closest("[data-navwrap]") as HTMLElement | null;
    const x = wrap ? el.getBoundingClientRect().left - wrap.getBoundingClientRect().left : 8;
    // the panel is 280px wide (.menu): it never runs off the right edge of a phone
    setMenuX(Math.max(8, Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 9999) - 288)));
    setMenu(key);
  };
  const cancelClose = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; } };
  const closeSoon = (ms: number) => { cancelClose(); closeTimer.current = setTimeout(() => { closeTimer.current = null; setMenu(null); }, ms); };
  const tabCls = (active: boolean) =>
    `whitespace-nowrap border-b-[3px] px-4 py-3 font-display text-[15px] font-semibold uppercase tracking-wider transition-colors duration-150 ${active ? "border-work text-work" : "border-transparent text-inksoft hover:text-ink active:text-ink"}`;
  const openGroup = entries.find((e): e is ["group", Group] => e[0] === "group" && e[1].key === menu)?.[1] || null;
  // in an open panel, the lit row is the most specific route the page is under
  const lit = openGroup ? openGroup.items.filter(([h]) => under(h)).sort((a, b) => b[0].length - a[0].length)[0]?.[0] : undefined;

  const signOut = async () => {
    setOut(true);
    clearMyProfile(); // the remembered profile and everything cached for this sign-in go too
    try { await sb().auth.signOut(); } catch {}
    window.location.href = "/login";
  };

  return (
    <div className="min-h-screen">
      <a href="#main" className="btn sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50">Skip to content</a>
      <div className="sticky top-0 z-20 bg-ink px-4 py-3 text-paper">
        <div className="mx-auto flex max-w-5xl items-baseline justify-between">
          {/* a 44px tap target (4px of padding each side, taken back by the margin so the header never moves) */}
          <Link href="/home" aria-label="Home" className="-my-1 block py-1">
            <div className="font-display text-2xl font-bold uppercase leading-none">Earth Link</div>
            <div className="text-[11px] uppercase tracking-[.25em] text-papersoft">Field Office</div>
          </Link>
          <div className="flex items-center gap-3 text-xs text-papersoft">
            {profile && <span>{[profile.name, ROLE_LABEL[profile.role] || profile.role].filter(Boolean).join(" · ")}</span>}
            {/* the label stays; the kit dims a disabled text button and a screen reader hears "busy" */}
            <button type="button" className="btn-link text-papersoft" disabled={out} aria-busy={out || undefined} onClick={signOut}>Sign out</button>
          </div>
        </div>
      </div>
      <div className="sticky top-[57px] z-10 border-b-[1.5px] border-ink bg-card relative" data-navwrap
        onPointerEnter={cancelClose}
        onPointerLeave={(ev) => { if (ev.pointerType === "mouse" && menu) closeSoon(150); }}>
        <div className="scroll-fade-card overflow-x-auto">
          <div className="mx-auto flex max-w-5xl">
            {profile === null
              /* the tabs depend on the role: placeholders hold the strip's height until it is known */
              ? [0, 1, 2, 3, 4].map((i) => <div key={i} aria-hidden className="skeleton mx-4 my-4 h-4 w-16" />)
              : entries.map((e) => {
                if (e[0] === "link") {
                  const [, href, label] = e;
                  // hovering a plain tab closes any open menu, a beat later
                  return (
                    <Link key={href} href={href} className={tabCls(under(href))}
                      onPointerEnter={(ev) => { if (ev.pointerType === "mouse" && menu) closeSoon(120); }}>
                      {label}
                    </Link>
                  );
                }
                const g = e[1];
                // a tap (phones have no hover) toggles the menu; hover opens it, and
                // the click a mouse makes on the way keeps what hovering opened
                return (
                  <button key={g.key} type="button" className={`${tabCls(groupActive(g))} inline-flex items-center gap-1.5 active:bg-paper`}
                    aria-expanded={menu === g.key} aria-haspopup="menu"
                    onPointerEnter={(ev) => { if (ev.pointerType === "mouse") { cancelClose(); openAt(g.key, ev.currentTarget); } }}
                    onPointerDown={(ev) => { byHover.current = ev.pointerType === "mouse" && menu === g.key; touchOpen.current = ev.pointerType !== "mouse"; }}
                    onClick={(ev) => {
                      if (byHover.current) { byHover.current = false; return; }
                      if (menu === g.key) setMenu(null); else openAt(g.key, ev.currentTarget);
                    }}>
                    {g.label}
                    <span aria-hidden className={`text-[11px] transition-transform duration-150 ${menu === g.key ? "rotate-180" : ""}`}>▾</span>
                  </button>
                );
              })}
          </div>
        </div>
        {/* opened by a finger: the tap that closes it lands here, so a field or a row under it never fires */}
        {openGroup && touchOpen.current && <div aria-hidden className="fixed inset-0 z-20" onClick={() => setMenu(null)} />}
        {openGroup && (
          /* floating panel anchored under its tab: the page never shifts and a
             tap outside (or Esc, or picking a page) dismisses it */
          <div role="menu" className="menu anim-menu absolute top-full z-30 w-64 origin-top-left" style={{ left: menuX }} onPointerEnter={cancelClose}>
            {openGroup.items.map(([h, l, icon]) => {
              const active = h === lit;
              return (
                <Link key={h} href={h} role="menuitem" onClick={() => setMenu(null)}
                  className={`menu-item row-btn flex items-center gap-2.5 border-l-[3px] font-display text-[14px] font-semibold uppercase tracking-wider ${active ? "border-l-work bg-work/5 text-work" : "border-l-transparent text-inksoft hover:text-ink"}`}>
                  <span aria-hidden className="text-base leading-none">{icon}</span>
                  {l}
                </Link>
              );
            })}
          </div>
        )}
      </div>
      <div key={path} id="main" className="page-enter mx-auto max-w-5xl px-4 pb-24 pt-5">{children}</div>
    </div>
  );
}
