import { NextResponse } from "next/server";
import { alpaca } from "@/lib/alpaca";
import { journal } from "@/lib/supabase";

export async function POST() {
  try {
    const [config, canceled] = await Promise.all([
      alpaca.updateAccountConfig({ suspend_trade: true }),
      alpaca.cancelAllOrders(),
    ]);
    const settings = await journal.settings();
    await journal.updateSettings({ ...settings, trading_enabled: false, promotion_stage: "research" });
    await journal.writeOrderEvent({ event_type: "hard_kill_activated", payload: { config, canceled_orders: canceled.length } });
    return NextResponse.json({ ok: true, canceled_orders: canceled.length });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Hard kill failed" }, { status: 500 });
  }
}
