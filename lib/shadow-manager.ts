import { competitionExitRequired } from "@/lib/competition";
import { CONSTITUTION, STRATEGY_VERSION } from "@/lib/constitution";
import { numberEnv } from "@/lib/env";
import type { TradePlan } from "@/lib/reward-engine";
import { spreadQuotes } from "@/lib/spread-quotes";
import { journal } from "@/lib/supabase";
import type { RiskGate, ShadowPosition } from "@/lib/types";

function nyseDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}${value("month")}${value("day")}`;
}

function holdingDays(position: ShadowPosition) {
  return Math.max(0, Math.floor((Date.now() - new Date(position.created_at ?? Date.now()).getTime()) / 86_400_000));
}

export function shadowAgeMinutes(position: Pick<ShadowPosition, "created_at">, now = new Date()) {
  return Math.max(0, (now.getTime() - new Date(position.created_at ?? now).getTime()) / 60_000);
}

export function shadowEvaluationDue(position: Pick<ShadowPosition, "created_at">, now = new Date()) {
  const windowMinutes = numberEnv("SHADOW_EVALUATION_MINUTES", 90);
  return windowMinutes > 0 && shadowAgeMinutes(position, now) >= windowMinutes;
}

function daysToExpiry(symbol: string) {
  const match = symbol.match(/(\d{6})[CP]/);
  if (!match) return Number.POSITIVE_INFINITY;
  const expiry = new Date(Date.UTC(2000 + Number(match[1].slice(0, 2)), Number(match[1].slice(2, 4)) - 1, Number(match[1].slice(4, 6)), 20));
  return Math.ceil((expiry.getTime() - Date.now()) / 86_400_000);
}

export function shadowExecutionKey(plan: TradePlan, now = new Date()) {
  return ["vf", "shadow", nyseDate(now), STRATEGY_VERSION, plan.candidate.optionSymbol, plan.shortLeg.optionSymbol].join(":");
}

export async function reserveShadowPosition(plan: TradePlan, traceId: string, rationale: string) {
  const [duplicate, active, settings] = await Promise.all([
    journal.activeShadowForUnderlying(plan.candidate.underlying), journal.activeShadowPositions(), journal.settings(),
  ]);
  if (duplicate) return { created: false, reason: `Active shadow exposure already exists on ${duplicate.underlying}.`, position: duplicate };
  if (active.length >= settings.max_open_positions) return { created: false, reason: `Shadow portfolio already holds its ${settings.max_open_positions}-position limit.`, position: null };
  const quotes = await spreadQuotes(plan.candidate.underlying, plan.candidate.optionSymbol, plan.shortLeg.optionSymbol);
  if (!quotes || !quotes.fresh) return { created: false, reason: "Fresh executable spread quote unavailable for shadow reservation.", position: null };
  const entryPrice = quotes.entryNatural;
  if (entryPrice > plan.maxEntryDebit || entryPrice >= plan.width || entryPrice * 100 * plan.quantity > plan.riskBudget) return { created: false, reason: "Live adverse shadow entry exceeded the model-approved debit cap, width, or risk budget.", position: null };
  const currentRisk = active.reduce((total, position) => total + Number(position.max_loss || 0), 0);
  const proposedRisk = currentRisk + entryPrice * 100 * plan.quantity;
  const portfolioCeiling = settings.max_premium_per_trade * settings.max_open_positions;
  if (proposedRisk > portfolioCeiling) return { created: false, reason: `Shadow defined loss would exceed its $${portfolioCeiling.toFixed(0)} portfolio ceiling.`, position: null };
  const position: ShadowPosition = {
    trace_id: traceId,
    strategy_version: STRATEGY_VERSION,
    idempotency_key: shadowExecutionKey(plan),
    symbol: `${plan.candidate.optionSymbol}/${plan.shortLeg.optionSymbol}`,
    underlying: plan.candidate.underlying,
    long_leg: plan.candidate.optionSymbol,
    short_leg: plan.shortLeg.optionSymbol,
    contract_type: plan.candidate.contractType,
    side: "buy",
    entry_price: entryPrice,
    current_price: quotes.closeNatural,
    quantity: plan.quantity,
    max_loss: entryPrice * 100 * plan.quantity,
    max_reward: (plan.width - entryPrice) * 100 * plan.quantity,
    status: "open",
    rationale,
    pnl: (quotes.closeNatural - entryPrice) * 100 * plan.quantity,
    max_adverse_excursion: Math.min(0, (quotes.closeNatural - entryPrice) * 100 * plan.quantity),
    max_favorable_excursion: Math.max(0, (quotes.closeNatural - entryPrice) * 100 * plan.quantity),
    last_mark_at: new Date().toISOString(),
    metadata: {
      alpha_source: plan.alphaSource, alpha_rationale: plan.alphaRationale, model_ev: plan.expectedValue, probability_profit: plan.payoffProbability,
      valuation: plan.valuation, entry_quote: quotes, evaluation_window_minutes: numberEnv("SHADOW_EVALUATION_MINUTES", 90),
      validation_scope: "Adverse-quote execution and short-window directional calibration; not a substitute for the modeled strategy holding horizon.",
    },
  };
  const reservation = await journal.reserveShadow(position);
  return { created: reservation.created, reason: reservation.created ? "Shadow position reserved." : "Identical shadow structure was already reserved today.", position: reservation.position };
}

export async function manageShadowPositions(marketOpen: boolean) {
  const positions = await journal.activeShadowPositions();
  const actions: Array<Record<string, unknown>> = [];
  if (!marketOpen) return actions;
  for (const position of positions) {
    if (!position.id) continue;
    try {
      const quotes = await spreadQuotes(position.underlying, position.long_leg, position.short_leg);
      if (!quotes || !quotes.fresh) {
        actions.push({ position_id: position.id, action: "mark_skipped", reason: "missing_or_stale_quote" });
        continue;
      }
      const pnl = (quotes.closeNatural - position.entry_price) * 100 * position.quantity;
      const returnPct = (quotes.closeNatural - position.entry_price) / position.entry_price;
      const maxAdverse = Math.min(position.max_adverse_excursion ?? 0, pnl);
      const maxFavorable = Math.max(position.max_favorable_excursion ?? 0, pnl);
      let exitReason: string | null = null;
      if (competitionExitRequired()) exitReason = "competition_cutoff";
      else if (returnPct >= CONSTITUTION.trading.takeProfitPct) exitReason = "take_profit";
      else if (returnPct <= -CONSTITUTION.trading.stopLossPct) exitReason = "stop_loss";
      else if (daysToExpiry(position.long_leg) <= 14) exitReason = "dte_exit";
      else if (shadowEvaluationDue(position)) exitReason = "shadow_evaluation_window";
      else if (holdingDays(position) >= CONSTITUTION.trading.maxHoldingDays) exitReason = "time_exit";
      const update: Partial<ShadowPosition> = {
        current_price: quotes.closeNatural,
        pnl,
        max_adverse_excursion: maxAdverse,
        max_favorable_excursion: maxFavorable,
        last_mark_at: new Date().toISOString(),
        metadata: { ...(position.metadata ?? {}), last_quote: quotes },
      };
      await journal.writeShadowMark({ shadow_position_id: position.id, trace_id: position.trace_id, marked_at: new Date().toISOString(), executable_price: quotes.closeNatural, midpoint_price: quotes.closeMid, pnl, quote_age_ms: quotes.quoteAgeMs, feed: quotes.feed, payload: { quotes, return_pct: returnPct, exit_reason: exitReason } });
      if (exitReason) Object.assign(update, { status: "closed", exit_price: quotes.closeNatural, exit_reason: exitReason, closed_at: new Date().toISOString() });
      await journal.updateShadow(position.id, update);
      actions.push({ position_id: position.id, action: exitReason ? "closed" : "marked", exit_reason: exitReason, pnl, price: quotes.closeNatural });
    } catch (error) {
      actions.push({ position_id: position.id, action: "error", error: error instanceof Error ? error.message : "unknown error" });
    }
  }
  return actions;
}

export async function shadowPromotionEvidence() {
  const positions = (await journal.closedShadowPositions()).filter((position) => position.strategy_version === STRATEGY_VERSION);
  const minimum = numberEnv("MIN_SHADOW_CLOSED_TRADES", 3);
  const pnl = positions.reduce((total, position) => total + Number(position.pnl || 0), 0);
  const wins = positions.filter((position) => Number(position.pnl) > 0).length;
  const winRate = positions.length ? wins / positions.length : 0;
  const meanPnl = positions.length ? pnl / positions.length : 0;
  let running = 0;
  let peak = 0;
  let maxDrawdown = 0;
  [...positions].reverse().forEach((position) => {
    running += Number(position.pnl || 0);
    peak = Math.max(peak, running);
    maxDrawdown = Math.min(maxDrawdown, running - peak);
  });
  const gates: RiskGate[] = [
    { name: "Closed shadow sample", passed: positions.length >= minimum, detail: `${positions.length}/${minimum} closed out-of-sample structures` },
    { name: "Shadow expectancy", passed: meanPnl > numberEnv("MIN_SHADOW_MEAN_PNL", 0), detail: `$${meanPnl.toFixed(2)} mean realized shadow P&L` },
    { name: "Shadow total P&L", passed: pnl > 0, detail: `$${pnl.toFixed(2)} total shadow P&L` },
    { name: "Shadow drawdown", passed: maxDrawdown >= -numberEnv("MAX_SHADOW_DRAWDOWN", 500), detail: `$${maxDrawdown.toFixed(2)} maximum sequence drawdown` },
  ];
  return { eligibleForPaper: gates.every((gate) => gate.passed), sampleSize: positions.length, pnl, meanPnl, winRate, maxDrawdown, gates };
}
