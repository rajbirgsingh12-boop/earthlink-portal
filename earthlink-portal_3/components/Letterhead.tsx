import { COMPANY } from "@/lib/company";

// The company letterhead the proposals print: the logo centered, the name in
// the logo's brown, address, both phone lines and both emails under it, and a
// rule in the globe's two colors — the same as the PDF walk sheet and letter.
export default function Letterhead() {
  const L = COMPANY.letterhead;
  return (
    <div className="mb-4 text-center">
      {/* eslint-disable-next-line @next/next/no-img-element -- print view needs a plain img */}
      <img src="/logo.png" alt="Earth Link logo" className="mx-auto h-16 w-auto" />
      <div className="mt-1 font-display text-[22px] font-bold leading-tight text-logo-brown">{L.name}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-logo-muted">
        <div>{L.address}</div>
        <div>{L.phones.replace(/^Phone:\s*/, "").replace(/\s*\|\s*/g, "  ·  ")}</div>
        <div>{L.emails.replace(/^Email:\s*/, "").replace(/\s*\|\s*Office Email:\s*/, "  ·  ")}</div>
      </div>
      {/* the globe's two halves, ocean then land */}
      <div className="mt-2 flex h-[3px]"><div className="flex-1 bg-logo-teal" /><div className="flex-1 bg-logo-green" /></div>
    </div>
  );
}
