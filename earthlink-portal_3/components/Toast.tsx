"use client";
import { useCallback, useEffect, useRef, useState } from "react";

// One flash per page, in one place. The hook keeps the message and its timer;
// the component draws it. A message stays up long enough to be read (2.5s to
// 8s, by its length). "progress" has no timer and sits in the same slot while
// the page is busy. An Undo action lives exactly as long as its toast.
export type ToastAction = { label: string; onClick: () => void };

export function useFlash() {
  const [msg, setMsg] = useState("");
  const [progress, setProgress] = useState("");
  const [action, setAction] = useState<ToastAction | null>(null);
  // one timer, cleared on every call, so a quick second message never gets cut short by the first one's clock
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const dismiss = useCallback(() => { stop(); setMsg(""); setAction(null); }, []);
  const show = useCallback((m: string, a: ToastAction | null) => {
    stop();
    setMsg(m);
    setAction(a);
    if (!m) return;
    timer.current = setTimeout(() => { timer.current = null; setMsg(""); setAction(null); }, Math.min(8000, Math.max(2500, 1800 + m.length * 35)));
  }, []);
  const flash = useCallback((m: string) => show(m, null), [show]);
  // the Undo button runs the given function and takes the toast down with it
  const flashWithUndo = useCallback((m: string, fn: () => void) => show(m, { label: "Undo", onClick: () => { dismiss(); fn(); } }), [show, dismiss]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return { msg, flash, progress, setProgress, action, undo: action, flashWithUndo, dismiss };
}

export function Toast({ msg, progress, action, onDismiss }: {
  msg?: string;
  progress?: string; // shown instead of msg while set; no timer
  action?: ToastAction | null; // an Undo (or similar) button inside the toast
  onDismiss?: () => void;
}) {
  const text = progress || msg || "";
  // a tap takes the toast down; the next message brings it back
  const [hidden, setHidden] = useState(false);
  useEffect(() => { setHidden(false); }, [text]);
  if (!text || hidden) return null;
  return (
    <div role="status" aria-live="polite" className="toast" onClick={() => { setHidden(true); onDismiss?.(); }}>
      {text}
      {action && (
        <button type="button" className="btn-link ml-3 text-paper decoration-paper" onClick={(e) => { e.stopPropagation(); action.onClick(); }}>{action.label}</button>
      )}
    </div>
  );
}

export default Toast;
