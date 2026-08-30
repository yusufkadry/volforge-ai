import { alpaca } from "@/lib/alpaca";
import { managePositions } from "@/lib/position-manager";
import { journal } from "@/lib/supabase";

export async function advanceEmergencyStop() {
  const [positions, orders] = await Promise.all([alpaca.positions(), alpaca.orders("open", 500)]);
  const optionPositions = positions.filter((position) => String(position.asset_class) === "us_option");
  if (optionPositions.length || orders.length) {
    const cancellations = orders.length ? await alpaca.cancelAllOrders() : [];
    const actions = await managePositions({ emergency: true });
    return { complete: false, optionPositions: optionPositions.length, workingOrders: orders.length, cancellationRequests: cancellations?.length ?? 0, actions };
  }
  const config = await alpaca.updateAccountConfig({ suspend_trade: true });
  await journal.writeOrderEvent({ event_key: `emergency_complete:${new Date().toISOString().slice(0, 16)}`, event_type: "emergency_liquidation_complete", payload: { config } });
  return { complete: true, optionPositions: 0, workingOrders: 0, actions: [] };
}
