import { NextResponse } from "next/server";
import { alpaca } from "@/lib/alpaca";
import { numberEnv } from "@/lib/env";
import { shadowPromotionEvidence } from "@/lib/shadow-manager";
import { journal } from "@/lib/supabase";

export async function PATCH(request: Request) {
  const body = await request.json() as { trading_enabled?: boolean; max_premium_per_trade?: number; max_daily_loss?: number; max_open_positions?: number; promotion_stage?: "research" | "shadow" | "paper" };
  const current = await journal.settings();
  const next = { ...current, ...body };
  if (typeof next.trading_enabled !== "boolean" || !Number.isFinite(next.max_premium_per_trade) || Number(next.max_premium_per_trade) < 1 || Number(next.max_premium_per_trade) > 10_000 || !Number.isFinite(next.max_daily_loss) || Number(next.max_daily_loss) < 1 || Number(next.max_daily_loss) > 25_000 || !Number.isInteger(next.max_open_positions) || next.max_open_positions < 1 || next.max_open_positions > 10 || !["research", "shadow", "paper"].includes(next.promotion_stage)) {
    return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
  }
  if (current.emergency_stop && (next.trading_enabled || next.promotion_stage !== current.promotion_stage)) return NextResponse.json({ error: "Emergency liquidation must finish and the broker must be re-armed before changing capital settings." }, { status: 409 });
  if (next.promotion_stage === "shadow" && current.promotion_stage === "research") {
    const research = await journal.latestResearch();
    if (!research || research.promotion_recommendation !== "shadow") return NextResponse.json({ error: "Latest purged research validation has not approved shadow promotion." }, { status: 409 });
  }
  const promotingToPaper = next.promotion_stage === "paper" && current.promotion_stage !== "paper";
  const armingEntries = next.trading_enabled && !current.trading_enabled;
  if (promotingToPaper || armingEntries) {
    const [evidence, heartbeat, attestation, cliPreflight, account] = await Promise.all([
      shadowPromotionEvidence(), journal.latestHeartbeat("execution-control-plane"), journal.latestAccountAttestation(), journal.latestCliPreflight(), alpaca.account(),
    ]);
    if (!evidence.eligibleForPaper) return NextResponse.json({ error: `Paper promotion blocked: ${evidence.gates.filter((gate) => !gate.passed).map((gate) => gate.detail).join("; ")}` }, { status: 409 });
    const age = heartbeat?.last_seen_at ? Date.now() - new Date(heartbeat.last_seen_at).getTime() : Number.POSITIVE_INFINITY;
    if (heartbeat?.status !== "healthy" || age > numberEnv("MAX_WORKER_HEARTBEAT_AGE_MS", 120_000)) return NextResponse.json({ error: "Paper promotion blocked: Railway execution heartbeat is missing or stale." }, { status: 409 });
    const accountId = String(account.id ?? account.account_number ?? "");
    if (attestation?.eligible_preflight !== true || String(attestation.account_id ?? "") !== accountId) return NextResponse.json({ error: "Paper promotion blocked: the eligible fresh-account attestation does not match the connected Alpaca account." }, { status: 409 });
    const cliAge = cliPreflight?.created_at ? Date.now() - new Date(cliPreflight.created_at).getTime() : Number.POSITIVE_INFINITY;
    if (cliPreflight?.healthy !== true || cliPreflight.paper !== true || cliPreflight.account_id !== accountId || cliAge > numberEnv("MAX_CLI_PREFLIGHT_AGE_MS", 45 * 60_000)) return NextResponse.json({ error: "Paper promotion blocked: the pinned Alpaca CLI preflight is missing, stale, unhealthy, or belongs to another account." }, { status: 409 });
  }
  if (next.promotion_stage !== "paper") next.trading_enabled = false;
  const rows = await journal.updateSettings(next);
  return NextResponse.json(rows[0]);
}
