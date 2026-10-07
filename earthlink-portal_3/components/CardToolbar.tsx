"use client";
import ActionMenu, { type ActionItem } from "./ActionMenu";

// The footer of a card or modal: one primary, up to two visible secondaries,
// everything else behind a named menu ("Papers", "⋯"). `sticky` pins it to the
// bottom of a long card, clear of the iPhone home indicator.
export default function CardToolbar({ primary, secondary, menu, menuLabel = "⋯", align = "start", sticky = false, className = "" }: {
  primary?: React.ReactNode;
  secondary?: React.ReactNode; // at most two ghost buttons
  menu?: ActionItem[];
  menuLabel?: string;
  align?: "start" | "end";
  sticky?: boolean; // for a long .card-pad card: stays in view at its foot
  className?: string;
}) {
  const stick = sticky
    ? "sticky bottom-0 z-10 -mx-3.5 -mb-3.5 border-t border-rulesoft bg-card px-3.5 pt-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] sm:-mx-4 sm:-mb-4 sm:px-4"
    : "";
  return (
    <div className={`flex flex-wrap items-center gap-2 ${align === "end" ? "justify-end" : ""} ${stick} ${className}`}>
      {primary}
      {secondary}
      {menu && menu.length > 0 && <ActionMenu label={menuLabel} items={menu} />}
    </div>
  );
}
