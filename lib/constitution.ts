import { createHash, randomUUID } from "crypto";

export const STRATEGY_VERSION = "volforge-reward-engine-v2";

export const CONSTITUTION = {
  purpose: "Allocate only to liquid, defined-risk vertical spreads whose model-weighted expected value and reward-to-risk survive execution costs.",
  data: { maxAgeMs: 120_000, minOpenInterest: 500, maxQuoteSpreadPct: 0.05 },
  portfolio: { maxPositions: 3, maxDailyLoss: 1000, maxPremiumRiskPct: 0.005, fractionalKellyCap: 0.25 },
  trading: { minDte: 21, maxDte: 35, maxHoldingDays: 7, takeProfitPct: 0.5, stopLossPct: 0.35 },
  governance: { liveStrategyFrozen: true, challengerCanTrade: false, requireShadowEvidence: true },
};

export function traceId() { return randomUUID(); }
export function constitutionHash() { return createHash("sha256").update(JSON.stringify(CONSTITUTION)).digest("hex"); }
