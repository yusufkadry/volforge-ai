import { alpaca } from "@/lib/alpaca";
import { competitionExitRequired } from "@/lib/competition";
import { CONSTITUTION } from "@/lib/constitution";
import { numberEnv } from "@/lib/env";
import { brokerMlegCreditLimit, intentClientOrderId } from "@/lib/execution-ledger";
import { AmbiguousOrderSubmissionError, submitOrderRecoverably } from "@/lib/order-submission";
import { spreadQuotes } from "@/lib/spread-quotes";
import { journal } from "@/lib/supabase";
import type { ExecutionIntent } from "@/lib/types";

function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }

export function daysToExpiry(symbol: string) {
  const match = symbol.match(/(\d{6})[CP]/);
  if (!match) return Number.POSITIVE_INFINITY;
  const expiry = new Date(Date.UTC(2000 + Number(match[1].slice(0, 2)), Number(match[1].slice(2, 4)) - 1, Number(match[1].slice(4, 6)), 20));
  return Math.ceil((expiry.getTime() - Date.now()) / 86_400_000);
}

function holdingDays(intent: ExecutionIntent) {
  const openedAt = typeof intent.metadata?.opened_at === "string" ? intent.metadata.opened_at : intent.created_at;
  return Math.max(0, Math.floor((Date.now() - new Date(openedAt ?? Date.now()).getTime()) / 86_400_000));
}

function nextExitPrice(mid: number, natural: number, attempt: number) {
  const fraction = Math.min(1, numberEnv("INITIAL_EXIT_NATURAL_FRACTION", 0.25) + Math.max(0, attempt - 1) * numberEnv("PRICE_LADDER_STEP_FRACTION", 0.25));
  return Math.max(0.01, Math.round((mid - (mid - natural) * fraction) * 100) / 100);
}

export async function submitSpreadExit(intent: ExecutionIntent, quantity: number, reason: string, attempt = 1) {
  if (!intent.id) throw new Error("Cannot submit an exit without an execution-intent ID.");
  const quotes = await spreadQuotes(intent.underlying, intent.long_leg, intent.short_leg);
  if (!quotes || !quotes.fresh) throw new Error("Fresh executable spread quote unavailable for exit.");
  const limitPrice = nextExitPrice(quotes.closeMid, quotes.closeNatural, attempt);
  const brokerLimitPrice = brokerMlegCreditLimit(limitPrice);
  const clientOrderId = intentClientOrderId(intent.trace_id, "exit");
  const exitRequestedAt = new Date().toISOString();
  const pendingMetadata = { ...(intent.metadata ?? {}), pending_exit_client_order_id: clientOrderId, exit_submission_started_at: exitRequestedAt, exit_requested_at: intent.metadata?.exit_requested_at ?? exitRequestedAt, exit_arrival_quote: intent.metadata?.exit_arrival_quote ?? quotes, exit_limit_credit: limitPrice, broker_limit_price: brokerLimitPrice, last_exit_quote: quotes };
  await journal.updateIntent(intent.id, { status: "exit_pending", exit_order_id: null, exit_reason: reason, current_debit: quotes.closeNatural, exit_attempts: attempt, metadata: pendingMetadata });
  const submission = await submitOrderRecoverably({
    order_class: "mleg", qty: quantity, type: "limit", time_in_force: "day", limit_price: brokerLimitPrice.toFixed(2), client_order_id: clientOrderId,
    legs: [
      { symbol: intent.long_leg, ratio_qty: 1, side: "sell", position_intent: "sell_to_close" },
      { symbol: intent.short_leg, ratio_qty: 1, side: "buy", position_intent: "buy_to_close" },
    ],
  }, clientOrderId);
  const order = submission.order;
  const orderId = String(order.id ?? "");
  const event = { trace_id: intent.trace_id, alpaca_order_id: orderId, client_order_id: clientOrderId, event_key: `${orderId}:spread_exit_submitted`, event_type: "spread_exit_submitted", payload: { intent_id: intent.id, reason, close_natural: quotes.closeNatural, close_mid: quotes.closeMid, economic_credit: limitPrice, broker_limit_price: brokerLimitPrice, quantity, attempt, acknowledgement_recovered: submission.recovered } };
  try {
    await journal.updateIntent(intent.id, { status: "exit_submitted", exit_order_id: orderId, exit_reason: reason, current_debit: quotes.closeNatural, exit_attempts: attempt, last_error: null, metadata: { ...pendingMetadata, exit_acknowledged_at: new Date().toISOString(), exit_ack_recovered: submission.recovered, exit_submission_error: submission.submissionError } });
    await journal.writeOrderEvent(event);
  } catch (error) {
    return { ...event, event_type: "spread_exit_ack_persistence_pending", payload: { ...event.payload, error: error instanceof Error ? error.message : "unknown persistence error" } };
  }
  return event;
}

async function closeOrphanLeg(position: Record<string, unknown>) {
  const quantity = Math.abs(number(position.qty));
  const side = number(position.qty) > 0 ? "sell" : "buy";
  const positionIntent = number(position.qty) > 0 ? "sell_to_close" : "buy_to_close";
  const symbol = String(position.symbol ?? "");
  const snapshots = symbol ? await alpaca.optionSnapshots([symbol]) : null;
  const snapshot = snapshots?.snapshots?.[symbol] ?? {};
  const quote = (snapshot.latestQuote ?? snapshot.latest_quote ?? {}) as Record<string, unknown>;
  const limit = side === "sell" ? number(quote.bp ?? quote.bid_price) : number(quote.ap ?? quote.ask_price);
  if (!symbol || quantity <= 0 || limit <= 0) throw new Error(`Cannot price orphan option leg ${symbol || "unknown"}.`);
  return alpaca.submitOrder({ symbol, qty: quantity, side, type: "limit", time_in_force: "day", limit_price: limit.toFixed(2), position_intent: positionIntent, client_order_id: `vf-orphan-${Date.now().toString(36)}`.slice(0, 48), extended_hours: false });
}

export async function managePositions(options: { emergency?: boolean } = {}) {
  const [positions, intents] = await Promise.all([alpaca.positions(), journal.activeIntents()]);
  const optionPositions = positions.filter((position) => String(position.asset_class) === "us_option");
  const bySymbol = new Map(optionPositions.map((position) => [String(position.symbol), position]));
  const trackedSymbols = new Set(intents.flatMap((intent) => [intent.long_leg, intent.short_leg]));
  const actions: Array<Record<string, unknown>> = [];

  for (const intent of intents) {
    if (!intent.id || ["entry_pending", "entry_submitted", "entry_partial", "entry_cancel_pending", "exit_pending", "exit_submitted", "exit_partial", "exit_cancel_pending"].includes(intent.status)) continue;
    const long = bySymbol.get(intent.long_leg);
    const short = bySymbol.get(intent.short_leg);
    if (!long && !short) continue;
    if (!long || !short || number(long.qty) <= 0 || number(short.qty) >= 0) {
      await journal.updateIntent(intent.id, { status: "reconciliation_error", last_error: "Broker legs do not match the reserved vertical." });
      const event = { trace_id: intent.trace_id, alpaca_order_id: intent.entry_order_id ?? "", event_key: `${intent.id}:spread_leg_mismatch:${Date.now()}`, event_type: "spread_leg_mismatch", payload: { intent_id: intent.id, long_present: Boolean(long), short_present: Boolean(short), long_qty: long?.qty, short_qty: short?.qty } };
      await journal.writeOrderEvent(event);
      actions.push(event);
      continue;
    }
    const quantity = Math.min(Math.abs(number(long.qty)), Math.abs(number(short.qty)), intent.quantity);
    const quotes = await spreadQuotes(intent.underlying, intent.long_leg, intent.short_leg);
    if (!quotes || !quotes.fresh || quantity <= 0) {
      actions.push({ event_type: "spread_mark_skipped", payload: { intent_id: intent.id, reason: "missing_or_stale_executable_quote" } });
      continue;
    }
    await journal.updateIntent(intent.id, { status: "open", current_debit: quotes.closeNatural, last_reconciled_at: new Date().toISOString() });
    const returnPct = (quotes.closeNatural - intent.entry_debit) / intent.entry_debit;
    const dte = daysToExpiry(intent.long_leg);
    let reason: string | null = null;
    if (options.emergency) reason = "emergency_stop";
    else if (competitionExitRequired()) reason = "competition_cutoff";
    else if (returnPct >= CONSTITUTION.trading.takeProfitPct) reason = "take_profit";
    else if (returnPct <= -CONSTITUTION.trading.stopLossPct) reason = "stop_loss";
    else if (dte <= 14) reason = "dte_exit";
    else if (holdingDays(intent) >= CONSTITUTION.trading.maxHoldingDays) reason = "time_exit";
    if (!reason) continue;
    try {
      actions.push(await submitSpreadExit(intent, quantity, reason, (intent.exit_attempts ?? 0) + 1));
    } catch (error) {
      if (error instanceof AmbiguousOrderSubmissionError) {
        await journal.updateIntent(intent.id, { status: "exit_pending", last_error: error.message });
        actions.push({ event_type: "spread_exit_ack_pending", payload: { intent_id: intent.id, reason, client_order_id: error.clientOrderId, error: error.message } });
        continue;
      }
      await journal.updateIntent(intent.id, { status: "open", last_error: error instanceof Error ? error.message : "unknown exit error" });
      actions.push({ event_type: "spread_exit_error", payload: { intent_id: intent.id, reason, error: error instanceof Error ? error.message : "unknown error" } });
    }
  }

  if (options.emergency) {
    for (const position of optionPositions.filter((item) => !trackedSymbols.has(String(item.symbol)))) {
      try {
        const order = await closeOrphanLeg(position);
        const event = { alpaca_order_id: String(order.id ?? ""), event_key: `${String(order.id ?? "")}:orphan_close_submitted`, event_type: "orphan_close_submitted", payload: { symbol: position.symbol, qty: position.qty } };
        await journal.writeOrderEvent(event);
        actions.push(event);
      } catch (error) {
        actions.push({ event_type: "orphan_close_error", payload: { symbol: position.symbol, error: error instanceof Error ? error.message : "unknown error" } });
      }
    }
  }
  return actions;
}
