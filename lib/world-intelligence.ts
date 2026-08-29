import { createHash } from "crypto";
import { alpaca } from "@/lib/alpaca";
import type { Candidate } from "@/lib/types";

export type WorldEvidence = {
  engine: "World Intelligence";
  verdict: "approve" | "veto" | "abstain";
  confidence: number;
  expiresAt: string;
  evidenceHash: string;
  headlineCount: number;
  eventTags: string[];
  rationale: string;
  articles: Array<{ headline: string; created_at?: string; source?: string }>;
};

const positiveTerms = /beat|raises? guidance|approval|contract|partnership|upgrade|record revenue|buyback|launch/i;
const negativeTerms = /miss(?:es|ed)?|cuts? guidance|downgrade|probe|investigation|lawsuit|antitrust|recall|fraud|breach/i;
const shockTerms = /earnings|fed|fomc|cpi|jobs report|tariff|sanctions|war|inflation|rate decision|guidance|antitrust|investigation/i;

function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }

export async function assessWorldIntelligence(candidate: Candidate): Promise<WorldEvidence> {
  try {
    const response = await alpaca.news([candidate.underlying]);
    const articles = (response.news ?? []).slice(0, 12).map((article) => ({
      headline: String(article.headline ?? article.summary ?? ""), created_at: typeof article.created_at === "string" ? article.created_at : undefined,
      source: typeof article.source === "string" ? article.source : undefined,
    })).filter((article) => article.headline);
    const positive = articles.filter((article) => positiveTerms.test(article.headline)).length;
    const negative = articles.filter((article) => negativeTerms.test(article.headline)).length;
    const tags = [...new Set(articles.flatMap((article) => {
      const headline = article.headline.toLowerCase();
      return ["earnings", "macro", "regulatory", "geopolitical", "guidance"].filter((tag) => {
        if (tag === "macro") return /fed|fomc|cpi|jobs report|inflation|rate decision/.test(headline);
        if (tag === "regulatory") return /probe|investigation|lawsuit|antitrust|approval/.test(headline);
        if (tag === "geopolitical") return /tariff|sanctions|war/.test(headline);
        return headline.includes(tag);
      });
    }))];
    const shocks = articles.filter((article) => shockTerms.test(article.headline)).length;
    const direction = candidate.contractType === "call" ? 1 : -1;
    const directionalScore = direction * (positive - negative);
    const contradictory = (direction === 1 && negative > positive) || (direction === -1 && positive > negative);
    const verdict: WorldEvidence["verdict"] = shocks >= 2 && contradictory ? "veto" : directionalScore >= 2 ? "approve" : "abstain";
    const confidence = clamp(0.3 + Math.min(articles.length, 6) * 0.04 + Math.min(Math.abs(directionalScore), 3) * 0.1 + Math.min(shocks, 2) * 0.05, 0.3, 0.85);
    const rationale = verdict === "veto"
      ? `${candidate.underlying} has ${shocks} fresh headline-risk markers that contradict the ${candidate.contractType} thesis; event ambiguity vetoed.`
      : verdict === "approve"
        ? `${candidate.underlying} news flow is directionally aligned with the ${candidate.contractType} thesis across ${articles.length} recent articles.`
        : `${articles.length} recent ${candidate.underlying} articles were assessed; no decisive, directionally aligned catalyst or contradiction.`;
    const evidence = { candidate: candidate.optionSymbol, articles, positive, negative, shocks, tags, verdict, confidence, rationale };
    return { engine: "World Intelligence", verdict, confidence, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), evidenceHash: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"), headlineCount: articles.length, eventTags: tags, rationale, articles };
  } catch (error) {
    const rationale = `News feed unavailable; World Intelligence abstained: ${error instanceof Error ? error.message : "unknown error"}`;
    return { engine: "World Intelligence", verdict: "abstain", confidence: 0, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), evidenceHash: createHash("sha256").update(rationale).digest("hex"), headlineCount: 0, eventTags: [], rationale, articles: [] };
  }
}
