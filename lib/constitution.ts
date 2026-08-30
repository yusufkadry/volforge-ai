import { createHash, randomUUID } from "crypto";

export const STRATEGY_VERSION = "volforge-distributional-surface-v3";

export const CONSTITUTION = {
  purpose: "Allocate only to liquid, defined-risk vertical spreads whose calibrated mark-forward payoff remains positive after quote friction and adverse-distribution stress.",
  data: { maxAgeMs: 120_000, minOpenInterest: 500, maxQuoteSpreadPct: 0.05, requireCompletePagination: true, surfaceModel: "robust-moneyness-tenor-v1" },
  validation: { protocol: "purged-walk-forward", minimumOosFolds: 8, requireVolatilityBaselineWin: true, requireBrierBaselineWin: true },
  portfolio: { maxPositions: 3, maxDailyLoss: 1000, maxPremiumRiskPct: 0.005, fractionalKellyCap: 0.25 },
  trading: { minDte: 21, maxDte: 35, maxHoldingDays: 7, takeProfitPct: 0.5, stopLossPct: 0.35 },
  governance: { liveStrategyFrozen: true, challengerCanTrade: false, requireShadowEvidence: true, llmCanApprove: false, exitsRemainActiveWhenEntriesDisabled: true },
};

export function traceId() { return randomUUID(); }
export function constitutionHash() { return createHash("sha256").update(JSON.stringify(CONSTITUTION)).digest("hex"); }
