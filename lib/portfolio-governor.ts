import { createHash } from "crypto";
import { alpaca } from "@/lib/alpaca";
import { competitionEntryAllowed } from "@/lib/competition";
import { numberEnv } from "@/lib/env";
import { journal } from "@/lib/supabase";
import type { TradePlan } from "@/lib/reward-engine";
import type { RiskGate } from "@/lib/types";

function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function finite(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }

function nyMinutes(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return value("hour") * 60 + value("minute");
}

export async function governPortfolio(plan: TradePlan, equity: number, marketOpen: boolean) {
  const [positions, intents] = await Promise.all([alpaca.positions(), journal.activeIntents()]);
  const optionPositions = positions.filter((position) => String(position.asset_class) === "us_option");
  const positionSymbols = optionPositions.map((position) => String(position.symbol));
  const snapshotResponse = positionSymbols.length ? await alpaca.optionSnapshots(positionSymbols) : { snapshots: {}, meta: { contracts: 0 } };
  const snapshotMap: Record<string, Record<string, unknown>> = snapshotResponse.snapshots;
  let delta = 0;
  let vega = 0;
  let portfolioGreeksComplete = snapshotResponse.meta.contracts === positionSymbols.length;
  let oldestQuoteAgeMs = 0;
  optionPositions.forEach((position) => {
    const snapshot = snapshotMap[String(position.symbol)] ?? {};
    const greeks = (snapshot.greeks ?? {}) as Record<string, unknown>;
    const quote = (snapshot.latestQuote ?? snapshot.latest_quote ?? {}) as Record<string, unknown>;
    const timestamp = String(quote.t ?? quote.timestamp ?? "");
    const quoteAge = timestamp ? Date.now() - new Date(timestamp).getTime() : Number.POSITIVE_INFINITY;
    const legDelta = finite(greeks.delta);
    const legVega = finite(greeks.vega);
    portfolioGreeksComplete = portfolioGreeksComplete && legDelta !== null && legVega !== null && quoteAge >= 0 && quoteAge <= numberEnv("MAX_DATA_AGE_MS", 120_000);
    oldestQuoteAgeMs = Math.max(oldestQuoteAgeMs, quoteAge);
    const quantity = number(position.qty) * 100;
    delta += quantity * (legDelta ?? 0);
    vega += quantity * (legVega ?? 0);
  });
  const candidateGreeksComplete = [plan.candidate.delta, plan.candidate.vega, plan.shortLeg.delta, plan.shortLeg.vega].every((value) => finite(value) !== null);
  const candidateDelta = ((plan.candidate.delta ?? 0) - (plan.shortLeg.delta ?? 0)) * plan.quantity * 100;
  const candidateVega = ((plan.candidate.vega ?? 0) - (plan.shortLeg.vega ?? 0)) * plan.quantity * 100;
  const proposedDelta = delta + candidateDelta;
  const proposedVega = vega + candidateVega;
  const currentRisk = intents.reduce((total, intent) => total + number(intent.max_loss), 0);
  const proposedRisk = currentRisk + plan.maxLoss * plan.quantity;
  const maxPortfolioRisk = equity * numberEnv("MAX_PORTFOLIO_RISK_PCT", 0.015);
  const sessionMinutes = nyMinutes();
  const inEntryWindow = marketOpen && sessionMinutes >= 9 * 60 + 35 && sessionMinutes < 15 * 60 + 30;
  const duplicateUnderlying = intents.some((intent) => intent.underlying === plan.candidate.underlying);
  const gates: RiskGate[] = [
    { name: "Entry session window", passed: inEntryWindow, detail: inEntryWindow ? "After opening auction and before closing-liquidity window" : "Entry blocked during closed, opening, or late session window" },
    { name: "Competition entry window", passed: competitionEntryAllowed(), detail: competitionEntryAllowed() ? "Enough time remains before forced competition liquidation" : "Competition liquidation buffer has begun" },
    { name: "Portfolio risk budget", passed: proposedRisk <= maxPortfolioRisk, detail: `$${proposedRisk.toFixed(0)} defined loss / $${maxPortfolioRisk.toFixed(0)} portfolio ceiling` },
    { name: "Underlying concentration", passed: !duplicateUnderlying, detail: duplicateUnderlying ? `${plan.candidate.underlying} already has active VolForge exposure` : "No active VolForge exposure on this underlying" },
    { name: "Portfolio Greeks provenance", passed: portfolioGreeksComplete && candidateGreeksComplete, detail: portfolioGreeksComplete && candidateGreeksComplete ? `Every existing and proposed option leg has fresh broker Greeks; oldest quote ${Math.round(oldestQuoteAgeMs / 1000)}s` : "Missing or stale broker Greeks prevent portfolio exposure estimation" },
    { name: "Net delta governor", passed: Math.abs(proposedDelta) <= numberEnv("MAX_NET_DELTA", 250), detail: `${proposedDelta.toFixed(0)} net delta-equivalent / ${numberEnv("MAX_NET_DELTA", 250).toFixed(0)} cap` },
    { name: "Net vega governor", passed: Math.abs(proposedVega) <= numberEnv("MAX_NET_VEGA", 300), detail: `${proposedVega.toFixed(0)} net vega-equivalent / ${numberEnv("MAX_NET_VEGA", 300).toFixed(0)} cap` },
    { name: "Loss-tail governor", passed: plan.valuation.cvar95 >= -plan.maxLoss, detail: `$${plan.valuation.cvar95.toFixed(0)} modeled 5% tail mean / -$${plan.maxLoss.toFixed(0)} defined-loss boundary` },
  ];
  const payload = { existing_delta: delta, proposed_delta: proposedDelta, existing_vega: vega, proposed_vega: proposedVega, current_risk: currentRisk, proposed_risk: proposedRisk, max_portfolio_risk: maxPortfolioRisk, session_minutes: sessionMinutes, active_intents: intents.length, cvar95: plan.valuation.cvar95, gates };
  return { gates, payload, evidenceHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
}
