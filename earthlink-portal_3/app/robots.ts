import type { MetadataRoute } from "next";

// Internal company tool — no search engine has any business in here.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
