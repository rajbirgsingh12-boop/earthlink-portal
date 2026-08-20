"use client";
import ActionMenu, { type ActionItem } from "./ActionMenu";

// Every page opens the same way: the title on the left, at most one primary
// action and one overflow menu on the right. The eye always knows where to go.
export default function PageHeader({ title, sub, primary, menu, menuLabel = "⋯", children }: {
  title: string;
  sub?: string; // one quiet line under the title
  primary?: React.ReactNode; // exactly one .btn-primary (or a primary ActionMenu)
  menu?: ActionItem[];
  menuLabel?: string;
  children?: React.ReactNode; // at most one extra ghost link/button
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div>
        <div className="font-display text-2xl font-bold uppercase leading-tight">{title}</div>
        {sub && <div className="text-[12px] text-inksoft">{sub}</div>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {children}
        {primary}
        {menu && menu.length > 0 && <ActionMenu label={menuLabel} items={menu} />}
      </div>
    </div>
  );
}
