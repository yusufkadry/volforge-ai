import { alpaca } from "@/lib/alpaca";
import { CONSTITUTION } from "@/lib/constitution";
import { journal } from "@/lib/supabase";

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

export async function managePositions() {
  const positions = await alpaca.positions();
  const actions: Array<Record<string, unknown>> = [];
  for (const position of positions) {
    if (String(position.asset_class) !== "us_option") continue;
    const entry = number(position.avg_entry_price);
    const current = number(position.current_price);
    if (entry <= 0 || current <= 0) {
      actions.push({ event_type: "exit_skipped", payload: { symbol: position.symbol, reason: "missing_live_price" } });
      continue;
    }
    const returnPct = entry > 0 ? (current - entry) / entry : 0;
    const qty = Math.abs(number(position.qty));
    const dte = daysToExpiry(String(position.symbol));
    let reason: string | null = null;
    if (returnPct >= CONSTITUTION.trading.takeProfitPct) reason = "take_profit";
    if (returnPct <= -CONSTITUTION.trading.stopLossPct) reason = "stop_loss";
    if (dte <= 14) reason = "dte_exit";
    if (!reason || qty <= 0) continue;
    try {
      const order = await alpaca.submitOrder({ symbol: position.symbol, qty, side: "sell", type: "limit", time_in_force: "day", limit_price: current.toFixed(2), position_intent: "sell_to_close", client_order_id: `vf-exit-${String(position.symbol).slice(-12)}-${Date.now()}` });
      const event = { alpaca_order_id: String(order.id ?? ""), client_order_id: String(order.client_order_id ?? ""), event_type: "exit_submitted", payload: { reason, symbol: position.symbol, return_pct: returnPct } };
      await journal.writeOrderEvent(event);
      actions.push(event);
    } catch (error) {
      actions.push({ event_type: "exit_error", payload: { symbol: position.symbol, reason, error: error instanceof Error ? error.message : "unknown error" } });
    }
  }
  return actions;
}
