import { env } from "@/lib/env";
import type { AgentSettings, Decision } from "@/lib/types";

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
  writeDecision: (decision: Decision) => request<Decision[]>("/agent_decisions", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(decision),
  }),
  settings: async (): Promise<AgentSettings> => {
    const rows = await request<AgentSettings[]>("/agent_settings?id=eq.true&select=*");
    return rows[0] ?? { trading_enabled: false, max_premium_per_trade: 500 };
  },
  updateSettings: (settings: AgentSettings) => request<AgentSettings[]>("/agent_settings?id=eq.true", {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(settings),
  }),
};
