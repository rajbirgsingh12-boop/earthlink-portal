"use client";
import { LANG_LABEL, type Lang } from "@/lib/crewText";

// English | Español — the one switch for a worker's texts, wherever their
// name is: the Settings crew list, "Who's going?", the NYCHA day schedule.
// Short (EN | ES) where a row is tight, the whole word where there's room.
export default function LangToggle({ value, onChange, full = false, disabled = false, name = "Language for texts" }: {
  value: Lang; onChange: (l: Lang) => void; full?: boolean; disabled?: boolean; name?: string;
}) {
  return (
    <span className="inline-flex rounded-sm border-[1.5px] border-ink" role="radiogroup" aria-label={name}>
      {(["en", "es"] as Lang[]).map((l, i) => (
        <button key={l} type="button" role="radio" aria-checked={value === l} aria-label={LANG_LABEL[l]} title={`Texts in ${LANG_LABEL[l]}`} disabled={disabled} onClick={() => onChange(l)}
          className={`min-h-[44px] min-w-[44px] font-display text-[12px] font-semibold uppercase tracking-wider ${full ? "px-3" : "px-2"} ${i > 0 ? "border-l-[1.5px] border-ink" : ""} ${value === l ? "bg-ink text-white" : "bg-white text-ink"} disabled:opacity-50`}>
          {full ? LANG_LABEL[l] : l.toUpperCase()}
        </button>
      ))}
    </span>
  );
}
