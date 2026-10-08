"use client";
import Link from "next/link";
import ActionMenu, { type ActionItem } from "./ActionMenu";

// Every page opens the same way: the title on the left, at most one primary
// action and one overflow menu on the right. The eye always knows where to go.
// An editor adds a "← Back" before the title and a status stamp beside it.
// On a phone the actions take the full width in one fixed shape: the ghost
// (stretched) and the ⋯ on the first row, the primary full width on the second,
// nearest the thumb. From sm up they sit on one line as before.
// the classes that stretch a child (a .btn, or an ActionMenu's wrapper and the .btn inside it) on phones only
const STRETCH = "[&>*]:w-full [&_.btn]:w-full sm:[&>*]:w-auto sm:[&_.btn]:w-auto";
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
  const hasMenu = !!menu && menu.length > 0;
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
      {(children || primary || hasMenu) && (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
          {children && <div className={`flex min-w-0 flex-1 sm:flex-none ${STRETCH}`}>{children}</div>}
          {primary && <div className={`order-last basis-full sm:order-none sm:basis-auto ${STRETCH}`}>{primary}</div>}
          {hasMenu && <ActionMenu label={menuLabel} items={menu!} className="ml-auto shrink-0 sm:ml-0" />}
        </div>
      )}
    </div>
  );
}
