"use client";
import { useEffect, useState } from "react";
import { sb } from "@/lib/supabase";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // Already signed in → straight to the portal (was middleware's job).
  useEffect(() => {
    sb().auth.getUser().then(({ data: { user } }) => {
      if (user) window.location.href = "/";
    });
  }, []);

  const signIn = async () => {
    setBusy(true); setErr("");
    const { error } = await sb().auth.signInWithPassword({ email, password });
    if (error) { setErr(error.message); setBusy(false); return; }
    window.location.href = "/";
  };

  const [resetMsg, setResetMsg] = useState("");
  const forgot = async () => {
    if (!email.trim()) { setErr("Type your email above first, then tap Forgot password"); return; }
    setErr(""); setBusy(true);
    const { error } = await sb().auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/reset` });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setResetMsg("Check your email — the reset link opens a page to set a new password.");
  };

  return (
    <div className="min-h-screen grid place-items-center p-4">
      <div className="card w-full max-w-sm p-6">
        <div className="font-display text-3xl font-bold uppercase leading-none">Earth Link</div>
        <div className="text-[10px] uppercase tracking-[.25em] text-inksoft mb-6">Field Office</div>
        <label className="text-[11px] uppercase tracking-widest text-inksoft">Email</label>
        <input className="field mb-3 mt-1" value={email} onChange={(e) => setEmail(e.target.value)} inputMode="email" autoCapitalize="none" />
        <label className="text-[11px] uppercase tracking-widest text-inksoft">Password</label>
        <input className="field mb-4 mt-1" type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && signIn()} />
        {err && <div className="mb-3 text-sm text-alert">{err}</div>}
        {resetMsg && <div className="mb-3 text-sm text-ok">{resetMsg}</div>}
        <button className="btn btn-primary w-full" onClick={signIn} disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <button className="mt-3 w-full text-center text-xs text-inksoft underline" onClick={forgot} disabled={busy}>Forgot password?</button>
        <div className="mt-4 text-xs text-inksoft">Accounts are created by the admin. Ask the office if you need one.</div>
      </div>
    </div>
  );
}
