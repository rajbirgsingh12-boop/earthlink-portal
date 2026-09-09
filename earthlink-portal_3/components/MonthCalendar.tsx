"use client";
import { localISO } from "@/lib/docs";

// A month of days, each showing what's booked. Tap a day to see it; arrows
// move a month; today is marked. Built for a thumb: every cell is a button.
export default function MonthCalendar<T extends { id: string }>({ month, onMonth, byDay, selected, onSelect, label }: {
  month: string;                              // "YYYY-MM"
  onMonth: (next: string) => void;
  byDay: Record<string, T[]>;                 // "YYYY-MM-DD" → the items that day
  selected: string;                           // "YYYY-MM-DD"
  onSelect: (day: string) => void;
  label: (item: T) => string;                 // one short line per item
}) {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const lead = first.getDay();               // Sunday first
  const today = localISO(new Date());
  const shift = (d: number) => { const n = new Date(y, m - 1 + d, 1); onMonth(`${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`); };
  const title = first.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`)];
  while (cells.length % 7) cells.push(null);
  return (
    <div className="card p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <button type="button" className="btn btn-ghost min-h-[44px] px-3" aria-label="Previous month" onClick={() => shift(-1)}>←</button>
        <div className="font-display text-[15px] font-bold uppercase tracking-wide">{title}</div>
        <button type="button" className="btn btn-ghost min-h-[44px] px-3" aria-label="Next month" onClick={() => shift(1)}>→</button>
      </div>
      <div className="grid grid-cols-7 gap-px text-center text-[10px] uppercase tracking-widest text-inksoft">
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => <div key={d} className="py-1">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-px">
        {cells.map((day, i) => {
          if (!day) return <div key={`b${i}`} className="min-h-[56px]" />;
          const items = byDay[day] || [];
          const isSel = day === selected, isToday = day === today;
          return (
            <button key={day} type="button" onClick={() => onSelect(day)} aria-label={`${day}${items.length ? `, ${items.length} job${items.length === 1 ? "" : "s"}` : ""}`}
              className={`min-h-[56px] rounded-sm border p-1 text-left align-top ${isSel ? "border-ink bg-card" : "border-rulesoft bg-white"} ${items.length ? "" : "opacity-70"}`}>
              <div className={`text-[11px] font-semibold ${isToday ? "rounded-sm bg-ink px-1 text-paper inline-block" : ""}`}>{Number(day.slice(-2))}</div>
              {items.slice(0, 2).map((it) => <div key={it.id} className="truncate text-[10px] leading-tight text-ink">{label(it)}</div>)}
              {items.length > 2 && <div className="text-[10px] text-inksoft">+{items.length - 2} more</div>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
