import { createHash } from "crypto";
import { numberEnv } from "@/lib/env";
import type { Candidate, RiskGate } from "@/lib/types";
import type { ResearchForecast } from "@/lib/research";
import type { TradePlan } from "@/lib/reward-engine";
import type { WorldEvidence } from "@/lib/world-intelligence";

export type CourtOpinion = { agent: "Surface" | "Regime" | "Execution" | "World Intelligence" | "Red Team"; vote: "approve" | "reject" | "abstain"; rationale: string };

export function conveneCourt(candidate: Candidate, forecast: ResearchForecast | undefined, gates: RiskGate[], plan?: TradePlan, world?: WorldEvidence) {
  const ivEdge = (forecast?.forecastRv ?? 0) - candidate.impliedVolatility;
  const spread = (candidate.ask - candidate.bid) / Math.max((candidate.ask + candidate.bid) / 2, 0.0001);
  const opinions: CourtOpinion[] = [
    { agent: "Surface", vote: candidate.anomalyScore <= -numberEnv("MIN_IV_DISCOUNT", 0.03) ? "approve" : "reject", rationale: `IV anomaly ${(candidate.anomalyScore * 100).toFixed(1)}% versus the local expiry surface; ${(numberEnv("MIN_IV_DISCOUNT", 0.03) * 100).toFixed(1)}% discount required.` },
    { agent: "Regime", vote: ivEdge >= numberEnv("MIN_FORECAST_EDGE", 0.02) ? "approve" : "reject", rationale: `Forecast RV ${((forecast?.forecastRv ?? 0) * 100).toFixed(1)}% versus live IV ${(candidate.impliedVolatility * 100).toFixed(1)}%; edge ${(ivEdge * 100).toFixed(1)}%, minimum ${(numberEnv("MIN_FORECAST_EDGE", 0.02) * 100).toFixed(1)}%.` },
    { agent: "Execution", vote: spread <= 0.05 && (candidate.openInterest ?? 0) >= 500 && Boolean(plan) ? "approve" : "reject", rationale: plan ? `${(spread * 100).toFixed(1)}% spread, ${candidate.openInterest ?? 0} open interest, ${plan.rewardRisk.toFixed(2)}x reward/risk, and $${plan.expectedValue.toFixed(0)} expected value.` : `${(spread * 100).toFixed(1)}% spread and ${candidate.openInterest ?? 0} open interest; no qualifying debit-spread payoff.` },
    { agent: "World Intelligence", vote: world?.verdict === "veto" ? "reject" : world?.verdict === "approve" ? "approve" : "abstain", rationale: world?.rationale ?? "No current world-intelligence evidence." },
    { agent: "Red Team", vote: gates.some((gate) => !gate.passed) ? "reject" : "abstain", rationale: gates.filter((gate) => !gate.passed).map((gate) => gate.name).join(", ") || "No deterministic weakness found." },
  ];
  const evidenceHash = createHash("sha256").update(JSON.stringify({ candidate, forecast, gates, opinions })).digest("hex");
  return { opinions, evidenceHash };
}
