import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Nav from "@/components/Nav";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PhillyEdge — Weather Trading Dashboard",
  description: "Polymarket weather trading dashboard for the Philadelphia region",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const isDemo = process.env.KALSHI_DEMO_MODE === "true";

  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} dark`}>
      <body className="min-h-screen bg-slate-900 text-slate-100 antialiased">
        <Nav />
        {isDemo && (
          <div className="bg-amber-400 text-amber-950 text-center text-sm font-bold py-2 px-4 sticky top-14 z-40">
            ⚠️ DEMO MODE — orders route to demo-api.kalshi.co · no real money at risk
          </div>
        )}
        <main className="max-w-6xl mx-auto px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
