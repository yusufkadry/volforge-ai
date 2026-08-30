import { NextResponse } from "next/server";
import { alpaca } from "@/lib/alpaca";
import { journal } from "@/lib/supabase";

export async function POST() {
  try {
    const [positions, orders, settings] = await Promise.all([alpaca.positions(), alpaca.orders("open", 500), journal.settings()]);
    const optionPositions = positions.filter((position) => String(position.asset_class) === "us_option");
    if (optionPositions.length || orders.length) return NextResponse.json({ error: "Cannot re-arm while broker exposure or working orders remain." }, { status: 409 });
    const config = await alpaca.updateAccountConfig({ suspend_trade: false });
    await journal.updateSettings({ ...settings, trading_enabled: false, emergency_stop: false });
    await journal.writeOrderEvent({ event_key: `broker_rearmed:${Date.now()}`, event_type: "broker_rearmed", payload: { config } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Broker re-arm failed" }, { status: 500 });
  }
}
