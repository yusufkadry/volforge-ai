import { NextResponse } from "next/server";
import { alpaca } from "@/lib/alpaca";
import { constitutionHash, STRATEGY_VERSION, traceId } from "@/lib/constitution";
import { paperLaunchGates } from "@/lib/paper-readiness";
import { selectResearchRun } from "@/lib/research";
import { shadowPromotionEvidence } from "@/lib/shadow-manager";
import { journal } from "@/lib/supabase";
import type { AgentSettings, Decision, RiskGate } from "@/lib/types";

type SettingsPatch = Partial<Pick<AgentSettings, "trading_enabled" | "max_premium_per_trade" | "max_daily_loss" | "max_open_positions" | "promotion_stage">> & {
  paper_bootstrap_confirmed?: boolean;
};

function valid(settings: AgentSettings) {
  return typeof settings.trading_enabled === "boolean"
    && Number.isFinite(settings.max_premium_per_trade) && Number(settings.max_premium_per_trade) >= 1 && Number(settings.max_premium_per_trade) <= 10_000
    && Number.isFinite(settings.max_daily_loss) && Number(settings.max_daily_loss) >= 1 && Number(settings.max_daily_loss) <= 25_000
    && Number.isInteger(settings.max_open_positions) && settings.max_open_positions >= 1 && settings.max_open_positions <= 10
    && ["research", "shadow", "paper"].includes(settings.promotion_stage);
}

async function patchSettings(request: Request) {
  const patch = await request.json() as SettingsPatch;
  const current = await journal.settings();
  const next: AgentSettings = {
    ...current,
    ...(typeof patch.trading_enabled === "boolean" ? { trading_enabled: patch.trading_enabled } : {}),
    ...(typeof patch.max_premium_per_trade === "number" ? { max_premium_per_trade: patch.max_premium_per_trade } : {}),
    ...(typeof patch.max_daily_loss === "number" ? { max_daily_loss: patch.max_daily_loss } : {}),
    ...(typeof patch.max_open_positions === "number" ? { max_open_positions: patch.max_open_positions } : {}),
    ...(patch.promotion_stage ? { promotion_stage: patch.promotion_stage } : {}),
  };
  if (!valid(next)) return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
  if (current.emergency_stop && (next.trading_enabled || next.promotion_stage !== current.promotion_stage)) return NextResponse.json({ error: "Emergency liquidation must finish and the broker must be re-armed before changing capital settings." }, { status: 409 });

  if (next.promotion_stage === "shadow" && current.promotion_stage === "research") {
    const selection = selectResearchRun(await journal.research(), true);
    if (!selection.champion) return NextResponse.json({ error: "No fresh, current-strategy research champion has approved shadow promotion." }, { status: 409 });
  }

  const promotingToPaper = next.promotion_stage === "paper" && current.promotion_stage !== "paper";
  const armingEntries = next.promotion_stage === "paper" && next.trading_enabled && !current.trading_enabled;
  let bootstrapDecision: Decision | null = null;
  if (promotingToPaper || armingEntries) {
    const [evidence, heartbeat, attestation, cliPreflight, account, accountConfiguration] = await Promise.all([
      shadowPromotionEvidence(), journal.latestHeartbeat("execution-control-plane"), journal.latestAccountAttestation(), journal.latestCliPreflight(), alpaca.account(), alpaca.accountConfig(),
    ]);
    const bootstrapRequested = promotingToPaper && current.promotion_stage !== "paper" && patch.paper_bootstrap_confirmed === true;
    const shadowAuthorized = evidence.eligibleForPaper || current.promotion_stage === "paper" || bootstrapRequested;
    const shadowGate: RiskGate = {
      name: "Paper-stage authorization",
      passed: shadowAuthorized,
      detail: evidence.eligibleForPaper
        ? `${evidence.sampleSize} closed shadow structures passed promotion policy`
        : current.promotion_stage === "paper"
          ? "Paper stage was already explicitly authorized"
          : bootstrapRequested
            ? `Operator explicitly authorized a time-boxed Paper launch with ${evidence.sampleSize} closed shadow structures; no trade-level gate is bypassed`
            : "Closed Shadow evidence is ineligible; explicit Paper launch confirmation is required",
    };
    const launchGates = [shadowGate, ...paperLaunchGates({ heartbeat, attestation, cliPreflight, account, accountConfiguration })];
    const failed = launchGates.filter((gate) => !gate.passed);
    if (failed.length) return NextResponse.json({ error: `Paper launch blocked: ${failed.map((gate) => gate.detail).join("; ")}` }, { status: 409 });

    if (bootstrapRequested && !evidence.eligibleForPaper) {
      bootstrapDecision = {
        source: "paper_launch_authorization", underlying: "ACCOUNT", option_symbol: null, side: null, score: null, implied_volatility: null, expected_move: null,
        status: "APPROVED", rationale: `Authenticated operator authorized the compressed competition Paper stage from ${current.promotion_stage} without claiming fabricated Shadow evidence. Every live market, liquidity, model, payoff, account, portfolio, and execution gate remains mandatory for each order.`,
        risk_gates: launchGates, trace_id: traceId(), strategy_version: STRATEGY_VERSION,
        raw: { constitution_hash: constitutionHash(), previous_stage: current.promotion_stage, shadow_evidence: evidence, authorization: "explicit_operator_paper_bootstrap", account_id: String(account.id ?? account.account_number ?? "") },
      };
    }
  }

  if (next.promotion_stage !== "paper") next.trading_enabled = false;
  const rows = await journal.updateSettings(next);
  if (bootstrapDecision) {
    try { await journal.writeDecision(bootstrapDecision); }
    catch (error) {
      await journal.updateSettings(current).catch(() => []);
      throw new Error(`Paper launch audit could not be persisted; settings were rolled back. ${error instanceof Error ? error.message : "unknown audit error"}`);
    }
  }
  return NextResponse.json(rows[0]);
}

export async function PATCH(request: Request) {
  try {
    return await patchSettings(request);
  } catch (error) {
    return NextResponse.json({ error: `Settings preflight failed: ${error instanceof Error ? error.message : "unknown control-plane error"}` }, { status: 502 });
  }
}
