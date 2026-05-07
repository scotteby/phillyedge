"use client";

import { useState, useEffect } from "react";
import type { BracketGroup, BracketMarket, BracketRange } from "@/lib/brackets";
import type { MarketTimeStatus, DailyHighStatus } from "@/lib/nws";
import PositionBuilderModal from "./PositionBuilderModal";
import { calcHedgeSize, readHedgeCoverage } from "@/lib/strategy";

interface Props {
  group:           BracketGroup;
  timeStatus?:     MarketTimeStatus;
  currentObsF?:    number | null;   // instantaneous temp right now (KXHIGHPHIL only)
  currentObsAt?:   string | null;   // ISO timestamp of that reading
  highSoFarF?:     number | null;   // running daily max since midnight (KXHIGHPHIL only)
  highReachedAt?:  string | null;   // when the daily max was first established
  highObsStatus?:  DailyHighStatus; // monitoring / leading / likely-final
}

function tempInRange(temp: number, r: BracketRange): boolean {
  // Mirror the inRange logic in lib/brackets.ts:
  // bottom-open (<X): exclusive upper bound  — temp < max
  // top-open (>X):    exclusive lower bound  — temp > min (boundary belongs to bracket below)
  // closed (X-Y):     inclusive on both ends — temp >= min && temp <= max
  if (r.min === null) return r.max !== null && temp < r.max;
  if (r.max === null) return temp > r.min;
  return temp >= r.min && temp <= r.max;
}

function fmtObsTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit",
    timeZone: "America/New_York", hour12: true,
  }) + " ET";
}

// Short series label for mobile header line 1
const SERIES_LABELS: Record<string, string> = {
  KXHIGHPHIL: "High Temperature",
  KXLOWTPHIL: "Low Temperature",
};

export default function BracketGroupCard({
  group, timeStatus = "active",
  currentObsF = null, currentObsAt = null,
  highSoFarF = null, highReachedAt = null, highObsStatus = "monitoring",
}: Props) {
  const [tradeTarget, setTradeTarget] = useState<BracketMarket | null>(null);
  const [showPositionBuilder, setShowPositionBuilder] = useState(false);
  const [hedgeCoverage, setHedgeCoverage] = useState(0.5);

  useEffect(() => {
    setHedgeCoverage(readHedgeCoverage());
  }, []);

  // Extract the date/relative suffix from the computed title: "… · Today, Apr 29" → "Today, Apr 29"
  const titleParts  = group.title.split(" · ");
  const dateSuffix  = titleParts.length > 1 ? titleParts.slice(1).join(" · ") : "";
  const seriesLabel = SERIES_LABELS[group.series] ?? titleParts[0];

  const isHigh    = group.series === "KXHIGHPHIL";
  const isLow     = group.series === "KXLOWTPHIL";
  const isLocked  = timeStatus === "locked";
  const isWarning = timeStatus === "warning";

  // "Likely Winner" — only for high-temp, only after 5 PM when the high is stable
  // Uses highSoFarF (running max) NOT currentObsF (instantaneous reading)
  const likelyWinnerId =
    isHigh && highObsStatus === "likely-final" &&
    highSoFarF !== null && group.observed_value === null
      ? (group.brackets.find((b) => tempInRange(highSoFarF, b.range))?.market_id ?? null)
      : null;

  // "Leading" — 2–5 PM window: high is in this bracket but may still rise
  const leadingId =
    isHigh && highObsStatus === "leading" &&
    highSoFarF !== null && group.observed_value === null && likelyWinnerId === null
      ? (group.brackets.find((b) => tempInRange(highSoFarF, b.range))?.market_id ?? null)
      : null;

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
      {/* ── Mobile header ─────────────────────────────────────────────────── */}
      <div className="md:hidden px-4 pt-3 pb-2.5 border-b border-slate-700">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-white font-semibold text-sm leading-snug">
              {seriesLabel} · Philadelphia
            </h2>
            <p className="text-slate-400 text-xs mt-0.5">
              {dateSuffix}
              {group.forecast_value !== null && (
                <> · Our forecast: <span className="text-white font-medium">{group.forecast_value}°F</span></>
              )}
            </p>
          </div>
          <button
            onClick={() => setShowPositionBuilder(true)}
            className="shrink-0 text-xs px-2.5 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-semibold transition-colors whitespace-nowrap"
          >
            🧱 Build
          </button>
        </div>

        {/* Banners — priority: confirmed > locked > warning > current high > best trade */}
        {group.observed_value !== null ? (
          isLow ? (
            <div className="mt-2 bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2">
              <p className="text-xs text-yellow-300 font-semibold">
                ⭐ Current low: {group.observed_value}°F — likely winner
              </p>
              <p className="text-[10px] text-yellow-400/70 mt-0.5">
                A lower temp near midnight is still possible — trades remain open
              </p>
            </div>
          ) : (
            <div className="mt-2 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
              <p className="text-xs text-amber-300 font-semibold">
                ⚠️ Observed high already recorded: {group.observed_value}°F
              </p>
              <p className="text-[10px] text-amber-400/70 mt-0.5">
                Market outcome is likely determined — arbitrage opportunity
              </p>
            </div>
          )
        ) : isLocked ? (
          <TimeGateBanner status="locked" isHigh={isHigh} isLow={isLow}
            currentObsF={currentObsF} currentObsAt={currentObsAt}
            highSoFarF={highSoFarF} highReachedAt={highReachedAt} highObsStatus={highObsStatus} compact />
        ) : isWarning ? (
          <TimeGateBanner status="warning" isHigh={isHigh} isLow={isLow}
            currentObsF={currentObsF} currentObsAt={currentObsAt}
            highSoFarF={highSoFarF} highReachedAt={highReachedAt} highObsStatus={highObsStatus} compact />
        ) : isHigh && highSoFarF !== null ? (
          <CurrentHighBanner highSoFarF={highSoFarF} highReachedAt={highReachedAt ?? null} highObsStatus={highObsStatus} compact />
        ) : group.best ? (
          <BestTradeBanner primary={group.best} secondary={group.secondary} forecastValue={group.forecast_value} hedgeCoverage={hedgeCoverage} compact />
        ) : null}
      </div>

      {/* ── Desktop header ─────────────────────────────────────────────────── */}
      <div className="hidden md:block px-5 pt-4 pb-3 border-b border-slate-700">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-white font-semibold text-base">{group.title}</h2>
            <p className="text-slate-500 text-xs mt-0.5">
              Closes {new Date(group.end_date + "T12:00:00").toLocaleDateString("en-US", {
                weekday: "short", month: "short", day: "numeric",
              })}
              {group.forecast_value !== null && (
                <span className="ml-2 text-slate-400">
                  · Our forecast: <span className="text-white font-medium">{group.forecast_value}°F</span>
                </span>
              )}
            </p>
          </div>
          <button
            onClick={() => setShowPositionBuilder(true)}
            className="shrink-0 text-xs px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-semibold transition-colors"
          >
            🧱 Build Position
          </button>
        </div>

        {/* Banners — desktop */}
        {group.observed_value !== null ? (
          isLow ? (
            <div className="mt-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-4 py-2.5">
              <p className="text-sm text-yellow-300 font-semibold">
                ⭐ Current low: {group.observed_value}°F — likely winner
              </p>
              <p className="text-xs text-yellow-400/70 mt-0.5">
                A lower temp near midnight is still possible — trades remain open
              </p>
            </div>
          ) : (
            <div className="mt-3 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-2.5">
              <p className="text-sm text-amber-300 font-semibold">
                ⚠️ Observed high already recorded: {group.observed_value}°F
              </p>
              <p className="text-xs text-amber-400/70 mt-0.5">
                Market outcome is likely determined — arbitrage opportunity. Kalshi prices may not yet reflect this.
              </p>
            </div>
          )
        ) : isLocked ? (
          <TimeGateBanner status="locked" isHigh={isHigh} isLow={isLow}
            currentObsF={currentObsF} currentObsAt={currentObsAt}
            highSoFarF={highSoFarF} highReachedAt={highReachedAt} highObsStatus={highObsStatus} />
        ) : isWarning ? (
          <TimeGateBanner status="warning" isHigh={isHigh} isLow={isLow}
            currentObsF={currentObsF} currentObsAt={currentObsAt}
            highSoFarF={highSoFarF} highReachedAt={highReachedAt} highObsStatus={highObsStatus} />
        ) : isHigh && highSoFarF !== null ? (
          <CurrentHighBanner highSoFarF={highSoFarF} highReachedAt={highReachedAt ?? null} highObsStatus={highObsStatus} />
        ) : group.best ? (
          <BestTradeBanner primary={group.best} secondary={group.secondary} forecastValue={group.forecast_value} hedgeCoverage={hedgeCoverage} />
        ) : null}
      </div>

      {/* Bracket rows */}
      <div>
        {/* Column headers — desktop only */}
        <div className="hidden md:grid grid-cols-[1fr_80px_80px_80px_100px_90px] px-5 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wider border-b border-slate-700/50">
          <div>Bracket</div>
          <div className="text-right">Kalshi %</div>
          <div className="text-right">Our %</div>
          <div className="text-right">Edge</div>
          <div className="text-center">Role</div>
          <div className="text-right" />
        </div>

        {group.brackets.map((b) => (
          <BracketRow
            key={b.market_id}
            bracket={b}
            onTrade={() => setTradeTarget(b)}
            observed={group.observed_value}
            timeStatus={timeStatus}
            isLikelyWinner={likelyWinnerId === b.market_id || b.relation === "likely_winner"}
            isLeading={leadingId === b.market_id}
          />
        ))}
      </div>

      {/* Single-bracket trade modal */}
      {tradeTarget && (
        <BracketTradeModal
          bracket={tradeTarget}
          groupTitle={group.title}
          onClose={() => setTradeTarget(null)}
          onConfirm={() => setTradeTarget(null)}
        />
      )}

      {/* Multi-leg position builder modal */}
      {showPositionBuilder && (
        <PositionBuilderModal
          group={group}
          timeStatus={timeStatus}
          onClose={() => setShowPositionBuilder(false)}
        />
      )}
    </div>
  );
}

// ── Current high temp banner ──────────────────────────────────────────────────
// Shown in the active (pre-lock) phase when we have a live running high from NWS.

function CurrentHighBanner({
  highSoFarF, highReachedAt, highObsStatus, compact = false,
}: {
  highSoFarF:     number;
  highReachedAt:  string | null;
  highObsStatus:  DailyHighStatus;
  compact?:       boolean;
}) {
  const outerClass = compact ? "mt-2 rounded-lg px-3 py-2" : "mt-3 rounded-lg px-4 py-2.5";
  const textMd     = compact ? "text-xs"     : "text-sm";
  const textSm     = compact ? "text-[10px]" : "text-xs";

  const peakNote = "";

  if (highObsStatus === "likely-final") {
    return (
      <div className={`${outerClass} border bg-emerald-500/10 border-emerald-500/30`}>
        <p className={`${textMd} text-emerald-300 font-semibold`}>
          ✅ Current high: {highSoFarF}°F — Likely Final{peakNote}
        </p>
        <p className={`${textSm} text-emerald-400/70 mt-0.5`}>
          Stable for 2+ hours · market outcome is likely determined
        </p>
      </div>
    );
  }

  if (highObsStatus === "leading") {
    return (
      <div className={`${outerClass} border bg-orange-500/10 border-orange-500/30`}>
        <p className={`${textMd} text-orange-300 font-semibold`}>
          📊 Current high: {highSoFarF}°F — Leading{peakNote}
        </p>
        <p className={`${textSm} text-orange-400/70 mt-0.5`}>
          2–5 PM peak window · high may still rise before market closes
        </p>
      </div>
    );
  }

  // monitoring — before 2 PM, high is still building
  return (
    <div className={`${outerClass} border bg-sky-500/10 border-sky-500/30`}>
      <p className={`${textMd} text-sky-300 font-semibold`}>
        🌡️ Current high so far: {highSoFarF}°F{peakNote}
      </p>
      <p className={`${textSm} text-sky-400/70 mt-0.5`}>
        Still climbing · typically peaks 2–4 PM ET
      </p>
    </div>
  );
}

// ── Time gate banner ─────────────────────────────────────────────────────────

function TimeGateBanner({
  status, isHigh, isLow,
  currentObsF, currentObsAt,
  highSoFarF = null, highReachedAt = null, highObsStatus = "monitoring",
  compact = false,
}: {
  status:          "warning" | "locked";
  isHigh:          boolean;
  isLow:           boolean;
  currentObsF:     number | null;
  currentObsAt:    string | null;
  highSoFarF?:     number | null;
  highReachedAt?:  string | null;
  highObsStatus?:  DailyHighStatus;
  compact?:        boolean;
}) {
  const outerClass  = compact ? "mt-2 rounded-lg px-3 py-2" : "mt-3 rounded-lg px-4 py-2.5";
  const textMd      = compact ? "text-xs"    : "text-sm";
  const textSm      = compact ? "text-[10px]" : "text-xs";

  // ── High-temp specific messaging ────────────────────────────────────────────
  if (isHigh) {
    let headline: string;
    let detail:   string | null = null;

    const currentLine = currentObsF !== null
      ? `🌡️ Current: ${currentObsF}°F${currentObsAt ? ` at ${fmtObsTime(currentObsAt)}` : ""}`
      : null;

    const highLine = highSoFarF !== null
      ? `High so far today: ${highSoFarF}°F`
      : null;

    if (highObsStatus === "likely-final" && highSoFarF !== null) {
      // 5 PM+ and stable for 2h — high is likely set
      headline = `✅ Today's high is likely recorded: ${highSoFarF}°F`;
      detail   = currentLine;
    } else if (highObsStatus === "leading") {
      // 2–5 PM — near peak but may still rise
      headline = status === "locked"
        ? "🔒 Market locked · Monitoring today's high — may still rise"
        : "⚠️ Approaching peak hours — today's high may still rise";
      const parts = [currentLine, highLine].filter(Boolean);
      detail = parts.length ? parts.join(" · ") : null;
    } else {
      // monitoring — before 2 PM
      headline = status === "locked"
        ? "🔒 Market locked · Today's high typically peaks 2–4 PM ET"
        : "⚠️ Trading window narrowing · Today's high typically peaks 2–4 PM ET";
      const parts = [currentLine, highLine].filter(Boolean);
      detail = parts.length ? parts.join(" · ") : null;
    }

    const bgCls = highObsStatus === "likely-final"
      ? "bg-emerald-500/10 border-emerald-500/30"
      : status === "locked"
      ? "bg-slate-700/40 border-slate-600/60"
      : "bg-yellow-500/10 border-yellow-500/30";

    const headlineCls = highObsStatus === "likely-final"
      ? "text-emerald-300 font-semibold"
      : status === "locked"
      ? "text-slate-300 font-medium"
      : "text-yellow-300 font-medium";

    const detailCls = highObsStatus === "likely-final"
      ? "text-emerald-400/70"
      : status === "locked"
      ? "text-slate-400"
      : "text-yellow-400/70";

    return (
      <div className={`${outerClass} border ${bgCls}`}>
        <p className={`${textMd} ${headlineCls}`}>{headline}</p>
        {detail && <p className={`${textSm} ${detailCls} mt-0.5`}>{detail}</p>}
      </div>
    );
  }

  // ── Low-temp (and other) — original behavior ────────────────────────────────
  const message = status === "locked"
    ? "🔒 Today's overnight low is likely already recorded. Verify before trading."
    : "⚠️ Today's low was likely recorded overnight. Verify observed low before trading this market.";

  const obsLine = currentObsF !== null
    ? `🌡️ Current observed temp: ${currentObsF}°F${currentObsAt ? ` at ${fmtObsTime(currentObsAt)}` : ""}`
    : null;

  if (status === "locked") {
    return (
      <div className={`${outerClass} bg-slate-700/40 border border-slate-600/60`}>
        <p className={`${textMd} text-slate-300 font-medium`}>{message}</p>
        {obsLine && <p className={`${textSm} text-slate-400 mt-0.5`}>{obsLine}</p>}
      </div>
    );
  }

  return (
    <div className={`${outerClass} bg-yellow-500/10 border border-yellow-500/30`}>
      <p className={`${textMd} text-yellow-300 font-medium`}>{message}</p>
      {obsLine && <p className={`${textSm} text-yellow-400/70 mt-0.5`}>{obsLine}</p>}
    </div>
  );
}

// ── Best trade banner ─────────────────────────────────────────────────────────

const REF_BUDGET = 20; // reference budget for suggested size display

function BestTradeBanner({
  primary,
  secondary,
  forecastValue,
  hedgeCoverage,
  compact = false,
}: {
  primary:       BracketMarket;
  secondary:     BracketMarket | null;
  forecastValue: number | null;
  hedgeCoverage: number;
  compact?:      boolean;
}) {
  const edgeSign = (n: number) => `${n >= 0 ? "+" : ""}${n}`;

  // Suggested sizes
  const primaryPrice     = primary.yes_price;
  const primaryContracts = Math.max(1, Math.floor(REF_BUDGET / primaryPrice));

  const hedgeCalc = secondary
    ? calcHedgeSize(primaryContracts, primaryPrice, secondary.yes_price, hedgeCoverage)
    : null;

  const outerClass = compact ? "mt-2 rounded-lg px-3 py-2" : "mt-3 rounded-lg px-4 py-2.5";
  const textSm     = compact ? "text-[10px]" : "text-xs";
  const textMd     = compact ? "text-xs"     : "text-sm";

  // Color based on primary edge
  const bg =
    primary.edge >= 25 ? "bg-emerald-500/10 border border-emerald-500/30" :
    primary.edge >= 10 ? "bg-sky-500/10 border border-sky-500/30"         :
    primary.edge >= 0  ? "bg-slate-700/40 border border-slate-600"         :
    "bg-amber-500/10 border border-amber-500/30";

  const accentCls =
    primary.edge >= 25 ? "text-emerald-400" :
    primary.edge >= 10 ? "text-sky-400"     :
    primary.edge >= 0  ? "text-slate-400"   :
    "text-amber-400";

  return (
    <div className={`${outerClass} ${bg}`}>
      {!compact && (
        <p className={`${textSm} font-semibold uppercase tracking-wide mb-1 ${accentCls}`}>
          Suggested Trades
        </p>
      )}
      {compact && (
        <p className={`${textSm} font-semibold uppercase tracking-wide mb-0.5 ${accentCls}`}>
          Suggested Trades
        </p>
      )}

      {/* Primary row */}
      <div className="flex items-baseline gap-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wide text-emerald-400 shrink-0">Primary</span>
        <span className={`${textMd} text-white font-semibold`}>
          {primary.range.label} YES @ {primary.yes_pct}%
        </span>
        {forecastValue !== null && (
          <span className={`${textSm} text-slate-400`}>
            — ~{primary.confidence}% likely
          </span>
        )}
        <span className={`${textSm} font-semibold ${accentCls} ml-auto shrink-0`}>
          {edgeSign(primary.edge)}pt edge
        </span>
      </div>
      <div className={`${textSm} text-slate-500 mt-0.5 mb-1`}>
        {primaryContracts} contracts · ${REF_BUDGET.toFixed(2)}
        {primary.edge < 0 && (
          <span className="ml-1 text-amber-400/80">(market overpricing our forecast)</span>
        )}
      </div>

      {/* Hedge row */}
      {secondary && hedgeCalc && hedgeCalc.secondaryContracts > 0 && (
        <>
          <div className="flex items-baseline gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wide text-amber-400 shrink-0">Hedge</span>
            <span className={`${textMd} text-white font-semibold`}>
              {secondary.range.label} YES @ {secondary.yes_pct}%
            </span>
            <span className={`${textSm} text-slate-400`}>
              — ~{secondary.confidence}% likely
            </span>
            <span className={`${textSm} font-semibold text-amber-400 ml-auto shrink-0`}>
              {edgeSign(secondary.edge)}pt edge
            </span>
          </div>
          <div className={`${textSm} text-slate-500 mt-0.5`}>
            {hedgeCalc.secondaryContracts} contracts · ${hedgeCalc.secondarySize.toFixed(2)}
            {" · "}{Math.round(hedgeCoverage * 100)}% coverage
          </div>
        </>
      )}

      {!secondary && (
        <div className={`${textSm} text-slate-500 mt-0.5`}>
          No hedge — primary is at edge of bracket range
        </div>
      )}
    </div>
  );
}

// ── Role badge ────────────────────────────────────────────────────────────────

function RoleBadge({ role, compact = false }: { role: "primary" | "hedge" | null; compact?: boolean }) {
  if (role === "primary") {
    return (
      <span className={`${compact ? "text-[10px] px-1" : "text-xs px-1.5"} bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 py-0.5 rounded font-semibold shrink-0 leading-tight`}>
        {compact ? "PRIMARY" : "PRIMARY"}
      </span>
    );
  }
  if (role === "hedge") {
    return (
      <span className={`${compact ? "text-[10px] px-1" : "text-xs px-1.5"} bg-amber-500/20 text-amber-400 border border-amber-500/30 py-0.5 rounded font-semibold shrink-0 leading-tight`}>
        {compact ? "HEDGE" : "HEDGE"}
      </span>
    );
  }
  return null;
}

// ── Bracket row ───────────────────────────────────────────────────────────────

function BracketRow({
  bracket, onTrade, observed, timeStatus = "active",
  isLikelyWinner = false, isLeading = false,
}: {
  bracket:         BracketMarket;
  onTrade:         () => void;
  observed:        number | null;
  timeStatus?:     MarketTimeStatus;
  isLikelyWinner?: boolean;
  isLeading?:      boolean;
}) {
  const isForecast  = bracket.relation === "forecast";
  const isConfirmed = bracket.relation === "confirmed";
  const isLocked    = timeStatus === "locked";
  const isDimmed    = timeStatus === "warning";
  const role        = bracket.bracketRole;

  const rowBg = isLikelyWinner
    ? "bg-yellow-500/10 hover:bg-yellow-500/15"
    : isLeading
    ? "bg-sky-500/10 hover:bg-sky-500/15"
    : isConfirmed
    ? "bg-amber-500/10 hover:bg-amber-500/15"
    : role === "primary"
    ? "bg-emerald-500/8 hover:bg-emerald-500/12"
    : role === "hedge"
    ? "bg-amber-500/5 hover:bg-amber-500/10"
    : "hover:bg-slate-700/20";

  const edgeColor =
    bracket.edge >= 25  ? "text-emerald-400" :
    bracket.edge >= 10  ? "text-sky-400"     :
    bracket.edge <= -25 ? "text-orange-300"  :
    bracket.edge <= -10 ? "text-orange-400"  :
    bracket.edge !== 0  ? "text-slate-300"   :
    "text-slate-600";

  const tradeAllowed = !isLocked || isLikelyWinner;

  function TradeBtn({ mobile }: { mobile: boolean }) {
    if (!tradeAllowed) {
      return (
        <span className={`${mobile ? "text-[10px]" : "text-xs"} text-slate-600 italic`}>
          locked
        </span>
      );
    }

    return (
      <button
        onClick={onTrade}
        className={`${mobile
          ? "shrink-0 text-xs px-3 py-1.5 rounded-lg font-medium transition-colors border"
          : "text-xs px-3 py-1.5 rounded-lg font-medium transition-colors"
        } ${
          isLikelyWinner
            ? mobile
              ? "border-yellow-500 text-yellow-400 hover:bg-yellow-500/20"
              : "bg-yellow-600/80 hover:bg-yellow-500 text-white"
            : mobile
              ? "border-sky-600 text-sky-400 hover:bg-sky-600/20 active:bg-sky-600/30"
              : "bg-sky-600 hover:bg-sky-500 text-white"
        }`}
      >
        Trade
      </button>
    );
  }

  return (
    <>
      {/* ── Desktop row ────────────────────────────────────────────────── */}
      <div className={`hidden md:grid grid-cols-[1fr_80px_80px_80px_100px_90px] items-center px-5 py-2.5 border-b border-slate-700/30 last:border-0 transition-colors ${rowBg} ${isDimmed ? "opacity-60" : ""}`}>
        {/* Bracket label */}
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white">{bracket.range.label}</span>
          {isLikelyWinner && (
            <span className="text-xs bg-yellow-500/20 text-yellow-300 border border-yellow-500/40 px-1.5 py-0.5 rounded font-semibold">
              LIKELY WINNER
            </span>
          )}
          {isLeading && (
            <span className="text-xs bg-sky-500/20 text-sky-300 border border-sky-500/40 px-1.5 py-0.5 rounded font-semibold">
              📊 LEADING
            </span>
          )}
          {isConfirmed && (
            <span className="text-xs bg-amber-500/20 text-amber-300 border border-amber-500/40 px-1.5 py-0.5 rounded font-semibold">
              CONFIRMED
            </span>
          )}
          {isForecast && !isConfirmed && !isLikelyWinner && !isLeading && (
            <span className="text-xs bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-1.5 py-0.5 rounded font-semibold">
              YOUR FORECAST
            </span>
          )}
        </div>

        {/* Kalshi % */}
        <div className="text-right text-sm text-slate-200">{bracket.yes_pct}%</div>

        {/* Our % */}
        <div className="text-right text-sm">
          {bracket.confidence > 0 ? (
            <span className={role === "primary" ? "text-emerald-400 font-semibold" : "text-slate-400"}>
              ~{bracket.confidence}%
            </span>
          ) : (
            <span className="text-slate-600 text-xs italic">no fcst</span>
          )}
        </div>

        {/* Edge */}
        <div className={`text-right text-sm font-semibold ${edgeColor}`}>
          {bracket.confidence > 0
            ? `${bracket.edge > 0 ? "+" : ""}${bracket.edge}`
            : <span className="text-slate-600 text-xs italic">—</span>}
        </div>

        {/* Role badge */}
        <div className="flex justify-center">
          {isLocked && !isLikelyWinner
            ? <span className="text-slate-600 text-xs">—</span>
            : role !== null
            ? <RoleBadge role={role} />
            : <span className="text-slate-600 text-xs">—</span>}
        </div>

        {/* Trade button */}
        <div className="flex justify-end">
          <TradeBtn mobile={false} />
        </div>
      </div>

      {/* ── Mobile card ────────────────────────────────────────────────── */}
      <div className={`md:hidden px-4 py-2 border-b border-slate-700/30 last:border-0 transition-colors ${rowBg} ${isDimmed ? "opacity-60" : ""}`}>
        {/* Row 1: label · tags · role badge · trade btn */}
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white flex-1 min-w-0">{bracket.range.label}</span>
          {isLikelyWinner && (
            <span className="text-[10px] bg-yellow-500/20 text-yellow-300 border border-yellow-500/40 px-1 py-0.5 rounded font-semibold shrink-0 leading-tight">
              ⭐ LIKELY
            </span>
          )}
          {isLeading && (
            <span className="text-[10px] bg-sky-500/20 text-sky-300 border border-sky-500/40 px-1 py-0.5 rounded font-semibold shrink-0 leading-tight">
              📊 LEADING
            </span>
          )}
          {isConfirmed && (
            <span className="text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/40 px-1 py-0.5 rounded font-semibold shrink-0 leading-tight">
              ✓ CONFIRMED
            </span>
          )}
          {isForecast && !isConfirmed && !isLikelyWinner && !isLeading && (
            <span className="text-[10px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-1 py-0.5 rounded font-semibold shrink-0 leading-tight">
              FCST
            </span>
          )}
          <div className="shrink-0">
            {!isLocked && role !== null && <RoleBadge role={role} compact />}
          </div>
          <TradeBtn mobile={true} />
        </div>

        {/* Row 2: inline stats */}
        <div className="text-sm mt-0.5">
          {bracket.confidence > 0 ? (
            <span className="text-slate-500">
              Kalshi <span className="text-slate-400">{bracket.yes_pct}%</span>
              {" · "}Ours <span className={role === "primary" ? "text-emerald-400 font-medium" : "text-slate-400"}>~{bracket.confidence}%</span>
              {!isLocked && (
                <>{" · "}Edge <span className={`font-medium ${edgeColor}`}>{bracket.edge > 0 ? "+" : ""}{bracket.edge}</span></>
              )}
            </span>
          ) : (
            <span className="text-slate-500">Kalshi {bracket.yes_pct}% · no forecast</span>
          )}
        </div>
      </div>
    </>
  );
}

// ── Bracket trade modal ───────────────────────────────────────────────────────

type TradeStatus = "idle" | "placing" | "success" | "error";

const SERIES_SLUGS: Record<string, string> = {
  kxhighphil:   "highest-temperature-in-philadelphia",
  kxlowtphil:   "lowest-temperature-in-philadelphia",
  kxprecipphil: "precipitation-in-philadelphia",
};

function buildKalshiUrl(marketId: string): string {
  const series = marketId.split("-")[0].toLowerCase();
  const slug   = SERIES_SLUGS[series] ?? series;
  return `https://kalshi.com/markets/${series}/${slug}/${marketId.toLowerCase()}`;
}

function BracketTradeModal({
  bracket,
  groupTitle,
  onClose,
  onConfirm,
}: {
  bracket: BracketMarket;
  groupTitle: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [side, setSide]     = useState<"YES" | "NO">("YES");
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<TradeStatus>("idle");
  const [error, setError]   = useState<string | null>(null);
  const [result, setResult] = useState<{
    order_id: string | null;
    count:    number;
    price:    number;
    demo:     boolean;
  } | null>(null);

  // Live orderbook — fetched fresh on open and when side changes.
  const [bidCents,    setBidCents]    = useState<number | null>(null);
  const [askCents,    setAskCents]    = useState<number | null>(null);
  const [obLoading,   setObLoading]   = useState(true);
  const [priceInput,  setPriceInput]  = useState("");

  useEffect(() => {
    setObLoading(true);
    setBidCents(null);
    setAskCents(null);
    fetch(`/api/orderbook?ticker=${encodeURIComponent(bracket.market_id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j) return;
        const bid = side === "YES" ? j.yes_bid_cents : j.no_bid_cents;
        const ask = side === "YES" ? j.yes_ask_cents : j.no_ask_cents;
        setBidCents(typeof bid === "number" ? bid : null);
        setAskCents(typeof ask === "number" ? ask : null);
        if (ask != null) setPriceInput(String(ask));
      })
      .catch(() => {})
      .finally(() => setObLoading(false));
  }, [bracket.market_id, side]);

  // Reset price when side changes so new ask is used as default
  useEffect(() => { setPriceInput(""); }, [side]);

  const parsedCents = parseInt(priceInput, 10);
  const validPrice  = !isNaN(parsedCents) && parsedCents >= 1 && parsedCents <= 99;
  const midPrice    = side === "YES" ? bracket.yes_price : 1 - bracket.yes_price;
  const limitPrice  = validPrice ? parsedCents / 100 : (askCents != null ? askCents / 100 : midPrice);

  const fillsNow = askCents != null && validPrice && parsedCents >= askCents;
  const rests    = askCents != null && validPrice && parsedCents < askCents;

  function nudgePrice(delta: number) {
    const current = parseInt(priceInput, 10);
    const base = isNaN(current) ? (askCents ?? Math.round(midPrice * 100)) : current;
    setPriceInput(String(Math.min(99, Math.max(1, base + delta))));
  }

  const kalshiUrl  = buildKalshiUrl(bracket.market_id);
  const usdc       = parseFloat(amount) || 0;
  const shares     = limitPrice > 0 ? usdc / limitPrice : 0;
  const maxProfit  = shares - usdc;

  async function handlePlace() {
    if (!usdc || usdc <= 0) { setError("Enter a valid USDC amount."); return; }
    setStatus("placing");
    setError(null);

    try {
      const res  = await fetch("/api/place-trade", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker:          bracket.market_id,
          side,
          amount_dollars:  usdc,
          limit_price:     limitPrice,
          market_question: `${groupTitle} — ${bracket.range.label}`,
          target_date:     bracket.end_date,
          market_pct:      bracket.yes_pct,
          my_pct:          bracket.confidence,
          edge:            bracket.edge,
          signal:          bracket.signal,
        }),
      });
      const json = await res.json();

      if (!res.ok) {
        setError(json.error ?? "Order failed.");
        setStatus("error");
        return;
      }

      setResult({ order_id: json.order_id, count: json.count, price: json.price_dollars, demo: !!json.demo });
      setStatus("success");
      // Don't call onConfirm() here — that would unmount the modal immediately,
      // swallowing the success screen. The user dismisses it with "Done".
    } catch (err) {
      setError(String(err));
      setStatus("error");
    }
  }

  // ── Success screen ──────────────────────────────────────────────────────────
  if (status === "success" && result) {
    return (
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
        <div className="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-md shadow-2xl p-8 text-center space-y-4">
          <p className="text-5xl">✅</p>
          <div>
            <div className="flex items-center justify-center gap-2">
              <p className="text-white font-bold text-lg">Order Placed!</p>
              {result.demo && (
                <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">
                  DEMO
                </span>
              )}
            </div>
            <p className="text-slate-400 text-sm mt-1">
              {result.count} contract{result.count !== 1 ? "s" : ""} ·{" "}
              {(result.price * 100).toFixed(0)}¢ each · ${usdc.toFixed(2)} deployed
            </p>
          </div>
          {result.order_id && (
            <p className="text-xs text-slate-500 font-mono bg-slate-700/60 rounded-lg px-3 py-1.5 break-all">
              Order ID: {result.order_id}
            </p>
          )}
          <div className="flex gap-3 pt-2">
            <a href={kalshiUrl} target="_blank" rel="noopener noreferrer"
              className="flex-1 py-2 rounded-xl border border-slate-600 text-slate-300 text-sm font-medium hover:bg-slate-700 transition-colors text-center">
              View on Kalshi ↗
            </a>
            <button onClick={onClose}
              className="flex-1 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold transition-colors">
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-md shadow-2xl">
        {/* Header */}
        <div className="p-6 border-b border-slate-700">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-slate-400 text-xs mb-1">{groupTitle}</p>
              <h2 className="text-white font-semibold text-base">{bracket.range.label}</h2>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors mt-0.5">✕</button>
          </div>
          {bracket.confidence > 0 && (
            <div className="mt-2 text-xs text-slate-400">
              Kalshi {bracket.yes_pct}% · Our estimate ~{bracket.confidence}% ·{" "}
              <span className={bracket.edge >= 0 ? "text-emerald-400" : "text-red-400"}>
                {bracket.edge > 0 ? "+" : ""}{bracket.edge}pt edge
              </span>
            </div>
          )}
        </div>

        <div className="p-6 space-y-4">
          {/* Side */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Side</label>
            <div className="flex gap-2">
              {(["YES", "NO"] as const).map((s) => (
                <button key={s} onClick={() => setSide(s)}
                  className={`flex-1 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                    side === s
                      ? s === "YES" ? "bg-emerald-500/20 border-emerald-500 text-emerald-400"
                                    : "bg-red-500/20 border-red-500 text-red-400"
                      : "bg-slate-700 border-slate-600 text-slate-400 hover:border-slate-500"
                  }`}>{s}</button>
              ))}
            </div>
          </div>

          {/* Amount */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Amount (USDC)</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
              <input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)}
                placeholder="100"
                className="w-full bg-slate-700 border border-slate-600 rounded-lg pl-7 pr-16 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-sky-500" />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs">USDC</span>
            </div>
          </div>

          {/* Limit price */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-slate-300">
                Limit Price ({side})
              </label>
              {!obLoading && bidCents != null && askCents != null && (
                <span className="text-xs text-slate-500">
                  Bid <span className="text-slate-400">{bidCents}¢</span>
                  <span className="mx-1.5 text-slate-600">/</span>
                  Ask <span className="text-slate-400">{askCents}¢</span>
                </span>
              )}
              {obLoading && (
                <span className="text-xs text-slate-500 animate-pulse">loading orderbook…</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => nudgePrice(-1)}
                disabled={obLoading || status === "placing"}
                className="w-9 h-9 flex items-center justify-center rounded-lg border border-slate-600 text-slate-300 hover:border-slate-400 hover:text-white transition-colors disabled:opacity-40 text-lg font-medium"
              >
                −
              </button>
              <div className="relative flex-1">
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={priceInput}
                  onChange={(e) => setPriceInput(e.target.value)}
                  disabled={obLoading || status === "placing"}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm text-center font-semibold focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent disabled:opacity-50"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm pointer-events-none">¢</span>
              </div>
              <button
                onClick={() => nudgePrice(1)}
                disabled={obLoading || status === "placing"}
                className="w-9 h-9 flex items-center justify-center rounded-lg border border-slate-600 text-slate-300 hover:border-slate-400 hover:text-white transition-colors disabled:opacity-40 text-lg font-medium"
              >
                +
              </button>
              {askCents != null && (
                <button
                  onClick={() => setPriceInput(String(askCents))}
                  disabled={status === "placing"}
                  className="px-2.5 py-2 rounded-lg border border-slate-600 text-slate-400 hover:text-white hover:border-slate-500 text-xs transition-colors disabled:opacity-40 whitespace-nowrap"
                >
                  Ask
                </button>
              )}
            </div>
            {fillsNow && (
              <p className="mt-1.5 text-xs text-emerald-400">
                ✓ At or above ask — order should fill immediately.
              </p>
            )}
            {rests && (
              <p className="mt-1.5 text-xs text-amber-400">
                ⏳ Below ask — order will rest until a seller matches it.
              </p>
            )}
          </div>

          {/* Stats */}
          <div className="bg-slate-700/50 rounded-xl p-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-400">Contracts</span>
              <span className="text-white">{shares > 0 ? Math.floor(shares).toLocaleString() : "—"}</span>
            </div>
            <div className="border-t border-slate-600 pt-2 flex justify-between font-semibold">
              <span className="text-slate-300">Max Profit</span>
              <span className="text-emerald-400">{maxProfit > 0 ? `+$${maxProfit.toFixed(2)}` : "—"}</span>
            </div>
          </div>

          {/* Error */}
          {status === "error" && error && (
            <div className="space-y-2">
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-400 text-sm">
                {error}
              </div>
              <a href={kalshiUrl} target="_blank" rel="noopener noreferrer"
                className="block w-full text-center py-2 rounded-lg border border-slate-600 text-slate-300 text-sm hover:bg-slate-700 transition-colors">
                Open on Kalshi instead ↗
              </a>
            </div>
          )}
        </div>

        <div className="p-6 pt-0 flex gap-3">
          <button onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-300 text-sm font-medium hover:bg-slate-700 transition-colors">
            Cancel
          </button>
          <button onClick={handlePlace} disabled={status === "placing" || obLoading || !validPrice}
            className="flex-1 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:bg-slate-600 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors">
            {status === "placing" ? "Placing…" : obLoading ? "Loading…" : `Buy ${Math.floor(shares) || "?"} @ ${validPrice ? parsedCents : "?"}¢`}
          </button>
        </div>
      </div>
    </div>
  );
}
