import assert from "node:assert/strict";
import test from "node:test";
import { adjudicateWorldArticles, type WorldArticle } from "../lib/world-intelligence";

function article(overrides: Partial<WorldArticle> = {}): WorldArticle {
  return {
    headline: "Market update", ageHours: 1, reliability: 1, category: "other", impact: "low",
    direction: 0, symbols: ["SPY"], scope: "market", ...overrides,
  };
}

test("an old broad geopolitical headline cannot veto the entire market session", () => {
  const result = adjudicateWorldArticles({ underlying: "SPY", contractType: "call" }, [article({ category: "geopolitical", impact: "high", ageHours: 12 })]);
  assert.equal(result.verdict, "abstain");
});

test("a fresh reliable macro shock still vetoes market-proxy exposure", () => {
  const result = adjudicateWorldArticles({ underlying: "SPY", contractType: "call" }, [article({ category: "macro", impact: "high", ageHours: 2 })]);
  assert.equal(result.verdict, "veto");
  assert.equal(result.jumpArticle?.scope, "market");
});

test("a recent issuer earnings event vetoes issuer exposure", () => {
  const result = adjudicateWorldArticles({ underlying: "NVDA", contractType: "call" }, [article({ category: "earnings", impact: "high", ageHours: 10, scope: "issuer", symbols: ["NVDA"] })]);
  assert.equal(result.verdict, "veto");
  assert.equal(result.jumpArticle?.scope, "issuer");
});
