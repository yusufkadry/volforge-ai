import { CONSTITUTION } from "@/lib/constitution";
import { numberEnv } from "@/lib/env";
import { clamp } from "@/lib/math";
import { evaluateVerticalSpread, type SpreadValuation } from "@/lib/options-model";
import { forecastForDte, forecastForTradingDays, validationPassed } from "@/lib/research";
import { quoteSpread } from "@/lib/strategy";
import type { Candidate, ResearchForecast } from "@/lib/types";

export type TradePlan = {
  alphaSource: "surface-value" | "directional-distribution";
  alphaRationale: string;
  candidate: Candidate;
  shortLeg: Candidate;
  debit: number;
  entryMid: number;
  naturalDebit: number;
  maxEntryDebit: number;
  width: number;
  maxLoss: number;
  maxReward: number;
  rewardRisk: number;
  forecastEdge: number;
  directionProbability: number;
  payoffProbability: number;
  expectedValue: number;
  baseExpectedValue: number;
  stressedExpectedValue: number;
  kellyFraction: number;
  rawKellyFraction: number;
  riskBudget: number;
  quantity: number;
  allocationScore: number;
  valuation: SpreadValuation;
  valuationHorizonDays: number;
  holdingHorizonDays: number;
};

export type AllocationDiagnostics = {
  candidatesSeen: number;
  forecastsMatched: number;
  executableLongLegs: number;
  horizonsMatched: number;
  validatedLongLegs: number;
  alphaQualified: number;
  spreadsPriced: number;
  valuationsRun: number;
  payoffsQualified: number;
  plansRanked: number;
  rejectionCounts: Record<string, number>;
};

export type AlphaSignal = {
  source: TradePlan["alphaSource"];
  rationale: string;
  directionProbability: number;
  forecastEdge: number;
};

function roundCent(value: number) { return Math.round(value * 100) / 100; }

export function candidatesWithoutActiveExposure(candidates: Candidate[], activeUnderlyings: Iterable<string>) {
  const blocked = new Set(activeUnderlyings);
  return candidates.filter((candidate) => !blocked.has(candidate.underlying));
}

export function executionLegEligible(contract: Candidate, requireDirectionalDelta: boolean) {
  const delta = Math.abs(contract.delta ?? 0);
  const quoteAge = contract.quoteTimestamp ? Date.now() - new Date(contract.quoteTimestamp).getTime() : Number.POSITIVE_INFINITY;
  return contract.bid > 0
    && contract.ask > contract.bid
    && quoteSpread(contract) <= numberEnv("MAX_QUOTE_SPREAD_PCT", 0.05)
    && (contract.openInterest ?? 0) >= numberEnv("MIN_OPEN_INTEREST", 500)
    && contract.tradable
    && quoteAge >= 0
    && quoteAge <= numberEnv("MAX_DATA_AGE_MS", 120_000)
    && (!requireDirectionalDelta || (delta >= numberEnv("MIN_DELTA", 0.3) && delta <= numberEnv("MAX_DELTA", 0.65)));
}

export function alphaSignal(candidate: Candidate, valuationForecast: ReturnType<typeof forecastForDte>, holdingForecast: ReturnType<typeof forecastForTradingDays>): AlphaSignal | null {
  if (!valuationForecast || !holdingForecast) return null;
  const directionProbability = candidate.contractType === "call" ? holdingForecast.probabilityUp : 1 - holdingForecast.probabilityUp;
  const forecastEdge = valuationForecast.forecastRv - candidate.impliedVolatility;
  const surfaceValue = forecastEdge >= numberEnv("MIN_FORECAST_EDGE", 0.02)
    && candidate.surface.relativeResidual <= -numberEnv("MIN_IV_DISCOUNT", 0.03)
    && candidate.surface.residualZScore <= -numberEnv("MIN_SURFACE_Z_SCORE", 1);
  if (surfaceValue) {
    return {
      source: "surface-value",
      directionProbability,
      forecastEdge,
      rationale: `${(Math.abs(candidate.surface.relativeResidual) * 100).toFixed(1)}% local IV discount with ${(forecastEdge * 100).toFixed(1)} volatility-point horizon edge`,
    };
  }
  const minimumProbability = numberEnv("MIN_DIRECTIONAL_PROBABILITY", 0.52);
  const directionalDistribution = directionProbability >= minimumProbability
    && candidate.surface.relativeResidual <= numberEnv("MAX_DIRECTIONAL_IV_RICHNESS", 0.08)
    && candidate.surface.residualZScore <= numberEnv("MAX_DIRECTIONAL_SURFACE_Z", 1.5);
  if (directionalDistribution) {
    return {
      source: "directional-distribution",
      directionProbability,
      forecastEdge,
      rationale: `${(directionProbability * 100).toFixed(1)}% calibrated ${candidate.contractType} probability with IV no more than ${(numberEnv("MAX_DIRECTIONAL_IV_RICHNESS", 0.08) * 100).toFixed(0)}% rich to its local surface`,
    };
  }
  return null;
}

function spreadFor(candidate: Candidate, contracts: Candidate[]) {
  return contracts
    .filter((other) => other.underlying === candidate.underlying
      && other.contractType === candidate.contractType
      && other.expirationDate === candidate.expirationDate
      && other.optionSymbol !== candidate.optionSymbol
      && (candidate.contractType === "call" ? other.strike > candidate.strike : other.strike < candidate.strike)
      && executionLegEligible(other, false))
    .flatMap((shortLeg) => {
      const width = Math.abs(shortLeg.strike - candidate.strike);
      const naturalDebit = candidate.ask - shortLeg.bid;
      const entryMid = candidate.midpoint - shortLeg.midpoint;
      if (width <= 0 || width > numberEnv("MAX_VERTICAL_WIDTH", 10) || naturalDebit <= 0 || entryMid <= 0 || entryMid >= width) return [];
      const range = Math.max(0, naturalDebit - entryMid);
      const maxEntryDebit = roundCent(Math.min(naturalDebit, entryMid + range * numberEnv("MAX_NATURAL_PRICE_FRACTION", 0.7)));
      const debit = roundCent(Math.min(maxEntryDebit, entryMid + range * numberEnv("INITIAL_PRICE_FRACTION", 0.25)));
      if (debit <= 0 || maxEntryDebit <= 0 || maxEntryDebit >= width) return [];
      return [{ shortLeg, width, debit, entryMid: roundCent(entryMid), naturalDebit: roundCent(naturalDebit), maxEntryDebit }];
    });
}

function diagnostics(): AllocationDiagnostics {
  return {
    candidatesSeen: 0, forecastsMatched: 0, executableLongLegs: 0, horizonsMatched: 0, validatedLongLegs: 0,
    alphaQualified: 0, spreadsPriced: 0, valuationsRun: 0, payoffsQualified: 0, plansRanked: 0, rejectionCounts: {},
  };
}

function reject(result: AllocationDiagnostics, reason: string) {
  result.rejectionCounts[reason] = (result.rejectionCounts[reason] ?? 0) + 1;
}

export function analyzeTradePlans(candidates: Candidate[], forecasts: Map<string, ResearchForecast>, accountEquity: number, maxPremium: number) {
  const riskBudget = Math.min(maxPremium, accountEquity * numberEnv("MAX_RISK_PER_TRADE_PCT", 0.005));
  const minRewardRisk = numberEnv("MIN_REWARD_RISK", 1.25);
  const minExpectedValue = numberEnv("MIN_EXPECTED_VALUE", 8);
  const minStressExpectedValue = numberEnv("MIN_STRESS_EXPECTED_VALUE", 0);
  const plans: TradePlan[] = [];
  const funnel = diagnostics();

  for (const candidate of candidates) {
    funnel.candidatesSeen += 1;
    const forecast = forecasts.get(candidate.underlying);
    if (!forecast) { reject(funnel, "missing forecast"); continue; }
    funnel.forecastsMatched += 1;
    if (!executionLegEligible(candidate, true)) { reject(funnel, "long-leg liquidity"); continue; }
    funnel.executableLongLegs += 1;
    const valuationForecast = forecastForDte(forecast, candidate.dte);
    const holdingForecast = forecastForTradingDays(forecast, numberEnv("EXPECTED_HOLDING_DAYS", 3));
    if (!valuationForecast || !holdingForecast) { reject(funnel, "missing horizon"); continue; }
    funnel.horizonsMatched += 1;
    if (!validationPassed(valuationForecast.validation) || !validationPassed(holdingForecast.validation)) { reject(funnel, "horizon validation"); continue; }
    funnel.validatedLongLegs += 1;
    const alpha = alphaSignal(candidate, valuationForecast, holdingForecast);
    if (!alpha) { reject(funnel, "no alpha thesis"); continue; }
    funnel.alphaQualified += 1;
    const spreads = spreadFor(candidate, candidates);
    if (!spreads.length) { reject(funnel, "no executable short leg"); continue; }
    funnel.spreadsPriced += spreads.length;

    for (const spread of spreads) {
      funnel.valuationsRun += 1;
      const valuation = evaluateVerticalSpread({ longLeg: candidate, shortLeg: spread.shortLeg, entryDebit: spread.maxEntryDebit, valuationForecast, holdingForecast });
      const maxLoss = spread.maxEntryDebit * 100;
      const maxReward = (spread.width - spread.maxEntryDebit) * 100;
      const rewardRisk = maxReward / maxLoss;
      const quantity = maxLoss <= riskBudget
        ? Math.min(numberEnv("MAX_CONTRACTS_PER_ORDER", 5), Math.max(1, Math.floor(riskBudget / maxLoss)))
        : 0;
      const calibrationStrength = clamp(Math.min(valuationForecast.validation.brierSkill, holdingForecast.validation.brierSkill), 0, 1);
      const allocationScore = valuation.conservativeExpectedValue > 0
        ? valuation.conservativeExpectedValue / Math.max(Math.abs(valuation.cvar95), 1)
          + calibrationStrength
          + Math.max(0, -candidate.surface.residualZScore) * 0.08
          + Math.min(valuation.fractionalKelly, CONSTITUTION.portfolio.fractionalKellyCap)
        : Number.NEGATIVE_INFINITY;
      if (rewardRisk < minRewardRisk) { reject(funnel, "reward/risk"); continue; }
      if (valuation.expectedValue < minExpectedValue) { reject(funnel, "base EV"); continue; }
      if (valuation.stressedExpectedValue < minStressExpectedValue) { reject(funnel, "stress EV"); continue; }
      if (quantity < 1) { reject(funnel, "risk budget"); continue; }
      funnel.payoffsQualified += 1;
      plans.push({
        alphaSource: alpha.source,
        alphaRationale: alpha.rationale,
        candidate,
        shortLeg: spread.shortLeg,
        debit: spread.debit,
        entryMid: spread.entryMid,
        naturalDebit: spread.naturalDebit,
        maxEntryDebit: spread.maxEntryDebit,
        width: spread.width,
        maxLoss,
        maxReward,
        rewardRisk,
        forecastEdge: alpha.forecastEdge,
        directionProbability: alpha.directionProbability,
        payoffProbability: valuation.probabilityProfit,
        expectedValue: valuation.conservativeExpectedValue,
        baseExpectedValue: valuation.expectedValue,
        stressedExpectedValue: valuation.stressedExpectedValue,
        kellyFraction: valuation.fractionalKelly,
        rawKellyFraction: valuation.rawKellyFraction,
        riskBudget,
        quantity,
        allocationScore,
        valuation,
        valuationHorizonDays: valuationForecast.horizonTradingDays,
        holdingHorizonDays: holdingForecast.horizonTradingDays,
      });
    }
  }
  const ranked = plans.sort((left, right) => right.allocationScore - left.allocationScore);
  funnel.plansRanked = ranked.length;
  return { plans: ranked, diagnostics: funnel };
}

export function rankTradePlans(candidates: Candidate[], forecasts: Map<string, ResearchForecast>, accountEquity: number, maxPremium: number) {
  return analyzeTradePlans(candidates, forecasts, accountEquity, maxPremium).plans;
}

export function diagnosticSummary(funnel: AllocationDiagnostics) {
  const blockers = Object.entries(funnel.rejectionCounts)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(", ");
  return `${funnel.candidatesSeen} surface contracts -> ${funnel.executableLongLegs} executable long legs -> ${funnel.alphaQualified} alpha-qualified -> ${funnel.spreadsPriced} priced verticals -> ${funnel.plansRanked} ranked plans${blockers ? `. Leading blockers: ${blockers}.` : "."}`;
}

export function rewardPlanFailure(candidates: Candidate[], forecasts: Map<string, ResearchForecast>, accountEquity: number, maxPremium: number, funnel?: AllocationDiagnostics) {
  if (!candidates.length) return "No complete, executable option chain was returned by the live surface scan.";
  if (!candidates.some((candidate) => forecasts.has(candidate.underlying))) return "No fresh horizon-matched research forecast matched the executable option chain.";
  const riskBudget = Math.min(maxPremium, accountEquity * numberEnv("MAX_RISK_PER_TRADE_PCT", 0.005));
  const detail = funnel ? ` ${diagnosticSummary(funnel)}` : "";
  return `No liquid debit spread survived validated dual-alpha routing, distributional EV, adverse-stress EV, ${numberEnv("MIN_REWARD_RISK", 1.25).toFixed(2)} reward/risk, and the $${riskBudget.toFixed(0)} defined-loss budget.${detail}`;
}
