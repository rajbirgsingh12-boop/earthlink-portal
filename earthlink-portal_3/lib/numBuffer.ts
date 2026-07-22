"use client";
import { useState } from "react";
import { parseNum } from "./format";

// Controlled numeric inputs eat decimal points: typing "7." re-renders as "7",
// so "7.5" lands as 75. This hook keeps the raw string on screen while a field
// is being typed in, and hands parsed numbers to the caller — live on every
// keystroke (for running totals) and final on blur (for saving).
export function useNumBuffer() {
  const [buf, setBuf] = useState<Record<string, string>>({});
  return (key: string, val: number, onLive: (n: number) => void, onCommit?: (n: number) => void, opts?: { showZero?: boolean }) => ({
    value: buf[key] ?? (val || (opts?.showZero ? "0" : "")),
    onChange: (e: { target: { value: string } }) => {
      setBuf((p) => ({ ...p, [key]: e.target.value }));
      onLive(parseNum(e.target.value));
    },
    onBlur: (e: { target: { value: string } }) => {
      const n = parseNum(e.target.value);
      setBuf((p) => { const q = { ...p }; delete q[key]; return q; });
      onCommit?.(n);
    },
  });
}
