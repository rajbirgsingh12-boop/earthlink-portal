"use client";
import { useEffect, useRef, useState, type HTMLAttributes } from "react";

// A status word in a bordered box. It pops (anim-stamp) when its words change,
// not on first paint: a list of twenty stamps arrives quietly, the one that
// just flipped jumps.
export default function Stamp({ label, tone, glyph, className = "", ...rest }: {
  label: string;
  tone: "ok" | "work" | "alert" | "mute" | "carbon";
  glyph?: string; // one leading glyph, e.g. "⚠"
} & HTMLAttributes<HTMLSpanElement>) {
  const prev = useRef(label);
  const [pop, setPop] = useState(0);
  useEffect(() => { if (prev.current !== label) { prev.current = label; setPop((n) => n + 1); } }, [label]);
  const map = { ok: "border-ok text-ok", work: "border-work text-work", alert: "border-alert text-alert", mute: "border-inksoft text-inksoft", carbon: "border-carbon text-carbon" };
  return <span key={pop} {...rest} className={`stamp ${pop ? "anim-stamp" : ""} ${map[tone]} ${className}`}>{glyph ? `${glyph} ` : ""}{label}</span>;
}
