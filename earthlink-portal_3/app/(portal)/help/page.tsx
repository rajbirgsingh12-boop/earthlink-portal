"use client";
import { useEffect, useRef, useState } from "react";
import PageHeader from "@/components/PageHeader";
import { scrollTo } from "@/lib/motion";

// Plain-language guide, written for someone opening the app for the first
// time. One section per page, named and ordered the way the nav shows them,
// and every control is quoted by the label it carries on screen right now.
// Crew texts get a section of their own because they touch three pages.
const SECTIONS: { icon?: string; title: string; lines: string[] }[] = [
  {
    title: "Home",
    lines: [
      "The brown band at the top is today: the day, your name, and the three numbers that need action: Payment not received, Not invoiced yet, Payroll to do. Tap a number to go where you fix it. The Today line says who is on the job and who still needs a text.",
      "The four buttons under it are the everyday jobs: Enter today's hours, Fill out a walk sheet, Make an invoice, See the releases.",
      "The cards below show what needs attention: money to chase, walk sheets not delivered, and payroll that's short. Tap a row to open it.",
      "Each card opens the page where you fix it: Invoice Package for the money, Proposals for the walk sheets, Payroll for the hours.",
    ],
  },
  {
    icon: "📄", title: "Releases",
    lines: [
      "Every NYCHA release lives here: paid, to chase, or waiting on payroll.",
      "Tap + Add release → From release PDFs and pick the release PDFs. The portal reads them and fills everything in.",
      "From a folder of PDFs (also under + Add release) takes a whole contract folder at once. It opens each PDF to read which release it really is and files it on that release.",
      "You get a list to check before a single file uploads. Fix anything it wasn't sure about right there.",
      "A release in the folder that isn't in the portal yet is created from its own PDF: development, amount, work order and required hours. It shows as NEW in the list first.",
      "Attaching also reads the line items out of each release PDF, so Invoice and SOS form (NYCHA's Statement of Services) appear in the row's ⋯ menu by themselves.",
      "Paid releases are left exactly as they are. Line items you already have, or edited by hand, are never overwritten.",
      "From a contract sheet (Excel) imports the contract's own sheet. Releases already here are updated; releases not on the sheet are removed, paid ones kept.",
      "The chips on each row show how far along it is: walk sheet → release PDF → payroll → invoiced → paid.",
      "The stamps on a row are buttons. PAYROLL TO DO flips to PAYROLL DONE. When NYCHA pays, tap NOT RECEIVED: it becomes RECEIVED and the release moves to the Received list.",
      "Hours check lists every release with required hours against the hours logged on the Payroll tab. HOURS OK means it meets the NYCHA minimum; SHORT 19H says how much is missing.",
      "Documents (in the row's ⋯ menu) holds the release PDF, the walk sheet and any job photos. Line items edits what the SOS form and the invoice use.",
      "Tools (⋯ at the top) has ⬇ Release list (Excel), Rename contract… and Fix duplicates in this contract….",
    ],
  },
  {
    icon: "📗", title: "Price Book",
    lines: [
      "The NYCHA price list for each contract. Pick the price book, then Upload price sheet (⋯) once. Walk sheets and invoices pull their prices from here.",
      "+ Add line adds a line by hand. Each row's ⋯ menu has Edit line and Delete line….",
    ],
  },
  {
    icon: "📋", title: "Proposals",
    lines: [
      "NYCHA walk sheets, for pricing a job during a walk-through.",
      "Tap + New walk sheet, pick the contract, and type quantities next to the work lines. It saves as you go.",
      "Search for any line by name (“cabinet”, “paint”).",
      "📝 Paste notes takes the whole note for a development off the phone: a line with the building and apartment, then one item per line.",
      "It makes one walk sheet per apartment, priced from the move-out contract's price book.",
      "A line the list can't match is shown before the sheet is made, so you can add it by hand.",
      "Upload survey PDF (⋯) reads the foreman's survey PDF into a walk sheet the same way. ⬇ Blank survey form (PDF) is the form to fill on site.",
      "Preview and print shows the finished sheet; ⬇ Walk sheet (Excel) downloads it in the NYCHA layout.",
      "Add to release… (in a sheet's ⋯ menu) turns the walk sheet into a release when the work is approved.",
      "The stamp on each sheet says where it is: Draft, In a release, Sent, Invoiced or Declined.",
    ],
  },
  {
    icon: "🧾", title: "Invoice Package",
    lines: [
      "Pick a contract to see everything NYCHA still owes on it, with how many days each invoice has been out.",
      "Invoice (in a release row's ⋯ menu) makes the NYCHA invoice for a release.",
      "⬇ Invoice package (PDF) (same menu) puts the invoice and every package document into one PDF. ⬇ All packages (n, zip) does the whole contract.",
      "Preview statement shows the Statement of Account. Every document can be printed (Print or save as PDF) or downloaded as Excel.",
      "The package documents card keeps this contract's copy of each form: Upload this contract's copy, Replace this contract's copy, or Use the standard copy.",
    ],
  },
  {
    icon: "🏢", title: "PACT Billing",
    lines: [
      "Private partner work: POs, proposals, invoices.",
      "Tap 📄 Upload PO or proposal and the job builds itself from the purchase order: address, contacts, work lines and amount.",
      "The ⋯ beside it has Upload a folder of proposals, ⬇ Proposal template (Word), + Type one in and Renumber invoices….",
      "Admin 1 also finds Add test POs there: three throwaway POs to try texting and photos on. Delete test POs takes them off.",
      "Tap a row to open the job. Take 📷 Before photos when you start and 📷 After photos when you finish.",
      "⬇ Photos (PDF) (on the open job, and under Documents) puts a job's before and after pictures on one PDF with the job on top, ready to send out.",
      "Work lines are what gets billed. + Add line if the job runs past what the PO listed; a removed line comes back with Undo.",
      "A PO read in is priced the way the work is billed: plaster and sheetrock by the square foot, and they bring their primer and paint by the room.",
      "Paint and primer on their own go by the room; a door by the door.",
      "An apartment-size paint (“paint 2 bedroom 1 bath apartment”) is at the apartment price. A price the PO itself prints is kept as printed.",
      "These rules run only when a PO is first read in, or re-read with Re-read the PO on the open job. A job already here, or typed in by hand, stays as entered.",
      "Price from list fills prices from the partner price list. It never changes a line's unit or count.",
      "Papers (on the open job) is what the portal writes: ⬇ Proposal + invoice, View proposal, ⬇ Proposal (PDF), ⬇ Proposal (Word), ⬇ Invoice package (PDF) and Edit invoice.",
      "⬇ Invoice package (PDF) makes one PDF with the invoice, the PO and all the photos, ready to send.",
      "Documents (in the row's ⋯ menu, or the 📎 count on the row) is what you attached or the crew texted in.",
      "MARK WORK DONE on the open job flips to WORK DONE ✓. The row then shows READY TO INVOICE until the invoice goes out.",
      "Open on Schedule (in the row's ⋯ menu) jumps to the PO on the PACT Schedule, where the crew is picked.",
      "Admin 2 works this page without prices: POs, photos and quantities, no money.",
    ],
  },
  {
    icon: "📅", title: "PACT Schedule",
    lines: [
      "Every PO with a day sits on this calendar, in a Month, Week or Day view. Drag a job to move it.",
      "+ Add PO → Upload a PO (PDF or letter) reads a PO straight onto its day. + Type one in adds one by hand.",
      "A PO with no day waits in the + Put a job on box under the calendar. Tap it to put it on the selected day.",
      "Open a day to see its jobs as cards. 📱 Who's going? on a card is where you pick the crew.",
      "📱 Text crew sends each of them the address, the apartment, the day and the work, in their own language. Send it later… picks a time instead.",
      "Mark work done on a card flips to WORK DONE ✓. A card marked ⚠ NOBODY HOME needs a new day.",
      "🏢 Billing jumps back to PACT Billing.",
    ],
  },
  {
    title: "Schedule",
    lines: [
      "NYCHA crews by day. Pick the day (Today, Tomorrow or the Day box), then + Add a release to this day.",
      "Write the work, then Add worker for everyone going. Map finds the address: type it, check the pin, tap Use this location. The crew's text then carries a tap-to-navigate map link.",
      "📱 Text crew messages the whole crew in one tap: the day, the release number, the address with its map link and the work. Send it later… picks a time.",
      "TEXTED ✓ shows who's been told, NOT TEXTED who hasn't. Resend re-sends one person; the row's ⋯ menu clears a TEXTED mark or removes someone from the day.",
    ],
  },
  {
    title: "Crew texts",
    lines: [
      "Photos, measurements and “nobody home” all come back by text to the company number. Settings → System → Run system check shows what is switched on and how to switch on the rest.",
      "With the company number connected, texts go out silently from that number. Without it, a group text opens on your phone.",
      "Workers answer the crew text with photos, as many as they like in one reply (up to ten per text, the phone's own limit).",
      "When a phone splits one reply into several texts, the first is answered and one last text gives the full count.",
      "Photos land on the job that worker is on that day, or the PO they type in the text. They get a text back saying where the photos went.",
      "A worker on two jobs that day: the pictures go to the job they were texted about last, or into the thread's own job. Otherwise the office picks.",
      "Photos the portal can't place wait in the 📱 From the crew card on both Schedule tabs. Pick the job there; Wrong job? moves a batch; Throw away removes one.",
      "A PACT job runs as one thread. The crew text ends by asking for BEFORE photos; once they land, the worker is asked for what the job's lines are measured in.",
      "Square feet for plaster (“plaster 120 sf”), linear feet for baseboard (“baseboard 200 lf”), rooms for paint and primer (“paint 3 rooms”). A job with nothing to measure is asked nothing.",
      "The number goes straight onto the job's line, so the proposal and the invoice carry it from then on. 📱 From the crew shows each measurement that came in.",
      "AFTER photos mark the job work done. It shows READY TO INVOICE on PACT Billing, and the worker can take the mark back by texting NOT DONE.",
      "A number is only believed when it is clearly a measurement. A job number, an apartment number, a time or a count of pictures is never written as square feet.",
      "A line that already has a number is only changed by one with its unit (“plaster 130 sf”). Anything unclear is asked about, not guessed.",
      "Want to be in the thread yourself? Run system check says how. With a local company number, each crew text then becomes one group thread with you, the workers on that job and the company number.",
      "Their photos, square feet, “done” and “no” land in that thread and the portal answers there, so you can chime in. A crew that reads two languages gets both in one message.",
      "If the company number can't make a thread (a toll-free number can't group-text), every text is copied to your phone instead: “Sent to Jose: …”, “From Jose: …”, “Reply to Jose: …”.",
      "TEXTED ✓ means the company number took the text, not that the worker's phone got it.",
      "If a text didn't go through, the message on screen says why: a number that texted STOP, a trial account, a number not registered yet.",
      "Nobody home? The worker texts back “no” (or “nobody home”, “nadie”). The job gets a ⚠ NOBODY HOME mark on the calendar and in 📱 From the crew.",
      "The worker is texted their next job right away: another one they have today, or the next day's job moved up to today.",
      "Give the missed job a new day and the mark comes off by itself. On a PACT job the notice has a day box and a Move it and text the crew button that does both at once.",
    ],
  },
  {
    title: "Payroll",
    lines: [
      "Tap the one big button, Make payroll.",
      "Make payroll opens this week and brings the crew over from last week. Add a release, add its workers, type each day's hours.",
      "A week runs Saturday to Friday and is named by the Friday it ends on. Sat and Sun hours are overtime.",
      "The Classification box next to each name is checked against the release's minimums.",
      "Under each release a stamp per classification shows the hours logged against the NYCHA minimum: HOURS OK, or SHORT 4H when it still needs more.",
      "⬇ Weekly sheet (Excel) downloads the paper-style sheet. The PAID stamps track who's been paid; tap NOT PAID when someone is.",
      "Crew list (Settings → Crew) holds each worker's phone number and the language for their texts. Enter them once and both Schedule tabs text them with one tap.",
      "Certified payroll (top of the Payroll tab) turns the payroll company's PDFs into the CSV eComply takes. Upload payroll PDFs, check the rows, download. Nothing on that page is saved.",
    ],
  },
  {
    title: "Settings",
    lines: [
      "Company letterhead: name, address and license, the way they print on every document.",
      "Contract names: what the dropdowns call each contract.",
      "Crew: phone numbers and the language for texts. Enter each worker once.",
      "Invoice package details: the wording on the package documents.",
      "Line items & prices: what a PO turns into. Show PO wording shows the words the reader looks for.",
      "Users & roles: who can sign in, and as what. Admin 1 sees everything; Admin 2 works PACT without prices.",
      "System: storage, backup, system check. Run system check verifies the database (every row should be green) and shows what is switched on for texting and how to switch on the rest.",
      "⬇ Full backup (Excel) downloads everything in one file. Re-read descriptions reads a PO's description again from its PDF when the first read cut it short.",
    ],
  },
  {
    title: "Good to know",
    lines: [
      "Everything saves by itself as you type.",
      "Everything updates on its own. If someone enters hours on their phone, you see it on yours without refreshing.",
      "Deleting always asks “are you sure” first.",
      "If something looks stuck, pull down to refresh once. If it is still stuck, tell Rajbir.",
    ],
  },
];

// a section's anchor is its title as a slug ("PACT Billing" -> "pact-billing")
const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
// where a section counts as "the one being read": its top has passed the sticky bars
const READ_LINE = 110;

export default function Help() {
  const [active, setActive] = useState(slug(SECTIONS[0].title));
  const strip = useRef<HTMLDivElement>(null);

  // the lit chip follows the reader down the page: the last section whose top
  // has gone under the sticky bars (and under the strip itself, on a desk)
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const line = Math.max(READ_LINE, (strip.current?.getBoundingClientRect().bottom ?? 0) + 8);
        let cur = slug(SECTIONS[0].title);
        for (const s of SECTIONS) {
          const el = document.getElementById(slug(s.title));
          if (el && el.getBoundingClientRect().top <= line) cur = slug(s.title);
        }
        setActive(cur);
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
  }, []);

  // on a phone the strip scrolls sideways: the lit chip is brought into view
  // (sideways only; the page itself is never pulled back up to the strip)
  useEffect(() => {
    const box = strip.current;
    const chip = box?.querySelector<HTMLElement>(`[data-help-anchor="${active}"]`);
    if (!box || !chip) return;
    const behavior: ScrollBehavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    const left = chip.offsetLeft, right = left + chip.offsetWidth;
    if (left < box.scrollLeft) box.scrollTo({ left: left - 12, behavior });
    else if (right > box.scrollLeft + box.clientWidth) box.scrollTo({ left: right - box.clientWidth + 12, behavior });
  }, [active]);

  const jump = (id: string) => {
    scrollTo(document.getElementById(id), "start");
    try { history.replaceState(null, "", `#${id}`); } catch {}
  };

  return (
    <div>
      <PageHeader title="Help" sub="How it works, in plain language: one section per page." />
      {/* one chip per section; on a desk the strip stays under the nav while the page scrolls */}
      <div className="bg-paper sm:sticky sm:top-[101px] sm:z-[5]">
        <nav aria-label="Sections" ref={strip} className="scroll-fade-paper relative mb-4 flex snap-x gap-2 overflow-x-auto pb-1">
          {SECTIONS.map((s) => {
            const id = slug(s.title);
            const lit = active === id;
            return (
              <a key={id} href={`#${id}`} data-help-anchor={id} aria-current={lit ? "location" : undefined}
                onClick={(e) => { e.preventDefault(); jump(id); }}
                className={`inline-flex min-h-[44px] shrink-0 snap-start items-center gap-1.5 whitespace-nowrap rounded-[2px] border px-3 font-mono text-[12px] font-semibold uppercase tracking-wide transition-colors ${lit ? "border-ink bg-ink text-paper" : "border-rule bg-card text-inksoft hover:border-ink hover:text-ink active:bg-rulesoft/60"}`}>
                {s.icon && <span aria-hidden>{s.icon}</span>}{s.title}
              </a>
            );
          })}
        </nav>
      </div>
      {SECTIONS.map((s) => (
        <section key={s.title} id={slug(s.title)} className="card card-pad mb-3 scroll-mt-[112px] sm:scroll-mt-[168px]">
          <h2 className="mb-1.5 font-display text-base font-bold uppercase">{s.icon ? `${s.icon} ` : ""}{s.title}</h2>
          {s.lines.map((l, i) => <p key={i} className="mb-1 text-[14px] leading-relaxed text-ink">{l}</p>)}
        </section>
      ))}
    </div>
  );
}
