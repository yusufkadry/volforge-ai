import { CONSTITUTION } from "@/lib/constitution";
import { numberEnv } from "@/lib/env";
import { clamp } from "@/lib/math";
import { evaluateVerticalSpread, type SpreadValuation } from "@/lib/options-model";
import { forecastForDte, forecastForTradingDays, validationPassed } from "@/lib/research";
import { quoteSpread } from "@/lib/strategy";
import type { Candidate, ResearchForecast } from "@/lib/types";

export type TradePlan = {
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

function roundCent(value: number) { return Math.round(value * 100) / 100; }

function liquidLeg(contract: Candidate, requireDirectionalDelta: boolean) {
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

function spreadFor(candidate: Candidate, contracts: Candidate[]) {
  return contracts
    .filter((other) => other.underlying === candidate.underlying
      && other.contractType === candidate.contractType
      && other.expirationDate === candidate.expirationDate
      && other.optionSymbol !== candidate.optionSymbol
      && (candidate.contractType === "call" ? other.strike > candidate.strike : other.strike < candidate.strike)
      && liquidLeg(other, false))
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

export function rankTradePlans(candidates: Candidate[], forecasts: Map<string, ResearchForecast>, accountEquity: number, maxPremium: number) {
  const riskBudget = Math.min(maxPremium, accountEquity * numberEnv("MAX_RISK_PER_TRADE_PCT", 0.005));
  const minRewardRisk = numberEnv("MIN_REWARD_RISK", 1.25);
  const minExpectedValue = numberEnv("MIN_EXPECTED_VALUE", 8);
  const minStressExpectedValue = numberEnv("MIN_STRESS_EXPECTED_VALUE", 0);
  const plans: TradePlan[] = [];

  for (const candidate of candidates) {
    const forecast = forecasts.get(candidate.underlying);
    if (!forecast || !liquidLeg(candidate, true)) continue;
    const valuationForecast = forecastForDte(forecast, candidate.dte);
    const holdingForecast = forecastForTradingDays(forecast, numberEnv("EXPECTED_HOLDING_DAYS", 3));
    if (!valuationForecast || !holdingForecast || !validationPassed(valuationForecast.validation) || !validationPassed(holdingForecast.validation)) continue;
    const directionProbability = candidate.contractType === "call" ? holdingForecast.probabilityUp : 1 - holdingForecast.probabilityUp;
    const forecastEdge = valuationForecast.forecastRv - candidate.impliedVolatility;
    if (forecastEdge < numberEnv("MIN_FORECAST_EDGE", 0.02)
      || candidate.surface.relativeResidual > -numberEnv("MIN_IV_DISCOUNT", 0.03)
      || candidate.surface.residualZScore > -numberEnv("MIN_SURFACE_Z_SCORE", 1)) continue;

    for (const spread of spreadFor(candidate, candidates)) {
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
      if (rewardRisk < minRewardRisk || valuation.expectedValue < minExpectedValue || valuation.stressedExpectedValue < minStressExpectedValue || quantity < 1) continue;
      plans.push({
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
        forecastEdge,
        directionProbability,
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
  return plans.sort((left, right) => right.allocationScore - left.allocationScore);
}

export function rewardPlanFailure(candidates: Candidate[], forecasts: Map<string, ResearchForecast>, accountEquity: number, maxPremium: number) {
  if (!candidates.length) return "No complete, executable option chain was returned by the live surface scan.";
  if (!candidates.some((candidate) => forecasts.has(candidate.underlying))) return "No fresh horizon-matched research forecast matched the executable option chain.";
  const riskBudget = Math.min(maxPremium, accountEquity * numberEnv("MAX_RISK_PER_TRADE_PCT", 0.005));
  return `No liquid debit spread survived the moneyness-tenor residual, purged validation, distributional EV, adverse-stress EV, ${numberEnv("MIN_REWARD_RISK", 1.25).toFixed(2)} reward/risk, and $${riskBudget.toFixed(0)} defined-loss thresholds.`;
}
