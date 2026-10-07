"use client";
import { useEffect, useState } from "react";
import { sb } from "@/lib/supabase";
import { COMPANY, COMPANY_ADDRESS } from "@/lib/company";

// the sign-in errors in plain words; anything unexpected shows as it came
const friendly = (m: string) =>
  /invalid login/i.test(m) ? "Wrong email or password. Try again, or tap Forgot password."
  : /security purposes|rate limit/i.test(m) ? "Too many tries. Wait a minute and try again."
  : m;

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState("");
  const [resetMsg, setResetMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { document.title = "Sign in · Earth Link"; }, []);

  // Already signed in → straight to the portal (was middleware's job).
  useEffect(() => {
    sb().auth.getUser().then(({ data: { user } }) => {
      if (user) window.location.href = "/home";
    });
  }, []);

  // every action starts clean: one message slot, never an old one left behind
  const clear = () => { setErr(""); setResetMsg(""); };

  const signIn = async () => {
    clear(); setBusy(true);
    const { error } = await sb().auth.signInWithPassword({ email, password });
    if (error) { setErr(friendly(error.message)); setBusy(false); return; }
    window.location.href = "/home";
  };

  const forgot = async () => {
    clear();
    if (!email.trim()) { setErr("Type your email above first, then tap Forgot password."); return; }
    setBusy(true);
    const { error } = await sb().auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/reset` });
    setBusy(false);
    if (error) { setErr(friendly(error.message)); return; }
    setResetMsg("Check your email. The reset link opens a page where you set a new password.");
  };

  // passwordless: an existing account gets a one-tap sign-in link by email
  const magicLink = async () => {
    clear();
    if (!email.trim()) { setErr("Type your email above first, then tap Email me a sign-in link."); return; }
    setBusy(true);
    const { error } = await sb().auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/home`, shouldCreateUser: false },
    });
    setBusy(false);
    if (error) { setErr(/not allowed|signups/i.test(error.message) ? "No account with that email. Ask the office to add you." : friendly(error.message)); return; }
    setResetMsg("Check your email and tap the link in it. You're signed in, no password needed.");
  };

  return (
    <div className="min-h-screen p-4">
      {/* public identity block: the site plainly belongs to the registered business */}
      <div className="mx-auto mt-6 max-w-sm text-center">
        <div className="font-display text-3xl font-bold uppercase leading-none">Earth Link</div>
        <div className="mt-1 text-[11px] uppercase tracking-[.2em] text-inksoft">{COMPANY.legalName}</div>
        <div className="mt-3 text-[12px] text-inksoft">
          {COMPANY_ADDRESS}
          <br />
          <a className="btn-link" href={`tel:${COMPANY.phoneHref}`}>{COMPANY.phone}</a>
          {" · "}
          <a className="btn-link" href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>
        </div>
      </div>
      <div className="mx-auto mt-6 grid max-w-sm place-items-center">
        <form className="card w-full max-w-sm p-6" onSubmit={(e) => { e.preventDefault(); signIn(); }}>
          <div className="font-display text-lg font-bold uppercase leading-none">Employee sign-in</div>
          <div className="mb-6 text-[11px] uppercase tracking-[.25em] text-inksoft">Field Office</div>
          <label htmlFor="email" className="section-label">Email</label>
          <input id="email" name="email" type="email" className="field mb-3 mt-1" value={email} onChange={(e) => setEmail(e.target.value)}
            inputMode="email" autoComplete="email" autoCapitalize="none" autoFocus />
          <label htmlFor="password" className="section-label">Password</label>
          <div className="relative mb-4 mt-1">
            <input id="password" name="password" type={showPw ? "text" : "password"} className="field pr-14" value={password}
              onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" enterKeyHint="done" />
            {/* the eye: a 44px tap target sitting inside the field's right edge */}
            <button type="button" className="btn-icon absolute right-1 top-1 border-0 text-[11px] font-semibold uppercase tracking-wider text-inksoft shadow-none"
              aria-label={showPw ? "Hide password" : "Show password"} aria-pressed={showPw} onClick={() => setShowPw((v) => !v)}>
              {showPw ? "Hide" : "Show"}
            </button>
          </div>
          {(err || resetMsg) && <div role={err ? "alert" : "status"} className={`mb-3 text-sm ${err ? "text-alert" : "text-ok"}`}>{err || resetMsg}</div>}
          <button type="submit" className="btn btn-primary w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
          <button type="button" className="btn mt-2.5 w-full" onClick={magicLink} disabled={busy}>Email me a sign-in link</button>
          <button type="button" className="btn-link mt-1 w-full justify-center text-inksoft" onClick={forgot} disabled={busy}>Forgot password?</button>
          <div className="mt-4 text-xs text-inksoft">Accounts are set up by the office. Ask them if you need one.</div>
        </form>
      </div>
      <div className="mx-auto mt-6 max-w-sm text-center text-[11px] text-inksoft">
        <a className="btn-link" href="/legal">Privacy Policy &amp; Text Message Terms</a>
        <div className="mt-1.5">© {new Date().getFullYear()} {COMPANY.legalName} · Staff portal · authorized users only.</div>
      </div>
    </div>
  );
}
