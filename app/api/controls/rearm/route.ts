import { NextResponse } from "next/server";
import { alpaca } from "@/lib/alpaca";
import { journal } from "@/lib/supabase";

export async function POST() {
  try {
    const config = await alpaca.updateAccountConfig({ suspend_trade: false });
    await journal.writeOrderEvent({ event_type: "broker_rearmed", payload: { config } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Broker re-arm failed" }, { status: 500 });
  }
}
