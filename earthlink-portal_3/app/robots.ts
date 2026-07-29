import type { MetadataRoute } from "next";

// The public pages (company page, sign-in, legal) stay visible so the business can
// be found and verified at its own domain; the staff portal stays out of search.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/home", "/releases", "/payroll", "/pact", "/schedule", "/items", "/proposals", "/statements", "/settings", "/admin", "/reset", "/api"],
    },
  };
}
