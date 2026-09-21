import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { PrivacyScript } from "@/components/privacy-toggle";
import { privacyConfig } from "@/lib/privacy";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "MTG Collection Tracker",
    template: "%s · MTG Collection Tracker",
  },
  description: "Track the value of a Magic: The Gathering collection over time.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      // The inline script adds a class here before first paint; React would
      // otherwise warn that the server and client markup disagree.
      suppressHydrationWarning
    >
      <head>
        <PrivacyScript defaultHidden={privacyConfig().defaultHidden} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
