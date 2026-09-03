import assert from "node:assert/strict";
import test from "node:test";
import { alpaca } from "../lib/alpaca";
import { competitionEntryAllowed, competitionExitRequired } from "../lib/competition";
import { nyMinutes, regularEntryWindow } from "../lib/portfolio-governor";
import { managePositions } from "../lib/position-manager";
import { journal } from "../lib/supabase";
import type { ExecutionIntent } from "../lib/types";

test("the one-day competition entry buffer and forced-exit cutoff are exact", () => {
  const originalExit = process.env.COMPETITION_EXIT_AT;
  const originalBuffer = process.env.COMPETITION_ENTRY_BUFFER_MINUTES;
  try {
    process.env.COMPETITION_EXIT_AT = "2026-09-03T19:30:00Z";
    process.env.COMPETITION_ENTRY_BUFFER_MINUTES = "90";
    assert.equal(competitionEntryAllowed(new Date("2026-09-03T17:59:59.999Z")), true);
    assert.equal(competitionEntryAllowed(new Date("2026-09-03T18:00:00.000Z")), false);
    assert.equal(competitionExitRequired(new Date("2026-09-03T19:29:59.999Z")), false);
    assert.equal(competitionExitRequired(new Date("2026-09-03T19:30:00.000Z")), true);
  } finally {
    if (originalExit === undefined) delete process.env.COMPETITION_EXIT_AT;
    else process.env.COMPETITION_EXIT_AT = originalExit;
    if (originalBuffer === undefined) delete process.env.COMPETITION_ENTRY_BUFFER_MINUTES;
    else process.env.COMPETITION_ENTRY_BUFFER_MINUTES = originalBuffer;
  }
});

test("New York session conversion admits entries only from 09:35 through 15:29", () => {
  assert.equal(nyMinutes(new Date("2026-09-03T13:34:59.999Z")), 9 * 60 + 34);
  assert.equal(regularEntryWindow(true, new Date("2026-09-03T13:34:59.999Z")), false);
  assert.equal(regularEntryWindow(true, new Date("2026-09-03T13:35:00.000Z")), true);
  assert.equal(regularEntryWindow(true, new Date("2026-09-03T19:29:59.999Z")), true);
  assert.equal(regularEntryWindow(true, new Date("2026-09-03T19:30:00.000Z")), false);
  assert.equal(regularEntryWindow(false, new Date("2026-09-03T15:00:00.000Z")), false);
});

test("competition cutoff autonomously escalates exhausted spread exits short leg first", async () => {
  const broker = alpaca as unknown as Record<string, unknown>;
  const database = journal as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  const originalExit = process.env.COMPETITION_EXIT_AT;
  const originalAttempts = process.env.MAX_COMPETITION_SPREAD_EXIT_ATTEMPTS;
  const replace = (target: Record<string, unknown>, name: string, value: unknown) => {
    const key = `${target === broker ? "broker" : "database"}:${name}`;
    originals.set(key, target[name]);
    target[name] = value;
  };
  const intent: ExecutionIntent = {
    id: "competition-exit", trace_id: "competition-trace", strategy_version: "test", idempotency_key: "competition-key", stage: "paper", status: "open",
    underlying: "TEST", contract_type: "call", long_leg: "TEST-LONG", short_leg: "TEST-SHORT", quantity: 1,
    entry_debit: 1, max_loss: 100, max_reward: 400, exit_attempts: 4,
  };
  const submitted: Array<Record<string, unknown>> = [];
  try {
    process.env.COMPETITION_EXIT_AT = "2020-01-01T00:00:00.000Z";
    process.env.MAX_COMPETITION_SPREAD_EXIT_ATTEMPTS = "4";
    replace(broker, "positions", async () => [
      { asset_class: "us_option", symbol: "TEST-LONG", qty: "1" },
      { asset_class: "us_option", symbol: "TEST-SHORT", qty: "-1" },
    ]);
    replace(broker, "orders", async () => []);
    replace(broker, "optionSnapshots", async (symbols: string[]) => ({ snapshots: Object.fromEntries(symbols.map((symbol) => [symbol, { latestQuote: { bp: 1.1, ap: 1.2 } }])), meta: { feed: "indicative", contracts: symbols.length } }));
    replace(broker, "submitOrder", async (payload: Record<string, unknown>) => { submitted.push(payload); return { id: `competition-close-${submitted.length}` }; });
    replace(database, "activeIntents", async () => [intent]);
    replace(database, "updateIntent", async (_id: string, value: Partial<ExecutionIntent>) => [{ ...intent, ...value }]);
    replace(database, "writeOrderEvent", async (value: unknown) => [value]);

    const actions = await managePositions();
    assert.deepEqual(submitted.map((order) => [order.symbol, order.side, order.position_intent]), [
      ["TEST-SHORT", "buy", "buy_to_close"],
      ["TEST-LONG", "sell", "sell_to_close"],
    ]);
    assert.equal(actions.some((action) => action.event_type === "competition_leg_escalation"), true);
    assert.equal(actions.filter((action) => action.event_type === "competition_leg_close_submitted").length, 2);
  } finally {
    for (const [key, value] of originals) {
      const [target, name] = key.split(":");
      (target === "broker" ? broker : database)[name] = value;
    }
    if (originalExit === undefined) delete process.env.COMPETITION_EXIT_AT;
    else process.env.COMPETITION_EXIT_AT = originalExit;
    if (originalAttempts === undefined) delete process.env.MAX_COMPETITION_SPREAD_EXIT_ATTEMPTS;
    else process.env.MAX_COMPETITION_SPREAD_EXIT_ATTEMPTS = originalAttempts;
  }
});
