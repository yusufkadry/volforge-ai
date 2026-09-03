import type { Candidate } from "@/lib/types";
import type { TradePlan } from "@/lib/reward-engine";
import type { WorldEvidence } from "@/lib/world-intelligence";

export type CriticVerdict = { approve: boolean; hardVeto: boolean; issues: string[]; rationale: string };

const HARD_VETO_ISSUES = new Set([
  "internal-contradiction",
  "missing-structure-evidence",
  "impossible-payoff",
  "stress-economics-contradiction",
  "unmodeled-jump-event",
]);

export function normalizeCriticVerdict(value: unknown): CriticVerdict {
  const parsed = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const issues = Array.isArray(parsed.issues) ? parsed.issues.map(String).filter(Boolean).slice(0, 8) : [];
  const hardVetoValue = parsed.hard_veto ?? parsed.hardVeto;
  const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "";
  const schemaValid = typeof parsed.approve === "boolean"
    && typeof hardVetoValue === "boolean"
    && Array.isArray(parsed.issues)
    && rationale.trim().length > 0;
  if (!schemaValid) return { approve: false, hardVeto: false, issues: ["critic-invalid-schema"], rationale: "LLM critic returned an invalid verdict schema; deterministic capital gates remain authoritative." };

  const recognizedHardVeto = issues.some((issue) => HARD_VETO_ISSUES.has(issue.trim().toLowerCase()));
  const requestedHardVeto = hardVetoValue === true;
  return {
    approve: parsed.approve === true,
    hardVeto: requestedHardVeto && recognizedHardVeto,
    issues: requestedHardVeto && !recognizedHardVeto ? [...issues, "veto-outside-jurisdiction"].slice(0, 8) : issues,
    rationale: requestedHardVeto && !recognizedHardVeto
      ? `${rationale} Recorded as advisory because no authorized hard-veto code was supplied.`
      : rationale,
  };
}

export function enforceCriticJurisdiction(verdict: CriticVerdict, plan?: TradePlan, world?: WorldEvidence): CriticVerdict {
  if (!verdict.hardVeto) return verdict;
  const authorizedByEvidence = new Set<string>();
  if (!plan) authorizedByEvidence.add("missing-structure-evidence");
  if (plan) {
    const invalidGeometry = plan.width <= 0 || plan.debit <= 0 || plan.maxEntryDebit <= 0 || plan.maxEntryDebit >= plan.width
      || Math.abs(plan.maxLoss - plan.maxEntryDebit * 100) > 1
      || Math.abs(plan.maxReward - (plan.width - plan.maxEntryDebit) * 100) > 1
      || plan.quantity < 1;
    if (invalidGeometry) {
      authorizedByEvidence.add("impossible-payoff");
      authorizedByEvidence.add("internal-contradiction");
    }
    if (plan.stressedExpectedValue < 0 && plan.expectedValue > 0) authorizedByEvidence.add("stress-economics-contradiction");
  }
  if (world?.verdict === "veto") authorizedByEvidence.add("unmodeled-jump-event");
  const supported = verdict.issues.some((issue) => authorizedByEvidence.has(issue.trim().toLowerCase()));
  if (supported) return verdict;
  return {
    ...verdict,
    hardVeto: false,
    issues: [...verdict.issues, "veto-not-supported-by-deterministic-evidence"].slice(0, 8),
    rationale: `${verdict.rationale} Recorded as advisory because the supplied deterministic evidence does not support that veto class.`,
  };
}

export async function critic(candidate: Candidate, plan?: TradePlan, world?: WorldEvidence): Promise<CriticVerdict> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { approve: false, hardVeto: false, issues: ["critic-unavailable"], rationale: "LLM critic unavailable; deterministic capital gates remain authoritative." };

  const prompt = [
    "You are a skeptical options risk critic. Return only JSON with boolean approve, boolean hard_veto, string[] issues, and a concise rationale.",
    "The numerical engines are authoritative and have already enforced quote freshness, open interest, bid/ask width, bounded loss, horizon validation, base EV, adverse-stress EV, and portfolio limits. An allowed indicative feed is disclosed and receives explicit friction; it is not by itself a hard veto.",
    "Set hard_veto=true only for a concrete internal contradiction, missing exact leg/price/quantity evidence, impossible payoff geometry, negative stress economics presented as positive, or a relevant unmodeled jump event supported by the supplied evidence. General caution, model uncertainty, or feed provenance concerns belong in issues with hard_veto=false. Never invent missing values.",
    "When hard_veto=true, issues must include at least one exact authorized code: internal-contradiction, missing-structure-evidence, impossible-payoff, stress-economics-contradiction, or unmodeled-jump-event. The control plane ignores hard-veto requests outside this jurisdiction.",
    JSON.stringify({
      symbol: candidate.optionSymbol, underlying: candidate.underlying, dte: candidate.dte,
      strike: candidate.strike, bid: candidate.bid, ask: candidate.ask,
      spot: candidate.spot, iv: candidate.impliedVolatility, fittedSurfaceIv: candidate.surface.fairIv,
      relativeResidual: candidate.surface.relativeResidual, residualZScore: candidate.surface.residualZScore, surfaceNeighbors: candidate.surface.neighborCount,
      delta: candidate.delta, openInterest: candidate.openInterest, dataFeed: candidate.dataFeed,
      payoff: plan ? {
        alphaSource: plan.alphaSource, alphaRationale: plan.alphaRationale,
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
      redirect: "error",
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
    return enforceCriticJurisdiction(normalizeCriticVerdict(JSON.parse(content)), plan, world);
  } catch (error) {
    return { approve: false, hardVeto: false, issues: ["critic-failure"], rationale: `LLM critic was unavailable and recorded an advisory failure: ${error instanceof Error ? error.message : "unknown error"}. Deterministic capital gates remain authoritative.` };
  }
}
