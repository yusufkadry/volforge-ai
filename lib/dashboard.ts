import { alpaca } from "@/lib/alpaca";
import { selectResearchRun } from "@/lib/research";
import { journal } from "@/lib/supabase";
import type { DashboardSnapshot } from "@/lib/types";

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const settled = await Promise.allSettled([
    alpaca.account(), alpaca.positions(), alpaca.orders(), alpaca.portfolioHistory(), alpaca.clock(),
    journal.decisions(), journal.decisionCount(), journal.submittedDecisionCount(), journal.latestMarketDecision(), journal.latestResearchDecision(),
    journal.settings(), journal.research(), journal.shadowPositions(), journal.latestRiskSnapshot(), journal.intents(), journal.latestCalibration(), journal.latestHeartbeat("execution-control-plane"), journal.latestCliPreflight(), journal.latestControlRequest(), journal.latestAccountAttestation(),
  ]);
  const [account, positions, orders, portfolioHistory, clock, decisions, decisionTotal, submittedDecisionTotal, latestMarketDecision, latestResearchDecision, settings, research, shadowPositions, riskSnapshot, intents, calibration, executionHeartbeat, cliPreflight, latestControlRequest, accountAttestation] = settled.map((result) => result.status === "fulfilled" ? result.value : null);
  const errors = settled.flatMap((result) => result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : "Unknown service error"] : []);
  const resolvedSettings = (settings ?? { trading_enabled: false, emergency_stop: false, max_premium_per_trade: 500, max_daily_loss: 1000, max_open_positions: 3, promotion_stage: "research" }) as DashboardSnapshot["settings"];
  const resolvedResearch = (research ?? []) as DashboardSnapshot["research"];
  const activeResearch = selectResearchRun(resolvedResearch, resolvedSettings.promotion_stage !== "research").selected;
  return {
    account: account as DashboardSnapshot["account"],
    positions: (positions ?? []) as DashboardSnapshot["positions"],
    orders: (orders ?? []) as DashboardSnapshot["orders"],
    decisions: (decisions ?? []) as DashboardSnapshot["decisions"],
    decisionTotal: Number(decisionTotal ?? 0),
    submittedDecisionTotal: Number(submittedDecisionTotal ?? 0),
    latestMarketDecision: latestMarketDecision as DashboardSnapshot["latestMarketDecision"],
    latestResearchDecision: latestResearchDecision as DashboardSnapshot["latestResearchDecision"],
    settings: resolvedSettings,
    research: resolvedResearch,
    activeResearchTraceId: activeResearch?.trace_id ?? null,
    shadowPositions: (shadowPositions ?? []) as DashboardSnapshot["shadowPositions"],
    riskSnapshot: riskSnapshot as DashboardSnapshot["riskSnapshot"],
    intents: (intents ?? []) as DashboardSnapshot["intents"],
    calibration: calibration as DashboardSnapshot["calibration"],
    executionHeartbeat: executionHeartbeat as DashboardSnapshot["executionHeartbeat"],
    cliPreflight: cliPreflight as DashboardSnapshot["cliPreflight"],
    latestControlRequest: latestControlRequest as DashboardSnapshot["latestControlRequest"],
    accountAttestation: accountAttestation as DashboardSnapshot["accountAttestation"],
    portfolioHistory: portfolioHistory as DashboardSnapshot["portfolioHistory"],
    marketOpen: Boolean((clock as { is_open?: boolean } | null)?.is_open),
    nextOpen: (clock as { next_open?: string } | null)?.next_open ?? null,
    errors,
  };
}
