import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { constantTimeEqual } from "../lib/auth";
import { brokerMlegCreditLimit, economicMlegCredit } from "../lib/execution-ledger";

test("v4 schema contains leases, manifests, CLI proof, login throttling, and expanded execution states", () => {
  const sql = readFileSync(new URL("../supabase/upgrade_v4.sql", import.meta.url), "utf8");
  for (const invariant of ["acquire_agent_lease", "renew_agent_lease", "release_agent_lease", "claim_control_request", "control_requests", "model_manifests", "shadow_marks", "service_heartbeats", "cli_preflights", "register_dashboard_login", "dashboard_login_limits", "entry_partial", "reconciliation_error", "event_key"]) assert.match(sql, new RegExp(invariant));
  assert.match(sql, /revoke execute on function public\.acquire_agent_lease/);
  assert.match(sql, /revoke execute on function public\.register_dashboard_login/);
});

test("hard kill liquidates before broker suspension", () => {
  const source = readFileSync(new URL("../app/api/controls/hard-kill/route.ts", import.meta.url), "utf8");
  const agent = readFileSync(new URL("../lib/agent.ts", import.meta.url), "utf8");
  const database = readFileSync(new URL("../lib/supabase.ts", import.meta.url), "utf8");
  assert.match(source, /emergency_stop: true/);
  assert.match(source, /suspend_trade: false/);
  assert.match(source, /advanceEmergencyStop/);
  assert.doesNotMatch(source, /cancelActiveIntents/);
  assert.match(source, /markEntryCancellations/);
  assert.match(database, /status: "entry_cancel_pending"/);
  assert.match(agent, /postSubmitAuthorization/);
  assert.match(agent, /authorization_cancel_requested/);
});

test("workflows serialize capital and pin Alpaca CLI", () => {
  const workflow = readFileSync(new URL("../.github/workflows/volforge-agent.yml", import.meta.url), "utf8");
  assert.match(workflow, /group: volforge-capital-loop/);
  assert.match(workflow, /alpaca@v0\.0\.13/);
  assert.match(workflow, /npm run cli:record/);
  assert.match(workflow, /ALPACA_LIVE_TRADE: "false"/);
  assert.match(workflow, /npm ci/);
  assert.doesNotMatch(workflow, /alpaca@latest/);
});

test("stream reconciliation and emergency recovery preserve single-writer control", () => {
  const stream = readFileSync(new URL("../worker/trade-stream.ts", import.meta.url), "utf8");
  const emergency = readFileSync(new URL("../lib/emergency.ts", import.meta.url), "utf8");
  const controlPlane = readFileSync(new URL("../worker/control-plane.ts", import.meta.url), "utf8");
  assert.match(stream, /acquireLease\("volforge-capital-loop"/);
  assert.match(stream, /deferred_to_rest_loop/);
  assert.match(emergency, /cancelAllOrders/);
  const agent = readFileSync(new URL("../lib/agent.ts", import.meta.url), "utf8");
  assert.match(agent, /renewLease/);
  assert.doesNotMatch(agent, /managePositions\(\{ emergency:/);
  assert.doesNotMatch(controlPlane, /managePositions\(\{ emergency:/);
});

test("manual scans use the durable Railway command queue", () => {
  const route = readFileSync(new URL("../app/api/agent/run/route.ts", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../worker/control-plane.ts", import.meta.url), "utf8");
  assert.match(route, /enqueueControlRequest/);
  assert.doesNotMatch(route, /runAgent/);
  assert.match(worker, /claimControlRequest/);
  assert.match(worker, /requeueControlRequest/);
});

test("dashboard surfaces the latest scheduled cycle even when no contract qualified", () => {
  const database = readFileSync(new URL("../lib/supabase.ts", import.meta.url), "utf8");
  assert.match(database, /source=in\.\(scheduled,manual\)/);
  assert.doesNotMatch(database, /latestMarketDecision:[^\n]+option_symbol=not\.is\.null/);
});

test("paper authorization requires account attestation and a fresh CLI oracle", () => {
  const agent = readFileSync(new URL("../lib/agent.ts", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../app/api/settings/route.ts", import.meta.url), "utf8");
  for (const source of [agent, settings]) {
    assert.match(source, /latestAccountAttestation/);
    assert.match(source, /latestCliPreflight/);
  }
});

test("multi-leg exits translate positive economic credits to Alpaca negative limits", () => {
  assert.equal(brokerMlegCreditLimit(1.237), -1.24);
  assert.equal(economicMlegCredit("-1.24"), 1.24);
  assert.equal(economicMlegCredit(null, 0.85), 0.85);
  assert.throws(() => brokerMlegCreditLimit(0));
  const manager = readFileSync(new URL("../lib/position-manager.ts", import.meta.url), "utf8");
  const reconciler = readFileSync(new URL("../lib/execution-reconciler.ts", import.meta.url), "utf8");
  assert.match(manager, /broker_limit_price/);
  assert.match(reconciler, /unverified_flatness/);
});

test("ambiguous order acknowledgements recover idempotently by client order ID", () => {
  const alpaca = readFileSync(new URL("../lib/alpaca.ts", import.meta.url), "utf8");
  const submission = readFileSync(new URL("../lib/order-submission.ts", import.meta.url), "utf8");
  const agent = readFileSync(new URL("../lib/agent.ts", import.meta.url), "utf8");
  const manager = readFileSync(new URL("../lib/position-manager.ts", import.meta.url), "utf8");
  const reconciler = readFileSync(new URL("../lib/execution-reconciler.ts", import.meta.url), "utf8");
  assert.match(alpaca, /orders:by_client_order_id/);
  assert.match(submission, /AmbiguousOrderSubmissionError/);
  assert.match(submission, /submitOrderRecoverably/);
  assert.match(agent, /pending_entry_client_order_id/);
  assert.match(manager, /pending_exit_client_order_id/);
  assert.match(reconciler, /entry_ack_recovered/);
  assert.match(reconciler, /exit_ack_recovered/);
});

test("operators can always disarm or downgrade without stale promotion proofs", () => {
  const settings = readFileSync(new URL("../app/api/settings/route.ts", import.meta.url), "utf8");
  assert.match(settings, /promotingToPaper/);
  assert.match(settings, /armingEntries/);
  assert.doesNotMatch(settings, /if \(next\.promotion_stage === "paper" \|\| next\.trading_enabled\)/);
});

test("shadow fills and portfolio Greeks fail closed at executable evidence", () => {
  const shadow = readFileSync(new URL("../lib/shadow-manager.ts", import.meta.url), "utf8");
  const governor = readFileSync(new URL("../lib/portfolio-governor.ts", import.meta.url), "utf8");
  const riskBook = readFileSync(new URL("../lib/risk-book.ts", import.meta.url), "utf8");
  assert.match(shadow, /entryPrice > plan\.maxEntryDebit/);
  assert.match(shadow, /active\.length >= settings\.max_open_positions/);
  assert.match(governor, /Portfolio Greeks provenance/);
  assert.match(governor, /portfolioGreeksComplete && candidateGreeksComplete/);
  assert.match(governor, /activeShadowPositions/);
  assert.match(riskBook, /shadow_structures/);
});

test("dashboard password comparison uses fixed-length digests", async () => {
  assert.equal(await constantTimeEqual("correct horse", "correct horse"), true);
  assert.equal(await constantTimeEqual("correct horse", "wrong battery"), false);
});
