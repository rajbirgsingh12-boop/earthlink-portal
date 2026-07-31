/** @type {import('next').NextConfig} */

// Browser-side hardening: these headers ride on every response.
// The CSP only lets the page talk to itself, Supabase, Google Fonts, and the
// Google Maps embed — a script sneaking in from anywhere else is dead on arrival.
// pin the CSP to this project's own Supabase host when the env is present at
// build time (Vercel) — the wildcard only remains for local fake-env builds
const SUPA = (() => {
  try { return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || "").host; } catch { return ""; }
})();
const supaHosts = SUPA ? `https://${SUPA}` : "https://*.supabase.co";
const supaWs = SUPA ? `wss://${SUPA}` : "wss://*.supabase.co";
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  `img-src 'self' data: blob: ${supaHosts}`,
  `connect-src 'self' ${supaHosts} ${supaWs}`,
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
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      // the portal stays out of search results; the public company page and the
      // privacy/SMS terms are left indexable so the business can be verified
      // the portal only — the public company page, sign-in and legal page stay indexable
      ...["home", "releases", "payroll", "pact", "schedule", "items", "proposals", "statements", "settings", "admin", "reset", "help"]
        .flatMap((p) => [`/${p}`, `/${p}/:path*`])
        .map((source) => ({ source, headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }] })),
    ];
  },
};
export default nextConfig;
