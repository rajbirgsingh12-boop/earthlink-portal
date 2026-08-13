// Public company identity — shown on the sign-in page and the legal page so the
// website plainly belongs to the registered business (carrier/Twilio verification
// checks that the site, the business name, and the contact email line up).
export const COMPANY = {
  legalName: "Earth Link General Construction Inc.",
  shortName: "Earth Link General Construction",
  street: "117-01 Atlantic Avenue",
  city: "Richmond Hill",
  state: "New York",
  zip: "11418",
  phone: "(917) 796-0479",
  phoneHref: "+19177960479",
  email: "info@earthlink-gc.com",
  site: "www.earthlink-gc.com",
  // the letterhead block, exactly as the owner's Word template prints it
  letterhead: {
    name: "Earth Link General Construction, Inc.",
    address: "117-01 Atlantic Avenue, Richmond Hill, NY 11418",
    phones: "Phone: (917) 509-6427 | Office: (718) 316-9098",
    emails: "Email: earthlink99@gmail.com | Office Email: info@earthlinkgc.com",
  },
  // filing details used on NYCHA paperwork (Statement of Services, invoices)
  fax: "718-766-8010",
  supplierNo: "104638",
  fedTaxId: "11-3511520",
  principal: "HARPINDER SINGH.",
  principalTitle: "PRESIDENT",
  blurb:
    "General construction contractor serving New York City public and affordable housing — NYCHA and PACT/RAD partners. Painting, plastering, carpentry, tile, and full apartment restoration.",
} as const;

export const COMPANY_ADDRESS = `${COMPANY.street}, ${COMPANY.city}, ${COMPANY.state} ${COMPANY.zip}`;
