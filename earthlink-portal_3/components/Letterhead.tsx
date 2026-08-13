import { COMPANY } from "@/lib/company";

// The company letterhead from the owner's Word template: logo centered,
// company name, address, both phone lines and both emails under it.
export default function Letterhead() {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element -- print view needs a plain img */}
        <img src="/logo.png" alt="Earth Link logo" className="h-24 w-auto shrink-0" />
        <div className="text-left">
          <div className="font-display text-[22px] font-bold leading-tight">{COMPANY.letterhead.name}</div>
          <div className="mt-0.5 text-[12px] leading-snug">
            <div>{COMPANY.letterhead.address}</div>
            <div>{COMPANY.letterhead.phones}</div>
            <div>{COMPANY.letterhead.emails}</div>
          </div>
        </div>
      </div>
      <div className="mt-2 border-b-2 border-ink" />
    </div>
  );
}
