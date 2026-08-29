import { alpaca } from "@/lib/alpaca";
import { critic } from "@/lib/critic";
import { universe } from "@/lib/env";
import { journal } from "@/lib/supabase";
import { riskGates, scanSurface, selectCandidate, thesis } from "@/lib/strategy";
import type { Decision } from "@/lib/types";

export async function runAgent(source: "scheduled" | "manual" = "scheduled") {
  const [settings, clock] = await Promise.all([journal.settings(), alpaca.clock()]);
  const allCandidates = (await Promise.allSettled(universe().map(scanSurface))).flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const candidate = selectCandidate(allCandidates);

  if (!candidate) return write({ source, underlying: "MARKET", option_symbol: null, side: null, score: null, implied_volatility: null, expected_move: null, status: "SCANNED", rationale: "No option snapshots passed surface-normalization requirements.", risk_gates: [] });
  const gates = riskGates(candidate, clock.is_open, settings.max_premium_per_trade);
  const criticResult = await critic(candidate);
  gates.push({ name: "AI critic", passed: criticResult.approve, detail: criticResult.rationale });
  gates.push({ name: "Kill switch", passed: settings.trading_enabled, detail: settings.trading_enabled ? "Paper trading enabled" : "Analysis-only mode" });
  const approved = gates.every((gate) => gate.passed);
  const decision: Decision = {
    source, underlying: candidate.underlying, option_symbol: candidate.optionSymbol, side: "buy",
    score: candidate.anomalyScore, implied_volatility: candidate.impliedVolatility,
    expected_move: null, status: approved ? "APPROVED" : "REJECTED",
    rationale: `${thesis(candidate)} ${criticResult.rationale}`, risk_gates: gates,
  };

  if (!approved) return write(decision);
  try {
    const order = await alpaca.submitOrder({ symbol: candidate.optionSymbol, qty: 1, side: "buy", type: "limit", time_in_force: "day", limit_price: candidate.ask.toFixed(2), position_intent: "buy_to_open" });
    return write({ ...decision, status: "SUBMITTED", order_id: String(order.id ?? "") });
  } catch (error) {
    return write({ ...decision, status: "ERROR", rationale: `${decision.rationale} Order submission failed: ${error instanceof Error ? error.message : "unknown error"}` });
  }
}

async function write(decision: Decision) {
  await journal.writeDecision(decision);
  return decision;
}
