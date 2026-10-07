"use client";
import { useEffect } from "react";

// A fixed bar along the bottom that slides up when there is something to
// save: the Save button can never be scrolled out of reach. It stays mounted
// and slides away when there is nothing to save, so the page never jumps.
// While it is up, --bottom-bar lifts the toast above it. Pages using it keep
// pb-24 so nothing hides behind it.
export default function SaveBar({ visible, label, saving = false, onSave, onDiscard, hint }: {
  visible: boolean;
  label: string;
  saving?: boolean;
  onSave: () => void;
  onDiscard?: () => void; // a ghost "Discard" before Save
  hint?: string; // the quiet line on the left; "Not saved yet" when nothing is given
}) {
  useEffect(() => {
    document.documentElement.style.setProperty("--bottom-bar", visible ? "64px" : "0px");
    return () => { document.documentElement.style.setProperty("--bottom-bar", "0px"); };
  }, [visible]);
  return (
    <div aria-hidden={!visible}
      className={`fixed inset-x-0 bottom-0 z-30 border-t-[1.5px] border-ink bg-card px-4 pt-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] shadow-[0_-2px_8px_rgba(23,22,20,0.08)] transition-transform duration-200 ${visible ? "anim-sheet translate-y-0" : "pointer-events-none translate-y-full"}`}>
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
        <div className="truncate text-[13px] text-inksoft">{hint || "Not saved yet"}</div>
        <div className="flex shrink-0 items-center gap-2">
          {onDiscard && (
            <button type="button" className="btn btn-ghost whitespace-nowrap" disabled={!visible || saving} onClick={onDiscard}>Discard</button>
          )}
          <button type="button" className="btn btn-primary min-h-[44px] whitespace-nowrap" disabled={!visible || saving} onClick={onSave}>
            {saving ? "Saving…" : label}
          </button>
        </div>
      </div>
    </div>
  );
}
