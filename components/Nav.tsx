"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/forecast", label: "Forecast" },
  { href: "/markets", label: "Markets" },
  { href: "/history", label: "Trades" },
  { href: "/performance", label: "Performance" },
];

export default function Nav() {
  const pathname = usePathname();

  return (
    <header className="border-b border-slate-700 bg-slate-900/80 backdrop-blur sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-4 flex items-center gap-3 md:gap-8 h-14">
        <Link href="/" className="font-bold text-lg text-sky-400 tracking-tight shrink-0">
          PhillyEdge
        </Link>

        {/*
          Mobile: wrapper takes remaining space, clips the nav's overflow, and
          hosts the fade-hint overlay on the right edge.
          Desktop: wrapper shrinks to fit, no clipping needed.
        */}
        <div className="relative flex-1 md:flex-none overflow-hidden md:overflow-visible">
          <nav className={[
            "flex gap-1",
            // Mobile: scroll horizontally; hide the scrollbar track
            "overflow-x-auto md:overflow-x-visible",
            "[&::-webkit-scrollbar]:hidden [scrollbar-width:none]",
          ].join(" ")}>
            {tabs.map((tab) => {
              const active = pathname.startsWith(tab.href);
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  className={`shrink-0 px-3 md:px-4 py-2 md:py-1.5 rounded-md text-sm font-medium transition-colors min-h-[44px] flex items-center justify-center ${
                    active
                      ? "bg-slate-700 text-white"
                      : "text-slate-400 hover:text-slate-100 hover:bg-slate-800"
                  }`}
                >
                  {tab.label}
                </Link>
              );
            })}
          </nav>

          {/* Right-edge fade hint — mobile only, pointer-events off so taps pass through */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-r from-transparent to-slate-900 md:hidden"
          />
        </div>

        <span className="ml-auto text-xs text-slate-500 hidden sm:block shrink-0">
          Philadelphia Weather Trading
        </span>
      </div>
    </header>
  );
}
