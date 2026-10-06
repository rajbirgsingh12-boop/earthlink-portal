"use client";

// Plain-language guide — written for someone opening the app for the first time.
const SECTIONS: { icon?: string; title: string; lines: string[] }[] = [
  {
    title: "Home",
    lines: [
      "The big buttons at the top jump you straight to everyday jobs — hours, walk sheets, invoices, releases.",
      "Below them, the Board shows what needs attention: money to chase, walk sheets not delivered, and payroll that's short.",
    ],
  },
  {
    icon: "📄", title: "Releases",
    lines: [
      "Every NYCHA release lives here. Tap Add → “+ From PDF(s)” and pick the release PDFs — the app reads them and fills everything in.",
      "Attach folder of PDFs (also under Add) takes a whole contract folder at once. It opens each PDF to read which release it actually is and files it on that release. You get a list to check — and fix anything it wasn't sure about — before a single file uploads.",
      "If a release in the folder isn't in the app yet, it gets created from its own PDF — development, amount, work order and required hours and all. Those show as NEW in the list before you press Attach.",
      "Attaching also reads the line items out of each release PDF, so SOS form and Invoice light up by themselves in the row's ⋯ menu. Releases that are already paid are left exactly as they are, and line items you've already got (or edited by hand) are never overwritten.",
      "The little green chips on each row show how far along it is: walk sheet → release → work done → payroll → invoiced → paid.",
      "The hrs number is payroll hours worked vs. required — it updates by itself as hours are entered on the Payroll tab.",
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
      "Search for any item by name (“cabinet”, “paint”). View PDF shows the finished sheet; ⬇ Walk sheet (Excel) downloads it in the NYCHA layout.",
      "“Add to release…” (in a sheet's ⋯ menu) turns the walk sheet into a release when the work is approved.",
    ],
  },
  {
    icon: "🏢", title: "PACT",
    lines: [
      "Private partner work. Tap “📄 Upload PO / proposal” and the job builds itself from the purchase order.",
      "Take 📷 Before photos when you start and 📷 After photos when you finish.",
      "Work lines are what gets billed — add a line if the job runs past what the PO listed.",
      "⬇ Invoice package (zip) — under the job's Papers menu — makes one PDF with the invoice, the PO, and all photos, ready to send. PACT has its own Schedule under the PACT menu.",
      "Text worker (in the job's ⋯ menu) opens a ready-made text with the job's address and work description — pick the worker and hit send.",
    ],
  },
  {
    icon: "📅", title: "Schedule",
    lines: [
      "Pick the day (Today / Tomorrow / any date), add a release, write the work description, then + Add worker for everyone going.",
      "Map opens a mini map window — type the address, check the pin, tap Use this location. The workers' texts then include a tap-to-navigate map link.",
      "Assign & text messages the whole crew in one tap — date, release #, address with map link, and the work description.",
      "With the company number connected (Twilio keys in Vercel), texts send silently from that number; otherwise a group text opens on your phone. TEXTED ✓ shows who's been told; “resend” re-sends one person.",
      "Workers can answer the crew text with photos — as many as they like in one reply (up to ten per text, which is the phone's own limit). When a phone splits one reply into several texts, the first is answered and one last text gives the full count. They go straight onto the job that worker is on that day (or the PO they type in the text), and they get a text back saying where they went. A worker on two jobs that day: pictures go to the one they were texted about last (a PO that comes in during the day is texted later than the morning's), or into the thread's own job; otherwise the office picks. Photos the portal can't place — two jobs texted together, or a phone not on the crew list — wait in the “📱 From the crew” card on the Schedule tabs for you to pick the job; “Wrong job?” there moves a batch. To switch it on, see Settings → System check — the photo line starts going out on crew texts the first time any text reaches the company number (on a PACT job's text it is the three steps below; on a release it is “Reply to this text with photos of the work”).",
      "A PACT job runs as one thread by text: the crew text ends by asking for BEFORE photos; those land on the job and the worker is asked for what the job's lines are measured in — square feet for plaster (“plaster 120 sf”), linear feet for baseboard (“baseboard 200 lf”), how many rooms for paint and primer (“paint 3 rooms”); nothing is asked on a job with nothing to measure, like an apartment painted at the apartment price; the number goes straight onto the job's line, so the proposal and the invoice carry it from then on; then AFTER photos, which mark the job work done — it shows “ready to invoice” on Billing, and the worker can take the mark back with NOT DONE. A number is only believed when it is clearly a measurement: a job number, an apartment number, a time, or a count of pictures is never written as square feet, a line that already has a number is only changed by one with its unit (“plaster 130 sf”), and anything unclear is asked about rather than guessed. The job card on the PACT Schedule shows how far along it is, and “📱 From the crew” shows each measurement that came in.",
      "Want to be in the thread yourself? Put your cell in Vercel as TEXT_COPY_TO (Settings → System check names it). With a local company number, each crew text then goes into one group thread with you, the workers on that job and the company number — like a group chat. Their photos, square feet, “done” and “no” land in that thread and the portal answers there, so you see where each job is and can chime in. A crew that reads two languages gets both in one message. If Twilio can't make a thread (a toll-free number can't group-text), every text is copied to your phone instead: “Sent to Jose: …”, “From Jose: …”, “Reply to Jose: …”.",
      "TEXTED ✓ means the company number took the text, not that the worker's phone got it. If a text didn't go through, the message on screen carries Twilio's own reason (a number that texted STOP, a trial account, a number not registered yet).",
      "Nobody home? The worker texts back “no” (or “nobody home”, “nadie”). The job gets a ⚠ NOBODY HOME mark on the calendar and in the “📱 From the crew” card, and the worker is texted their next job right away — another one they have today, or their next day's job moved up to today. Give the missed job a new day and the mark comes off by itself — on a PACT job the notice has a date and a “Move it and text the crew” button that does both at once.",
    ],
  },
  {
    title: "Payroll",
    lines: [
      "Tap the one big button — Make payroll. It opens this week and brings the crew over from last week.",
      "The week opens on today: type each person's hours, one number each. Tap a name to link their hours to a release or change their classification.",
      "The Release hours check shows if a release has enough hours per trade — green means it meets the NYCHA minimum.",
      "“Weekly sheet (xlsx)” downloads the paper-style sheet. The PAID stamps track who's been paid.",
      "The Crew list holds each worker's phone number — enter it once and the Schedule tab texts them with one tap.",
    ],
  },
  {
    icon: "🧾", title: "Invoices & Statements",
    lines: [
      "Pick a contract to see everything NYCHA still owes on it, with how many days each invoice has been out.",
      "“Invoice” (in a release row's ⋯ menu) makes the NYCHA invoice for a release. Preview shows the Statement of Account; every document can be printed to PDF or downloaded as Excel.",
    ],
  },
  {
    title: "Settings",
    lines: [
      "Company letterhead info, contract nicknames, and user accounts (Admin 1 sees everything; Admin 2 works PACT without prices — POs, photos and quantities, no money).",
      "“Run system check” verifies the database — every row should be green.",
    ],
  },
  {
    title: "Good to know",
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
          <div className="mb-1.5 font-display text-base font-bold uppercase">{s.icon ? `${s.icon} ` : ""}{s.title}</div>
          {s.lines.map((l, i) => <p key={i} className="mb-1 text-[14px] leading-relaxed text-ink">{l}</p>)}
        </div>
      ))}
    </div>
  );
}
