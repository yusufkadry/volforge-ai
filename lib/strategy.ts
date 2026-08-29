import { alpaca } from "@/lib/alpaca";
import { numberEnv } from "@/lib/env";
import type { Candidate, RiskGate } from "@/lib/types";

type RawCandidate = Omit<Candidate, "expiryMedianIv" | "anomalyScore"> & {
  delta: number | undefined;
  openInterest: number | undefined;
  quoteTimestamp: string;
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

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export async function scanSurface(symbol: string, contractType: "call" | "put" = "call"): Promise<Candidate[]> {
  const [contractsResponse, snapshotsResponse] = await Promise.all([
    alpaca.contracts(symbol, isoDate(numberEnv("MIN_DTE", 21)), isoDate(numberEnv("MAX_DTE", 35)), contractType),
    alpaca.snapshots(symbol),
  ]);
  const snapshots = snapshotsResponse.snapshots ?? {};
  const raw = (contractsResponse.option_contracts ?? []).map((contract) => {
    const optionSymbol = String(contract.symbol ?? "");
    const snapshot = snapshots[optionSymbol] ?? {};
    const quote = (snapshot.latestQuote ?? snapshot.latest_quote ?? {}) as Record<string, unknown>;
    const greeks = (snapshot.greeks ?? {}) as Record<string, unknown>;
    const expirationDate = String(contract.expiration_date ?? "");
    return {
      optionSymbol,
      underlying: String(contract.underlying_symbol ?? symbol),
      contractType: String(contract.type ?? "call") as "call" | "put",
      strike: finite(contract.strike_price),
      expirationDate,
      dte: dte(expirationDate),
      bid: finite(quote.bp ?? quote.bid_price),
      ask: finite(quote.ap ?? quote.ask_price),
      impliedVolatility: finite(snapshot.impliedVolatility ?? snapshot.implied_volatility),
      delta: finite(greeks.delta),
      openInterest: finite(snapshot.openInterest ?? snapshot.open_interest ?? contract.open_interest),
      quoteTimestamp: String(quote.t ?? quote.timestamp ?? ""),
      tradable: contract.tradable !== false,
    };
  }).filter((row): row is RawCandidate => Boolean(
    row.optionSymbol && row.expirationDate && row.strike !== undefined && row.bid !== undefined && row.ask !== undefined && row.impliedVolatility !== undefined,
  ));

  const ivByExpiry = new Map<string, number[]>();
  raw.forEach((row) => ivByExpiry.set(row.expirationDate, [...(ivByExpiry.get(row.expirationDate) ?? []), row.impliedVolatility]));
  return raw.map((row) => {
    const expiryMedianIv = median(ivByExpiry.get(row.expirationDate) ?? [row.impliedVolatility]);
    return { ...row, expiryMedianIv, anomalyScore: (row.impliedVolatility - expiryMedianIv) / expiryMedianIv };
  }).sort((a, b) => a.anomalyScore - b.anomalyScore);
}

export function selectCandidate(candidates: Candidate[]) {
  return candidates.find((candidate) => candidate.anomalyScore <= -0.05) ?? candidates[0] ?? null;
}

export function riskGates(candidate: Candidate, marketOpen: boolean, maxPremium: number): RiskGate[] {
  const premium = candidate.ask * 100;
  const midpoint = (candidate.ask + candidate.bid) / 2;
  const spread = midpoint > 0 ? (candidate.ask - candidate.bid) / midpoint : Infinity;
  const minDte = numberEnv("MIN_DTE", 14);
  const maxDte = numberEnv("MAX_DTE", 45);
  const quoteAge = candidate.quoteTimestamp ? Date.now() - new Date(candidate.quoteTimestamp).getTime() : Number.POSITIVE_INFINITY;
  return [
    { name: "Market session", passed: marketOpen, detail: marketOpen ? "Alpaca reports market open" : "Market is closed" },
    { name: "Defined risk", passed: candidate.contractType === "call", detail: "Single long option caps loss at paid premium" },
    { name: "Premium cap", passed: premium <= maxPremium, detail: `$${premium.toFixed(0)} premium / $${maxPremium.toFixed(0)} limit` },
    { name: "Quote quality", passed: spread <= numberEnv("MAX_QUOTE_SPREAD_PCT", 0.18), detail: `${(spread * 100).toFixed(1)}% bid-ask spread` },
    { name: "Open interest", passed: (candidate.openInterest ?? 0) >= numberEnv("MIN_OPEN_INTEREST", 500), detail: `${candidate.openInterest ?? 0} contracts; minimum ${numberEnv("MIN_OPEN_INTEREST", 500)}` },
    { name: "Data freshness", passed: quoteAge <= numberEnv("MAX_DATA_AGE_MS", 120000), detail: Number.isFinite(quoteAge) ? `${Math.max(0, Math.round(quoteAge / 1000))} seconds old` : "Missing quote timestamp" },
    { name: "Tenor", passed: candidate.dte >= minDte && candidate.dte <= maxDte, detail: `${candidate.dte} DTE; allowed ${minDte}-${maxDte}` },
    { name: "Tradability", passed: candidate.tradable, detail: candidate.tradable ? "Contract tradable" : "Contract not tradable" },
  ];
}

export function thesis(candidate: Candidate) {
  return `Long ${candidate.underlying} ${candidate.strike} call expiring ${candidate.expirationDate}. IV is ${(Math.abs(candidate.anomalyScore) * 100).toFixed(1)}% below its expiry median (${(candidate.impliedVolatility * 100).toFixed(1)}% vs ${(candidate.expiryMedianIv * 100).toFixed(1)}%).`;
}
