"use client";

import { useCallback, useEffect, useState } from "react";

interface Props {
  /** Additional class names on the wrapper */
  className?: string;
  /** Show a manual refresh button */
  showRefresh?: boolean;
}

export default function KalshiBalance({ className = "", showRefresh = false }: Props) {
  const [balance,  setBalance]  = useState<number | null>(null);
  const [loading,  setLoading]  = useState(true);

  const fetch_ = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await fetch("/api/balance");
      const json = await res.json();
      setBalance(res.ok && json.balance_dollars != null ? json.balance_dollars : null);
    } catch {
      setBalance(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetch_(); }, [fetch_]);

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span className="text-xs text-slate-500 uppercase tracking-wide font-medium">Balance</span>
      {loading ? (
        <span className="text-xs text-slate-500 animate-pulse">…</span>
      ) : balance != null ? (
        <span className="text-sm font-semibold text-emerald-400">${balance.toFixed(2)}</span>
      ) : (
        <span className="text-xs text-slate-600">—</span>
      )}
      {showRefresh && !loading && (
        <button
          onClick={fetch_}
          title="Refresh balance"
          className="text-slate-600 hover:text-slate-300 transition-colors text-xs leading-none"
        >
          ↻
        </button>
      )}
    </span>
  );
}
