import assert from "node:assert/strict";
import test from "node:test";
import { alpaca } from "../lib/alpaca";
import { advanceEmergencyStop, isRiskReducingOptionOrder } from "../lib/emergency";
import { managePositions } from "../lib/position-manager";
import { journal } from "../lib/supabase";
import type { ExecutionIntent } from "../lib/types";

test("emergency liquidation decomposes mismatched exposure short leg first", async () => {
  const broker = alpaca as unknown as Record<string, unknown>;
  const database = journal as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  const replace = (target: Record<string, unknown>, name: string, value: unknown) => {
    const key = `${target === broker ? "broker" : "database"}:${name}`;
    originals.set(key, target[name]);
    target[name] = value;
  };
  const intent: ExecutionIntent = {
    id: "intent-1", trace_id: "trace-1", strategy_version: "test", idempotency_key: "key", stage: "paper", status: "open",
    underlying: "TEST", contract_type: "call", long_leg: "TEST-LONG", short_leg: "TEST-SHORT", quantity: 1,
    entry_debit: 1, max_loss: 100, max_reward: 400,
  };
  const submitted: Array<Record<string, unknown>> = [];
  try {
    replace(broker, "positions", async () => [
      { asset_class: "us_option", symbol: "TEST-LONG", qty: "1" },
      { asset_class: "us_option", symbol: "TEST-SHORT", qty: "-2" },
    ]);
    replace(broker, "optionSnapshots", async (symbols: string[]) => ({ snapshots: Object.fromEntries(symbols.map((symbol) => [symbol, { latestQuote: { bp: 1.1, ap: 1.2 } }])), meta: { feed: "indicative", contracts: symbols.length } }));
    replace(broker, "orders", async () => []);
    replace(broker, "submitOrder", async (payload: Record<string, unknown>) => { submitted.push(payload); return { id: `order-${submitted.length}` }; });
    replace(database, "activeIntents", async () => [intent]);
    replace(database, "updateIntent", async (_id: string, value: Partial<ExecutionIntent>) => [{ ...intent, ...value }]);
    replace(database, "writeOrderEvent", async (value: unknown) => [value]);

    const actions = await managePositions({ emergency: true });
    assert.equal(submitted.length, 2);
    assert.deepEqual(submitted.map((order) => [order.symbol, order.side, order.position_intent]), [
      ["TEST-SHORT", "buy", "buy_to_close"],
      ["TEST-LONG", "sell", "sell_to_close"],
    ]);
    assert.deepEqual(submitted.map((order) => order.qty), ["2", "1"]);
    assert.notEqual(submitted[0].client_order_id, submitted[1].client_order_id);
    assert.equal(actions.some((action) => action.event_type === "spread_leg_mismatch"), true);
    assert.equal(actions.filter((action) => action.event_type === "mismatched_leg_close_submitted").length, 2);
  } finally {
    for (const [key, value] of originals) {
      const [target, name] = key.split(":");
      (target === "broker" ? broker : database)[name] = value;
    }
  }
});

test("emergency supervision preserves only identifiable risk-reducing orders while exposure exists", () => {
  const exitOrderIds = new Set(["known-exit"]);
  const exitClientOrderIds = new Set(["known-client-exit"]);
  assert.equal(isRiskReducingOptionOrder({ id: "known-exit" }, exitOrderIds, exitClientOrderIds), true);
  assert.equal(isRiskReducingOptionOrder({ client_order_id: "known-client-exit" }, exitOrderIds, exitClientOrderIds), true);
  assert.equal(isRiskReducingOptionOrder({ symbol: "TEST", position_intent: "sell_to_close" }, exitOrderIds, exitClientOrderIds), true);
  assert.equal(isRiskReducingOptionOrder({ legs: [{ symbol: "LONG", position_intent: "sell_to_close" }, { symbol: "SHORT", position_intent: "buy_to_close" }] }, exitOrderIds, exitClientOrderIds), true);
  assert.equal(isRiskReducingOptionOrder({ symbol: "TEST", position_intent: "buy_to_open" }, exitOrderIds, exitClientOrderIds), false);
  assert.equal(isRiskReducingOptionOrder({ legs: [{ symbol: "LONG", position_intent: "sell_to_close" }, { symbol: "SHORT", position_intent: "sell_to_open" }] }, exitOrderIds, exitClientOrderIds), false);
});

test("emergency position management does not duplicate a working orphan close", async () => {
  const broker = alpaca as unknown as Record<string, unknown>;
  const database = journal as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  const replace = (target: Record<string, unknown>, name: string, value: unknown) => {
    const key = `${target === broker ? "broker" : "database"}:${name}`;
    originals.set(key, target[name]);
    target[name] = value;
  };
  let submissions = 0;
  try {
    replace(broker, "positions", async () => [{ asset_class: "us_option", symbol: "ORPHAN", qty: "1" }]);
    replace(broker, "orders", async () => [{ id: "close-1", symbol: "ORPHAN", position_intent: "sell_to_close" }]);
    replace(broker, "submitOrder", async () => { submissions += 1; return { id: "duplicate" }; });
    replace(database, "activeIntents", async () => []);

    const actions = await managePositions({ emergency: true });
    assert.equal(submissions, 0);
    assert.equal(actions.some((action) => action.event_type === "orphan_close_working"), true);
  } finally {
    for (const [key, value] of originals) {
      const [target, name] = key.split(":");
      (target === "broker" ? broker : database)[name] = value;
    }
  }
});

test("emergency spread liquidation escalates short-leg first after the bounded limit ladder", async () => {
  const broker = alpaca as unknown as Record<string, unknown>;
  const database = journal as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  const replace = (target: Record<string, unknown>, name: string, value: unknown) => {
    const key = `${target === broker ? "broker" : "database"}:${name}`;
    originals.set(key, target[name]);
    target[name] = value;
  };
  const intent: ExecutionIntent = {
    id: "intent-escalation", trace_id: "trace-escalation", strategy_version: "test", idempotency_key: "escalation", stage: "paper", status: "open",
    underlying: "TEST", contract_type: "call", long_leg: "TEST-LONG", short_leg: "TEST-SHORT", quantity: 1,
    entry_debit: 1, max_loss: 100, max_reward: 400, exit_attempts: 3, exit_order_id: "expired-spread-exit",
  };
  const submitted: Array<Record<string, unknown>> = [];
  try {
    replace(broker, "positions", async () => [
      { asset_class: "us_option", symbol: "TEST-LONG", qty: "1" },
      { asset_class: "us_option", symbol: "TEST-SHORT", qty: "-1" },
    ]);
    replace(broker, "orders", async () => []);
    replace(broker, "optionSnapshots", async (symbols: string[]) => ({ snapshots: Object.fromEntries(symbols.map((symbol) => [symbol, { latestQuote: { bp: 1.1, ap: 1.2 } }])), meta: { feed: "indicative", contracts: symbols.length } }));
    replace(broker, "submitOrder", async (payload: Record<string, unknown>) => { submitted.push(payload); return { id: `emergency-${submitted.length}` }; });
    replace(database, "activeIntents", async () => [intent]);
    replace(database, "updateIntent", async (_id: string, value: Partial<ExecutionIntent>) => [{ ...intent, ...value }]);
    replace(database, "writeOrderEvent", async (value: unknown) => [value]);

    const actions = await managePositions({ emergency: true });
    assert.deepEqual(submitted.map((order) => [order.symbol, order.side, order.position_intent]), [
      ["TEST-SHORT", "buy", "buy_to_close"],
      ["TEST-LONG", "sell", "sell_to_close"],
    ]);
    assert.equal(actions.some((action) => action.event_type === "emergency_leg_escalation"), true);
    assert.equal(actions.filter((action) => action.event_type === "emergency_leg_close_submitted").length, 2);
  } finally {
    for (const [key, value] of originals) {
      const [target, name] = key.split(":");
      (target === "broker" ? broker : database)[name] = value;
    }
  }
});

test("the recurring emergency loop preserves closes and does not re-cancel pending cancellations", async () => {
  const broker = alpaca as unknown as Record<string, unknown>;
  const database = journal as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  const replace = (target: Record<string, unknown>, name: string, value: unknown) => {
    const key = `${target === broker ? "broker" : "database"}:${name}`;
    originals.set(key, target[name]);
    target[name] = value;
  };
  const intent: ExecutionIntent = {
    id: "intent-close", trace_id: "trace-close", strategy_version: "test", idempotency_key: "close-key", stage: "paper", status: "exit_submitted",
    underlying: "TEST", contract_type: "call", long_leg: "TEST-LONG", short_leg: "TEST-SHORT", quantity: 1,
    entry_debit: 1, max_loss: 100, max_reward: 400, exit_order_id: "close-order", metadata: { pending_exit_client_order_id: "close-client" },
  };
  const canceled: string[] = [];
  try {
    replace(broker, "positions", async () => [
      { asset_class: "us_option", symbol: "TEST-LONG", qty: "1" },
      { asset_class: "us_option", symbol: "TEST-SHORT", qty: "-1" },
    ]);
    replace(broker, "orders", async () => [
      { id: "close-order", client_order_id: "close-client", status: "new" },
      { id: "entry-order", status: "new", position_intent: "buy_to_open" },
      { id: "already-canceling", status: "pending_cancel", position_intent: "buy_to_open" },
    ]);
    replace(broker, "cancelOrder", async (orderId: string) => { canceled.push(orderId); return null; });
    replace(database, "activeIntents", async () => [intent]);

    const result = await advanceEmergencyStop();
    assert.deepEqual(canceled, ["entry-order"]);
    assert.equal(result.complete, false);
    assert.equal(result.cancellationRequests, 1);
  } finally {
    for (const [key, value] of originals) {
      const [target, name] = key.split(":");
      (target === "broker" ? broker : database)[name] = value;
    }
  }
});
