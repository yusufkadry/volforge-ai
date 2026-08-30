import type { Candidate, HorizonForecast, HorizonValidation, ModelManifest } from "../lib/types";

export function validation(overrides: Partial<HorizonValidation> = {}): HorizonValidation {
  return {
    mae: 0.02, baselineMae: 0.03, brier: 0.20, baselineBrier: 0.25, brierSkill: 0.2,
    directionAccuracy: 0.55, observations: 300, oosObservations: 10, purgedSamples: 100, embargoDays: 2, folds: 10,
    calibration: [], stress: { highVolatilityMae: 0.03, highVolatilitySamples: 2, downsideDirectionAccuracy: 0.5, downsideSamples: 5 },
    ...overrides,
  };
}

export function horizon(days: number, overrides: Partial<HorizonForecast> = {}): HorizonForecast {
  const manifest: ModelManifest = {
    modelVersion: "test", featureNames: [], horizonTradingDays: days, dataStart: "2025-01-01", dataEnd: "2026-01-01", trainingSamples: 300,
    regression: { means: [], scales: [], weights: [], targetMean: 0.2, targetScale: 0.1 },
    classifier: { means: [], scales: [], weights: [], probabilityShrinkage: 1 }, datasetHash: "data", manifestHash: "manifest",
  };
  return { horizonTradingDays: days, forecastRv: 0.25, rawProbabilityUp: 0.5, probabilityUp: 0.5, expectedLogReturn: 0, sigmaLogReturn: 0.025, validation: validation(), featureValues: [], manifest, ...overrides };
}

export function candidate(overrides: Partial<Candidate> = {}): Candidate {
  const strike = overrides.strike ?? 100;
  const spot = overrides.spot ?? 100;
  const bid = overrides.bid ?? 2;
  const ask = overrides.ask ?? 2.1;
  return {
    optionSymbol: "TEST261218C00100000", underlying: "TEST", contractType: "call", strike, expirationDate: "2026-12-18", dte: 30,
    bid, ask, midpoint: (bid + ask) / 2, impliedVolatility: 0.2, spot, logMoneyness: Math.log(strike / spot),
    surface: { fairIv: 0.23, residualIv: -0.03, relativeResidual: -0.13, residualZScore: -2, fitRmse: 0.01, localScale: 0.015, neighborCount: 12, model: "robust-moneyness-tenor-v1" },
    expiryMedianIv: 0.23, anomalyScore: -0.13, delta: 0.5, vega: 0.1, openInterest: 2000, quoteTimestamp: new Date().toISOString(), dataFeed: "opra", tradable: true,
    ...overrides,
  };
}
