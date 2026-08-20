"use client";
import ActionMenu, { type ActionItem } from "./ActionMenu";

// The footer of a card or modal: one primary, up to two visible secondaries,
// everything else behind a named menu ("Papers", "⋯").
export default function CardToolbar({ primary, secondary, menu, menuLabel = "⋯", className = "" }: {
  primary?: React.ReactNode;
  secondary?: React.ReactNode; // at most two ghost buttons
  menu?: ActionItem[];
  menuLabel?: string;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {primary}
      {secondary}
      {menu && menu.length > 0 && <ActionMenu label={menuLabel} items={menu} />}
    </div>
  );
}
