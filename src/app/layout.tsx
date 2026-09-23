import type { Metadata, Viewport } from "next";
import { Inter, Noto_Sans_Tamil } from "next/font/google";

import { brand } from "@/lib/brand";

import "./globals.css";

// Inter covers English UI text, ½ ¾ × and the ₹ sign (latin-ext subset).
const inter = Inter({
  subsets: ["latin", "latin-ext"],
  variable: "--font-inter",
  display: "swap",
});

// Tamil text that staff enter (customer names, notes) renders with a proper
// Unicode font on every device (decision A18). The browser downloads it only
// when a page actually contains Tamil characters.
const notoSansTamil = Noto_Sans_Tamil({
  subsets: ["tamil"],
  variable: "--font-tamil",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: { default: brand.name, template: `%s · ${brand.name}` },
  description: `${brand.productName} — ${brand.name}, ${brand.tagline}.`,
  applicationName: brand.name,
  // Internal business application: never indexed.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: brand.primaryHex,
  colorScheme: "light",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-IN" className={`${inter.variable} ${notoSansTamil.variable} h-full`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
