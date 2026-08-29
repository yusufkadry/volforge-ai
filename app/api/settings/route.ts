import { NextResponse } from "next/server";
import { journal } from "@/lib/supabase";

export async function PATCH(request: Request) {
  const body = await request.json() as { trading_enabled?: boolean; max_premium_per_trade?: number };
  if (typeof body.trading_enabled !== "boolean" || !Number.isFinite(body.max_premium_per_trade) || Number(body.max_premium_per_trade) < 1) {
    return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
  }
  const rows = await journal.updateSettings({ trading_enabled: body.trading_enabled, max_premium_per_trade: Number(body.max_premium_per_trade) });
  return NextResponse.json(rows[0]);
}
