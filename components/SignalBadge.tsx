import type { Signal } from "@/lib/types";

const config: Record<Signal, { label: string; className: string }> = {
  "strong-buy":  { label: "Strong Buy", className: "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" },
  "buy":         { label: "Buy",        className: "bg-sky-500/20 text-sky-400 border border-sky-500/30" },
  "neutral":     { label: "Neutral",    className: "bg-slate-500/20 text-slate-400 border border-slate-500/30" },
  "sell":        { label: "NO",         className: "bg-orange-500/20 text-orange-400 border border-orange-500/30" },
  "strong-sell": { label: "Strong NO",  className: "bg-orange-500/30 text-orange-300 border border-orange-400/50" },
  "avoid":       { label: "Avoid",      className: "bg-red-500/20 text-red-400 border border-red-500/30" },
};

export default function SignalBadge({ signal }: { signal: Signal }) {
  const { label, className } = config[signal];
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold whitespace-nowrap ${className}`}>
      {label}
    </span>
  );
}
