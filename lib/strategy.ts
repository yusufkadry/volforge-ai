import { alpaca } from "@/lib/alpaca";
import { numberEnv } from "@/lib/env";
import { fitVolatilitySurface, type SurfacePoint } from "@/lib/surface-engine";
import type { Candidate, RiskGate } from "@/lib/types";

type RawCandidate = SurfacePoint & {
  optionSymbol: string;
  underlying: string;
  contractType: "call" | "put";
  expirationDate: string;
  delta: number | undefined;
  vega: number | undefined;
  openInterest: number | undefined;
  quoteTimestamp: string;
  tradable: boolean;
};

const asNumber = (value: unknown) => typeof value === "number" ? value : Number(value);
const finite = (value: unknown) => Number.isFinite(asNumber(value)) ? asNumber(value) : undefined;

function isoDate(daysFromNow: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysFromNow);
  return date.toISOString().slice(0, 10);
}

function dte(expirationDate: string) {
  const ms = new Date(`${expirationDate}T20:00:00Z`).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

function stockPrice(snapshot: Record<string, unknown>) {
  const latestTrade = (snapshot.latestTrade ?? snapshot.latest_trade ?? {}) as Record<string, unknown>;
  const minuteBar = (snapshot.minuteBar ?? snapshot.minute_bar ?? {}) as Record<string, unknown>;
  const dailyBar = (snapshot.dailyBar ?? snapshot.daily_bar ?? {}) as Record<string, unknown>;
  const previousDailyBar = (snapshot.prevDailyBar ?? snapshot.prev_daily_bar ?? {}) as Record<string, unknown>;
  return finite(latestTrade.p ?? latestTrade.price ?? minuteBar.c ?? dailyBar.c ?? previousDailyBar.c) ?? 0;
}

export async function scanSurface(symbol: string, contractType: "call" | "put" = "call"): Promise<Candidate[]> {
  const start = isoDate(numberEnv("MIN_DTE", 21));
  const end = isoDate(numberEnv("MAX_DTE", 35));
  const [contractsResponse, snapshotsResponse, stockResponse] = await Promise.all([
    alpaca.contracts(symbol, start, end, contractType),
    alpaca.snapshots(symbol, { start, end, type: contractType }),
    alpaca.stockSnapshot(symbol),
  ]);
  if (contractsResponse.meta.truncated || snapshotsResponse.meta.truncated) throw new Error(`${symbol} option chain exceeded ALPACA_MAX_OPTION_PAGES; scan refused as incomplete.`);
  const spot = stockPrice(stockResponse);
  if (spot <= 0) throw new Error(`${symbol} underlying spot was unavailable; surface scan refused.`);
  const snapshots = snapshotsResponse.snapshots ?? {};
  const raw = (contractsResponse.option_contracts ?? []).map((contract): RawCandidate | null => {
    const optionSymbol = String(contract.symbol ?? "");
    const snapshot = snapshots[optionSymbol] ?? {};
    const quote = (snapshot.latestQuote ?? snapshot.latest_quote ?? {}) as Record<string, unknown>;
    const greeks = (snapshot.greeks ?? {}) as Record<string, unknown>;
    const expirationDate = String(contract.expiration_date ?? "");
    const strike = finite(contract.strike_price);
    const bid = finite(quote.bp ?? quote.bid_price);
    const ask = finite(quote.ap ?? quote.ask_price);
    const impliedVolatility = finite(snapshot.impliedVolatility ?? snapshot.implied_volatility);
    if (!optionSymbol || !expirationDate || strike === undefined || bid === undefined || ask === undefined || ask < bid || impliedVolatility === undefined || impliedVolatility <= 0.01) return null;
    return {
      optionSymbol,
      underlying: String(contract.underlying_symbol ?? symbol),
      contractType: String(contract.type ?? contractType) as "call" | "put",
      strike,
      expirationDate,
      dte: dte(expirationDate),
      bid,
      ask,
      impliedVolatility,
      delta: finite(greeks.delta),
      vega: finite(greeks.vega),
      openInterest: finite(snapshot.openInterest ?? snapshot.open_interest ?? contract.open_interest),
      quoteTimestamp: String(quote.t ?? quote.timestamp ?? ""),
      tradable: contract.tradable !== false,
    };
  }).filter((row): row is RawCandidate => row !== null);

  const fits = fitVolatilitySurface(raw, spot);
  return raw.map((row, index) => {
    const fit = fits[index];
    return {
      ...row,
      spot,
      midpoint: (row.bid + row.ask) / 2,
      logMoneyness: fit.logMoneyness,
      surface: { ...fit, model: "robust-moneyness-tenor-v1" as const },
      expiryMedianIv: fit.fairIv,
      anomalyScore: fit.relativeResidual,
      dataFeed: snapshotsResponse.meta.feed,
    };
  }).sort((left, right) => left.surface.residualZScore - right.surface.residualZScore);
}

export function selectCandidate(candidates: Candidate[]) {
  const discount = numberEnv("MIN_IV_DISCOUNT", 0.03);
  const zScore = numberEnv("MIN_SURFACE_Z_SCORE", 1);
  return candidates.find((candidate) => candidate.surface.relativeResidual <= -discount && candidate.surface.residualZScore <= -zScore) ?? candidates[0] ?? null;
}

export function quoteSpread(candidate: Pick<Candidate, "bid" | "ask">) {
  const midpoint = (candidate.ask + candidate.bid) / 2;
  return midpoint > 0 ? (candidate.ask - candidate.bid) / midpoint : Number.POSITIVE_INFINITY;
}

export function riskGates(candidate: Candidate, marketOpen: boolean): RiskGate[] {
  const spread = quoteSpread(candidate);
  const minDte = numberEnv("MIN_DTE", 21);
  const maxDte = numberEnv("MAX_DTE", 35);
  const delta = Math.abs(candidate.delta ?? 0);
  const quoteAge = candidate.quoteTimestamp ? Date.now() - new Date(candidate.quoteTimestamp).getTime() : Number.POSITIVE_INFINITY;
  const allowIndicative = process.env.ALLOW_INDICATIVE_OPTIONS !== "false";
  const feedApproved = candidate.dataFeed.toLowerCase() === "opra" || allowIndicative;
  return [
    { name: "Market session", passed: marketOpen, detail: marketOpen ? "Alpaca reports market open" : "Market is closed" },
    { name: "Defined risk", passed: candidate.contractType === "call" || candidate.contractType === "put", detail: "Long option is eligible only inside a capped-loss vertical" },
    { name: "Quote quality", passed: spread <= numberEnv("MAX_QUOTE_SPREAD_PCT", 0.05), detail: `${(spread * 100).toFixed(1)}% bid-ask spread; ${(numberEnv("MAX_QUOTE_SPREAD_PCT", 0.05) * 100).toFixed(1)}% maximum` },
    { name: "Open interest", passed: (candidate.openInterest ?? 0) >= numberEnv("MIN_OPEN_INTEREST", 500), detail: `${candidate.openInterest ?? 0} contracts; minimum ${numberEnv("MIN_OPEN_INTEREST", 500)}` },
    { name: "Absolute delta target", passed: delta >= numberEnv("MIN_DELTA", 0.30) && delta <= numberEnv("MAX_DELTA", 0.65), detail: `|delta| ${delta.toFixed(3)}; target ${numberEnv("MIN_DELTA", 0.30).toFixed(2)}-${numberEnv("MAX_DELTA", 0.65).toFixed(2)}` },
    { name: "Data freshness", passed: quoteAge >= 0 && quoteAge <= numberEnv("MAX_DATA_AGE_MS", 120_000), detail: Number.isFinite(quoteAge) ? `${Math.max(0, Math.round(quoteAge / 1000))} seconds old` : "Missing quote timestamp" },
    { name: "Tenor", passed: candidate.dte >= minDte && candidate.dte <= maxDte, detail: `${candidate.dte} DTE; allowed ${minDte}-${maxDte}` },
    { name: "Surface support", passed: candidate.surface.neighborCount >= numberEnv("MIN_SURFACE_NEIGHBORS", 5), detail: `${candidate.surface.neighborCount} liquid local neighbors; fit RMSE ${(candidate.surface.fitRmse * 100).toFixed(2)} vol points` },
    { name: "Feed provenance", passed: feedApproved, detail: candidate.dataFeed.toLowerCase() === "opra" ? "Official OPRA options feed" : `Using ${candidate.dataFeed} feed with conservative execution haircuts${allowIndicative ? "" : "; blocked by policy"}` },
    { name: "Tradability", passed: candidate.tradable, detail: candidate.tradable ? "Contract tradable" : "Contract not tradable" },
  ];
}

export function thesis(candidate: Candidate) {
  const relation = candidate.surface.relativeResidual < 0 ? "below" : "above";
  return `Long ${candidate.underlying} ${candidate.strike} ${candidate.contractType} expiring ${candidate.expirationDate}. IV is ${(Math.abs(candidate.surface.relativeResidual) * 100).toFixed(1)}% ${relation} the robust moneyness-tenor fit (${(candidate.impliedVolatility * 100).toFixed(1)}% observed vs ${(candidate.surface.fairIv * 100).toFixed(1)}% fitted, z ${candidate.surface.residualZScore.toFixed(2)}, ${candidate.surface.neighborCount} local peers).`;
}
