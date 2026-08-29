import { alpaca } from "@/lib/alpaca";
import { CONSTITUTION } from "@/lib/constitution";
import { journal } from "@/lib/supabase";
import type { AgentSettings, RiskGate } from "@/lib/types";

function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }

export async function createRiskSnapshot(traceId: string, settings: AgentSettings) {
  const [account, positions] = await Promise.all([alpaca.account(), alpaca.positions()]);
  const equity = number(account.equity);
  const dailyPnl = equity - number(account.last_equity);
  const premiumAtRisk = positions.filter((position) => String(position.asset_class) === "us_option").reduce((total, position) => total + Math.abs(number(position.market_value)), 0);
  const snapshot = {
    trace_id: traceId,
    account_equity: equity,
    daily_pnl: dailyPnl,
    premium_at_risk: premiumAtRisk,
    open_positions: positions.length,
    exposure: Object.fromEntries(positions.map((position) => [String(position.symbol), { market_value: number(position.market_value), unrealized_pl: number(position.unrealized_pl), qty: position.qty }])),
    circuit_breakers: [
      { name: "Daily loss limit", passed: dailyPnl > -settings.max_daily_loss, detail: `${dailyPnl.toFixed(2)} / -${settings.max_daily_loss.toFixed(2)}` },
      { name: "Position limit", passed: positions.length < settings.max_open_positions, detail: `${positions.length} / ${settings.max_open_positions}` },
      { name: "Premium budget", passed: premiumAtRisk <= equity * CONSTITUTION.portfolio.maxPremiumRiskPct * settings.max_open_positions, detail: `$${premiumAtRisk.toFixed(0)} at risk` },
    ],
  };
  await journal.writeRiskSnapshot(snapshot);
  return snapshot;
}

export function portfolioGates(snapshot: Awaited<ReturnType<typeof createRiskSnapshot>>): RiskGate[] {
  return (snapshot.circuit_breakers as Array<{ name: string; passed: boolean; detail: string }>).map((gate) => ({ name: gate.name, passed: gate.passed, detail: gate.detail }));
}
