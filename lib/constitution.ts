import { createHash, randomUUID } from "crypto";

export const STRATEGY_VERSION = "volforge-rv-ensemble-v1";

export const CONSTITUTION = {
  purpose: "Trade liquid, defined-risk options only when a validated realized-volatility forecast exceeds implied volatility after execution costs.",
  data: { maxAgeMs: 120_000, minOpenInterest: 500, maxQuoteSpreadPct: 0.05 },
  portfolio: { maxPositions: 3, maxDailyLoss: 1000, maxPremiumRiskPct: 0.005 },
  trading: { minDte: 21, maxDte: 35, maxHoldingDays: 7, takeProfitPct: 0.5, stopLossPct: 0.35 },
  governance: { liveStrategyFrozen: true, challengerCanTrade: false, requireShadowEvidence: true },
};

export function traceId() { return randomUUID(); }
export function constitutionHash() { return createHash("sha256").update(JSON.stringify(CONSTITUTION)).digest("hex"); }
