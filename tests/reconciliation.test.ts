import assert from "node:assert/strict";
import test from "node:test";
import { alpaca } from "../lib/alpaca";
import { reconcileExecution } from "../lib/execution-reconciler";
import { journal } from "../lib/supabase";
import type { ExecutionIntent } from "../lib/types";

function openIntent(): ExecutionIntent {
  return {
    id: "intent-1", trace_id: "trace-1", strategy_version: "test", idempotency_key: "key", stage: "paper", status: "open",
    underlying: "TEST", contract_type: "call", long_leg: "TEST-LONG", short_leg: "TEST-SHORT", quantity: 1,
    entry_debit: 1, max_loss: 100, max_reward: 400, entry_order_id: "entry-1",
  };
}

test("reconciliation degrades before malformed vertical exposure can coexist with new entries", async () => {
  const broker = alpaca as unknown as Record<string, unknown>;
  const database = journal as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  const replace = (target: Record<string, unknown>, name: string, value: unknown) => {
    const key = `${target === broker ? "broker" : "database"}:${name}`;
    originals.set(key, target[name]);
    target[name] = value;
  };
  const updates: Array<Partial<ExecutionIntent>> = [];
  try {
    replace(database, "activeIntents", async () => [openIntent()]);
    replace(database, "updateIntent", async (_id: string, value: Partial<ExecutionIntent>) => { updates.push(value); return [{ ...openIntent(), ...value }]; });
    replace(broker, "positions", async () => [
      { asset_class: "us_option", symbol: "TEST-LONG", qty: "1" },
      { asset_class: "us_option", symbol: "TEST-SHORT", qty: "-2" },
    ]);

    const result = await reconcileExecution({ entriesAllowed: true });
    assert.equal(result.healthy, false);
    assert.equal(result.intents[0]?.state, "position_mismatch");
    assert.equal(updates[0]?.status, "reconciliation_error");
  } finally {
    for (const [key, value] of originals) {
      const [target, name] = key.split(":");
      (target === "broker" ? broker : database)[name] = value;
    }
  }
});

test("reconciliation marks an untracked option position unhealthy", async () => {
  const broker = alpaca as unknown as Record<string, unknown>;
  const database = journal as unknown as Record<string, unknown>;
  const originalIntents = database.activeIntents;
  const originalPositions = broker.positions;
  try {
    database.activeIntents = async () => [];
    broker.positions = async () => [{ asset_class: "us_option", symbol: "ORPHAN", qty: "1" }];
    const result = await reconcileExecution({ entriesAllowed: true });
    assert.equal(result.healthy, false);
    assert.deepEqual(result.orphanPositions, ["ORPHAN"]);
  } finally {
    database.activeIntents = originalIntents;
    broker.positions = originalPositions;
  }
});

test("a historical filled entry cannot become open without broker-confirmed legs", async () => {
  const broker = alpaca as unknown as Record<string, unknown>;
  const database = journal as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  const replace = (target: Record<string, unknown>, name: string, value: unknown) => {
    const key = `${target === broker ? "broker" : "database"}:${name}`;
    originals.set(key, target[name]);
    target[name] = value;
  };
  const intent = { ...openIntent(), status: "entry_submitted" as const };
  const updates: Array<Partial<ExecutionIntent>> = [];
  try {
    replace(database, "activeIntents", async () => [intent]);
    replace(database, "updateIntent", async (_id: string, value: Partial<ExecutionIntent>) => { updates.push(value); return [{ ...intent, ...value }]; });
    replace(broker, "positions", async () => []);
    replace(broker, "order", async () => ({ id: "entry-1", status: "filled", filled_qty: "1", filled_avg_price: "1.00" }));

    const result = await reconcileExecution({ entriesAllowed: true });
    assert.equal(result.healthy, false);
    assert.equal(result.intents[0]?.state, "unverified_flatness");
    assert.equal(updates.at(-1)?.status, "reconciliation_error");
  } finally {
    for (const [key, value] of originals) {
      const [target, name] = key.split(":");
      (target === "broker" ? broker : database)[name] = value;
    }
  }
});

test("a canceled entry with a reported partial fill cannot be treated as flat without broker-confirmed legs", async () => {
  const broker = alpaca as unknown as Record<string, unknown>;
  const database = journal as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  const replace = (target: Record<string, unknown>, name: string, value: unknown) => {
    const key = `${target === broker ? "broker" : "database"}:${name}`;
    originals.set(key, target[name]);
    target[name] = value;
  };
  const intent = { ...openIntent(), status: "entry_submitted" as const };
  const updates: Array<Partial<ExecutionIntent>> = [];
  try {
    replace(database, "activeIntents", async () => [intent]);
    replace(database, "updateIntent", async (_id: string, value: Partial<ExecutionIntent>) => { updates.push(value); return [{ ...intent, ...value }]; });
    replace(broker, "positions", async () => []);
    replace(broker, "order", async () => ({ id: "entry-1", status: "canceled", filled_qty: "1", filled_avg_price: "1.00" }));

    const result = await reconcileExecution({ entriesAllowed: true });
    assert.equal(result.healthy, false);
    assert.equal(result.intents[0]?.state, "unverified_flatness");
    assert.equal(updates.at(-1)?.status, "reconciliation_error");
  } finally {
    for (const [key, value] of originals) {
      const [target, name] = key.split(":");
      (target === "broker" ? broker : database)[name] = value;
    }
  }
});

test("a partial entry fill must match the exact broker-confirmed spread quantity", async () => {
  const broker = alpaca as unknown as Record<string, unknown>;
  const database = journal as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  const replace = (target: Record<string, unknown>, name: string, value: unknown) => {
    const key = `${target === broker ? "broker" : "database"}:${name}`;
    originals.set(key, target[name]);
    target[name] = value;
  };
  const intent: ExecutionIntent = { ...openIntent(), quantity: 2, status: "entry_submitted" };
  const updates: Array<Partial<ExecutionIntent>> = [];
  try {
    replace(database, "activeIntents", async () => [intent]);
    replace(database, "updateIntent", async (_id: string, value: Partial<ExecutionIntent>) => { updates.push(value); return [{ ...intent, ...value }]; });
    replace(broker, "positions", async () => [
      { asset_class: "us_option", symbol: "TEST-LONG", qty: "1" },
      { asset_class: "us_option", symbol: "TEST-SHORT", qty: "-1" },
    ]);
    replace(broker, "order", async () => ({ id: "entry-1", status: "canceled", filled_qty: "2", filled_avg_price: "1.00" }));

    const result = await reconcileExecution({ entriesAllowed: true });
    assert.equal(result.healthy, false);
    assert.equal(result.intents[0]?.state, "position_mismatch");
    assert.equal(updates.at(-1)?.status, "reconciliation_error");
  } finally {
    for (const [key, value] of originals) {
      const [target, name] = key.split(":");
      (target === "broker" ? broker : database)[name] = value;
    }
  }
});

test("a filled exit cannot become closed while broker exposure remains", async () => {
  const broker = alpaca as unknown as Record<string, unknown>;
  const database = journal as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  const replace = (target: Record<string, unknown>, name: string, value: unknown) => {
    const key = `${target === broker ? "broker" : "database"}:${name}`;
    originals.set(key, target[name]);
    target[name] = value;
  };
  const intent: ExecutionIntent = { ...openIntent(), status: "exit_submitted", exit_order_id: "exit-1" };
  const updates: Array<Partial<ExecutionIntent>> = [];
  try {
    replace(database, "activeIntents", async () => [intent]);
    replace(database, "updateIntent", async (_id: string, value: Partial<ExecutionIntent>) => { updates.push(value); return [{ ...intent, ...value }]; });
    replace(broker, "positions", async () => [
      { asset_class: "us_option", symbol: "TEST-LONG", qty: "1" },
      { asset_class: "us_option", symbol: "TEST-SHORT", qty: "-1" },
    ]);
    replace(broker, "order", async () => ({ id: "exit-1", status: "filled", filled_qty: "1", filled_avg_price: "-2.00" }));

    const result = await reconcileExecution({ entriesAllowed: true });
    assert.equal(result.healthy, false);
    assert.equal(result.intents[0]?.state, "position_mismatch");
    assert.equal(updates.at(-1)?.status, "reconciliation_error");
  } finally {
    for (const [key, value] of originals) {
      const [target, name] = key.split(":");
      (target === "broker" ? broker : database)[name] = value;
    }
  }
});

test("a broker-rejected entry degrades reconciliation before another allocation", async () => {
  const broker = alpaca as unknown as Record<string, unknown>;
  const database = journal as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  const replace = (target: Record<string, unknown>, name: string, value: unknown) => {
    const key = `${target === broker ? "broker" : "database"}:${name}`;
    originals.set(key, target[name]);
    target[name] = value;
  };
  const intent = { ...openIntent(), status: "entry_submitted" as const };
  try {
    replace(database, "activeIntents", async () => [intent]);
    replace(database, "updateIntent", async (_id: string, value: Partial<ExecutionIntent>) => [{ ...intent, ...value }]);
    replace(broker, "positions", async () => []);
    replace(broker, "order", async () => ({ id: "entry-1", status: "rejected", filled_qty: "0", reject_reason: "invalid order" }));

    const result = await reconcileExecution({ entriesAllowed: true });
    assert.equal(result.intents[0]?.state, "rejected");
    assert.equal(result.healthy, false);
  } finally {
    for (const [key, value] of originals) {
      const [target, name] = key.split(":");
      (target === "broker" ? broker : database)[name] = value;
    }
  }
});

test("an incomplete pre-submission reservation self-heals after its recovery window", async () => {
  const broker = alpaca as unknown as Record<string, unknown>;
  const database = journal as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  const replace = (target: Record<string, unknown>, name: string, value: unknown) => {
    const key = `${target === broker ? "broker" : "database"}:${name}`;
    originals.set(key, target[name]);
    target[name] = value;
  };
  const intent: ExecutionIntent = {
    ...openIntent(), status: "entry_pending", entry_order_id: null,
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(), metadata: {},
  };
  const updates: Array<Partial<ExecutionIntent>> = [];
  try {
    replace(database, "activeIntents", async () => [intent]);
    replace(database, "updateIntent", async (_id: string, value: Partial<ExecutionIntent>) => { updates.push(value); return [{ ...intent, ...value }]; });
    replace(broker, "positions", async () => []);

    const result = await reconcileExecution({ entriesAllowed: true });
    assert.equal(result.intents[0]?.state, "incomplete_reservation_canceled");
    assert.equal(result.healthy, true);
    assert.equal(updates.at(-1)?.status, "canceled");
    assert.equal(updates.at(-1)?.exit_reason, "incomplete_reservation_recovered");
  } finally {
    for (const [key, value] of originals) {
      const [target, name] = key.split(":");
      (target === "broker" ? broker : database)[name] = value;
    }
  }
});
