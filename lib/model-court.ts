import { createHash } from "crypto";
import { numberEnv } from "@/lib/env";
import type { TradePlan } from "@/lib/reward-engine";
import type { Candidate, ResearchForecast, RiskGate } from "@/lib/types";
import type { WorldEvidence } from "@/lib/world-intelligence";

export type CourtOpinion = { agent: "Surface" | "Regime" | "Execution" | "Event Intelligence" | "Red Team"; vote: "approve" | "reject" | "abstain"; rationale: string };

export function conveneCourt(candidate: Candidate, forecast: ResearchForecast | undefined, gates: RiskGate[], plan?: TradePlan, world?: WorldEvidence) {
  const opinions: CourtOpinion[] = [
    {
      agent: "Surface",
      vote: candidate.surface.relativeResidual <= -numberEnv("MIN_IV_DISCOUNT", 0.03) && candidate.surface.residualZScore <= -numberEnv("MIN_SURFACE_Z_SCORE", 1) ? "approve" : "reject",
      rationale: `${(candidate.surface.relativeResidual * 100).toFixed(1)}% residual versus robust moneyness-tenor fit; z ${candidate.surface.residualZScore.toFixed(2)} across ${candidate.surface.neighborCount} local peers.`,
    },
    {
      agent: "Regime",
      vote: plan && plan.forecastEdge >= numberEnv("MIN_FORECAST_EDGE", 0.02) ? "approve" : "reject",
      rationale: plan ? `${plan.valuationHorizonDays}-day horizon-matched RV edge ${(plan.forecastEdge * 100).toFixed(1)} points; purged volatility and Brier baselines passed.` : `No horizon-matched validated distribution for ${candidate.dte} calendar DTE.`,
    },
    {
      agent: "Execution",
      vote: plan && plan.expectedValue >= numberEnv("MIN_EXPECTED_VALUE", 8) && plan.stressedExpectedValue >= numberEnv("MIN_STRESS_EXPECTED_VALUE", 0) ? "approve" : "reject",
      rationale: plan ? `$${plan.baseExpectedValue.toFixed(0)} base EV, $${plan.stressedExpectedValue.toFixed(0)} adverse-stress EV, ${(plan.payoffProbability * 100).toFixed(0)}% modeled profit probability, ${plan.valuation.scenarioCount} deterministic scenarios.` : "No spread survived executable pricing and distributional payoff integration.",
    },
    { agent: "Event Intelligence", vote: world?.verdict === "veto" ? "reject" : world?.verdict === "approve" ? "approve" : "abstain", rationale: world?.rationale ?? "No current event evidence." },
    { agent: "Red Team", vote: gates.some((gate) => !gate.passed) ? "reject" : "abstain", rationale: gates.filter((gate) => !gate.passed).map((gate) => gate.name).join(", ") || "No deterministic weakness found." },
  ];
  const evidenceHash = createHash("sha256").update(JSON.stringify({ candidate, forecast, plan, gates, opinions })).digest("hex");
  return { opinions, evidenceHash };
}
