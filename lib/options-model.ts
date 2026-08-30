import { CONSTITUTION } from "@/lib/constitution";
import { numberEnv } from "@/lib/env";
import { average, blackScholesPrice, clamp, inverseNormal, percentile } from "@/lib/math";
import type { Candidate, HorizonForecast } from "@/lib/types";

type WeightedOutcome = { pnl: number; exitValue: number; terminalSpot: number; weight: number };

export type SpreadValuation = {
  model: "distributional-mark-forward-v1";
  probabilityProfit: number;
  expirationProbabilityProfit: number;
  expectedValue: number;
  stressedExpectedValue: number;
  conservativeExpectedValue: number;
  expectedExitValue: number;
  cvar95: number;
  pnlP10: number;
  pnlP50: number;
  pnlP90: number;
  rawKellyFraction: number;
  fractionalKelly: number;
  scenarioCount: number;
  assumptions: Record<string, unknown>;
};

function weightedAverage(outcomes: WeightedOutcome[], field: "pnl" | "exitValue") {
  const weight = outcomes.reduce((total, outcome) => total + outcome.weight, 0);
  return outcomes.reduce((total, outcome) => total + outcome[field] * outcome.weight, 0) / Math.max(weight, 0.000001);
}

function weightedProbability(outcomes: WeightedOutcome[], predicate: (outcome: WeightedOutcome) => boolean) {
  const weight = outcomes.reduce((total, outcome) => total + outcome.weight, 0);
  return outcomes.filter(predicate).reduce((total, outcome) => total + outcome.weight, 0) / Math.max(weight, 0.000001);
}

function expandedPnl(outcomes: WeightedOutcome[]) {
  return outcomes.flatMap((outcome) => Array.from({ length: Math.max(1, Math.round(outcome.weight * 1000)) }, () => outcome.pnl));
}

function optimizeKelly(outcomes: WeightedOutcome[], maxLoss: number) {
  if (maxLoss <= 0 || weightedAverage(outcomes, "pnl") <= 0) return 0;
  let bestFraction = 0;
  let bestUtility = Number.NEGATIVE_INFINITY;
  for (let step = 0; step <= 100; step += 1) {
    const fraction = step / 100;
    const utility = outcomes.reduce((total, outcome) => {
      const wealth = 1 + fraction * clamp(outcome.pnl / maxLoss, -1, 20);
      return total + outcome.weight * Math.log(Math.max(wealth, 0.000001));
    }, 0);
    if (utility > bestUtility) { bestUtility = utility; bestFraction = fraction; }
  }
  return bestFraction;
}

function targetIv(contract: Candidate, valuationForecast: HorizonForecast, convergence: number) {
  const localRepair = contract.impliedVolatility + convergence * (contract.surface.fairIv - contract.impliedVolatility);
  const broadRepair = numberEnv("FORECAST_IV_CONVERGENCE", 0.15) * (valuationForecast.forecastRv - contract.surface.fairIv);
  return clamp(localRepair + broadRepair, 0.03, 3);
}

function markOutcomes(input: {
  longLeg: Candidate;
  shortLeg: Candidate;
  entryDebit: number;
  valuationForecast: HorizonForecast;
  holdingForecast: HorizonForecast;
  stress: boolean;
}) {
  const { longLeg, shortLeg, entryDebit, valuationForecast, holdingForecast, stress } = input;
  const scenarios: WeightedOutcome[] = [];
  const quantiles = Math.max(61, Math.round(numberEnv("VALUATION_QUANTILES", 121)));
  const rate = numberEnv("RISK_FREE_RATE", 0.045);
  const holdingTradingDays = Math.min(holdingForecast.horizonTradingDays, Math.max(1, longLeg.dte - 1));
  const holdingCalendarDays = holdingTradingDays * 365 / 252;
  const remainingYears = Math.max((longLeg.dte - holdingCalendarDays) / 365, 1 / 3650);
  const convergence = stress ? 0 : numberEnv("LOCAL_IV_CONVERGENCE", 0.35);
  const longIv = targetIv(longLeg, valuationForecast, convergence);
  const shortIv = targetIv(shortLeg, valuationForecast, convergence);
  const feedMultiplier = longLeg.dataFeed.toLowerCase() === "opra" && shortLeg.dataFeed.toLowerCase() === "opra" ? 1 : numberEnv("INDICATIVE_FRICTION_MULTIPLIER", 1.25);
  const quoteFriction = ((longLeg.ask - longLeg.bid) + (shortLeg.ask - shortLeg.bid)) * numberEnv("EXIT_QUOTE_HAIRCUT", 0.5) * feedMultiplier * (stress ? 1.35 : 1);
  const mean = holdingForecast.expectedLogReturn * (stress ? 0.5 : 1);
  const sigma = holdingForecast.sigmaLogReturn * (stress ? 1.25 : 1);
  const regimes = stress ? [{ weight: 0.7, scale: 1.25 }, { weight: 0.3, scale: 2 }] : [{ weight: 0.85, scale: 1 }, { weight: 0.15, scale: 1.75 }];
  const width = Math.abs(shortLeg.strike - longLeg.strike);
  const currentYears = Math.max(longLeg.dte / 365, 1 / 3650);
  const currentLongModel = blackScholesPrice({ spot: longLeg.spot, strike: longLeg.strike, years: currentYears, volatility: longLeg.impliedVolatility, rate, type: longLeg.contractType });
  const currentShortModel = blackScholesPrice({ spot: shortLeg.spot, strike: shortLeg.strike, years: currentYears, volatility: shortLeg.impliedVolatility, rate, type: shortLeg.contractType });
  const currentModelSpread = clamp(currentLongModel - currentShortModel, 0, width);
  const observedMidSpread = clamp(longLeg.midpoint - shortLeg.midpoint, 0, width);

  for (const regime of regimes) {
    for (let index = 0; index < quantiles; index += 1) {
      const z = inverseNormal((index + 0.5) / quantiles);
      const terminalSpot = longLeg.spot * Math.exp(mean + sigma * regime.scale * z);
      const longValue = blackScholesPrice({ spot: terminalSpot, strike: longLeg.strike, years: remainingYears, volatility: longIv, rate, type: longLeg.contractType });
      const shortValue = blackScholesPrice({ spot: terminalSpot, strike: shortLeg.strike, years: remainingYears, volatility: shortIv, rate, type: shortLeg.contractType });
      const theoreticalSpread = clamp(longValue - shortValue, 0, width);
      // Anchor model changes to the observed market so theoretical level error cannot fabricate instant alpha.
      const anchoredSpread = clamp(observedMidSpread + theoreticalSpread - currentModelSpread, 0, width);
      const executableExit = Math.max(0, anchoredSpread - quoteFriction);
      scenarios.push({ terminalSpot, exitValue: executableExit, pnl: (executableExit - entryDebit) * 100, weight: regime.weight / quantiles });
    }
  }
  return { scenarios, holdingTradingDays, quoteFriction, longIv, shortIv };
}

function expirationOutcomes(longLeg: Candidate, shortLeg: Candidate, entryDebit: number, forecast: HorizonForecast) {
  const quantiles = Math.max(61, Math.round(numberEnv("VALUATION_QUANTILES", 121)));
  const width = Math.abs(shortLeg.strike - longLeg.strike);
  const outcomes: WeightedOutcome[] = [];
  for (let index = 0; index < quantiles; index += 1) {
    const z = inverseNormal((index + 0.5) / quantiles);
    const terminalSpot = longLeg.spot * Math.exp(forecast.expectedLogReturn + forecast.sigmaLogReturn * z);
    const intrinsic = verticalExpirationPayoff(longLeg.contractType, longLeg.strike, shortLeg.strike, terminalSpot);
    outcomes.push({ terminalSpot, exitValue: intrinsic, pnl: (intrinsic - entryDebit) * 100, weight: 1 / quantiles });
  }
  return outcomes;
}

export function verticalExpirationPayoff(type: "call" | "put", longStrike: number, shortStrike: number, terminalSpot: number) {
  const width = Math.abs(shortStrike - longStrike);
  return type === "call" ? clamp(terminalSpot - longStrike, 0, width) : clamp(longStrike - terminalSpot, 0, width);
}

export function evaluateVerticalSpread(input: {
  longLeg: Candidate;
  shortLeg: Candidate;
  entryDebit: number;
  valuationForecast: HorizonForecast;
  holdingForecast: HorizonForecast;
}): SpreadValuation {
  const base = markOutcomes({ ...input, stress: false });
  const stress = markOutcomes({ ...input, stress: true });
  const expiration = expirationOutcomes(input.longLeg, input.shortLeg, input.entryDebit, input.valuationForecast);
  const expectedValue = weightedAverage(base.scenarios, "pnl");
  const stressedExpectedValue = weightedAverage(stress.scenarios, "pnl");
  const conservativeExpectedValue = Math.min(expectedValue, stressedExpectedValue);
  const pnl = expandedPnl(base.scenarios);
  const maxLoss = input.entryDebit * 100;
  const rawKellyFraction = optimizeKelly(base.scenarios, maxLoss);
  const fractionalKelly = Math.min(CONSTITUTION.portfolio.fractionalKellyCap, rawKellyFraction * numberEnv("KELLY_FRACTION", 0.25));
  const worst = [...pnl].sort((left, right) => left - right).slice(0, Math.max(1, Math.ceil(pnl.length * 0.05)));
  return {
    model: "distributional-mark-forward-v1",
    probabilityProfit: weightedProbability(base.scenarios, (outcome) => outcome.pnl > 0),
    expirationProbabilityProfit: weightedProbability(expiration, (outcome) => outcome.pnl > 0),
    expectedValue,
    stressedExpectedValue,
    conservativeExpectedValue,
    expectedExitValue: weightedAverage(base.scenarios, "exitValue"),
    cvar95: average(worst),
    pnlP10: percentile(pnl, 0.1),
    pnlP50: percentile(pnl, 0.5),
    pnlP90: percentile(pnl, 0.9),
    rawKellyFraction,
    fractionalKelly,
    scenarioCount: base.scenarios.length + stress.scenarios.length + expiration.length,
    assumptions: {
      holding_trading_days: base.holdingTradingDays,
      return_distribution: "85% calibrated lognormal / 15% 1.75x volatility tail regime",
      stress_distribution: "50% directional mean, 1.25x-2x volatility, no local IV convergence",
      exit_quote_friction: base.quoteFriction,
      options_feed: input.longLeg.dataFeed,
      indicative_friction_multiplier: input.longLeg.dataFeed.toLowerCase() === "opra" ? 1 : numberEnv("INDICATIVE_FRICTION_MULTIPLIER", 1.25),
      long_exit_iv: base.longIv,
      short_exit_iv: base.shortIv,
      pricing_anchor: "Observed spread midpoint plus modeled change in theoretical value",
      risk_free_rate: numberEnv("RISK_FREE_RATE", 0.045),
      paper_limitations: "Model adds quote friction; paper fills still omit market impact, queue position, and latency slippage.",
    },
  };
}
