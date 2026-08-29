import { createHash } from "crypto";
import type { Candidate, RiskGate } from "@/lib/types";
import type { ResearchForecast } from "@/lib/research";

export type CourtOpinion = { agent: "Surface" | "Regime" | "Execution" | "Red Team"; vote: "approve" | "reject" | "abstain"; rationale: string };

export function conveneCourt(candidate: Candidate, forecast: ResearchForecast | undefined, gates: RiskGate[]) {
  const ivEdge = (forecast?.forecastRv ?? 0) - candidate.impliedVolatility;
  const spread = (candidate.ask - candidate.bid) / Math.max((candidate.ask + candidate.bid) / 2, 0.0001);
  const opinions: CourtOpinion[] = [
    { agent: "Surface", vote: candidate.anomalyScore <= -0.05 ? "approve" : "reject", rationale: `IV anomaly ${(candidate.anomalyScore * 100).toFixed(1)}% versus the local expiry surface.` },
    { agent: "Regime", vote: ivEdge >= 0.02 ? "approve" : "reject", rationale: `Forecast RV ${((forecast?.forecastRv ?? 0) * 100).toFixed(1)}% versus live IV ${(candidate.impliedVolatility * 100).toFixed(1)}%; edge ${(ivEdge * 100).toFixed(1)}%.` },
    { agent: "Execution", vote: spread <= 0.05 && (candidate.openInterest ?? 0) >= 500 ? "approve" : "reject", rationale: `${(spread * 100).toFixed(1)}% spread and ${candidate.openInterest ?? 0} open interest.` },
    { agent: "Red Team", vote: gates.some((gate) => !gate.passed) ? "reject" : "abstain", rationale: gates.filter((gate) => !gate.passed).map((gate) => gate.name).join(", ") || "No deterministic weakness found." },
  ];
  const evidenceHash = createHash("sha256").update(JSON.stringify({ candidate, forecast, gates, opinions })).digest("hex");
  return { opinions, evidenceHash };
}
