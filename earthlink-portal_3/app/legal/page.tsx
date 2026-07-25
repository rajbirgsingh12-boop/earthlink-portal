import { COMPANY, COMPANY_ADDRESS } from "@/lib/company";

// Public page. Carrier/Twilio verification asks to see the messaging program
// described and a privacy policy at the business's own website.
export const metadata = {
  title: `Privacy Policy & Text Message Terms — ${COMPANY.legalName}`,
  description: `Privacy policy and SMS terms for ${COMPANY.legalName}.`,
};

const H = ({ children }: { children: React.ReactNode }) => (
  <h2 className="mt-7 font-display text-lg font-bold uppercase">{children}</h2>
);
const P = ({ children }: { children: React.ReactNode }) => (
  <p className="mt-2 text-[14px] leading-relaxed">{children}</p>
);

export default function Legal() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <div className="font-display text-2xl font-bold uppercase leading-none">{COMPANY.shortName}</div>
      <div className="mt-1 text-[11px] uppercase tracking-[.2em] text-inksoft">{COMPANY.legalName}</div>
      <div className="mt-2 text-[12px] text-inksoft">
        {COMPANY_ADDRESS} · {COMPANY.phone} · {COMPANY.email}
      </div>

      <h1 className="mt-8 font-display text-xl font-bold uppercase">Text Message (SMS) Terms</h1>
      <P>
        {COMPANY.legalName} sends text messages to its own employees and field crew for one purpose:
        telling them where they are scheduled to work and what the work is. We do not send marketing
        or promotional text messages, and we never text people who do not work for us.
      </P>

      <H>What the messages contain</H>
      <P>
        A typical message includes the date, the job or release number, the work address (with a map
        link), and a short description of the work. Example: “Earth Link: you&apos;re scheduled for
        Monday at 123 Example Ave (Release #1234). Work: patch and paint apartment 4B.”
      </P>

      <H>How employees are added and how they consent</H>
      <P>
        An employee&apos;s mobile number is entered in our office system only after the employee gives
        it to us directly for this purpose, as part of being hired or assigned to crews. Providing the
        number to the office is the employee&apos;s consent to receive work-assignment messages. No
        number is bought, rented, or obtained from any third party.
      </P>

      <H>Message frequency, cost, and support</H>
      <P>
        Message frequency varies by work schedule — typically a few messages per week, and never more
        than a few per day. Message and data rates may apply from the recipient&apos;s mobile carrier.
        {" "}
        <b>Reply STOP to any message to stop receiving them; reply HELP for help.</b> An employee may
        also simply tell the office to remove their number, and it is removed the same day. Stopping
        messages does not affect anyone&apos;s employment — assignments are then given in person or by
        phone call.
      </P>

      <H>Carriers</H>
      <P>Mobile carriers are not liable for delayed or undelivered messages.</P>

      <h1 className="mt-10 font-display text-xl font-bold uppercase">Privacy Policy</h1>
      <P>
        This policy covers the private staff portal at {COMPANY.site} and the text messages described
        above. The portal is an internal business tool; it is not open to the public and has no public
        sign-up.
      </P>

      <H>What we collect</H>
      <P>
        For employees and field crew: name, mobile phone number, work classification, hours worked, and
        job assignments. For our contract work: job addresses, work descriptions, photographs of the
        work, and the related purchase orders, invoices, and payment records. Portal users
        (office staff) also have an email address and password managed by our authentication provider.
      </P>

      <H>How we use it</H>
      <P>
        Solely to run the business: scheduling crews, notifying workers of assignments, tracking hours
        for payroll, documenting completed work, and billing our clients. We do not use any of this
        information for advertising.
      </P>

      <H>What we never do</H>
      <P>
        We do not sell, rent, or share personal information — including mobile phone numbers and
        messaging consent — with third parties for marketing or promotional purposes. No mobile
        information is shared with third parties or affiliates for marketing. Information is shared
        only with the service providers that operate the system on our behalf (our website host, our
        database provider, and our text-message provider), and with our clients or government agencies
        where a contract or law requires it.
      </P>

      <H>How it is protected</H>
      <P>
        The portal requires a sign-in, is encrypted in transit, restricts each user to only the records
        their role allows, and is not indexed by search engines. Documents and photographs are stored in
        private storage that requires a valid sign-in to access.
      </P>

      <H>How long we keep it</H>
      <P>
        Job, payroll, and billing records are retained as long as our contracts, tax, and recordkeeping
        obligations require. A worker&apos;s phone number is deleted from the system on request.
      </P>

      <H>Questions or requests</H>
      <P>
        Contact {COMPANY.legalName}, {COMPANY_ADDRESS}, {COMPANY.phone},{" "}
        <a className="underline" href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>. We will respond
        to any request to correct or delete personal information.
      </P>

      <div className="mt-10 border-t border-rulesoft pt-4 text-[12px] text-inksoft">
        <a className="underline" href="/login">← Employee sign-in</a>
        <div className="mt-1.5">© {new Date().getFullYear()} {COMPANY.legalName}. All rights reserved.</div>
      </div>
    </div>
  );
}
