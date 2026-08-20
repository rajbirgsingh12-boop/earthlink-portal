"use client";

// A fixed bar along the bottom that appears only when there is something to
// save — the Save button can never be scrolled out of reach. Pages using it
// keep pb-24 so nothing hides behind it.
export default function SaveBar({ visible, label, saving = false, onSave, hint }: {
  visible: boolean;
  label: string;
  saving?: boolean;
  onSave: () => void;
  hint?: string;
}) {
  if (!visible) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t-[1.5px] border-ink bg-card px-4 py-2.5 shadow-[0_-2px_8px_rgba(23,22,20,0.08)]">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
        <div className="truncate text-[13px] text-inksoft">{hint || "You have unsaved changes"}</div>
        <button type="button" className="btn btn-primary min-h-[44px] whitespace-nowrap" disabled={saving} onClick={onSave}>
          {saving ? "Saving…" : label}
        </button>
      </div>
    </div>
  );
}
