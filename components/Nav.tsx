"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/forecast", label: "Forecast" },
  { href: "/markets", label: "Markets" },
  { href: "/history", label: "History" },
];

export default function Nav() {
  const pathname = usePathname();

  return (
    <header className="border-b border-slate-700 bg-slate-900/80 backdrop-blur sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-4 flex items-center gap-8 h-14">
        <Link href="/" className="font-bold text-lg text-sky-400 tracking-tight shrink-0">
          PhillyEdge
        </Link>
        <nav className="flex gap-1">
          {tabs.map((tab) => {
            const active = pathname.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
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
        <span className="ml-auto text-xs text-slate-500 hidden sm:block">
          Philadelphia Weather Trading
        </span>
      </div>
    </header>
  );
}
