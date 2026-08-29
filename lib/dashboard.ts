import { alpaca } from "@/lib/alpaca";
import { journal } from "@/lib/supabase";
import type { DashboardSnapshot } from "@/lib/types";

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const settled = await Promise.allSettled([
    alpaca.account(), alpaca.positions(), alpaca.orders(), alpaca.clock(), journal.decisions(), journal.settings(),
  ]);
  const [account, positions, orders, clock, decisions, settings] = settled.map((result) => result.status === "fulfilled" ? result.value : null);
  const errors = settled.flatMap((result) => result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : "Unknown service error"] : []);
  return {
    account: account as DashboardSnapshot["account"],
    positions: (positions ?? []) as DashboardSnapshot["positions"],
    orders: (orders ?? []) as DashboardSnapshot["orders"],
    decisions: (decisions ?? []) as DashboardSnapshot["decisions"],
    settings: (settings ?? { trading_enabled: false, max_premium_per_trade: 500 }) as DashboardSnapshot["settings"],
    marketOpen: Boolean((clock as { is_open?: boolean } | null)?.is_open),
    nextOpen: (clock as { next_open?: string } | null)?.next_open ?? null,
    errors,
  };
}
