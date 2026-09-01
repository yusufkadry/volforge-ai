import { createHash } from "crypto";
import { alpaca } from "@/lib/alpaca";
import { numberEnv } from "@/lib/env";
import { clamp } from "@/lib/math";
import type { Candidate } from "@/lib/types";

type EventCategory = "earnings" | "macro" | "regulatory" | "geopolitical" | "corporate" | "security" | "other";

export type WorldArticle = {
  headline: string;
  created_at?: string;
  source?: string;
  ageHours: number;
  reliability: number;
  category: EventCategory;
  impact: "high" | "medium" | "low";
  direction: -1 | 0 | 1;
  symbols: string[];
  scope: "issuer" | "market";
};

export type WorldEvidence = {
  engine: "Event Intelligence";
  verdict: "approve" | "veto" | "abstain";
  confidence: number;
  expiresAt: string;
  evidenceHash: string;
  headlineCount: number;
  eventTags: string[];
  eventRiskScore: number;
  directionalScore: number;
  rationale: string;
  articles: WorldArticle[];
};

const positiveTerms = /beat|raises? guidance|approval|wins? contract|partnership|upgrade|record revenue|buyback|launch|settles favorably/i;
const negativeTerms = /miss(?:es|ed)?|cuts? guidance|downgrade|probe|investigation|lawsuit|antitrust|recall|fraud|breach|outage|default/i;
const sourceReliability: Record<string, number> = { reuters: 1, bloomberg: 1, associatedpress: 1, "associated press": 1, cnbc: 0.9, wsj: 0.95, "wall street journal": 0.95, benzinga: 0.75 };
const marketProxies = new Set(["SPY", "QQQ", "IWM", "DIA"]);

function normalizedHeadline(headline: string) { return headline.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim(); }
function ageHours(timestamp?: string) { return timestamp ? Math.max(0, (Date.now() - new Date(timestamp).getTime()) / 3_600_000) : 999; }
function reliability(source?: string) {
  const key = String(source ?? "").toLowerCase().replace(/[^a-z ]/g, "").trim();
  return sourceReliability[key] ?? 0.6;
}
function classify(headline: string): { category: EventCategory; impact: WorldArticle["impact"] } {
  if (/earnings|guidance|revenue|eps|quarterly results/i.test(headline)) return { category: "earnings", impact: "high" };
  if (/fed|fomc|cpi|jobs report|payroll|inflation|rate decision|gdp/i.test(headline)) return { category: "macro", impact: "high" };
  if (/probe|investigation|lawsuit|antitrust|approval|regulator|sec |doj/i.test(headline)) return { category: "regulatory", impact: "high" };
  if (/tariff|sanctions|war|missile|invasion|ceasefire/i.test(headline)) return { category: "geopolitical", impact: "high" };
  if (/breach|cyber|ransomware|outage|hack/i.test(headline)) return { category: "security", impact: "high" };
  if (/contract|partnership|buyback|acquisition|merger|launch|upgrade|downgrade/i.test(headline)) return { category: "corporate", impact: "medium" };
  return { category: "other", impact: "low" };
}

export function adjudicateWorldArticles(candidate: Pick<Candidate, "underlying" | "contractType">, articles: WorldArticle[]) {
  const scopedWeight = (article: WorldArticle) => article.scope === "issuer" ? 1 : 0.6;
  const directionalScore = articles.reduce((total, article) => total + article.direction * article.reliability * scopedWeight(article) * Math.exp(-article.ageHours / 36), 0);
  const eventRiskScore = articles.reduce((total, article) => total + (article.impact === "high" ? 1 : article.impact === "medium" ? 0.4 : 0.1) * article.reliability * scopedWeight(article) * Math.exp(-article.ageHours / 24), 0);
  const strategyDirection = candidate.contractType === "call" ? 1 : -1;
  const contradiction = directionalScore * strategyDirection < -numberEnv("EVENT_CONTRADICTION_THRESHOLD", 1.2);
  const minimumReliability = numberEnv("EVENT_VETO_MIN_RELIABILITY", 0.75);
  const issuerVetoHours = numberEnv("ISSUER_EVENT_VETO_HOURS", 24);
  const marketVetoHours = numberEnv("MARKET_EVENT_VETO_HOURS", 4);
  const jumpArticle = articles.find((article) => {
    if (article.impact !== "high" || article.reliability < minimumReliability) return false;
    if (article.scope === "issuer") return article.ageHours <= issuerVetoHours && ["earnings", "regulatory", "security"].includes(article.category);
    return article.ageHours <= marketVetoHours && ["macro", "geopolitical"].includes(article.category);
  });
  const verdict: WorldEvidence["verdict"] = contradiction || jumpArticle
    ? "veto"
    : directionalScore * strategyDirection >= 1.2 && eventRiskScore < 1.5 ? "approve" : "abstain";
  const confidence = clamp((articles.length ? 0.25 : 0) + Math.min(0.35, Math.abs(directionalScore) * 0.15) + Math.min(0.35, eventRiskScore * 0.12), 0, 0.9);
  const eventTags = [...new Set(articles.filter((article) => article.category !== "other").map((article) => article.category))];
  const rationale = verdict === "veto"
    ? jumpArticle
      ? `A reliable ${jumpArticle.scope} ${jumpArticle.category} catalyst published ${jumpArticle.ageHours.toFixed(1)} hours ago falls inside its explicit event-risk window.`
      : `Reliability-, scope-, and recency-weighted news flow contradicts the ${candidate.contractType} thesis (${directionalScore.toFixed(2)} score).`
    : verdict === "approve"
      ? `Scope- and recency-weighted evidence aligns with the ${candidate.contractType} thesis without a relevant event-window veto.`
      : `${articles.length} deduplicated issuer and market articles were classified; none is both relevant and recent enough to veto allocation.`;
  return { directionalScore, eventRiskScore, verdict, confidence, eventTags, rationale, jumpArticle };
}

export async function assessWorldIntelligence(candidate: Candidate): Promise<WorldEvidence> {
  try {
    const start = new Date(Date.now() - 72 * 60 * 60_000).toISOString();
    const response = await alpaca.news([candidate.underlying, "SPY"], 150, start);
    const seen = new Set<string>();
    const classified = (response.news ?? []).flatMap((article) => {
      const headline = String(article.headline ?? article.summary ?? "").trim();
      const key = normalizedHeadline(headline);
      if (!headline || seen.has(key)) return [];
      seen.add(key);
      const createdAt = typeof article.created_at === "string" ? article.created_at : undefined;
      const source = typeof article.source === "string" ? article.source : undefined;
      const age = ageHours(createdAt);
      if (age > 72) return [];
      const event = classify(headline);
      const direction: -1 | 0 | 1 = positiveTerms.test(headline) ? 1 : negativeTerms.test(headline) ? -1 : 0;
      const symbols = Array.isArray(article.symbols) ? article.symbols.map(String) : [];
      const scope: WorldArticle["scope"] = !marketProxies.has(candidate.underlying) && symbols.includes(candidate.underlying) ? "issuer" : "market";
      return [{ headline, created_at: createdAt, source, ageHours: age, reliability: reliability(source), category: event.category, impact: event.impact, direction, symbols, scope } satisfies WorldArticle];
    });
    const articles = [
      ...classified.filter((article) => article.scope === "issuer").slice(0, 12),
      ...classified.filter((article) => article.scope === "market").slice(0, 8),
    ].sort((left, right) => left.ageHours - right.ageHours);
    const adjudication = adjudicateWorldArticles(candidate, articles);
    const evidence = { candidate: candidate.optionSymbol, articles, ...adjudication, pagination: response.meta };
    return { engine: "Event Intelligence", verdict: adjudication.verdict, confidence: adjudication.confidence, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), evidenceHash: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"), headlineCount: articles.length, eventTags: adjudication.eventTags, eventRiskScore: adjudication.eventRiskScore, directionalScore: adjudication.directionalScore, rationale: adjudication.rationale, articles };
  } catch (error) {
    const rationale = `News feed unavailable; unmodeled event risk cannot be cleared: ${error instanceof Error ? error.message : "unknown error"}`;
    return { engine: "Event Intelligence", verdict: "veto", confidence: 1, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), evidenceHash: createHash("sha256").update(rationale).digest("hex"), headlineCount: 0, eventTags: ["feed-unavailable"], eventRiskScore: 1, directionalScore: 0, rationale, articles: [] };
  }
}
