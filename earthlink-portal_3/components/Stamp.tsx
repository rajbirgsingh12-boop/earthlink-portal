export default function Stamp({ label, tone }: { label: string; tone: "ok" | "work" | "alert" | "mute" | "carbon" }) {
  const map = { ok: "border-ok text-ok", work: "border-work text-work", alert: "border-alert text-alert", mute: "border-inksoft text-inksoft", carbon: "border-carbon text-carbon" };
  return <span className={`stamp ${map[tone]}`}>{label}</span>;
}
