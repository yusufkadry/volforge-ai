import { createHash } from "crypto";
import { alpaca } from "@/lib/alpaca";
import { numberEnv } from "@/lib/env";
import { journal } from "@/lib/supabase";
import type { TradePlan } from "@/lib/reward-engine";
import type { RiskGate } from "@/lib/types";

function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function underlyingFromOption(symbol: string) { return symbol.match(/^([A-Z.]+)\d{6}[CP]/)?.[1] ?? null; }

function nyMinutes(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return value("hour") * 60 + value("minute");
}

export async function governPortfolio(plan: TradePlan, equity: number, marketOpen: boolean) {
  const [positions, intents] = await Promise.all([alpaca.positions(), journal.activeIntents()]);
  const optionPositions = positions.filter((position) => String(position.asset_class) === "us_option");
  const underlyings = [...new Set(optionPositions.map((position) => underlyingFromOption(String(position.symbol))).filter((value): value is string => Boolean(value)))];
  const snapshotResults = await Promise.allSettled(underlyings.map((underlying) => alpaca.snapshots(underlying)));
  let delta = 0;
  let vega = 0;
  optionPositions.forEach((position) => {
    const underlying = underlyingFromOption(String(position.symbol));
    const index = underlying ? underlyings.indexOf(underlying) : -1;
    const result = index >= 0 ? snapshotResults[index] : null;
    const response = result?.status === "fulfilled" ? result.value : null;
    const snapshot = response?.snapshots?.[String(position.symbol)] ?? {};
    const greeks = (snapshot.greeks ?? {}) as Record<string, unknown>;
    const quantity = number(position.qty) * 100;
    delta += quantity * number(greeks.delta);
    vega += quantity * number(greeks.vega);
  });
  const candidateDelta = ((plan.candidate.delta ?? 0) - (plan.shortLeg.delta ?? 0)) * plan.quantity * 100;
  const candidateVega = ((plan.candidate.vega ?? 0) - (plan.shortLeg.vega ?? 0)) * plan.quantity * 100;
  const proposedDelta = delta + candidateDelta;
  const proposedVega = vega + candidateVega;
  const currentRisk = intents.reduce((total, intent) => total + number(intent.max_loss), 0);
  const proposedRisk = currentRisk + plan.maxLoss * plan.quantity;
  const maxPortfolioRisk = equity * numberEnv("MAX_PORTFOLIO_RISK_PCT", 0.015);
  const sessionMinutes = nyMinutes();
  const inEntryWindow = marketOpen && sessionMinutes >= 9 * 60 + 35 && sessionMinutes < 15 * 60 + 45;
  const duplicateUnderlying = intents.some((intent) => intent.underlying === plan.candidate.underlying);
  const gates: RiskGate[] = [
    { name: "Entry session window", passed: inEntryWindow, detail: inEntryWindow ? "After opening auction and before closing-liquidity window" : "Entry blocked during closed, opening, or closing session window" },
    { name: "Portfolio risk budget", passed: proposedRisk <= maxPortfolioRisk, detail: `$${proposedRisk.toFixed(0)} defined loss / $${maxPortfolioRisk.toFixed(0)} portfolio ceiling` },
    { name: "Underlying concentration", passed: !duplicateUnderlying, detail: duplicateUnderlying ? `${plan.candidate.underlying} already has active VolForge exposure` : "No active VolForge exposure on this underlying" },
    { name: "Net delta governor", passed: Math.abs(proposedDelta) <= numberEnv("MAX_NET_DELTA", 250), detail: `${proposedDelta.toFixed(0)} net delta-equivalent / ${numberEnv("MAX_NET_DELTA", 250).toFixed(0)} cap` },
    { name: "Net vega governor", passed: Math.abs(proposedVega) <= numberEnv("MAX_NET_VEGA", 300), detail: `${proposedVega.toFixed(0)} net vega-equivalent / ${numberEnv("MAX_NET_VEGA", 300).toFixed(0)} cap` },
  ];
  const payload = { existing_delta: delta, proposed_delta: proposedDelta, existing_vega: vega, proposed_vega: proposedVega, current_risk: currentRisk, proposed_risk: proposedRisk, max_portfolio_risk: maxPortfolioRisk, session_minutes: sessionMinutes, active_intents: intents.length, gates };
  return { gates, payload, evidenceHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
}
