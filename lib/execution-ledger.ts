import { STRATEGY_VERSION } from "@/lib/constitution";
import type { TradePlan } from "@/lib/reward-engine";

function nyseDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}${value("month")}${value("day")}`;
}

export function executionKey(plan: TradePlan, now = new Date(), decisionTrace = "legacy") {
  return ["vf", "paper", nyseDate(now), STRATEGY_VERSION, plan.candidate.underlying, plan.candidate.optionSymbol, plan.shortLeg.optionSymbol, decisionTrace.slice(0, 12)].join(":");
}

export function intentClientOrderId(traceId: string, leg: "entry" | "exit") {
  return `vf-${leg}-${traceId.slice(0, 8)}-${Date.now().toString(36)}`.slice(0, 48);
}

export function brokerMlegCreditLimit(credit: number) {
  if (!Number.isFinite(credit) || credit <= 0) throw new Error("Multi-leg exit credit must be positive in economic terms.");
  return -Math.round(Math.abs(credit) * 100) / 100;
}

export function economicMlegCredit(value: unknown, fallback = 0) {
  const parsed = Number(value);
  // Alpaca represents multi-leg debits as positive prices and credits as negative.
  // The journal stores the position owner's economics, where received credit is positive.
  if (Number.isFinite(parsed) && parsed !== 0) return -parsed;
  return Math.max(0, Number.isFinite(fallback) ? fallback : 0);
}

export function orderEventKey(orderId: string, eventType: string, timestamp: string, filledQuantity: unknown) {
  return [orderId || "unknown", eventType, timestamp || "untimed", String(filledQuantity ?? "0")].join(":");
}
