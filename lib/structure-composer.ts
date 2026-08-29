import type { Candidate } from "@/lib/types";

type Structure = { label: string; payload: Record<string, unknown>; maxLoss: number };

export function composeStructure(candidate: Candidate, candidates: Candidate[], optionsLevel: number, clientOrderId: string): Structure {
  const multiLegEnabled = process.env.ENABLE_MULTI_LEG === "true";
  const shortLeg = candidates.find((other) => other.underlying === candidate.underlying && other.contractType === candidate.contractType && other.expirationDate === candidate.expirationDate && other.optionSymbol !== candidate.optionSymbol && (candidate.contractType === "call" ? other.strike > candidate.strike : other.strike < candidate.strike) && other.bid > 0);
  if (multiLegEnabled && optionsLevel >= 3 && shortLeg) {
    const debit = Math.max(0.01, candidate.ask - shortLeg.bid);
    return {
      label: `${candidate.contractType === "call" ? "Call" : "Put"} debit spread`,
      maxLoss: debit * 100,
      payload: {
        order_class: "mleg", qty: 1, type: "limit", time_in_force: "day", limit_price: debit.toFixed(2), client_order_id: clientOrderId,
        legs: [
          { symbol: candidate.optionSymbol, ratio_qty: 1, side: "buy", position_intent: "buy_to_open" },
          { symbol: shortLeg.optionSymbol, ratio_qty: 1, side: "sell", position_intent: "sell_to_open" },
        ],
      },
    };
  }
  return {
    label: `Long ${candidate.contractType}`,
    maxLoss: candidate.ask * 100,
    payload: { symbol: candidate.optionSymbol, qty: 1, side: "buy", type: "limit", time_in_force: "day", limit_price: candidate.ask.toFixed(2), position_intent: "buy_to_open", client_order_id: clientOrderId },
  };
}
