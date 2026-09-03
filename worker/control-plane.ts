import { randomUUID } from "crypto";
import { alpaca } from "../lib/alpaca";
import { runAgent } from "../lib/agent";
import { STRATEGY_VERSION } from "../lib/constitution";
import { advanceEmergencyStop } from "../lib/emergency";
import { numberEnv } from "../lib/env";
import { reconcileExecution } from "../lib/execution-reconciler";
import { supervisionIssues } from "../lib/execution-health";
import { managePositions } from "../lib/position-manager";
import { DEFAULT_RESEARCH_MAX_AGE_MS, forecastsFromRun, researchConstitutionMatches } from "../lib/research";
import { runAutonomousResearch } from "../lib/research-factory";
import { journal } from "../lib/supabase";
import type { ControlRequest } from "../lib/types";
import { startTradeStream } from "./trade-stream";

const instanceId = process.env.RAILWAY_REPLICA_ID ?? randomUUID();
const stream = startTradeStream(instanceId);
let executionBusy = false;
let strategyBusy = false;
let controlRequestBusy = false;
let researchBusy = false;

const executionIntervalMs = 30_000;
const strategyIntervalMs = 5 * 60_000;
const strategyRetryMs = 15_000;
const strategyInitialDelayMs = 15_000;
const researchCheckIntervalMs = 30 * 60_000;
const researchRefreshAgeMs = numberEnv("WORKER_RESEARCH_REFRESH_MS", 4 * 60 * 60_000);

function researchTimestamp(run: Awaited<ReturnType<typeof journal.latestResearch>>) {
  const generated = typeof run?.report?.generated_at === "string" ? run.report.generated_at : run?.created_at;
  const timestamp = generated ? new Date(generated).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

async function researchWatchdogCycle() {
  if (researchBusy) return;
  researchBusy = true;
  try {
    const [clock, latest] = await Promise.all([alpaca.clock(), journal.latestResearch()]);
    const age = Date.now() - researchTimestamp(latest);
    const usable = latest?.strategy_version === STRATEGY_VERSION && researchConstitutionMatches(latest) && forecastsFromRun(latest).length > 0;
    if (usable && age >= 0 && age < researchRefreshAgeMs) return;
    const capitalMaxAge = numberEnv("RESEARCH_MAX_AGE_MS", DEFAULT_RESEARCH_MAX_AGE_MS);
    if (clock.is_open && usable && age >= 0 && age <= capitalMaxAge) return;
    await runAutonomousResearch("railway_research_watchdog");
  } catch (error) {
    console.error("Research watchdog failed", error);
  } finally {
    researchBusy = false;
  }
}

async function executionCycle() {
  if (executionBusy || strategyBusy) return;
  executionBusy = true;
  const owner = `execution:${instanceId}:${Date.now()}`;
  const leaseTtl = 240;
  let renewalTimer: ReturnType<typeof setInterval> | null = null;
  try {
    const acquired = await journal.acquireLease("volforge-capital-loop", owner, leaseTtl);
    if (!acquired) return;
    const renewLease = async () => {
      try { return await journal.renewLease("volforge-capital-loop", owner, leaseTtl); }
      catch { return false; }
    };
    renewalTimer = setInterval(() => void renewLease(), 60_000);
    try {
      const [settings, clock] = await Promise.all([journal.settings(), alpaca.clock()]);
      const entriesAllowed = settings.promotion_stage === "paper" && settings.trading_enabled && !settings.emergency_stop;
      const reconciliation = await reconcileExecution({ entriesAllowed, leaseGuard: renewLease });
      if (!await renewLease()) throw new Error("Execution cycle lost the capital lease.");
      const actions = clock.is_open && !settings.emergency_stop ? await managePositions() : [];
      const emergency = settings.emergency_stop ? await advanceEmergencyStop() : null;
      const emergencyActions = Array.isArray(emergency?.actions) ? emergency.actions as Array<Record<string, unknown>> : [];
      const managementIssues = supervisionIssues([...actions, ...emergencyActions]);
      const healthy = reconciliation.healthy && managementIssues.length === 0;
      await journal.heartbeat({ service: "execution-control-plane", instance_id: instanceId, status: healthy ? "healthy" : "degraded", last_seen_at: new Date().toISOString(), details: { source: "rest_reconciliation", reconciliation, position_actions: actions.length, position_action_issues: managementIssues, emergency } });
    } finally {
      if (renewalTimer) clearInterval(renewalTimer);
      await journal.releaseLease("volforge-capital-loop", owner).catch(() => false);
    }
  } catch (error) {
    console.error("Execution cycle failed", error);
    await journal.heartbeat({ service: "execution-control-plane", instance_id: instanceId, status: "degraded", last_seen_at: new Date().toISOString(), details: { error: error instanceof Error ? error.message : "unknown execution-cycle error" } }).catch(() => undefined);
  } finally {
    executionBusy = false;
  }
}

async function strategyCycle() {
  if (strategyBusy || executionBusy) return false;
  strategyBusy = true;
  try {
    const [clock, settings] = await Promise.all([alpaca.clock(), journal.settings()]);
    if (!clock.is_open && !settings.emergency_stop) return true;
    const result = await runAgent("scheduled");
    if (result.underlying === "CONTROL" && result.rationale.includes("owns the capital lease")) return false;
    return true;
  } catch (error) {
    console.error("Strategy cycle failed", error);
    return false;
  } finally {
    strategyBusy = false;
  }
}

async function controlRequestCycle() {
  if (controlRequestBusy) return;
  controlRequestBusy = true;
  let request: ControlRequest | null = null;
  try {
    request = await journal.claimControlRequest(instanceId);
    if (!request) return;
    const result = await runAgent("manual");
    if (result.underlying === "CONTROL" && result.rationale.includes("owns the capital lease")) {
      await journal.requeueControlRequest(request.id);
      return;
    }
    await journal.completeControlRequest(request.id, result as unknown as Record<string, unknown>);
  } catch (error) {
    console.error("Control request failed", error);
    if (request) await journal.failControlRequest(request.id, error instanceof Error ? error.message : "unknown control-request error").catch(() => undefined);
  } finally {
    controlRequestBusy = false;
  }
}

void executionCycle();
void controlRequestCycle();
void researchWatchdogCycle();
const executionTimer = setInterval(() => void executionCycle(), executionIntervalMs);
const controlRequestTimer = setInterval(() => void controlRequestCycle(), 15_000);
const researchTimer = setInterval(() => void researchWatchdogCycle(), researchCheckIntervalMs);
let strategyTimer: ReturnType<typeof setTimeout>;

function scheduleStrategy(delayMs: number) {
  strategyTimer = setTimeout(async () => {
    const completed = await strategyCycle();
    scheduleStrategy(completed ? strategyIntervalMs : strategyRetryMs);
  }, delayMs);
}

scheduleStrategy(strategyInitialDelayMs);

async function shutdown() {
  clearInterval(executionTimer);
  clearInterval(strategyTimer);
  clearInterval(controlRequestTimer);
  clearInterval(researchTimer);
  await stream.stop().catch((error) => console.error("Trade stream shutdown failed", error));
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
