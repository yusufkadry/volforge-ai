import { alpaca } from "@/lib/alpaca";
import { CONSTITUTION } from "@/lib/constitution";
import { intentClientOrderId } from "@/lib/execution-ledger";
import { journal } from "@/lib/supabase";
import type { ExecutionIntent } from "@/lib/types";

function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }

function daysToExpiry(symbol: string) {
  const match = symbol.match(/(\d{6})[CP]/);
  if (!match) return Number.POSITIVE_INFINITY;
  const year = Number(match[1].slice(0, 2));
  const month = Number(match[1].slice(2, 4));
  const day = Number(match[1].slice(4, 6));
  const expiry = new Date(Date.UTC(2000 + year, month - 1, day, 20));
  return Math.ceil((expiry.getTime() - Date.now()) / 86_400_000);
}

function holdingDays(intent: ExecutionIntent) {
  return Math.max(0, Math.floor((Date.now() - new Date(intent.created_at ?? Date.now()).getTime()) / 86_400_000));
}

function quote(snapshot: Record<string, unknown> | undefined) {
  const latest = (snapshot?.latestQuote ?? snapshot?.latest_quote ?? {}) as Record<string, unknown>;
  return { bid: number(latest.bp ?? latest.bid_price), ask: number(latest.ap ?? latest.ask_price) };
}

async function spreadMark(intent: ExecutionIntent) {
  const response = await alpaca.snapshots(intent.underlying);
  const snapshots = response.snapshots ?? {};
  const long = quote(snapshots[intent.long_leg]);
  const short = quote(snapshots[intent.short_leg]);
  if (long.bid <= 0 || short.ask <= 0) return null;
  return Math.max(0.01, long.bid - short.ask);
}

export async function managePositions() {
  const [positions, intents] = await Promise.all([alpaca.positions(), journal.activeIntents()]);
  const bySymbol = new Map(positions.filter((position) => String(position.asset_class) === "us_option").map((position) => [String(position.symbol), position]));
  const actions: Array<Record<string, unknown>> = [];

  for (const intent of intents) {
    if (intent.status === "exit_submitted") continue;
    const long = bySymbol.get(intent.long_leg);
    const short = bySymbol.get(intent.short_leg);
    if (!long && !short) continue;
    if (!long || !short || number(long.qty) <= 0 || number(short.qty) >= 0) {
      const event = { trace_id: intent.trace_id, alpaca_order_id: intent.entry_order_id ?? "", event_type: "spread_leg_mismatch", payload: { intent_id: intent.id, long_present: Boolean(long), short_present: Boolean(short), long_qty: long?.qty, short_qty: short?.qty } };
      await journal.writeOrderEvent(event);
      actions.push(event);
      continue;
    }

    const quantity = Math.min(Math.abs(number(long.qty)), Math.abs(number(short.qty)), intent.quantity);
    const mark = await spreadMark(intent);
    if (!mark || quantity <= 0) {
      actions.push({ event_type: "spread_mark_skipped", payload: { intent_id: intent.id, reason: "missing_executable_spread_quote" } });
      continue;
    }
    if (intent.status === "entry_pending" || intent.status === "entry_submitted") await journal.updateIntent(String(intent.id), { status: "open", current_debit: mark });
    else await journal.updateIntent(String(intent.id), { current_debit: mark });

    const returnPct = (mark - intent.entry_debit) / intent.entry_debit;
    const dte = daysToExpiry(intent.long_leg);
    let reason: string | null = null;
    if (returnPct >= CONSTITUTION.trading.takeProfitPct) reason = "take_profit";
    else if (returnPct <= -CONSTITUTION.trading.stopLossPct) reason = "stop_loss";
    else if (dte <= 14) reason = "dte_exit";
    else if (holdingDays(intent) >= CONSTITUTION.trading.maxHoldingDays) reason = "time_exit";
    if (!reason) continue;

    const clientOrderId = intentClientOrderId(intent.trace_id, "exit");
    try {
      const order = await alpaca.submitOrder({
        order_class: "mleg", qty: quantity, type: "limit", time_in_force: "day", limit_price: mark.toFixed(2), client_order_id: clientOrderId,
        legs: [
          { symbol: intent.long_leg, ratio_qty: 1, side: "sell", position_intent: "sell_to_close" },
          { symbol: intent.short_leg, ratio_qty: 1, side: "buy", position_intent: "buy_to_close" },
        ],
      });
      const orderId = String(order.id ?? "");
      await journal.updateIntent(String(intent.id), { status: "exit_submitted", exit_order_id: orderId, exit_reason: reason, current_debit: mark });
      const event = { trace_id: intent.trace_id, alpaca_order_id: orderId, client_order_id: clientOrderId, event_type: "spread_exit_submitted", payload: { intent_id: intent.id, reason, close_debit: mark, return_pct: returnPct, dte, quantity } };
      await journal.writeOrderEvent(event);
      actions.push(event);
    } catch (error) {
      const event = { trace_id: intent.trace_id, alpaca_order_id: intent.entry_order_id ?? "", event_type: "spread_exit_error", payload: { intent_id: intent.id, reason, error: error instanceof Error ? error.message : "unknown error" } };
      await journal.writeOrderEvent(event);
      actions.push(event);
    }
  }
  return actions;
}
