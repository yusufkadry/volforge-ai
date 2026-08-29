import { numberEnv } from "@/lib/env";
import type { ResearchForecast } from "@/lib/research";
import type { Candidate } from "@/lib/types";

export type TradePlan = {
  candidate: Candidate;
  shortLeg: Candidate;
  debit: number;
  width: number;
  maxLoss: number;
  maxReward: number;
  rewardRisk: number;
  forecastEdge: number;
  directionProbability: number;
  payoffProbability: number;
  expectedValue: number;
  kellyFraction: number;
  riskBudget: number;
  quantity: number;
  allocationScore: number;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function spreadFor(candidate: Candidate, contracts: Candidate[]) {
  return contracts
    .filter((other) => other.underlying === candidate.underlying
      && other.contractType === candidate.contractType
      && other.expirationDate === candidate.expirationDate
      && other.optionSymbol !== candidate.optionSymbol
      && (candidate.contractType === "call" ? other.strike > candidate.strike : other.strike < candidate.strike)
      && other.bid > 0)
    .map((shortLeg) => {
      const width = Math.abs(shortLeg.strike - candidate.strike);
      const debit = candidate.ask - shortLeg.bid;
      if (width <= 0 || debit <= 0 || debit >= width) return null;
      return { shortLeg, width, debit };
    })
    .filter((value): value is { shortLeg: Candidate; width: number; debit: number } => value !== null);
}

export function rankTradePlans(candidates: Candidate[], forecasts: Map<string, ResearchForecast>, accountEquity: number, maxPremium: number) {
  const riskBudget = Math.min(maxPremium, accountEquity * numberEnv("MAX_RISK_PER_TRADE_PCT", 0.005));
  const minRewardRisk = numberEnv("MIN_REWARD_RISK", 1.25);
  const minExpectedValue = numberEnv("MIN_EXPECTED_VALUE", 8);
  const plans: TradePlan[] = [];

  for (const candidate of candidates) {
    const forecast = forecasts.get(candidate.underlying);
    if (!forecast) continue;
    const directionProbability = candidate.contractType === "call" ? forecast.probabilityUp : 1 - forecast.probabilityUp;
    const forecastEdge = forecast.forecastRv - candidate.impliedVolatility;
    for (const { shortLeg, width, debit } of spreadFor(candidate, candidates)) {
      const maxLoss = debit * 100;
      const maxReward = (width - debit) * 100;
      const rewardRisk = maxReward / maxLoss;
      const breakEvenFraction = debit / width;
      // A conservative payoff proxy blends directional confidence, breakeven distance, and forecast-IV edge.
      const payoffProbability = clamp(
        directionProbability * 0.55 + (1 - breakEvenFraction) * 0.3 + Math.max(0, forecastEdge) * 0.75,
        0.25,
        0.8,
      );
      const expectedValue = payoffProbability * maxReward - (1 - payoffProbability) * maxLoss;
      const kellyFraction = Math.max(0, payoffProbability - (1 - payoffProbability) / rewardRisk);
      const confidenceBudget = riskBudget * clamp(0.35 + kellyFraction * 2.5, 0.35, 1);
      const quantity = maxLoss <= riskBudget ? Math.max(1, Math.floor(confidenceBudget / maxLoss)) : 0;
      const allocationScore = expectedValue > 0
        ? (expectedValue / maxLoss) * (1 + Math.min(kellyFraction, 0.25) * 2) + Math.max(0, forecastEdge) + Math.max(0, -candidate.anomalyScore)
        : -Infinity;
      if (rewardRisk < minRewardRisk || expectedValue < minExpectedValue || quantity < 1) continue;
      plans.push({ candidate, shortLeg, debit, width, maxLoss, maxReward, rewardRisk, forecastEdge, directionProbability, payoffProbability, expectedValue, kellyFraction, riskBudget, quantity, allocationScore });
    }
  }
  return plans.sort((left, right) => right.allocationScore - left.allocationScore);
}

export function rewardPlanFailure(candidates: Candidate[], forecasts: Map<string, ResearchForecast>, accountEquity: number, maxPremium: number) {
  if (!candidates.length) return "No executable option contracts were returned by the live surface scan.";
  if (!candidates.some((candidate) => forecasts.has(candidate.underlying))) return "No model forecast matched the executable option chain.";
  const riskBudget = Math.min(maxPremium, accountEquity * numberEnv("MAX_RISK_PER_TRADE_PCT", 0.005));
  return `No debit spread met the ${numberEnv("MIN_REWARD_RISK", 1.25).toFixed(2)} reward/risk, $${numberEnv("MIN_EXPECTED_VALUE", 8).toFixed(0)} expected-value, and $${riskBudget.toFixed(0)} risk-budget thresholds.`;
}
