import { COMPANY } from "@/lib/company";

// The company letterhead from the owner's Word template: logo centered,
// company name, address, both phone lines and both emails under it.
export default function Letterhead() {
  return (
    <div className="mb-4 text-center">
      {/* eslint-disable-next-line @next/next/no-img-element -- print view needs a plain img */}
      <img src="/logo.png" alt="Earth Link logo" className="mx-auto mb-1 h-24 w-auto" />
      <div className="font-display text-[22px] font-bold leading-tight">{COMPANY.letterhead.name}</div>
      <div className="mt-0.5 text-[12px] leading-snug">
        <div>{COMPANY.letterhead.address}</div>
        <div>{COMPANY.letterhead.phones}</div>
        <div>{COMPANY.letterhead.emails}</div>
      </div>
      <div className="mt-2 border-b-2 border-ink" />
    </div>
  );
}
