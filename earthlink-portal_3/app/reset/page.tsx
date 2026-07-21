"use client";
import { useEffect, useState } from "react";
import { sb } from "@/lib/supabase";

// Landing page for the password-reset email link: the link signs the user in
// with a recovery session, and this page sets the new password.
export default function Reset() {
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    sb().auth.getUser().then(({ data: { user } }) => setReady(!!user));
    const { data: sub } = sb().auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") setReady(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const save = async () => {
    if (password.length < 6) { setErr("Password needs at least 6 characters"); return; }
    if (password !== confirm) { setErr("Passwords don't match"); return; }
    setBusy(true); setErr("");
    const { error } = await sb().auth.updateUser({ password });
    if (error) { setErr(error.message); setBusy(false); return; }
    window.location.href = "/";
  };

  return (
    <div className="grid min-h-screen place-items-center p-4">
      <div className="card w-full max-w-sm p-6">
        <div className="font-display text-3xl font-bold uppercase leading-none">Earth Link</div>
        <div className="mb-6 text-[10px] uppercase tracking-[.25em] text-inksoft">Set a new password</div>
        {!ready ? (
          <div className="text-sm text-inksoft">
            Waiting for your reset link… This page only works when opened from the link in the reset email.
            If you got here another way, go back to the <a className="underline" href="/login">sign-in page</a> and tap Forgot password.
          </div>
        ) : (
          <>
            <label className="text-[11px] uppercase tracking-widest text-inksoft">New password</label>
            <input className="field mb-3 mt-1" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <label className="text-[11px] uppercase tracking-widest text-inksoft">Type it again</label>
            <input className="field mb-4 mt-1" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()} />
            {err && <div className="mb-3 text-sm text-alert">{err}</div>}
            <button className="btn btn-primary w-full" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save new password"}</button>
          </>
        )}
      </div>
    </div>
  );
}
