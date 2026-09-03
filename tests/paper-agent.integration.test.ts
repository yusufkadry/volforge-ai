import assert from "node:assert/strict";
import test from "node:test";
import { alpaca } from "../lib/alpaca";
import { runAgent } from "../lib/agent";
import { constitutionHash, STRATEGY_VERSION } from "../lib/constitution";
import { journal } from "../lib/supabase";
import type { AgentSettings, Decision, ExecutionIntent, ResearchForecast, ResearchRun } from "../lib/types";
import { horizon } from "./fixtures";

test("an authorized Paper cycle reserves before sending an atomic Alpaca spread", async () => {
  const broker = alpaca as unknown as Record<string, unknown>;
  const database = journal as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  const environment = new Map<string, string | undefined>();
  const replace = (target: Record<string, unknown>, name: string, value: unknown) => {
    const key = `${target === broker ? "broker" : "database"}:${name}`;
    originals.set(key, target[name]);
    target[name] = value;
  };
  const setEnvironment = (name: string, value: string) => {
    environment.set(name, process.env[name]);
    process.env[name] = value;
  };

  const now = new Date();
  const expiration = new Date(now);
  expiration.setUTCDate(expiration.getUTCDate() + 29);
  const expirationDate = expiration.toISOString().slice(0, 10);
  const expiryCode = `${String(expiration.getUTCFullYear()).slice(2)}${String(expiration.getUTCMonth() + 1).padStart(2, "0")}${String(expiration.getUTCDate()).padStart(2, "0")}`;
  const strikes = Array.from({ length: 16 }, (_, index) => 86 + index * 2);
  const symbolFor = (strike: number) => `TEST${expiryCode}C${String(Math.round(strike * 1000)).padStart(8, "0")}`;
  const quoteTimestamp = now.toISOString();
  const contracts = strikes.map((strike) => ({ symbol: symbolFor(strike), underlying_symbol: "TEST", type: "call", strike_price: String(strike), expiration_date: expirationDate, tradable: true }));
  const snapshots = Object.fromEntries(strikes.map((strike) => {
    const distance = strike - 100;
    const midpoint = strike === 100 ? 2.04 : strike === 102 ? 1.42 : strike === 104 ? 0.82 : Math.max(0.18, 2.04 * Math.exp(-distance * 0.22));
    const spread = Math.max(0.02, midpoint * 0.035);
    const logMoneyness = Math.log(strike / 100);
    const iv = 0.22 - 0.08 * logMoneyness + 0.55 * logMoneyness * logMoneyness;
    const delta = Math.max(0.08, Math.min(0.92, 0.55 - distance * 0.045));
    return [symbolFor(strike), {
      latestQuote: { bp: Number((midpoint - spread / 2).toFixed(2)), ap: Number((midpoint + spread / 2).toFixed(2)), t: quoteTimestamp },
      impliedVolatility: iv, openInterest: 2500, greeks: { delta, vega: 0.08 },
    }];
  }));
  const holding = horizon(3, { probabilityUp: 0.76, rawProbabilityUp: 0.78, expectedLogReturn: 0.045, sigmaLogReturn: 0.02, forecastRv: 0.24 });
  const option = horizon(20, { probabilityUp: 0.68, rawProbabilityUp: 0.7, expectedLogReturn: 0.09, sigmaLogReturn: 0.065, forecastRv: 0.25 });
  const forecast = { symbol: "TEST", generatedAt: now.toISOString(), horizons: [holding, option], forecastRv: option.forecastRv, probabilityUp: option.probabilityUp, validation: option.validation, featureValues: [] } satisfies ResearchForecast;
  const research: ResearchRun = { strategy_version: STRATEGY_VERSION, universe: ["TEST"], report: { generated_at: now.toISOString(), constitution_hash: constitutionHash(), forecasts: [forecast], strongest_models: 1 }, promotion_recommendation: "shadow", trace_id: "research-champion", created_at: now.toISOString() };
  const settings: AgentSettings = { promotion_stage: "paper", trading_enabled: true, emergency_stop: false, max_premium_per_trade: 500, max_daily_loss: 1000, max_open_positions: 3 };
  const account = { id: "paper-account", status: "ACTIVE", equity: "100000", last_equity: "100000", buying_power: "400000", options_buying_power: "100000", options_trading_level: "3", trading_blocked: false };
  const callOrder: string[] = [];
  let submittedPayload: Record<string, unknown> | null = null;
  let reservedIntent: ExecutionIntent | null = null;
  let writtenDecision: Decision | null = null;
  const originalFetch = globalThis.fetch;

  try {
    setEnvironment("VOLFORGE_UNIVERSE", "TEST");
    setEnvironment("OPENAI_API_KEY", "test-key");
    setEnvironment("COMPETITION_EXIT_AT", "2026-09-03T19:30:00Z");
    setEnvironment("MIN_EXPECTED_VALUE", "1");
    setEnvironment("MIN_STRESS_EXPECTED_VALUE", "-25");
    setEnvironment("MAX_QUOTE_SPREAD_PCT", "0.05");
    setEnvironment("MIN_OPEN_INTEREST", "500");

    replace(broker, "clock", async () => ({ is_open: true, timestamp: "2026-09-02T14:00:00.000Z", next_close: "2026-09-02T20:00:00.000Z" }));
    replace(broker, "account", async () => account);
    replace(broker, "accountConfig", async () => ({ suspend_trade: false }));
    replace(broker, "positions", async () => []);
    replace(broker, "contracts", async () => ({ option_contracts: contracts, next_page_token: null, meta: { pages: 1, truncated: false, contracts: contracts.length } }));
    replace(broker, "snapshots", async () => ({ snapshots, next_page_token: null, meta: { feed: "indicative", pages: 1, truncated: false, contracts: contracts.length } }));
    replace(broker, "optionSnapshots", async (symbols: string[]) => ({ snapshots: Object.fromEntries(symbols.map((symbol) => [symbol, snapshots[symbol]]).filter((entry) => entry[1])), meta: { feed: "indicative", pages: 1, truncated: false, contracts: symbols.length } }));
    replace(broker, "stockSnapshot", async () => ({ latestTrade: { p: 100 } }));
    replace(broker, "news", async () => ({ news: [], next_page_token: null, meta: { pages: 1, truncated: false, articles: 0 } }));
    replace(broker, "submitOrder", async (payload: Record<string, unknown>) => { callOrder.push("broker-submit"); submittedPayload = payload; return { id: "alpaca-entry-order", status: "accepted", client_order_id: payload.client_order_id }; });

    replace(database, "acquireLease", async () => true);
    replace(database, "renewLease", async () => true);
    replace(database, "releaseLease", async () => true);
    replace(database, "settings", async () => settings);
    replace(database, "research", async () => [research]);
    replace(database, "latestHeartbeat", async () => ({ service: "execution-control-plane", instance_id: "railway", status: "healthy", last_seen_at: new Date().toISOString(), details: {} }));
    replace(database, "latestAccountAttestation", async () => ({ account_id: "paper-account", eligible_preflight: true }));
    replace(database, "latestCliPreflight", async () => ({ account_id: "paper-account", paper: true, market_open: false, cli_version: "alpaca 0.0.13", evidence_hash: "cli-proof", healthy: true, created_at: new Date(Date.now() - 36 * 60 * 60_000).toISOString(), payload: {} }));
    replace(database, "activeIntents", async () => []);
    replace(database, "recentFailedIntents", async () => []);
    replace(database, "activeShadowPositions", async () => []);
    replace(database, "closedShadowPositions", async () => []);
    replace(database, "closedIntents", async () => []);
    replace(database, "latestCalibration", async () => null);
    replace(database, "writeCalibration", async (value: unknown) => [value]);
    replace(database, "writeRiskSnapshot", async (value: unknown) => [value]);
    replace(database, "writeObservations", async (value: unknown) => value);
    replace(database, "writeEngineEvaluations", async (value: unknown) => value);
    replace(database, "reserveIntent", async (intent: ExecutionIntent) => { callOrder.push("reserve-intent"); reservedIntent = { ...intent, id: "intent-1" }; return { created: true, intent: reservedIntent }; });
    replace(database, "updateIntent", async (_id: string, value: Partial<ExecutionIntent>) => { callOrder.push(`persist-${value.status ?? "update"}`); return [{ ...reservedIntent, ...value }]; });
    replace(database, "writeOrderEvent", async (value: unknown) => [value]);
    replace(database, "writeDecision", async (decision: Decision) => { writtenDecision = decision; return [decision]; });

    globalThis.fetch = async (input) => {
      assert.match(String(input), /api\.openai\.com/);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ approve: true, hard_veto: false, issues: [], rationale: "Exact legs, payoff, and stress evidence are internally consistent." }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const decision = await runAgent("scheduled");
    const persistedDecision = writtenDecision as Decision | null;
    const persistedIntent = reservedIntent as ExecutionIntent | null;
    const orderPayload = submittedPayload as Record<string, unknown> | null;
    assert.equal(decision.status, "SUBMITTED", decision.rationale);
    assert.equal(decision.order_id, "alpaca-entry-order");
    assert.ok(persistedDecision);
    assert.ok(persistedIntent);
    assert.ok(orderPayload);
    assert.equal(persistedDecision.status, "SUBMITTED");
    assert.ok(persistedIntent.idempotency_key.includes(STRATEGY_VERSION));
    assert.ok(callOrder.indexOf("reserve-intent") < callOrder.indexOf("broker-submit"));
    assert.equal(orderPayload.order_class, "mleg");
    assert.equal(orderPayload.type, "limit");
    assert.equal(typeof orderPayload.qty, "string");
    assert.ok(Number(orderPayload.limit_price) > 0);
    assert.deepEqual(orderPayload.legs, [
      { symbol: persistedIntent.long_leg, ratio_qty: "1", side: "buy", position_intent: "buy_to_open" },
      { symbol: persistedIntent.short_leg, ratio_qty: "1", side: "sell", position_intent: "sell_to_open" },
    ]);
    for (const gate of decision.risk_gates) assert.equal(gate.passed, true, `${gate.name}: ${gate.detail}`);
    assert.equal(decision.risk_gates.some((gate) => gate.name === "Shadow promotion evidence"), false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of environment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const [key, value] of originals) {
      const [target, name] = key.split(":");
      (target === "broker" ? broker : database)[name] = value;
    }
  }
});
