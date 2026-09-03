import assert from "node:assert/strict";
import test from "node:test";
import { PATCH } from "../app/api/settings/route";
import { alpaca } from "../lib/alpaca";
import { journal } from "../lib/supabase";
import type { AgentSettings, Decision } from "../lib/types";

test("explicit competition launch authorizes and arms Paper without fabricating Shadow evidence", async () => {
  const broker = alpaca as Record<string, unknown>;
  const database = journal as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  const replace = (target: Record<string, unknown>, name: string, value: unknown) => {
    const key = `${target === broker ? "broker" : "database"}:${name}`;
    originals.set(key, target[name]);
    target[name] = value;
  };
  const current: AgentSettings = { promotion_stage: "shadow", trading_enabled: false, emergency_stop: false, max_premium_per_trade: 500, max_daily_loss: 1000, max_open_positions: 3 };
  let updated: AgentSettings | null = null;
  let audit: Decision | null = null;
  try {
    replace(database, "settings", async () => current);
    replace(database, "closedShadowPositions", async () => []);
    replace(database, "latestHeartbeat", async () => ({ service: "execution-control-plane", instance_id: "railway", status: "healthy", last_seen_at: new Date().toISOString(), details: {} }));
    replace(database, "latestAccountAttestation", async () => ({ account_id: "paper-account", eligible_preflight: true }));
    replace(database, "latestCliPreflight", async () => ({ account_id: "paper-account", paper: true, market_open: false, cli_version: "alpaca 0.0.13", evidence_hash: "proof", healthy: true, created_at: new Date(Date.now() - 48 * 60 * 60_000).toISOString(), payload: {} }));
    replace(database, "updateSettings", async (settings: AgentSettings) => { updated = settings; return [settings]; });
    replace(database, "writeDecision", async (decision: Decision) => { audit = decision; return [decision]; });
    replace(broker, "account", async () => ({ id: "paper-account", status: "ACTIVE", options_trading_level: "3", options_buying_power: "100000", trading_blocked: false }));
    replace(broker, "accountConfig", async () => ({ suspend_trade: false }));

    const blocked = await PATCH(new Request("https://volforge.test/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ promotion_stage: "paper", trading_enabled: true }) }));
    assert.equal(blocked.status, 409);
    assert.equal(updated, null);

    const response = await PATCH(new Request("https://volforge.test/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ promotion_stage: "paper", trading_enabled: true, paper_bootstrap_confirmed: true }) }));
    assert.equal(response.status, 200);
    const finalSettings = updated as AgentSettings | null;
    const finalAudit = audit as Decision | null;
    assert.ok(finalSettings);
    assert.ok(finalAudit);
    assert.equal(finalSettings.promotion_stage, "paper");
    assert.equal(finalSettings.trading_enabled, true);
    assert.equal(finalAudit.source, "paper_launch_authorization");
    assert.equal(finalAudit.status, "APPROVED");
    assert.equal(finalAudit.risk_gates.every((gate) => gate.passed), true);
  } finally {
    for (const [key, value] of originals) {
      const [target, name] = key.split(":");
      (target === "broker" ? broker : database)[name] = value;
    }
  }
});

test("explicit competition launch can move directly from Research to Paper", async () => {
  const broker = alpaca as Record<string, unknown>;
  const database = journal as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  const replace = (target: Record<string, unknown>, name: string, value: unknown) => {
    const key = `${target === broker ? "broker" : "database"}:${name}`;
    originals.set(key, target[name]);
    target[name] = value;
  };
  const current: AgentSettings = { promotion_stage: "research", trading_enabled: false, emergency_stop: false, max_premium_per_trade: 500, max_daily_loss: 1000, max_open_positions: 3 };
  let updated: AgentSettings | null = null;
  try {
    replace(database, "settings", async () => current);
    replace(database, "closedShadowPositions", async () => []);
    replace(database, "latestHeartbeat", async () => ({ service: "execution-control-plane", instance_id: "railway", status: "healthy", last_seen_at: new Date().toISOString(), details: {} }));
    replace(database, "latestAccountAttestation", async () => ({ account_id: "paper-account", eligible_preflight: true }));
    replace(database, "latestCliPreflight", async () => ({ account_id: "paper-account", paper: true, market_open: false, cli_version: "alpaca 0.0.13", evidence_hash: "proof", healthy: true, created_at: new Date().toISOString(), payload: {} }));
    replace(database, "updateSettings", async (settings: AgentSettings) => { updated = settings; return [settings]; });
    replace(database, "writeDecision", async (decision: Decision) => [decision]);
    replace(broker, "account", async () => ({ id: "paper-account", status: "ACTIVE", options_trading_level: "3", options_buying_power: "100000", trading_blocked: false }));
    replace(broker, "accountConfig", async () => ({ suspend_trade: false }));

    const response = await PATCH(new Request("https://volforge.test/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ promotion_stage: "paper", trading_enabled: true, paper_bootstrap_confirmed: true }) }));
    assert.equal(response.status, 200);
    const finalSettings = updated as AgentSettings | null;
    assert.ok(finalSettings);
    assert.equal(finalSettings.promotion_stage, "paper");
    assert.equal(finalSettings.trading_enabled, true);
  } finally {
    for (const [key, value] of originals) {
      const [target, name] = key.split(":");
      (target === "broker" ? broker : database)[name] = value;
    }
  }
});
