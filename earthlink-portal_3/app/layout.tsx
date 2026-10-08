import type { Metadata, Viewport } from "next";
// fonts are baked into the build and served from our own domain: no
// render-blocking trip to Google on every page open
import { Inter, Barlow_Condensed, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-body", display: "swap" });
const barlow = Barlow_Condensed({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-display", display: "swap" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "600"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Earth Link Field Office",
  description: "Earth Link General Construction portal",
  // added to an iPhone home screen (app/apple-icon.png) it opens full screen, named "Earth Link", under a dark status bar
  appleWebApp: { title: "Earth Link", capable: true, statusBarStyle: "black" },
  manifest: "/manifest.webmanifest",
};

// the page runs edge to edge on an iPhone (the kit pads the home indicator
// itself) and the browser chrome takes the header's ink
export const viewport: Viewport = { themeColor: "#2B231B", viewportFit: "cover", width: "device-width", initialScale: 1 };

// the database's address: the browser opens the connection to it while the
// page is still arriving, so the first data request has nothing to wait for
const supaOrigin = (() => { try { return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || "").origin; } catch { return ""; } })();

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${barlow.variable} ${plexMono.variable}`}>
      <head>
        {supaOrigin && <link rel="preconnect" href={supaOrigin} crossOrigin="anonymous" />}
        {supaOrigin && <link rel="dns-prefetch" href={supaOrigin} />}
      </head>
      <body>{children}</body>
    </html>
  );
}
