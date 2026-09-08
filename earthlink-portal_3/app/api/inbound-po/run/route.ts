// "📧 Read email now": the site pokes the Gmail script instead of waiting
// for its 10-minute timer. The script is published as a web address (Deploy →
// Web app) and that address goes in Vercel as GMAIL_INTAKE_URL; the shared
// PO_INTAKE_KEY is what lets this route call it. Signed-in admins only.
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;
const env = (k: string) => process.env[k] || "";
const configured = () => !!(env("GMAIL_INTAKE_URL") && env("PO_INTAKE_KEY"));

export async function GET() {
  return NextResponse.json({ configured: configured() });
}

// one account may press the button 10 times in 10 minutes — plenty for a
// person, a wall for a script
const presses = new Map<string, number[]>();
const overLimit = (who: string) => {
  const now = Date.now();
  const kept = (presses.get(who) || []).filter((t) => now - t < 600_000);
  kept.push(now); presses.set(who, kept);
  return kept.length > 10;
};
const callerIp = (req: Request) => (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
// every press goes on the audit trail (best effort — the table exists once RUN_ME.sql has run)
const audit = async (userId: string, after: Record<string, unknown>) => {
  console.log(`[read-email] ${userId} ${JSON.stringify(after).slice(0, 400)}`);
  const key = env("SUPABASE_SERVICE_ROLE_KEY"); if (!key) return;
  try {
    await fetch(`${env("NEXT_PUBLIC_SUPABASE_URL")}/rest/v1/audit_log`, {
      method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, cache: "no-store",
      body: JSON.stringify({ user_id: userId, action: "read_email_now", table_name: "pact_jobs", record_id: null, before: null, after }),
    });
  } catch { /* no audit table yet */ }
};

type ScriptResult = { name?: string; status?: string; po?: string; reason?: string };
type ScriptAnswer = { ok?: boolean; error?: string; since?: string; threads?: number; alreadyImported?: number; results?: ScriptResult[] };

export async function POST(req: Request) {
  if (!configured()) return NextResponse.json({ configured: false, error: "The read-email button isn't set up — publish the Gmail script as a web app and put its address in Vercel as GMAIL_INTAKE_URL" }, { status: 501 });
  // same gate as the PO reader: a signed-in admin or office account
  const supaUrl = env("NEXT_PUBLIC_SUPABASE_URL"), anon = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || !supaUrl || !anon) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const uRes = await fetch(`${supaUrl}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!uRes.ok) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const user = (await uRes.json()) as { id?: string };
  const pRes = await fetch(`${supaUrl}/rest/v1/profiles?id=eq.${user.id}&select=role`, { headers: { apikey: anon, Authorization: `Bearer ${token}` }, cache: "no-store" });
  const role = (pRes.ok ? ((await pRes.json()) as { role?: string }[]) : [])[0]?.role || "";
  if (role !== "admin" && role !== "office") return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  const ip = callerIp(req);
  if (overLimit(user.id || ip)) return NextResponse.json({ error: "That's a lot of presses — the inbox is also checked every 10 minutes on its own. Try again in a few minutes." }, { status: 429 });

  // Apps Script answers a web-app call with a redirect to the page that holds
  // the result — fetch follows it
  const url = `${env("GMAIL_INTAKE_URL").replace(/\/+$/, "")}?key=${encodeURIComponent(env("PO_INTAKE_KEY"))}&run=1`;
  let ans: ScriptAnswer;
  try {
    const r = await fetch(url, { redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(50_000) });
    const text = await r.text();
    try { ans = JSON.parse(text) as ScriptAnswer; } catch {
      return NextResponse.json({ error: /accounts\.google|Sign in/i.test(text) ? "Google asked for a sign-in — the web app must be deployed with access set to \"Anyone\"" : `The Gmail script answered something that isn't its result (${r.status})` }, { status: 502 });
    }
  } catch (e) {
    return NextResponse.json({ error: `Couldn't reach the Gmail script (${e instanceof Error ? e.message.slice(0, 80) : "unknown"})` }, { status: 502 });
  }
  if (!ans.ok) return NextResponse.json({ error: ans.error || "The Gmail script said no" }, { status: 502 });
  const results = ans.results || [];
  const count = (s: string) => results.filter((x) => x.status === s).length;
  await audit(user.id || "", { ip, threads: ans.threads ?? 0, created: count("created"), duplicate: count("duplicate"), skipped: count("skipped"), errors: count("error") });
  return NextResponse.json({
    ok: true, threads: ans.threads ?? 0, alreadyImported: ans.alreadyImported ?? 0, since: ans.since || "",
    created: count("created"), duplicate: count("duplicate"), skipped: count("skipped"), errors: count("error"), results,
  });
}
