import { NextResponse } from "next/server";
import { alpaca } from "@/lib/alpaca";
import { advanceEmergencyStop } from "@/lib/emergency";
import { journal } from "@/lib/supabase";

export async function POST() {
  try {
    const settings = await journal.settings();
    await journal.updateSettings({ ...settings, trading_enabled: false, emergency_stop: true });
    // The broker must remain unsuspended long enough to submit risk-reducing closes.
    await alpaca.updateAccountConfig({ suspend_trade: false });
    const canceled = await alpaca.cancelAllOrders();
    const intents = await journal.markEntryCancellations();
    const liquidation = await advanceEmergencyStop();
    await journal.writeOrderEvent({ event_key: `hard_kill:${Date.now()}`, event_type: "hard_kill_activated", payload: { canceled_orders: canceled?.length ?? 0, canceled_entries: intents.length, liquidation } });
    return NextResponse.json({ ok: true, canceled_orders: canceled?.length ?? 0, canceled_entries: intents.length, liquidation });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Hard kill failed" }, { status: 500 });
  }
}
