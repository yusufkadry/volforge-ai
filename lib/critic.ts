import type { Candidate } from "@/lib/types";
import type { TradePlan } from "@/lib/reward-engine";
import type { WorldEvidence } from "@/lib/world-intelligence";

type CriticVerdict = { approve: boolean; rationale: string };

export async function critic(candidate: Candidate, plan?: TradePlan, world?: WorldEvidence): Promise<CriticVerdict> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { approve: false, rationale: "LLM critic unavailable: OPENAI_API_KEY is not configured." };

  const prompt = [
    "You are a skeptical options risk critic. Return only JSON with boolean approve and a concise rationale.",
    "The numerical engines are authoritative. Approve only if the evidence is internally consistent, liquid, bounded-risk, horizon-matched, and positive in both base and adverse-stress valuation. Reject ambiguity, contradictory assumptions, or unmodeled jump risk. Never invent missing values.",
    JSON.stringify({
      symbol: candidate.optionSymbol, underlying: candidate.underlying, dte: candidate.dte,
      strike: candidate.strike, bid: candidate.bid, ask: candidate.ask,
      spot: candidate.spot, iv: candidate.impliedVolatility, fittedSurfaceIv: candidate.surface.fairIv,
      relativeResidual: candidate.surface.relativeResidual, residualZScore: candidate.surface.residualZScore, surfaceNeighbors: candidate.surface.neighborCount,
      delta: candidate.delta, openInterest: candidate.openInterest, dataFeed: candidate.dataFeed,
      payoff: plan ? {
        structure: `${candidate.contractType} debit spread`,
        longLeg: { symbol: candidate.optionSymbol, strike: candidate.strike, bid: candidate.bid, ask: candidate.ask },
        shortLeg: { symbol: plan.shortLeg.optionSymbol, strike: plan.shortLeg.strike, bid: plan.shortLeg.bid, ask: plan.shortLeg.ask },
        initialLimit: plan.debit, maximumApprovedDebit: plan.maxEntryDebit, naturalDebit: plan.naturalDebit,
        width: plan.width, maxLoss: plan.maxLoss, maxReward: plan.maxReward, rewardRisk: plan.rewardRisk,
        payoffProbability: plan.payoffProbability, baseExpectedValue: plan.baseExpectedValue, stressedExpectedValue: plan.stressedExpectedValue,
        conservativeExpectedValue: plan.expectedValue, cvar95: plan.valuation.cvar95, quantity: plan.quantity,
        valuationHorizonDays: plan.valuationHorizonDays, holdingHorizonDays: plan.holdingHorizonDays, assumptions: plan.valuation.assumptions,
      } : "No executable spread passed the allocator",
      world_intelligence: world ? { verdict: world.verdict, confidence: world.confidence, eventTags: world.eventTags, rationale: world.rationale } : "No world evidence",
    }),
  ].join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`critic returned ${response.status}`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content) as Partial<CriticVerdict>;
    return { approve: parsed.approve === true, rationale: String(parsed.rationale ?? "Critic returned no rationale.") };
  } catch (error) {
    return { approve: false, rationale: `LLM critic failed closed: ${error instanceof Error ? error.message : "unknown error"}` };
  }
}
