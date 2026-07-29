import { COMPANY, COMPANY_ADDRESS } from "@/lib/company";

// The public front door at earthlink-gc.com. Deliberately a plain server-rendered
// page with no sign-in and no JavaScript needed: anyone (or any verification
// crawler) that loads the domain sees the registered business name, address and
// contact details in the HTML itself. The staff portal lives behind /home.
export const metadata = {
  title: `${COMPANY.legalName} — General Construction, New York City`,
  description: COMPANY.blurb,
};

const SERVICES = [
  ["Apartment restoration", "Full turnover of vacant and occupied apartments — kitchens, bathrooms, floors, doors."],
  ["Painting & plastering", "Skim coating, plaster repair, and painting to NYCHA specification."],
  ["Carpentry & tile", "Doors, frames, cabinets, trim, and floor and wall tile."],
  ["Public housing contracts", "NYCHA blanket releases and PACT/RAD partner work across the five boroughs."],
];

export default function PublicHome() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-12">
      <header>
        <h1 className="font-display text-4xl font-bold uppercase leading-none">{COMPANY.shortName}</h1>
        <div className="mt-2 text-[12px] uppercase tracking-[.22em] text-inksoft">{COMPANY.legalName}</div>
        <p className="mt-5 max-w-xl text-[15px] leading-relaxed">{COMPANY.blurb}</p>
      </header>

      <section className="mt-9">
        <h2 className="font-display text-lg font-bold uppercase">What we do</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {SERVICES.map(([title, body]) => (
            <div key={title} className="card p-3.5">
              <div className="font-display text-[15px] font-semibold uppercase">{title}</div>
              <p className="mt-1 text-[13px] leading-relaxed text-inksoft">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-9">
        <h2 className="font-display text-lg font-bold uppercase">Contact</h2>
        <address className="mt-2 not-italic text-[14px] leading-relaxed">
          <b>{COMPANY.legalName}</b>
          <br />
          {COMPANY.street}
          <br />
          {COMPANY.city}, {COMPANY.state} {COMPANY.zip}
          <br />
          Telephone: <a className="underline" href={`tel:${COMPANY.phoneHref}`}>{COMPANY.phone}</a>
          <br />
          Email: <a className="underline" href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>
          <br />
          Web: <a className="underline" href={`https://${COMPANY.site}`}>{COMPANY.site}</a>
        </address>
      </section>

      <section className="mt-9">
        <h2 className="font-display text-lg font-bold uppercase">Staff</h2>
        <p className="mt-2 text-[14px] leading-relaxed">
          {COMPANY.shortName} employees use the Field Office portal to see their work assignments,
          walk sheets and hours. It is private to our staff.
        </p>
        <a className="btn btn-primary mt-3 inline-block" href="/login">Employee sign-in</a>
      </section>

      <footer className="mt-12 border-t border-rulesoft pt-4 text-[12px] text-inksoft">
        <a className="underline" href="/legal">Privacy Policy &amp; Text Message Terms</a>
        <div className="mt-1.5">
          © {new Date().getFullYear()} {COMPANY.legalName}. {COMPANY_ADDRESS}.
        </div>
      </footer>
    </main>
  );
}
