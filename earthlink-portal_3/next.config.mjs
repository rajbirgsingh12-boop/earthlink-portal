/** @type {import('next').NextConfig} */

// Browser-side hardening: these headers ride on every response.
// The CSP only lets the page talk to itself, Supabase, Google Fonts, and the
// Google Maps embed — a script sneaking in from anywhere else is dead on arrival.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.supabase.co",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
  "frame-src https://www.google.com https://maps.google.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  // browsers remember to always use HTTPS for this site
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  // no other site may show this app inside a frame (blocks clickjacking)
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=()" },
];

const nextConfig = {
  // pdfjs must load from node_modules at runtime on the server — bundling it
  // breaks its internal worker resolution (/api/parse-po)
  experimental: { serverComponentsExternalPackages: ["pdfjs-dist"] },
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      // the portal stays out of search results; the public company page and the
      // privacy/SMS terms are left indexable so the business can be verified
      // the portal only — the public company page, sign-in and legal page stay indexable
      ...["home", "releases", "payroll", "pact", "schedule", "items", "proposals", "statements", "settings", "admin", "reset"]
        .flatMap((p) => [`/${p}`, `/${p}/:path*`])
        .map((source) => ({ source, headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }] })),
    ];
  },
};
export default nextConfig;
