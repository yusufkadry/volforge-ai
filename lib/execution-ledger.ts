import type { TradePlan } from "@/lib/reward-engine";

function nyseDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}${value("month")}${value("day")}`;
}

export function executionKey(plan: TradePlan, now = new Date()) {
  return ["vf", "paper", nyseDate(now), plan.candidate.underlying, plan.candidate.optionSymbol, plan.shortLeg.optionSymbol].join(":");
}

export function intentClientOrderId(traceId: string, leg: "entry" | "exit") {
  return `vf-${leg}-${traceId.slice(0, 8)}-${Date.now().toString(36)}`.slice(0, 48);
}
