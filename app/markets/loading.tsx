import React from "react";

// Shown automatically by Next.js App Router while markets/page.tsx is loading.
// Mirrors the real layout so there's no layout shift when data arrives.

function Pulse({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`animate-pulse rounded-lg bg-slate-700/60 ${className}`} style={style} />;
}

function BracketGroupSkeleton() {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
      {/* Group header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700/50">
        <div className="space-y-2">
          <Pulse className="h-4 w-48" />
          <Pulse className="h-3 w-32" />
        </div>
        <Pulse className="h-8 w-24" />
      </div>
      {/* Bracket rows */}
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-3 border-b border-slate-700/30 last:border-0">
          <Pulse className="h-4 w-24" />
          <Pulse className="h-4 w-12" />
          <Pulse className="h-4 w-12" />
          <Pulse className="h-4 w-16" />
          <div className="ml-auto flex items-center gap-3">
            <Pulse className="h-6 w-16 rounded-full" />
            <Pulse className="h-8 w-16 rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function MarketsLoading() {
  return (
    <>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="space-y-2">
          <Pulse className="h-7 w-28" />
          <Pulse className="h-3 w-52" />
        </div>
        <div className="flex items-center gap-3">
          <Pulse className="h-8 w-28 rounded-lg" />
          <Pulse className="h-8 w-24 rounded-lg" />
        </div>
      </div>

      {/* Filter pills */}
      <div className="flex gap-2 mb-6">
        {[80, 100, 64, 72].map((w, i) => (
          <Pulse key={i} className={`h-8 w-${w} rounded-full`} style={{ width: w * 4 }} />
        ))}
      </div>

      {/* Bracket group cards */}
      <div className="space-y-4">
        <BracketGroupSkeleton />
        <BracketGroupSkeleton />
      </div>
    </>
  );
}
