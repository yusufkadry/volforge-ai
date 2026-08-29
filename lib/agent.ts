import { alpaca } from "@/lib/alpaca";
import { calibrate } from "@/lib/calibration";
import { constitutionHash, STRATEGY_VERSION, traceId } from "@/lib/constitution";
import { critic } from "@/lib/critic";
import { numberEnv, universe } from "@/lib/env";
import { executionKey, intentClientOrderId } from "@/lib/execution-ledger";
import { managePositions } from "@/lib/position-manager";
import { conveneCourt } from "@/lib/model-court";
import { governPortfolio } from "@/lib/portfolio-governor";
import { rankTradePlans, rewardPlanFailure } from "@/lib/reward-engine";
import { composeStructure } from "@/lib/structure-composer";
import { runResearch } from "@/lib/research";
import { createRiskSnapshot, portfolioGates } from "@/lib/risk-book";
import { journal } from "@/lib/supabase";
import { riskGates, scanSurface, selectCandidate, thesis } from "@/lib/strategy";
import { assessWorldIntelligence } from "@/lib/world-intelligence";
import type { Decision } from "@/lib/types";

export async function runAgent(source: "scheduled" | "manual" = "scheduled") {
  const trace_id = traceId();
  const [settings, clock, research, account] = await Promise.all([journal.settings(), alpaca.clock(), runResearch(), alpaca.account()]);
  const positionActions = clock.is_open && settings.trading_enabled && settings.promotion_stage === "paper" ? await managePositions() : [];
  const riskSnapshot = await createRiskSnapshot(trace_id, settings);
  const researchBySymbol = new Map(research.forecasts.map((forecast) => [forecast.symbol, forecast]));
  const symbols = universe();
  const scans = await Promise.allSettled(symbols.map(async (symbol) => {
    const forecast = researchBySymbol.get(symbol);
    const executionStage = settings.promotion_stage === "shadow" || settings.promotion_stage === "paper";
    const validated = Boolean(forecast && forecast.validation.mae < forecast.validation.baselineMae && forecast.validation.directionAccuracy >= 0.52);
    if (!forecast || forecast.probabilityUp === 0.5 || (executionStage && !validated)) return [];
    const type: "call" | "put" = forecast.probabilityUp > 0.5 ? "call" : "put";
    return scanSurface(symbol, type);
  }));
  const allCandidates = scans.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  await journal.writeObservations(scans.map((result, index) => {
    const candidates = result.status === "fulfilled" ? result.value : [];
    const leader = selectCandidate(candidates);
    return { trace_id, engine: "Surface", underlying: symbols[index], option_symbol: leader?.optionSymbol ?? null, payload: { contracts_seen: candidates.length, leader, scan_error: result.status === "rejected" ? String(result.reason) : null } };
  }));
  const tradePlan = rankTradePlans(allCandidates, researchBySymbol, Number(account.equity ?? 0), settings.max_premium_per_trade)[0];
  const candidate = tradePlan?.candidate ?? selectCandidate(allCandidates);

  if (!candidate) return write({ source, underlying: "MARKET", option_symbol: null, side: null, score: null, implied_volatility: null, expected_move: null, status: "SCANNED", rationale: "No option snapshots passed the model-directed surface scan.", risk_gates: [], trace_id, strategy_version: STRATEGY_VERSION, raw: { constitution_hash: constitutionHash(), research: research.run.report, position_actions: positionActions, allocation: { status: "unavailable", reason: rewardPlanFailure(allCandidates, researchBySymbol, Number(account.equity ?? 0), settings.max_premium_per_trade) } } });
  const forecast = researchBySymbol.get(candidate.underlying);
  const activeIntent = await journal.activeIntentForUnderlying(candidate.underlying);
  const idempotencyKey = tradePlan ? executionKey(tradePlan) : null;
  const world = await assessWorldIntelligence(candidate);
  const governor = tradePlan ? await governPortfolio(tradePlan, Number(account.equity ?? 0), clock.is_open) : null;
  const calibration = await calibrate();
  const forecastEdge = tradePlan?.forecastEdge ?? (forecast?.forecastRv ?? 0) - candidate.impliedVolatility;
  const gates = riskGates(candidate, clock.is_open, settings.max_premium_per_trade);
  gates.push(...portfolioGates(riskSnapshot));
  gates.push(...(governor?.gates ?? [{ name: "Portfolio governor", passed: false, detail: "No qualifying structure available for portfolio simulation" }]));
  gates.push({ name: "Surface valuation", passed: candidate.anomalyScore <= -numberEnv("MIN_IV_DISCOUNT", 0.03), detail: `${(candidate.anomalyScore * 100).toFixed(1)}% IV discount; minimum ${(numberEnv("MIN_IV_DISCOUNT", 0.03) * 100).toFixed(1)}%` });
  gates.push({ name: "Forecast edge", passed: forecastEdge >= numberEnv("MIN_FORECAST_EDGE", 0.02), detail: `Forecast RV ${((forecast?.forecastRv ?? 0) * 100).toFixed(1)}% vs IV ${(candidate.impliedVolatility * 100).toFixed(1)}%; minimum ${(numberEnv("MIN_FORECAST_EDGE", 0.02) * 100).toFixed(1)}%` });
  gates.push({ name: "Walk-forward validation", passed: Boolean(forecast && forecast.validation.mae < forecast.validation.baselineMae && forecast.validation.directionAccuracy >= 0.52), detail: forecast ? `MAE ${forecast.validation.mae.toFixed(3)} vs baseline ${forecast.validation.baselineMae.toFixed(3)}; direction ${(forecast.validation.directionAccuracy * 100).toFixed(0)}%` : "No validated forecast" });
  gates.push({ name: "Reward-to-risk", passed: Boolean(tradePlan && tradePlan.rewardRisk >= numberEnv("MIN_REWARD_RISK", 1.25)), detail: tradePlan ? `${tradePlan.rewardRisk.toFixed(2)}x maximum reward / maximum loss` : rewardPlanFailure(allCandidates, researchBySymbol, Number(account.equity ?? 0), settings.max_premium_per_trade) });
  gates.push({ name: "Expected value", passed: Boolean(tradePlan && tradePlan.expectedValue >= numberEnv("MIN_EXPECTED_VALUE", 8)), detail: tradePlan ? `$${tradePlan.expectedValue.toFixed(2)} model-weighted payoff estimate per spread` : "No positive expected-value spread" });
  gates.push({ name: "Risk-sized allocation", passed: Boolean(tradePlan && tradePlan.quantity >= 1), detail: tradePlan ? `${tradePlan.quantity} spread${tradePlan.quantity === 1 ? "" : "s"}; $${(tradePlan.maxLoss * tradePlan.quantity).toFixed(2)} maximum loss within $${tradePlan.riskBudget.toFixed(2)} budget` : "No spread fits the risk budget" });
  const multiLegAuthorized = process.env.ENABLE_MULTI_LEG !== "false" && Number(account.options_trading_level ?? 0) >= 3;
  gates.push({ name: "Multi-leg authorization", passed: multiLegAuthorized, detail: multiLegAuthorized ? `Alpaca options level ${String(account.options_trading_level)} supports atomic debit spreads` : "Set ENABLE_MULTI_LEG=true and use an Alpaca paper account with options trading level 3 or higher" });
  gates.push({ name: "Duplicate exposure", passed: !activeIntent, detail: activeIntent ? `Existing ${activeIntent.status} spread on ${activeIntent.underlying}: ${activeIntent.long_leg}/${activeIntent.short_leg}` : "No active VolForge spread on this underlying" });
  gates.push({ name: "World intelligence", passed: world.verdict !== "veto", detail: world.rationale });
  gates.push({ name: "Calibration integrity", passed: calibration.status !== "degraded", detail: `${calibration.status}; ${calibration.sample_size} closed spread${calibration.sample_size === 1 ? "" : "s"}, realized $${calibration.realized_pnl.toFixed(0)} versus predicted $${calibration.predicted_ev.toFixed(0)}` });
  const criticResult = await critic(candidate, tradePlan, world);
  gates.push({ name: "AI critic", passed: criticResult.approve, detail: criticResult.rationale });
  gates.push({ name: "Capital promotion", passed: settings.promotion_stage !== "research", detail: `Current stage: ${settings.promotion_stage}` });
  gates.push({ name: "Kill switch", passed: settings.trading_enabled || settings.promotion_stage === "shadow", detail: settings.trading_enabled ? "Paper trading enabled" : settings.promotion_stage === "shadow" ? "Shadow execution enabled" : "Analysis-only mode" });
  const researchApproved = gates.filter((gate) => gate.name !== "Kill switch" && gate.name !== "Capital promotion").every((gate) => gate.passed);
  const approved = researchApproved && (settings.promotion_stage === "shadow" || (settings.promotion_stage === "paper" && settings.trading_enabled));
  const court = conveneCourt(candidate, forecast, gates, tradePlan, world);
  const decision: Decision = {
    source, underlying: candidate.underlying, option_symbol: candidate.optionSymbol, side: "buy",
    score: candidate.anomalyScore, implied_volatility: candidate.impliedVolatility,
    expected_move: forecast?.forecastRv ?? null, status: approved ? "APPROVED" : "REJECTED",
    rationale: `${thesis(candidate)}${tradePlan ? ` Proposed ${candidate.contractType} debit spread: buy ${candidate.optionSymbol} at $${candidate.ask.toFixed(2)}, sell ${tradePlan.shortLeg.optionSymbol} at $${tradePlan.shortLeg.bid.toFixed(2)}, net debit $${tradePlan.debit.toFixed(2)}. Maximum loss $${tradePlan.maxLoss.toFixed(2)} and maximum reward $${tradePlan.maxReward.toFixed(2)} per spread.` : ""} ${criticResult.rationale}`, risk_gates: gates,
    trace_id, strategy_version: STRATEGY_VERSION, model_score: forecast?.validation.directionAccuracy ?? null,
    data_freshness_ms: candidate.quoteTimestamp ? Math.max(0, Date.now() - new Date(candidate.quoteTimestamp).getTime()) : null,
    raw: {
      constitution_hash: constitutionHash(), evidence_hash: court.evidenceHash, research_trace_id: research.run.trace_id,
      forecast, court: court.opinions, world, portfolio_governor: governor, calibration, risk_snapshot: riskSnapshot, position_actions: positionActions,
      allocation: tradePlan ? {
        status: "ranked", structure: `${candidate.contractType} debit spread`, short_leg: tradePlan.shortLeg.optionSymbol,
        debit: tradePlan.debit, max_loss: tradePlan.maxLoss, max_reward: tradePlan.maxReward, reward_risk: tradePlan.rewardRisk,
        payoff_probability: tradePlan.payoffProbability, expected_value: tradePlan.expectedValue, kelly_fraction: tradePlan.kellyFraction,
        risk_budget: tradePlan.riskBudget, quantity: tradePlan.quantity, allocation_score: tradePlan.allocationScore, idempotency_key: idempotencyKey,
      } : { status: "rejected", reason: rewardPlanFailure(allCandidates, researchBySymbol, Number(account.equity ?? 0), settings.max_premium_per_trade) },
    },
  };

  await journal.writeEngineEvaluations([
    ...court.opinions.map((opinion) => ({ trace_id, engine: opinion.agent, verdict: opinion.vote === "reject" ? "veto" : opinion.vote, confidence: opinion.agent === "Regime" ? Math.min(1, forecast?.validation.directionAccuracy ?? 0) : opinion.agent === "World Intelligence" ? world.confidence : opinion.vote === "approve" ? 0.75 : 0.5, expires_at: opinion.agent === "World Intelligence" ? world.expiresAt : new Date(Date.now() + 5 * 60_000).toISOString(), evidence_hash: court.evidenceHash, payload: { opinion, candidate: candidate.optionSymbol, forecast_edge: forecastEdge } })),
    ...(governor ? [{ trace_id, engine: "Portfolio Governor", verdict: governor.gates.every((gate) => gate.passed) ? "approve" : "veto", confidence: 1, expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), evidence_hash: governor.evidenceHash, payload: governor.payload }] : []),
    { trace_id, engine: "Calibration Engine", verdict: calibration.status === "degraded" ? "veto" : calibration.status === "calibrated" ? "approve" : "abstain", confidence: calibration.sample_size ? Math.min(1, calibration.sample_size / 20) : 0, expires_at: new Date(Date.now() + 4 * 60 * 60_000).toISOString(), evidence_hash: constitutionHash(), payload: calibration },
  ]);

  if (!approved) return write(decision);
  if (settings.promotion_stage === "shadow") {
    if (!tradePlan) return write(decision);
    const markDebit = Math.max(0.01, candidate.bid - tradePlan.shortLeg.ask);
    await journal.createShadow({ trace_id, strategy_version: STRATEGY_VERSION, symbol: `${candidate.optionSymbol}/${tradePlan.shortLeg.optionSymbol}`, underlying: candidate.underlying, side: "buy", entry_price: tradePlan.debit, current_price: markDebit, quantity: tradePlan.quantity, status: "open", rationale: decision.rationale, pnl: (markDebit - tradePlan.debit) * 100 * tradePlan.quantity });
    return write({ ...decision, status: "APPROVED", rationale: `${decision.rationale} Allocated ${tradePlan.quantity} debit spread${tradePlan.quantity === 1 ? "" : "s"}: $${(tradePlan.maxLoss * tradePlan.quantity).toFixed(2)} maximum loss for up to $${(tradePlan.maxReward * tradePlan.quantity).toFixed(2)} reward. Promoted to live shadow portfolio; no broker order submitted.` });
  }
  let reservationId: string | null = null;
  try {
    if (!tradePlan) return write(decision);
    const reservation = await journal.reserveIntent({
      trace_id, strategy_version: STRATEGY_VERSION, idempotency_key: idempotencyKey ?? executionKey(tradePlan), stage: "paper", status: "entry_pending",
      underlying: candidate.underlying, long_leg: candidate.optionSymbol, short_leg: tradePlan.shortLeg.optionSymbol, quantity: tradePlan.quantity,
      entry_debit: tradePlan.debit, max_loss: tradePlan.maxLoss * tradePlan.quantity, max_reward: tradePlan.maxReward * tradePlan.quantity,
      metadata: { allocation_score: tradePlan.allocationScore, reward_risk: tradePlan.rewardRisk, expected_value: tradePlan.expectedValue, payoff_probability: tradePlan.payoffProbability },
    });
    if (!reservation.created || !reservation.intent?.id) return write({ ...decision, status: "REJECTED", rationale: `${decision.rationale} Entry skipped: an execution intent with this idempotency key already exists.` });
    reservationId = reservation.intent.id;
    const clientOrderId = intentClientOrderId(trace_id, "entry");
    const structure = composeStructure(tradePlan, clientOrderId);
    const order = await alpaca.submitOrder(structure.payload);
    await journal.updateIntent(reservationId, { status: "entry_submitted", entry_order_id: String(order.id ?? "") });
    await journal.writeOrderEvent({ trace_id, alpaca_order_id: String(order.id ?? ""), client_order_id: clientOrderId, event_type: "entry_submitted", payload: { candidate, forecast, structure, order } });
    return write({ ...decision, status: "SUBMITTED", rationale: `${decision.rationale} Structure: ${structure.label}; max loss $${structure.maxLoss.toFixed(2)}.`, order_id: String(order.id ?? "") });
  } catch (error) {
    if (reservationId) await journal.updateIntent(reservationId, { status: "error", metadata: { entry_error: error instanceof Error ? error.message : "unknown error" } });
    return write({ ...decision, status: "ERROR", rationale: `${decision.rationale} Order submission failed: ${error instanceof Error ? error.message : "unknown error"}` });
  }
}

async function write(decision: Decision) {
  await journal.writeDecision(decision);
  return decision;
}
