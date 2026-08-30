import { randomUUID } from "crypto";
import { alpaca } from "../lib/alpaca";
import { runAgent } from "../lib/agent";
import { advanceEmergencyStop } from "../lib/emergency";
import { reconcileExecution } from "../lib/execution-reconciler";
import { managePositions } from "../lib/position-manager";
import { journal } from "../lib/supabase";
import type { ControlRequest } from "../lib/types";
import { startTradeStream } from "./trade-stream";

const instanceId = process.env.RAILWAY_REPLICA_ID ?? randomUUID();
const stream = startTradeStream(instanceId);
let executionBusy = false;
let strategyBusy = false;
let controlRequestBusy = false;

async function executionCycle() {
  if (executionBusy) return;
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
      await journal.heartbeat({ service: "execution-control-plane", instance_id: instanceId, status: reconciliation.healthy ? "healthy" : "degraded", last_seen_at: new Date().toISOString(), details: { source: "rest_reconciliation", reconciliation, position_actions: actions.length, emergency } });
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
  if (strategyBusy) return;
  strategyBusy = true;
  try {
    const [clock, settings] = await Promise.all([alpaca.clock(), journal.settings()]);
    if (clock.is_open || settings.emergency_stop) await runAgent("scheduled");
  } catch (error) {
    console.error("Strategy cycle failed", error);
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
void strategyCycle();
void controlRequestCycle();
const executionTimer = setInterval(() => void executionCycle(), 30_000);
const strategyTimer = setInterval(() => void strategyCycle(), 5 * 60_000);
const controlRequestTimer = setInterval(() => void controlRequestCycle(), 15_000);

async function shutdown() {
  clearInterval(executionTimer);
  clearInterval(strategyTimer);
  clearInterval(controlRequestTimer);
  await stream.stop();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
