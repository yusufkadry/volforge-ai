import assert from "node:assert/strict";
import test from "node:test";
import { shadowAgeMinutes, shadowEvaluationDue } from "../lib/shadow-manager";

test("compressed shadow evaluation closes only after its explicit evidence window", () => {
  const previous = process.env.SHADOW_EVALUATION_MINUTES;
  process.env.SHADOW_EVALUATION_MINUTES = "90";
  try {
    const position = { created_at: "2026-08-31T14:00:00.000Z" };
    assert.equal(shadowAgeMinutes(position, new Date("2026-08-31T15:00:00.000Z")), 60);
    assert.equal(shadowEvaluationDue(position, new Date("2026-08-31T15:29:59.000Z")), false);
    assert.equal(shadowEvaluationDue(position, new Date("2026-08-31T15:30:00.000Z")), true);
  } finally {
    if (previous === undefined) delete process.env.SHADOW_EVALUATION_MINUTES;
    else process.env.SHADOW_EVALUATION_MINUTES = previous;
  }
});
