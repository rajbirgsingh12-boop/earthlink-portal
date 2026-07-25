// Public company identity — shown on the sign-in page and the legal page so the
// website plainly belongs to the registered business (carrier/Twilio verification
// checks that the site, the business name, and the contact email line up).
export const COMPANY = {
  legalName: "Earth Link General Construction Inc.",
  shortName: "Earth Link General Construction",
  street: "110-117 Atlantic Avenue",
  city: "Richmond Hill",
  state: "New York",
  zip: "11418",
  phone: "(917) 796-0479",
  phoneHref: "+19177960479",
  email: "info@earthlink-gc.com",
  site: "www.earthlink-gc.com",
  blurb:
    "General construction contractor serving New York City public and affordable housing — NYCHA and PACT/RAD partners. Painting, plastering, carpentry, tile, and full apartment restoration.",
} as const;

export const COMPANY_ADDRESS = `${COMPANY.street}, ${COMPANY.city}, ${COMPANY.state} ${COMPANY.zip}`;
