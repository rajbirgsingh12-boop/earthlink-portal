import type { MetadataRoute } from "next";

// The portal itself stays out of search engines; the public company page and the
// privacy/SMS terms stay visible so the business can be verified at its own domain.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: ["/login", "/legal"], disallow: "/" } };
}
