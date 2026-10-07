"use client";
import Link from "next/link";
import ActionMenu, { type ActionItem } from "./ActionMenu";

// Every page opens the same way: the title on the left, at most one primary
// action and one overflow menu on the right. The eye always knows where to go.
// An editor adds a "← Back" before the title and a status stamp beside it.
export default function PageHeader({ title, sub, primary, menu, menuLabel = "⋯", back, stamp, children }: {
  title: string;
  sub?: string; // one quiet line under the title: plain words, no dashes (":" "," "." or " · " instead)
  primary?: React.ReactNode; // exactly one .btn-primary (or a primary ActionMenu)
  menu?: ActionItem[];
  menuLabel?: string;
  back?: { href?: string; onClick?: () => void; label?: string }; // a ghost "← Back" (or the label given) before the title
  stamp?: React.ReactNode; // a <Stamp> beside the title
  children?: React.ReactNode; // at most one extra ghost link/button
}) {
  const backLabel = `← ${back?.label || "Back"}`;
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-3">
        {back && (back.href
          ? <Link href={back.href} className="btn btn-ghost shrink-0" onClick={back.onClick}>{backLabel}</Link>
          : <button type="button" className="btn btn-ghost shrink-0" onClick={back.onClick}>{backLabel}</button>)}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h1 className="font-display text-2xl font-bold uppercase leading-tight">{title}</h1>
            {stamp}
          </div>
          {sub && <div className="text-[12px] text-inksoft">{sub}</div>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {children}
        {primary}
        {menu && menu.length > 0 && <ActionMenu label={menuLabel} items={menu} />}
      </div>
    </div>
  );
}
