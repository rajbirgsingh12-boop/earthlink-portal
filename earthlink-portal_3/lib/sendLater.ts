// A crew text set up for later: the office picks a time tonight or tomorrow
// morning, the row is stamped with it, and the text goes out then — written
// fresh at that moment, so if the job moved in between it says the new day.
// Nothing here talks to Twilio; it only marks the crew rows.
import { sb } from "./supabase";

// the day part of a local time, "YYYY-MM-DDTHH:MM" — what <input type="datetime-local"> wants
export const localStamp = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const atHour = (daysAhead: number, hour: number, from = new Date()): Date => {
  const d = new Date(from);
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  return d;
};
// the quick picks: the evening before, and the morning of — the two times a
// crew is actually told. Anything already past is left out.
export const sendPicks = (now = new Date()): { label: string; when: Date }[] => {
  const picks = [
    { label: "Tonight 6 PM", when: atHour(0, 18, now) },
    { label: "Tonight 8 PM", when: atHour(0, 20, now) },
    { label: "Tomorrow 6 AM", when: atHour(1, 6, now) },
    { label: "Tomorrow 7 AM", when: atHour(1, 7, now) },
    { label: "Tomorrow 8 AM", when: atHour(1, 8, now) },
  ];
  return picks.filter((p) => p.when.getTime() > now.getTime() + 60_000);
};
// "Tue 7:00 AM" — the way the screen says a time that hasn't come yet
export const prettyWhen = (iso?: string | null): string => {
  const t = iso ? new Date(iso) : null;
  if (!t || Number.isNaN(t.getTime())) return "";
  const now = new Date();
  const sameDay = t.toDateString() === now.toDateString();
  const tomorrow = t.toDateString() === new Date(now.getTime() + 86400_000).toDateString();
  const clock = t.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return sameDay ? `today ${clock}` : tomorrow ? `tomorrow ${clock}` : `${t.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} ${clock}`;
};
// a row waiting for its time; and one whose time has come and gone unsent
export const isQueued = (r: { send_at?: string | null; texted?: boolean }): boolean => !!(r.send_at && !r.texted);
export const isLate = (r: { send_at?: string | null; texted?: boolean }, now = new Date()): boolean =>
  isQueued(r) && new Date(r.send_at!).getTime() < now.getTime() - 5 * 60_000;

// mark these crew rows to go out at that time (and un-mark TEXTED, so a
// re-send that was set up really does go out)
export async function queueRows(ids: string[], when: Date): Promise<string> {
  if (ids.length === 0) return "No one to set up";
  const { error } = await sb().from("schedule_days").update({ send_at: when.toISOString(), texted: false }).in("id", ids);
  if (!error) return "";
  return /send_at|column|schema cache/i.test(error.message)
    ? "Run supabase/RUN_ME.sql so a text can be set up for later"
    : error.message;
}
export async function unqueueRows(ids: string[]): Promise<string> {
  if (ids.length === 0) return "";
  const { error } = await sb().from("schedule_days").update({ send_at: null }).in("id", ids);
  return error ? error.message : "";
}
// does a set-up text go out on its own (the Vercel timer), or only while
// somebody has the portal open? The picker says which, so nobody is promised
// something this site isn't set up for.
export async function goesOnItsOwn(): Promise<boolean> {
  try {
    const r = await fetch("/api/text-due");
    return r.ok ? !!((await r.json()) as { onItsOwn?: boolean }).onItsOwn : false;
  } catch { return false; }
}
// the catch-up: anything whose time has come goes out now. Called when the
// portal is open — with the Vercel cron set up it has usually gone already.
export type DueReport = { sent: number; missed: number; failed: number; note?: string };
export async function sendDueNow(): Promise<DueReport | null> {
  try {
    const { data: { session } } = await sb().auth.getSession();
    if (!session?.access_token) return null;
    const res = await fetch("/api/text-due", { method: "POST", headers: { Authorization: `Bearer ${session.access_token}` } });
    if (!res.ok) return null;
    const out = (await res.json()) as DueReport;
    return out && typeof out.sent === "number" ? out : null;
  } catch { return null; }
}
