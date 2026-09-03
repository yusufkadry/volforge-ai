import assert from "node:assert/strict";
import test from "node:test";
import { enforceCriticJurisdiction, normalizeCriticVerdict } from "../lib/critic";
import type { TradePlan } from "../lib/reward-engine";

test("critic concerns do not veto deterministic approval without an authorized code", () => {
  const verdict = normalizeCriticVerdict({
    approve: false,
    hard_veto: true,
    issues: ["indicative-feed", "general-model-uncertainty"],
    rationale: "Feed provenance warrants caution.",
  });
  assert.equal(verdict.hardVeto, false);
  assert.ok(verdict.issues.includes("veto-outside-jurisdiction"));
});

test("critic retains a concrete authorized hard veto", () => {
  const verdict = normalizeCriticVerdict({
    approve: false,
    hard_veto: true,
    issues: ["impossible-payoff"],
    rationale: "The stated payoff exceeds the spread width.",
  });
  assert.equal(verdict.hardVeto, true);
});

test("critic output with an incomplete schema cannot become a capital veto", () => {
  const verdict = normalizeCriticVerdict({ approve: true, rationale: "Looks fine." });
  assert.equal(verdict.approve, false);
  assert.equal(verdict.hardVeto, false);
  assert.deepEqual(verdict.issues, ["critic-invalid-schema"]);
});

test("an explicit advisory verdict remains advisory", () => {
  const verdict = normalizeCriticVerdict({ approve: false, hard_veto: false, issues: ["slippage-watch"], rationale: "Monitor fills." });
  assert.equal(verdict.approve, false);
  assert.equal(verdict.hardVeto, false);
});

test("an authorized issue code still needs matching deterministic evidence", () => {
  const plan = {
    width: 5, debit: 1.5, maxEntryDebit: 2, maxLoss: 200, maxReward: 300,
    quantity: 1, stressedExpectedValue: 20, expectedValue: 25,
  } as TradePlan;
  const requested = normalizeCriticVerdict({ approve: false, hard_veto: true, issues: ["unmodeled-jump-event"], rationale: "Generic jump risk." });
  const enforced = enforceCriticJurisdiction(requested, plan, { verdict: "abstain" } as never);
  assert.equal(enforced.hardVeto, false);
  assert.ok(enforced.issues.includes("veto-not-supported-by-deterministic-evidence"));
});

test("missing structure evidence remains a hard veto when no plan exists", () => {
  const requested = normalizeCriticVerdict({ approve: false, hard_veto: true, issues: ["missing-structure-evidence"], rationale: "No exact legs supplied." });
  assert.equal(enforceCriticJurisdiction(requested).hardVeto, true);
});
