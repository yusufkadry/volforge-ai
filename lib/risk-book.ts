import { alpaca } from "@/lib/alpaca";
import { CONSTITUTION } from "@/lib/constitution";
import { journal } from "@/lib/supabase";
import type { AgentSettings, RiskGate } from "@/lib/types";

function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }

export async function createRiskSnapshot(traceId: string, settings: AgentSettings) {
  const [account, positions, intents, shadowPositions] = await Promise.all([alpaca.account(), alpaca.positions(), journal.activeIntents(), journal.activeShadowPositions()]);
  const equity = number(account.equity);
  const priorClose = number(account.last_equity);
  const dailyPnl = priorClose > 0 ? equity - priorClose : 0;
  const optionPositions = positions.filter((position) => String(position.asset_class) === "us_option");
  const trackedSymbols = new Set(intents.flatMap((intent) => [intent.long_leg, intent.short_leg]));
  const orphanPositions = optionPositions.filter((position) => !trackedSymbols.has(String(position.symbol)));
  const shadowRisk = settings.promotion_stage === "shadow" ? shadowPositions.reduce((total, position) => total + Math.max(0, number(position.max_loss)), 0) : 0;
  const structureRisk = intents.reduce((total, intent) => total + Math.max(0, number(intent.max_loss)), 0) + shadowRisk;
  const orphanRisk = orphanPositions.reduce((total, position) => {
    const quantity = number(position.qty);
    // An untracked short option is treated as an account-level emergency, not as its mark value.
    return total + (quantity < 0 ? equity : Math.abs(number(position.market_value)));
  }, 0);
  const premiumAtRisk = structureRisk + orphanRisk;
  const orphanUnderlyings = new Set(orphanPositions.map((position) => String(position.symbol).match(/^([A-Z.]+)\d{6}[CP]/)?.[1] ?? String(position.symbol)));
  const openPositions = intents.length + (settings.promotion_stage === "shadow" ? shadowPositions.length : 0) + orphanUnderlyings.size;
  const snapshot = {
    trace_id: traceId,
    account_equity: equity,
    daily_pnl: dailyPnl,
    premium_at_risk: premiumAtRisk,
    open_positions: openPositions,
    exposure: {
      accounting: "tracked defined loss plus conservative orphan risk; broker legs are reconciled by symbol",
      structures: intents.map((intent) => ({ underlying: intent.underlying, long_leg: intent.long_leg, short_leg: intent.short_leg, status: intent.status, max_loss: intent.max_loss, current_debit: intent.current_debit })),
      shadow_structures: settings.promotion_stage === "shadow" ? shadowPositions.map((position) => ({ underlying: position.underlying, long_leg: position.long_leg, short_leg: position.short_leg, status: position.status, max_loss: position.max_loss, current_price: position.current_price })) : [],
      orphan_positions: orphanPositions.map((position) => ({ symbol: position.symbol, market_value: number(position.market_value), unrealized_pl: number(position.unrealized_pl), qty: position.qty })),
      broker_positions: Object.fromEntries(optionPositions.map((position) => [String(position.symbol), { market_value: number(position.market_value), unrealized_pl: number(position.unrealized_pl), qty: position.qty }])),
    },
    circuit_breakers: [
      { name: "Daily loss limit", passed: dailyPnl > -settings.max_daily_loss, detail: `${dailyPnl.toFixed(2)} / -${settings.max_daily_loss.toFixed(2)}` },
      { name: "Position limit", passed: openPositions < settings.max_open_positions, detail: `${openPositions} / ${settings.max_open_positions}` },
      { name: "Premium budget", passed: premiumAtRisk <= equity * CONSTITUTION.portfolio.maxPremiumRiskPct * settings.max_open_positions, detail: `$${premiumAtRisk.toFixed(0)} at risk` },
      { name: "Broker reconciliation", passed: orphanPositions.length === 0, detail: orphanPositions.length ? `${orphanPositions.length} untracked broker option leg${orphanPositions.length === 1 ? "" : "s"}` : "Every broker option leg maps to an execution intent" },
      { name: "Emergency state", passed: !settings.emergency_stop, detail: settings.emergency_stop ? "Emergency liquidation is active; entries blocked" : "No emergency stop" },
    ],
  };
  await journal.writeRiskSnapshot(snapshot);
  return snapshot;
}

export function portfolioGates(snapshot: Awaited<ReturnType<typeof createRiskSnapshot>>): RiskGate[] {
  return (snapshot.circuit_breakers as Array<{ name: string; passed: boolean; detail: string }>).map((gate) => ({ name: gate.name, passed: gate.passed, detail: gate.detail }));
}
