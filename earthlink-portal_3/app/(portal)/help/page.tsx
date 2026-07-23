"use client";

// Plain-language guide — written for someone opening the app for the first time.
const SECTIONS: { icon: string; title: string; lines: string[] }[] = [
  {
    icon: "🏠", title: "Home",
    lines: [
      "The big buttons at the top jump you straight to everyday jobs — hours, walk sheets, invoices, releases.",
      "Below them, the Board shows what needs attention: money to chase, walk sheets not delivered, and payroll that's short.",
    ],
  },
  {
    icon: "📄", title: "Releases",
    lines: [
      "Every NYCHA release lives here. Tap “+ From PDF(s)” and pick the release PDFs — the app reads them and fills everything in.",
      "The little green chips on each row show how far along it is: walk sheet → release → work done → payroll → invoiced → paid.",
      "The ⏱ number is payroll hours worked vs. required — it updates by itself as hours are entered on the Payroll tab.",
      "When NYCHA pays, tap the Received stamp. Paid releases move to the Received list to keep the screen clean.",
    ],
  },
  {
    icon: "📗", title: "Price Book",
    lines: [
      "The NYCHA price list for each contract. Upload the contract's price sheet once — walk sheets and invoices pull their prices from here.",
    ],
  },
  {
    icon: "📋", title: "Proposals (walk sheets)",
    lines: [
      "For pricing a job during a walk-through. Start a sheet, pick the contract, and type quantities next to the work items — it saves as you go.",
      "Search for any item by name (“cabinet”, “paint”). Preview shows the finished sheet; Excel downloads it in the NYCHA layout.",
      "“→ Add to release” turns the walk sheet into a release when the work is approved.",
    ],
  },
  {
    icon: "🏢", title: "PACT",
    lines: [
      "Private partner work. Tap “+ Upload PO (PDF)” and the job builds itself from the purchase order.",
      "Take 📷 Before photos when you start and 📷 After photos when you finish.",
      "Work lines are what gets billed — add a line if the job runs past what the PO listed.",
      "📦 Package makes one PDF with the invoice, the PO, and all photos — ready to send. PACT has its own Schedule under the PACT menu.",
      "📱 Text worker opens a ready-made text with the job's address and work description — pick the worker and hit send.",
    ],
  },
  {
    icon: "⏱", title: "Payroll",
    lines: [
      "Tap the one big button — Make payroll. It opens this week and brings the crew over from last week.",
      "The week opens on today: type each person's hours, one number each. Tap a name to link their hours to a release or change their classification.",
      "The Release hours check shows if a release has enough hours per trade — green means it meets the NYCHA minimum.",
      "“Weekly sheet (xlsx)” downloads the paper-style sheet. The PAID stamps track who's been paid.",
      "📱 Text crew on a release card opens a ready-made text for each worker with the release #, location, and work description — save each worker's number once (in the Crew list) and it's one tap after that.",
    ],
  },
  {
    icon: "🧾", title: "Invoices & Statements",
    lines: [
      "Pick a contract to see everything NYCHA still owes on it, with how many days each invoice has been out.",
      "“Invoice” makes the NYCHA invoice for a release. Preview shows the Statement of Account; every document can be printed to PDF or downloaded as Excel.",
    ],
  },
  {
    icon: "⚙️", title: "Settings",
    lines: [
      "Company letterhead info, contract nicknames, and user accounts (Admin 1 sees everything; Admin 2 sees everything except PACT invoices).",
      "“Run system check” verifies the database — every row should be green.",
    ],
  },
  {
    icon: "💡", title: "Good to know",
    lines: [
      "Everything saves by itself as you type — Save & close is just a quick way out.",
      "Everything updates live: if someone enters hours on their phone, you see it on yours without refreshing.",
      "Deleting always asks “are you sure” first. If something looks stuck, pull down to refresh once — then tell Rajbir.",
    ],
  },
];

export default function Help() {
  return (
    <div>
      <div className="mb-1 font-display text-2xl font-bold uppercase">How it works</div>
      <div className="mb-4 text-sm text-inksoft">The whole app in plain language — one section per tab.</div>
      {SECTIONS.map((s) => (
        <div key={s.title} className="card mb-3 p-4">
          <div className="mb-1.5 font-display text-base font-bold uppercase">{s.icon} {s.title}</div>
          {s.lines.map((l, i) => <p key={i} className="mb-1 text-[14px] leading-relaxed text-ink">{l}</p>)}
        </div>
      ))}
    </div>
  );
}
