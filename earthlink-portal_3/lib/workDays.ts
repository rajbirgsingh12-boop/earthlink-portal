// A PACT job's work days. A job starts on its start_date and runs for
// `work_days` days (pact_jobs.work_days, RUN_ME section 23; 1 when the column
// isn't there yet), Monday to Saturday: a Sunday is never one of its days
// (the start day itself is kept even on a Sunday, when the office put it
// there). Pure: dates are "YYYY-MM-DD" strings, read by the calendar with no
// clock and no time zone, so the browser and the server always agree.

export const MAX_WORK_DAYS = 30;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const shift = (iso: string, n: number): string => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const isSunday = (iso: string): boolean => DAY.test(iso) && new Date(`${iso}T12:00:00Z`).getUTCDay() === 0;
export const isWorkDay = (iso: string): boolean => DAY.test(iso) && !isSunday(iso);
// the first work day after this one (Saturday → Monday)
export const nextWorkDay = (iso: string): string => {
  let d = shift(iso, 1);
  while (isSunday(d)) d = shift(d, 1);
  return d;
};
// n work days on (negative: back), Sundays skipped
export const addWorkDays = (iso: string, n: number): string => {
  let d = iso;
  const step = n < 0 ? -1 : 1;
  for (let i = 0; i < Math.abs(n); i++) {
    d = shift(d, step);
    while (isSunday(d)) d = shift(d, step);
  }
  return d;
};
// how many days a job is: what's saved, kept between 1 and the cap
export const dayCount = (n: unknown): number => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v >= 1 ? Math.min(v, MAX_WORK_DAYS) : 1;
};
// every work day of a job, in order; none when it has no day yet
export const workDaysOf = (start: string | null | undefined, n?: unknown): string[] => {
  const s = (start || "").trim();
  if (!DAY.test(s)) return [];
  const out = [s];
  for (let i = 1; i < dayCount(n); i++) out.push(nextWorkDay(out[i - 1]));
  return out;
};
export const lastWorkDay = (start: string | null | undefined, n?: unknown): string => workDaysOf(start, n).pop() || "";
// how many work days from the start through `last` (the count that makes `last` the job's last day)
// (a Sunday `last` counts the work days up to it: ALL DONE on a Sunday keeps Friday and Saturday)
export const daysThrough = (start: string, last: string): number => {
  if (!DAY.test(start) || !DAY.test(last) || last < start) return 1;
  let n = 0;
  for (let d = start; d <= last && n < MAX_WORK_DAYS; d = nextWorkDay(d)) n++;
  return Math.max(1, n);
};
// which day of the job a date is: 1-based, 0 when it isn't one of its days
export const dayNumber = (start: string | null | undefined, n: unknown, day: string): number => workDaysOf(start, n).indexOf(day) + 1;
// the job's day the photos of `today` belong to: today when it is one of its
// days; after the last day, the last day (pictures sent the evening after, or
// the next morning); before the first day, today
export const currentWorkDay = (start: string | null | undefined, n: unknown, today: string): string => {
  const days = workDaysOf(start, n);
  if (!days.length || days.includes(today)) return today;
  const before = days.filter((d) => d <= today);
  return before.length ? before[before.length - 1] : today;
};
// a job that runs on: the day it continues when it isn't finished (the first
// work day after its last one, but never a day already gone by)
export const continueDay = (last: string, today: string): string => {
  let d = DAY.test(last) ? nextWorkDay(last) : today;
  if (d < today) d = isWorkDay(today) ? today : nextWorkDay(today);
  return d;
};
