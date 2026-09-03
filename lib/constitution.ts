import { createHash, randomUUID } from "crypto";

export const STRATEGY_VERSION = "volforge-dual-alpha-v4";

export const CONSTITUTION = {
  purpose: "Allocate only to liquid, defined-risk vertical spreads supported by either a volatility-surface dislocation or a calibrated directional distribution, with positive mark-forward payoff after quote friction and adverse stress.",
  data: { maxAgeMs: 120_000, minOpenInterest: 500, maxQuoteSpreadPct: 0.05, requireCompletePagination: true, surfaceModel: "robust-moneyness-tenor-v1", rejectNonEconomicSurfaceInputs: true },
  validation: { protocol: "purged-walk-forward", minimumOosFolds: 8, requireVolatilityBaselineWin: true, requireBrierBaselineWin: true },
  portfolio: { maxPositions: 3, maxDailyLoss: 1000, maxPremiumRiskPct: 0.005, fractionalKellyCap: 0.25 },
  trading: { minDte: 21, maxDte: 35, maxHoldingDays: 7, takeProfitPct: 0.5, stopLossPct: 0.35 },
  execution: { paperOriginsPinned: true, brokerFlatnessRequiredForClosure: true, quantityWeightedExitLedger: true, brokerFailureCooldownMinutes: 30, durableClientOrderRecovery: true, emergencyLegDecompositionAfterAttempts: 3, competitionLegDecompositionAfterAttempts: 4 },
  governance: { liveStrategyFrozen: true, rejectedChallengerCannotDisplaceFreshChampion: true, requirePerSymbolHorizonValidation: true, requireShadowEvidenceByDefault: true, allowAuditedCompetitionBootstrap: true, llmCanApprove: false, exitsRemainActiveWhenEntriesDisabled: true, eventVetoRequiresRelevantEvidence: true },
};

export function traceId() { return randomUUID(); }
export function constitutionHash() { return createHash("sha256").update(JSON.stringify(CONSTITUTION)).digest("hex"); }
