import type { Candidate } from "@/lib/types";
import type { TradePlan } from "@/lib/reward-engine";

type CriticVerdict = { approve: boolean; rationale: string };

export async function critic(candidate: Candidate, plan?: TradePlan): Promise<CriticVerdict> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { approve: false, rationale: "LLM critic unavailable: OPENAI_API_KEY is not configured." };

  const prompt = [
    "You are a skeptical options risk critic. Return only JSON with boolean approve and a concise rationale.",
    "Approve only if this is a liquid, bounded-risk debit spread with a meaningful valuation edge, positive expected value, and reward-to-risk above 1.25. Reject ambiguous or weak cases.",
    JSON.stringify({
      symbol: candidate.optionSymbol, underlying: candidate.underlying, dte: candidate.dte,
      strike: candidate.strike, bid: candidate.bid, ask: candidate.ask,
      iv: candidate.impliedVolatility, expiryMedianIv: candidate.expiryMedianIv,
      ivDiscount: candidate.anomalyScore, delta: candidate.delta, openInterest: candidate.openInterest,
      payoff: plan ? { debit: plan.debit, maxLoss: plan.maxLoss, maxReward: plan.maxReward, rewardRisk: plan.rewardRisk, payoffProbability: plan.payoffProbability, expectedValue: plan.expectedValue, quantity: plan.quantity } : "No executable spread passed the allocator",
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
