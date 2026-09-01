import { env, numberEnv } from "@/lib/env";
import type { AgentSettings, CalibrationSnapshot, CliPreflight, ControlRequest, Decision, ExecutionIntent, ResearchRun, ServiceHeartbeat, ShadowPosition } from "@/lib/types";

function baseUrl() { return `${env("SUPABASE_URL").replace(/\/$/, "")}/rest/v1`; }

async function rawRequest(path: string, init: RequestInit = {}) {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const headers = new Headers(init.headers);
  headers.set("apikey", key);
  headers.set("authorization", `Bearer ${key}`);
  headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl()}${path}`, { ...init, headers, cache: "no-store", signal: init.signal ?? AbortSignal.timeout(numberEnv("SUPABASE_REQUEST_TIMEOUT_MS", 20_000)) });
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  return response;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await rawRequest(path, init);
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}

async function count(path: string) {
  const response = await rawRequest(path, { headers: { Prefer: "count=exact" } });
  const range = response.headers.get("content-range") ?? "0-0/0";
  const total = Number(range.split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

const activeStatuses = "entry_pending,entry_submitted,entry_partial,entry_cancel_pending,open,exit_pending,exit_submitted,exit_partial,exit_cancel_pending,reconciliation_error";

export const journal = {
  decisions: () => request<Decision[]>("/agent_decisions?select=*&order=created_at.desc&limit=24"),
  decisionCount: () => count("/agent_decisions?select=id&limit=1"),
  submittedDecisionCount: () => count("/agent_decisions?status=eq.SUBMITTED&select=id&limit=1"),
  latestMarketDecision: async () => (await request<Decision[]>("/agent_decisions?source=in.(scheduled,manual)&select=*&order=created_at.desc&limit=1"))[0] ?? null,
  latestResearchDecision: async () => (await request<Decision[]>("/agent_decisions?source=in.(autonomous_research_factory,weekend_research_factory)&select=*&order=created_at.desc&limit=1"))[0] ?? null,
  decisionByTrace: (traceId: string) => request<Decision[]>(`/agent_decisions?trace_id=eq.${encodeURIComponent(traceId)}&select=*`),
  writeDecision: (decision: Decision) => request<Decision[]>("/agent_decisions", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(decision),
  }),
  settings: async (): Promise<AgentSettings> => {
    const rows = await request<AgentSettings[]>("/agent_settings?id=eq.true&select=*");
    return rows[0] ?? { trading_enabled: false, emergency_stop: false, max_premium_per_trade: 500, max_daily_loss: 1000, max_open_positions: 3, promotion_stage: "research" };
  },
  updateSettings: (settings: AgentSettings) => request<AgentSettings[]>("/agent_settings?id=eq.true", {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ ...settings, updated_at: new Date().toISOString() }),
  }),
  research: () => request<ResearchRun[]>("/research_runs?select=*&order=created_at.desc&limit=12"),
  latestResearch: async () => (await request<ResearchRun[]>("/research_runs?select=*&order=created_at.desc&limit=1"))[0] ?? null,
  writeResearch: (run: ResearchRun) => request<ResearchRun[]>("/research_runs", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(run),
  }),
  writeModelManifests: (manifests: Array<Record<string, unknown>>) => manifests.length ? request<Array<Record<string, unknown>>>("/model_manifests?on_conflict=manifest_hash", {
    method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(manifests),
  }) : Promise.resolve([]),
  strategy: (version: string) => request<Array<Record<string, unknown>>>(`/strategy_versions?version=eq.${encodeURIComponent(version)}&select=*`),
  writeStrategy: (strategy: Record<string, unknown>) => request<Array<Record<string, unknown>>>("/strategy_versions?on_conflict=version", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(strategy),
  }),
  shadowPositions: () => request<ShadowPosition[]>("/shadow_positions?select=*&order=created_at.desc&limit=100"),
  activeShadowPositions: () => request<ShadowPosition[]>("/shadow_positions?status=eq.open&select=*&order=created_at.asc"),
  closedShadowPositions: () => request<ShadowPosition[]>("/shadow_positions?status=eq.closed&select=*&order=closed_at.desc&limit=200"),
  activeShadowForUnderlying: async (underlying: string) => (await request<ShadowPosition[]>(`/shadow_positions?underlying=eq.${encodeURIComponent(underlying)}&status=eq.open&select=*&limit=1`))[0] ?? null,
  shadowByKey: async (key: string) => (await request<ShadowPosition[]>(`/shadow_positions?idempotency_key=eq.${encodeURIComponent(key)}&select=*&limit=1`))[0] ?? null,
  reserveShadow: async (position: ShadowPosition) => {
    const rows = await request<ShadowPosition[]>("/shadow_positions?on_conflict=idempotency_key", {
      method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(position),
    });
    if (rows[0]) return { created: true, position: rows[0] };
    return { created: false, position: await journal.shadowByKey(position.idempotency_key) };
  },
  updateShadow: (id: string, position: Partial<ShadowPosition>) => request<ShadowPosition[]>(`/shadow_positions?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ ...position, updated_at: new Date().toISOString() }),
  }),
  writeShadowMark: (mark: Record<string, unknown>) => request<Array<Record<string, unknown>>>("/shadow_marks", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(mark),
  }),
  writeOrderEvent: (event: Record<string, unknown>) => request<Array<Record<string, unknown>>>("/order_events?on_conflict=event_key", {
    method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(event),
  }),
  writeRiskSnapshot: (snapshot: Record<string, unknown>) => request<Array<Record<string, unknown>>>("/risk_snapshots", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(snapshot),
  }),
  writeObservations: (observations: Array<Record<string, unknown>>) => observations.length ? request<Array<Record<string, unknown>>>("/market_observations", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(observations),
  }) : Promise.resolve([]),
  writeEngineEvaluations: (evaluations: Array<Record<string, unknown>>) => evaluations.length ? request<Array<Record<string, unknown>>>("/engine_evaluations", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(evaluations),
  }) : Promise.resolve([]),
  latestRiskSnapshot: async () => (await request<Array<Record<string, unknown>>>("/risk_snapshots?select=*&order=created_at.desc&limit=1"))[0] ?? null,
  intents: () => request<ExecutionIntent[]>("/execution_intents?select=*&order=created_at.desc&limit=100"),
  closedIntents: () => request<ExecutionIntent[]>("/execution_intents?status=eq.closed&select=*&order=created_at.desc&limit=200"),
  activeIntents: () => request<ExecutionIntent[]>(`/execution_intents?status=in.(${activeStatuses})&select=*&order=created_at.asc`),
  activeIntentForUnderlying: async (underlying: string) => (await request<ExecutionIntent[]>(`/execution_intents?underlying=eq.${encodeURIComponent(underlying)}&status=in.(${activeStatuses})&select=*&order=created_at.desc&limit=1`))[0] ?? null,
  intentByKey: async (key: string) => (await request<ExecutionIntent[]>(`/execution_intents?idempotency_key=eq.${encodeURIComponent(key)}&select=*&limit=1`))[0] ?? null,
  reserveIntent: async (intent: ExecutionIntent) => {
    const rows = await request<ExecutionIntent[]>("/execution_intents?on_conflict=idempotency_key", {
      method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(intent),
    });
    if (rows[0]) return { created: true, intent: rows[0] };
    return { created: false, intent: await journal.intentByKey(intent.idempotency_key) };
  },
  updateIntent: (id: string, intent: Partial<ExecutionIntent>) => request<ExecutionIntent[]>(`/execution_intents?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ ...intent, updated_at: new Date().toISOString() }),
  }),
  intentByEntryOrder: async (orderId: string) => (await request<ExecutionIntent[]>(`/execution_intents?entry_order_id=eq.${encodeURIComponent(orderId)}&select=*&limit=1`))[0] ?? null,
  intentByExitOrder: async (orderId: string) => (await request<ExecutionIntent[]>(`/execution_intents?exit_order_id=eq.${encodeURIComponent(orderId)}&select=*&limit=1`))[0] ?? null,
  markEntryCancellations: () => request<ExecutionIntent[]>("/execution_intents?status=in.(entry_pending,entry_submitted,entry_partial,entry_cancel_pending)", {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "entry_cancel_pending", updated_at: new Date().toISOString(), exit_reason: "emergency_stop" }),
  }),
  writeCalibration: (snapshot: CalibrationSnapshot) => request<CalibrationSnapshot[]>("/calibration_snapshots", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(snapshot),
  }),
  latestCalibration: async () => (await request<CalibrationSnapshot[]>("/calibration_snapshots?select=*&order=created_at.desc&limit=1"))[0] ?? null,
  acquireLease: async (leaseName: string, owner: string, ttlSeconds: number) => {
    const value = await request<boolean>("/rpc/acquire_agent_lease", { method: "POST", body: JSON.stringify({ p_lease_name: leaseName, p_lease_owner: owner, p_ttl_seconds: ttlSeconds }) });
    return Boolean(value);
  },
  renewLease: async (leaseName: string, owner: string, ttlSeconds: number) => {
    const value = await request<boolean>("/rpc/renew_agent_lease", { method: "POST", body: JSON.stringify({ p_lease_name: leaseName, p_lease_owner: owner, p_ttl_seconds: ttlSeconds }) });
    return Boolean(value);
  },
  releaseLease: (leaseName: string, owner: string) => request<boolean>("/rpc/release_agent_lease", { method: "POST", body: JSON.stringify({ p_lease_name: leaseName, p_lease_owner: owner }) }),
  heartbeat: (heartbeat: ServiceHeartbeat) => request<ServiceHeartbeat[]>("/service_heartbeats?on_conflict=service", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(heartbeat),
  }),
  latestHeartbeat: async (service: string) => (await request<ServiceHeartbeat[]>(`/service_heartbeats?service=eq.${encodeURIComponent(service)}&select=*&limit=1`))[0] ?? null,
  writeCliPreflight: (preflight: CliPreflight) => request<CliPreflight[]>("/cli_preflights", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(preflight),
  }),
  latestCliPreflight: async () => (await request<CliPreflight[]>("/cli_preflights?select=*&order=created_at.desc&limit=1"))[0] ?? null,
  enqueueControlRequest: async (requestedBy: string) => (await request<ControlRequest[]>("/control_requests", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ action: "run_agent", status: "pending", requested_by: requestedBy }),
  }))[0],
  activeControlRequest: async () => (await request<ControlRequest[]>("/control_requests?status=in.(pending,running)&select=*&order=created_at.asc&limit=1"))[0] ?? null,
  claimControlRequest: async (worker: string) => (await request<ControlRequest[]>("/rpc/claim_control_request", {
    method: "POST", body: JSON.stringify({ p_worker: worker }),
  }))[0] ?? null,
  completeControlRequest: (id: string, result: Record<string, unknown>) => request<ControlRequest[]>(`/control_requests?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "completed", result, completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), error: null }),
  }),
  failControlRequest: (id: string, error: string) => request<ControlRequest[]>(`/control_requests?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "error", error, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
  }),
  requeueControlRequest: (id: string) => request<ControlRequest[]>(`/control_requests?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "pending", claimed_by: null, claimed_at: null, updated_at: new Date().toISOString() }),
  }),
  latestControlRequest: async () => (await request<ControlRequest[]>("/control_requests?select=*&order=created_at.desc&limit=1"))[0] ?? null,
  writeAccountAttestation: (attestation: Record<string, unknown>) => request<Array<Record<string, unknown>>>("/competition_attestations", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(attestation),
  }),
  latestAccountAttestation: async () => (await request<Array<Record<string, unknown>>>("/competition_attestations?select=*&order=created_at.desc&limit=1"))[0] ?? null,
  registerLoginAttempt: (fingerprint: string, success: boolean) => request<{ allowed?: boolean; blocked?: boolean; retry_after_seconds?: number }>("/rpc/register_dashboard_login", {
    method: "POST", body: JSON.stringify({ p_fingerprint: fingerprint, p_success: success }),
  }),
};
