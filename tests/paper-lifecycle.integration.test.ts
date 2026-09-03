import assert from "node:assert/strict";
import test from "node:test";
import { alpaca } from "../lib/alpaca";
import { reconcileExecution } from "../lib/execution-reconciler";
import { managePositions } from "../lib/position-manager";
import { journal } from "../lib/supabase";
import type { ExecutionIntent } from "../lib/types";

test("Paper lifecycle reconciles entry, takes profit, and persists a broker-backed close", async () => {
  const broker = alpaca as unknown as Record<string, unknown>;
  const database = journal as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  const replace = (target: Record<string, unknown>, name: string, value: unknown) => {
    const key = `${target === broker ? "broker" : "database"}:${name}`;
    originals.set(key, target[name]);
    target[name] = value;
  };
  let intent: ExecutionIntent = {
    id: "intent-1", created_at: new Date(Date.now() - 60_000).toISOString(), trace_id: "trace-lifecycle", strategy_version: "test", idempotency_key: "key", stage: "paper", status: "entry_submitted",
    underlying: "TEST", contract_type: "call", long_leg: "TEST-LONG", short_leg: "TEST-SHORT", quantity: 1, filled_quantity: 0,
    entry_debit: 1.55, entry_limit_price: 1.55, max_entry_debit: 1.75, max_loss: 175, max_reward: 825, entry_order_id: "entry-order", entry_attempts: 1,
    metadata: { expected_value: 80, payoff_probability: 0.62, arrival_quote: { mid: 1.5 } },
  };
  let positions: Array<Record<string, unknown>> = [
    { asset_class: "us_option", symbol: "TEST-LONG", qty: "1" },
    { asset_class: "us_option", symbol: "TEST-SHORT", qty: "-1" },
  ];
  const submitted: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  try {
    replace(database, "activeIntents", async () => [intent]);
    replace(database, "updateIntent", async (_id: string, value: Partial<ExecutionIntent>) => {
      intent = { ...intent, ...value, metadata: value.metadata ?? intent.metadata };
      return [intent];
    });
    replace(database, "writeOrderEvent", async (value: Record<string, unknown>) => { events.push(value); return [value]; });
    replace(broker, "positions", async () => positions);
    replace(broker, "order", async (orderId: string) => orderId === "entry-order"
      ? { id: orderId, status: "filled", filled_qty: "1", filled_avg_price: "1.50", filled_at: new Date().toISOString() }
      : { id: orderId, status: "filled", filled_qty: "1", filled_avg_price: "-2.35", filled_at: new Date().toISOString() });
    replace(broker, "optionSnapshots", async (symbols: string[]) => ({
      snapshots: Object.fromEntries(symbols.map((symbol) => [symbol, symbol === "TEST-LONG"
        ? { latestQuote: { bp: 4.0, ap: 4.1, t: new Date().toISOString() } }
        : { latestQuote: { bp: 1.5, ap: 1.6, t: new Date().toISOString() } }])),
      meta: { feed: "indicative", pages: 1, truncated: false, contracts: symbols.length },
    }));
    replace(broker, "submitOrder", async (payload: Record<string, unknown>) => { submitted.push(payload); return { id: "exit-order", status: "accepted", client_order_id: payload.client_order_id }; });

    const entry = await reconcileExecution({ entriesAllowed: true });
    assert.equal(entry.healthy, true);
    assert.equal(intent.status, "open");
    assert.equal(intent.entry_debit, 1.5);

    const actions = await managePositions();
    assert.equal(actions.some((action) => action.event_type === "spread_exit_submitted"), true);
    assert.equal(intent.status, "exit_submitted");
    assert.equal(intent.exit_reason, "take_profit");
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].order_class, "mleg");
    assert.ok(Number(submitted[0].limit_price) < 0);
    assert.deepEqual(submitted[0].legs, [
      { symbol: "TEST-LONG", ratio_qty: "1", side: "sell", position_intent: "sell_to_close" },
      { symbol: "TEST-SHORT", ratio_qty: "1", side: "buy", position_intent: "buy_to_close" },
    ]);

    positions = [];
    const exit = await reconcileExecution({ entriesAllowed: true });
    assert.equal(exit.healthy, true);
    assert.equal(intent.status, "closed");
    assert.equal(intent.exit_credit, 2.35);
    assert.equal(intent.metadata?.realized_pnl, 85);
    assert.equal(events.some((event) => event.event_type === "spread_exit_submitted"), true);
  } finally {
    for (const [key, value] of originals) {
      const [target, name] = key.split(":");
      (target === "broker" ? broker : database)[name] = value;
    }
  }
});

test("partial multi-quantity exits produce a weighted broker-backed realized P&L", async () => {
  const broker = alpaca as unknown as Record<string, unknown>;
  const database = journal as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  const replace = (target: Record<string, unknown>, name: string, value: unknown) => {
    const key = `${target === broker ? "broker" : "database"}:${name}`;
    originals.set(key, target[name]);
    target[name] = value;
  };
  let intent: ExecutionIntent = {
    id: "intent-partial", created_at: new Date(Date.now() - 60_000).toISOString(), trace_id: "trace-partial", strategy_version: "test", idempotency_key: "partial-key", stage: "paper", status: "exit_submitted",
    underlying: "TEST", contract_type: "call", long_leg: "TEST-LONG", short_leg: "TEST-SHORT", quantity: 2, filled_quantity: 2,
    entry_debit: 1.5, max_loss: 300, max_reward: 700, entry_order_id: "entry-order", exit_order_id: "exit-1", metadata: {},
  };
  let positions: Array<Record<string, unknown>> = [
    { asset_class: "us_option", symbol: "TEST-LONG", qty: "1" },
    { asset_class: "us_option", symbol: "TEST-SHORT", qty: "-1" },
  ];
  try {
    replace(database, "activeIntents", async () => [intent]);
    replace(database, "updateIntent", async (_id: string, value: Partial<ExecutionIntent>) => {
      intent = { ...intent, ...value, metadata: value.metadata ?? intent.metadata };
      return [intent];
    });
    replace(broker, "positions", async () => positions);
    replace(broker, "order", async (orderId: string) => orderId === "exit-1"
      ? { id: orderId, status: "canceled", filled_qty: "1", filled_avg_price: "-2.00", updated_at: new Date().toISOString() }
      : { id: orderId, status: "filled", filled_qty: "1", filled_avg_price: "-3.00", filled_at: new Date().toISOString() });

    const partial = await reconcileExecution({ entriesAllowed: true });
    assert.equal(partial.healthy, true);
    assert.equal(intent.status, "open");
    assert.equal((intent.metadata?.exit_fills_by_order as Record<string, { quantity: number }>)["exit-1"].quantity, 1);

    intent = { ...intent, status: "exit_submitted", exit_order_id: "exit-2" };
    positions = [];
    const closed = await reconcileExecution({ entriesAllowed: true });
    assert.equal(closed.healthy, true);
    assert.equal(intent.status, "closed");
    assert.equal(intent.exit_credit, 2.5);
    assert.equal(intent.metadata?.exit_filled_quantity, 2);
    assert.equal(intent.metadata?.realized_pnl, 200);
  } finally {
    for (const [key, value] of originals) {
      const [target, name] = key.split(":");
      (target === "broker" ? broker : database)[name] = value;
    }
  }
});

test("a broker-reported debit paid to close is recorded as negative economic credit", async () => {
  const broker = alpaca as unknown as Record<string, unknown>;
  const database = journal as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  const replace = (target: Record<string, unknown>, name: string, value: unknown) => {
    const key = `${target === broker ? "broker" : "database"}:${name}`;
    originals.set(key, target[name]);
    target[name] = value;
  };
  let intent: ExecutionIntent = {
    id: "intent-debit-close", trace_id: "trace-debit-close", strategy_version: "test", idempotency_key: "debit-close", stage: "paper", status: "exit_submitted",
    underlying: "TEST", contract_type: "call", long_leg: "TEST-LONG", short_leg: "TEST-SHORT", quantity: 1, filled_quantity: 1,
    entry_debit: 1.5, max_loss: 150, max_reward: 850, entry_order_id: "entry-order", exit_order_id: "exit-debit", metadata: {},
  };
  try {
    replace(database, "activeIntents", async () => [intent]);
    replace(database, "updateIntent", async (_id: string, value: Partial<ExecutionIntent>) => {
      intent = { ...intent, ...value, metadata: value.metadata ?? intent.metadata };
      return [intent];
    });
    replace(broker, "positions", async () => []);
    replace(broker, "order", async () => ({ id: "exit-debit", status: "filled", filled_qty: "1", filled_avg_price: "0.20", filled_at: new Date().toISOString() }));

    const result = await reconcileExecution({ entriesAllowed: true });
    assert.equal(result.healthy, true);
    assert.equal(intent.status, "closed");
    assert.equal(intent.exit_credit, -0.2);
    assert.equal(intent.metadata?.realized_pnl, -170);
  } finally {
    for (const [key, value] of originals) {
      const [target, name] = key.split(":");
      (target === "broker" ? broker : database)[name] = value;
    }
  }
});
