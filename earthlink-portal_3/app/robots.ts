import type { MetadataRoute } from "next";

// The public pages stay visible so the business can be verified at its own
// domain. The portal pages are left crawlable but carry X-Robots-Tag: noindex —
// a robots.txt Disallow would HIDE that header from crawlers, which can leave
// bare URLs in search results; noindex actually removes them.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/", disallow: ["/api"] } };
}
