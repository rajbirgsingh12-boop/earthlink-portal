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
// ---- the crew's clock: New York's, whatever zone the phone or server is in
const NY = "America/New_York";
// "2026-11-20" for a moment, as the crew counts days
export const nyDay = (d: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const nyHour = (d: Date): number =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone: NY, hour: "numeric", hourCycle: "h23" }).format(d)) % 24;
// that hour on that New York day, as a moment (no clock change happens at
// these hours: New York changes at 2 AM)
const nyAt = (day: string, hour: number): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((day || "").trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour + 5); // that hour in winter (UTC-5)
  const ahead = (nyHour(new Date(t)) - hour + 24) % 24;                        // 1 in summer (UTC-4): an hour earlier
  return new Date(t - ahead * 3600_000);
};
// a work day that has gone by: before today in New York (today still counts)
export const dayPassed = (day: string, now = new Date()): boolean => /^\d{4}-\d{2}-\d{2}$/.test((day || "").trim()) && day.trim() < nyDay(now);

// The latest a crew text set up for later can go: noon on the work day, New
// York time. Set for later than that, it would reach the crew after the
// work has started, or about a day that has finished (and the timer drops a
// text whose day has gone by, so it would never go at all). Both Schedules
// and the picker check against this one rule.
export const SEND_CUTOFF_HOUR = 12;
export const latestSend = (day: string): Date | null => nyAt(day, SEND_CUTOFF_HOUR);
// a time is allowed when it is before that: the days before the work day,
// or the work day's own morning
export const sendTimeOk = (day: string, at: Date): boolean => {
  const last = latestSend(day);
  return !!last && !Number.isNaN(at.getTime()) && at.getTime() < last.getTime();
};
// why a time won't do, in plain words; "" when it will
export function sendTimeWhy(day: string, at: Date, now = new Date()): string {
  if (Number.isNaN(at.getTime())) return "That time doesn't look right";
  if (!latestSend(day)) return "Give the job a day first: the crew is texted the day";
  if (dayPassed(day, now)) return "That day has passed. Put the job on a day ahead to text the crew";
  if (sendTimeOk(day, at)) return "";
  return nyDay(at) > day.trim() ? "That's after the job's day. Text them now instead" : "That's too late on the job's day: it has to go before noon. Text them now instead";
}
// is there still a time left to set one up for (a minute from now at the earliest)?
export const sendLaterOpen = (day: string, now = new Date()): boolean => {
  const last = latestSend(day);
  return !!last && last.getTime() > now.getTime() + 60_000;
};
// a row already set up for a time the rule no longer allows (the job was
// moved to an earlier day, say): shown as a warning, never as GOES OUT
export const queuedTooLate = (r: { send_at?: string | null; texted?: boolean }, day: string): boolean =>
  isQueued(r) && !sendTimeOk(day, new Date(r.send_at!));
export const TOO_LATE_WORDS = "That's too late for the job's day: text them now";

// ---- the daily timer: vercel.json runs app/api/text-due at 11:00 UTC ("0 11 * * *").
// A free Vercel plan fires it at any minute of that hour.
export const MORNING_RUN_UTC_HOUR = 11;
// "between 6 and 7 AM": when the timer runs on that day, in New York (an hour later in summer)
export const morningRun = (day?: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((day || "").trim());
  if (!m) return "about 6 to 7 AM (7 to 8 AM in summer)";
  const h = nyHour(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), MORNING_RUN_UTC_HOUR)));
  const clock = (x: number) => `${x % 12 || 12}`;
  return `between ${clock(h)} and ${clock(h + 1)} ${h + 1 < 12 ? "AM" : "PM"}`;
};

// the quick picks: the evening before, and the morning of — the two times a
// crew is actually told. Anything already past is left out, and with the
// work day given, anything later than the rule above allows.
export const sendPicks = (now = new Date(), day?: string): { label: string; when: Date }[] => {
  const picks = [
    { label: "Tonight 6 PM", when: atHour(0, 18, now) },
    { label: "Tonight 8 PM", when: atHour(0, 20, now) },
    { label: "Tomorrow 6 AM", when: atHour(1, 6, now) },
    { label: "Tomorrow 7 AM", when: atHour(1, 7, now) },
    { label: "Tomorrow 8 AM", when: atHour(1, 8, now) },
  ];
  return picks.filter((p) => p.when.getTime() > now.getTime() + 60_000 && (day === undefined || sendTimeOk(day, p.when)));
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
// re-send that was set up really does go out). With the work day given, a
// time later than the rule allows is refused here, whichever box picked it,
// and the answer says why.
export async function queueRows(ids: string[], when: Date, day?: string): Promise<string> {
  if (ids.length === 0) return "No one to set up";
  if (day !== undefined) { const why = sendTimeWhy(day, when); if (why) return why; }
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
export type DueReport = { sent: number; missed: number; failed: number; note?: string; errors?: { to: string; error: string }[] };
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
