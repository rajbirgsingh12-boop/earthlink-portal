"use client";
import { LANG_LABEL, type Lang } from "@/lib/crewText";

// English | Español: the one switch for a worker's texts, wherever their
// name is: the Settings crew list, "Who's going?", the NYCHA day schedule.
// Short (EN | ES) where a row is tight, the whole word where there's room.
export default function LangToggle({ value, onChange, full = false, disabled = false, name = "Language for texts" }: {
  value: Lang; onChange: (l: Lang) => void; full?: boolean; disabled?: boolean; name?: string;
}) {
  return (
    <span className="seg" role="radiogroup" aria-label={name}>
      {(["en", "es"] as Lang[]).map((l) => (
        <button key={l} type="button" role="radio" aria-checked={value === l} aria-label={LANG_LABEL[l]} disabled={disabled} onClick={() => { if (l !== value) onChange(l); }}
          className={`seg-item min-w-[44px] ${full ? "px-3" : "px-2"} disabled:cursor-default`}>
          {full ? LANG_LABEL[l] : l.toUpperCase()}
        </button>
      ))}
    </span>
  );
}
