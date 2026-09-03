import { alpaca } from "@/lib/alpaca";
import { managePositions } from "@/lib/position-manager";
import { journal } from "@/lib/supabase";

function positionIntent(value: unknown) {
  return String(value ?? "").toLowerCase();
}

export function isRiskReducingOptionOrder(order: Record<string, unknown>, knownExitOrderIds: Set<string>, knownExitClientOrderIds: Set<string>) {
  const orderId = String(order.id ?? "");
  const clientOrderId = String(order.client_order_id ?? "");
  if ((orderId && knownExitOrderIds.has(orderId)) || (clientOrderId && knownExitClientOrderIds.has(clientOrderId))) return true;
  const directIntent = positionIntent(order.position_intent);
  if (directIntent === "buy_to_close" || directIntent === "sell_to_close") return true;
  const legs = Array.isArray(order.legs) ? order.legs as Array<Record<string, unknown>> : [];
  return legs.length > 0 && legs.every((leg) => {
    const intent = positionIntent(leg.position_intent);
    return intent === "buy_to_close" || intent === "sell_to_close";
  });
}

export async function advanceEmergencyStop() {
  const [positions, orders, intents] = await Promise.all([alpaca.positions(), alpaca.orders("open", 500), journal.activeIntents()]);
  const optionPositions = positions.filter((position) => String(position.asset_class) === "us_option");
  if (optionPositions.length || orders.length) {
    const knownExitOrderIds = new Set(intents.map((intent) => intent.exit_order_id).filter((value): value is string => Boolean(value)));
    const knownExitClientOrderIds = new Set(intents.map((intent) => intent.metadata?.pending_exit_client_order_id).filter((value): value is string => typeof value === "string" && value.length > 0));
    const cancelableOrders = orders.filter((order) => {
      if (String(order.status ?? "").toLowerCase() === "pending_cancel") return false;
      return !optionPositions.length || !isRiskReducingOptionOrder(order, knownExitOrderIds, knownExitClientOrderIds);
    });
    if (cancelableOrders.length) {
      await Promise.all(cancelableOrders.map((order) => {
        const orderId = String(order.id ?? "");
        if (!orderId) throw new Error("Alpaca returned an open order without an ID during emergency liquidation.");
        return alpaca.cancelOrder(orderId);
      }));
    }
    const actions = optionPositions.length ? await managePositions({ emergency: true }) : [];
    return { complete: false, optionPositions: optionPositions.length, workingOrders: orders.length, cancellationRequests: cancelableOrders.length, actions };
  }
  const config = await alpaca.updateAccountConfig({ suspend_trade: true });
  await journal.writeOrderEvent({ event_key: `emergency_complete:${new Date().toISOString().slice(0, 16)}`, event_type: "emergency_liquidation_complete", payload: { config } });
  return { complete: true, optionPositions: 0, workingOrders: 0, actions: [] };
}
