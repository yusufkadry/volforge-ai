import { alpaca } from "@/lib/alpaca";
import { numberEnv } from "@/lib/env";

function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }

function quote(snapshot: Record<string, unknown> | undefined) {
  const latest = (snapshot?.latestQuote ?? snapshot?.latest_quote ?? {}) as Record<string, unknown>;
  const timestamp = String(latest.t ?? latest.timestamp ?? "");
  return { bid: number(latest.bp ?? latest.bid_price), ask: number(latest.ap ?? latest.ask_price), timestamp };
}

export async function spreadQuotes(underlying: string, longLeg: string, shortLeg: string) {
  const response = await alpaca.optionSnapshots([longLeg, shortLeg]);
  const long = quote(response.snapshots?.[longLeg]);
  const short = quote(response.snapshots?.[shortLeg]);
  if (long.bid <= 0 || long.ask <= 0 || short.bid <= 0 || short.ask <= 0) return null;
  const timestamps = [long.timestamp, short.timestamp].filter(Boolean).map((value) => new Date(value).getTime()).filter(Number.isFinite);
  const oldestTimestamp = timestamps.length ? Math.min(...timestamps) : 0;
  const quoteAgeMs = oldestTimestamp ? Date.now() - oldestTimestamp : Number.POSITIVE_INFINITY;
  return {
    long,
    short,
    entryNatural: Math.max(0.01, long.ask - short.bid),
    entryMid: Math.max(0.01, (long.ask + long.bid - short.ask - short.bid) / 2),
    closeNatural: Math.max(0.01, long.bid - short.ask),
    closeMid: Math.max(0.01, (long.ask + long.bid - short.ask - short.bid) / 2),
    quoteAgeMs,
    fresh: quoteAgeMs >= 0 && quoteAgeMs <= numberEnv("MAX_DATA_AGE_MS", 120_000),
    feed: response.meta.feed,
  };
}
