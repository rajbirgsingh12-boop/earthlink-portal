import type { HTMLAttributes } from "react";

// A status word in a bordered box. The key is the label, so a stamp whose
// words change is drawn fresh and scales in (anim-stamp) instead of flipping.
export default function Stamp({ label, tone, glyph, className = "", ...rest }: {
  label: string;
  tone: "ok" | "work" | "alert" | "mute" | "carbon";
  glyph?: string; // one leading glyph, e.g. "⚠"
} & HTMLAttributes<HTMLSpanElement>) {
  const map = { ok: "border-ok text-ok", work: "border-work text-work", alert: "border-alert text-alert", mute: "border-inksoft text-inksoft", carbon: "border-carbon text-carbon" };
  return <span key={label} {...rest} className={`stamp anim-stamp ${map[tone]} ${className}`}>{glyph ? `${glyph} ` : ""}{label}</span>;
}
