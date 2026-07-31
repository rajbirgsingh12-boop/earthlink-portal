import type { Metadata } from "next";
// fonts are baked into the build and served from our own domain — no
// render-blocking trip to Google on every page open
import { Inter, Barlow_Condensed, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-body", display: "swap" });
const barlow = Barlow_Condensed({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-display", display: "swap" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "600"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Earth Link Field Office",
  description: "Earth Link General Construction portal",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${barlow.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
