import { NextResponse } from "next/server";
import { journal } from "@/lib/supabase";

export async function PATCH(request: Request) {
  const body = await request.json() as { trading_enabled?: boolean; max_premium_per_trade?: number; max_daily_loss?: number; max_open_positions?: number; promotion_stage?: "research" | "shadow" | "paper" };
  const current = await journal.settings();
  const next = { ...current, ...body };
  if (typeof next.trading_enabled !== "boolean" || !Number.isFinite(next.max_premium_per_trade) || Number(next.max_premium_per_trade) < 1 || !Number.isFinite(next.max_daily_loss) || !Number.isInteger(next.max_open_positions) || !["research", "shadow", "paper"].includes(next.promotion_stage)) {
    return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
  }
  const rows = await journal.updateSettings(next);
  return NextResponse.json(rows[0]);
}
