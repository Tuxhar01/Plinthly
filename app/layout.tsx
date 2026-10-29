import type { Metadata } from "next";
import { Newsreader, Geist, Geist_Mono } from "next/font/google";
import { APP_NAME, APP_TAGLINE } from "@/lib/brand";
import "./globals.css";

const fontDisplay = Newsreader({
  weight: ["500", "600"],
  subsets: ["latin"],
  variable: "--font-display",
  fallback: ["Georgia", "Times New Roman", "serif"],
});

const fontUi = Geist({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-ui",
  fallback: ["system-ui", "-apple-system", "Segoe UI", "sans-serif"],
});

const fontMono = Geist_Mono({
  weight: ["400"],
  subsets: ["latin"],
  variable: "--font-mono",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
});

export const metadata: Metadata = {
  title: APP_NAME,
  description: APP_TAGLINE,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${fontDisplay.variable} ${fontUi.variable} ${fontMono.variable}`}
    >
      <body className="min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
