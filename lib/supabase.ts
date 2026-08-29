import { env } from "@/lib/env";
import type { AgentSettings, Decision, ResearchRun, ShadowPosition } from "@/lib/types";

function baseUrl() { return `${env("SUPABASE_URL").replace(/\/$/, "")}/rest/v1`; }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const headers = new Headers(init.headers);
  headers.set("apikey", key);
  headers.set("authorization", `Bearer ${key}`);
  headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl()}${path}`, { ...init, headers, cache: "no-store" });
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}

export const journal = {
  decisions: () => request<Decision[]>("/agent_decisions?select=*&order=created_at.desc&limit=24"),
  decisionByTrace: (traceId: string) => request<Decision[]>(`/agent_decisions?trace_id=eq.${encodeURIComponent(traceId)}&select=*`),
  writeDecision: (decision: Decision) => request<Decision[]>("/agent_decisions", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(decision),
  }),
  settings: async (): Promise<AgentSettings> => {
    const rows = await request<AgentSettings[]>("/agent_settings?id=eq.true&select=*");
    return rows[0] ?? { trading_enabled: false, max_premium_per_trade: 500, max_daily_loss: 1000, max_open_positions: 3, promotion_stage: "research" };
  },
  updateSettings: (settings: AgentSettings) => request<AgentSettings[]>("/agent_settings?id=eq.true", {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(settings),
  }),
  research: () => request<ResearchRun[]>("/research_runs?select=*&order=created_at.desc&limit=12"),
  writeResearch: (run: ResearchRun) => request<ResearchRun[]>("/research_runs", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(run),
  }),
  strategy: (version: string) => request<Array<Record<string, unknown>>>(`/strategy_versions?version=eq.${encodeURIComponent(version)}&select=*`),
  writeStrategy: (strategy: Record<string, unknown>) => request<Array<Record<string, unknown>>>("/strategy_versions", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(strategy),
  }),
  shadowPositions: () => request<ShadowPosition[]>("/shadow_positions?select=*&order=created_at.desc&limit=48"),
  createShadow: (position: ShadowPosition) => request<ShadowPosition[]>("/shadow_positions", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(position),
  }),
  updateShadow: (id: string, position: Partial<ShadowPosition>) => request<ShadowPosition[]>(`/shadow_positions?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(position),
  }),
  writeOrderEvent: (event: Record<string, unknown>) => request<Array<Record<string, unknown>>>("/order_events", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(event),
  }),
  writeRiskSnapshot: (snapshot: Record<string, unknown>) => request<Array<Record<string, unknown>>>("/risk_snapshots", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(snapshot),
  }),
  latestRiskSnapshot: async () => (await request<Array<Record<string, unknown>>>("/risk_snapshots?select=*&order=created_at.desc&limit=1"))[0] ?? null,
};
