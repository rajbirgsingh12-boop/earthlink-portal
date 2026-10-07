"use client";
import { useEffect, useState } from "react";
import { sb } from "@/lib/supabase";

// the save errors in plain words; anything unexpected shows as it came
const friendly = (m: string) =>
  /different from the old|same password/i.test(m) ? "That's your old password. Pick a new one."
  : /session|not logged in|jwt|expired/i.test(m) ? "The reset link has expired. Go back to the sign-in page and tap Forgot password again."
  : m;

// Landing page for the password-reset email link: the link signs the user in
// with a recovery session, and this page sets the new password.
export default function Reset() {
  // null while we find out whether the link signed us in; false when it did not
  const [ready, setReady] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { document.title = "New password · Earth Link"; }, []);

  useEffect(() => {
    // the link's sign-in can land a beat after the first check, so a miss
    // waits a moment for the sign-in event before calling it a wrong turn
    let miss: ReturnType<typeof setTimeout> | null = null;
    sb().auth.getUser().then(({ data: { user } }) => {
      if (user) setReady(true);
      else miss = setTimeout(() => setReady((r) => (r === null ? false : r)), 1500);
    });
    const { data: sub } = sb().auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") setReady(true);
    });
    return () => { sub.subscription.unsubscribe(); if (miss) clearTimeout(miss); };
  }, []);

  const save = async () => {
    if (password.length < 6) { setErr("Password needs at least 6 characters"); return; }
    if (password !== confirm) { setErr("Passwords don't match"); return; }
    setBusy(true); setErr("");
    const { error } = await sb().auth.updateUser({ password });
    if (error) { setErr(friendly(error.message)); setBusy(false); return; }
    window.location.href = "/home";
  };

  return (
    <div className="grid min-h-screen place-items-center p-4">
      <div className="card w-full max-w-sm p-6">
        <div className="text-[11px] uppercase tracking-[.25em] text-inksoft">Earth Link · Field Office</div>
        <div className="mb-6 font-display text-lg font-bold uppercase leading-none">Set a new password</div>
        {ready === null ? (
          /* the form's shape while the link is checked */
          <div role="status" aria-busy="true" aria-label="Loading">
            <div className="skeleton mb-3 h-12 w-full" />
            <div className="skeleton h-12 w-full" />
          </div>
        ) : ready === false ? (
          <div className="text-sm text-inksoft">
            This page only works from the link in the reset email. If you got here another way, go back to the sign-in page and tap Forgot password.
            <div className="mt-3"><a className="btn btn-ghost w-full" href="/login">Back to sign-in</a></div>
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); save(); }}>
            <label htmlFor="password" className="section-label">New password</label>
            <input id="password" name="password" type="password" className="field mb-3 mt-1" value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password" autoFocus />
            <label htmlFor="confirm" className="section-label">Type it again</label>
            <input id="confirm" name="confirm" type="password" className="field mb-4 mt-1" value={confirm} onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password" enterKeyHint="done" />
            {err && <div role="alert" className="mb-3 text-sm text-alert">{err}</div>}
            <button type="submit" className="btn btn-primary w-full" disabled={busy}>{busy ? "Saving…" : "Save new password"}</button>
          </form>
        )}
      </div>
    </div>
  );
}
