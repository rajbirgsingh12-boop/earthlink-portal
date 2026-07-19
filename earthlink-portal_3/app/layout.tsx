import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Earth Link Field Office",
  description: "Earth Link General Construction portal",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
