import type { TradePlan } from "@/lib/reward-engine";

type Structure = { label: string; payload: Record<string, unknown>; maxLoss: number; maxReward: number; rewardRisk: number };

export function composeStructure(plan: TradePlan, clientOrderId: string): Structure {
  return {
    label: `${plan.candidate.contractType === "call" ? "Call" : "Put"} debit spread`,
    maxLoss: plan.maxLoss * plan.quantity,
    maxReward: plan.maxReward * plan.quantity,
    rewardRisk: plan.rewardRisk,
    payload: {
      order_class: "mleg", qty: String(plan.quantity), type: "limit", time_in_force: "day", limit_price: plan.debit.toFixed(2), client_order_id: clientOrderId,
      legs: [
        { symbol: plan.candidate.optionSymbol, ratio_qty: "1", side: "buy", position_intent: "buy_to_open" },
        { symbol: plan.shortLeg.optionSymbol, ratio_qty: "1", side: "sell", position_intent: "sell_to_open" },
      ],
    },
  };
}
