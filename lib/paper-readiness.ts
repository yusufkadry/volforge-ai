import { numberEnv } from "@/lib/env";
import type { CliPreflight, RiskGate, ServiceHeartbeat } from "@/lib/types";

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function enabled(value: unknown) {
  return value === true || String(value).toLowerCase() === "true";
}

export function alpacaAccountId(account: Record<string, unknown>) {
  return String(account.id ?? account.account_number ?? "");
}

export function paperEndpointGate(): RiskGate {
  const configured = process.env.ALPACA_PAPER_BASE_URL?.trim() || "https://paper-api.alpaca.markets";
  let passed = false;
  try {
    const endpoint = new URL(configured);
    const path = endpoint.pathname.replace(/\/$/, "") || "/";
    passed = endpoint.protocol === "https:"
      && endpoint.hostname === "paper-api.alpaca.markets"
      && endpoint.port === ""
      && endpoint.username === ""
      && endpoint.password === ""
      && endpoint.search === ""
      && endpoint.hash === ""
      && (path === "/" || path === "/v2");
  } catch {
    passed = false;
  }
  return {
    name: "Alpaca paper endpoint",
    passed,
    detail: passed ? "REST order authority is pinned to paper-api.alpaca.markets" : "ALPACA_PAPER_BASE_URL is not Alpaca's exact HTTPS paper endpoint",
  };
}

export function executionHeartbeatGate(heartbeat: ServiceHeartbeat | null | undefined, now = Date.now()): RiskGate {
  const age = heartbeat?.last_seen_at ? now - new Date(heartbeat.last_seen_at).getTime() : Number.POSITIVE_INFINITY;
  const passed = heartbeat?.status === "healthy" && age >= 0 && age <= numberEnv("MAX_WORKER_HEARTBEAT_AGE_MS", 120_000);
  return {
    name: "Execution heartbeat",
    passed,
    detail: passed ? `Railway execution control plane healthy; heartbeat ${Math.round(age / 1000)}s old` : "Railway execution control plane is missing, stale, or degraded",
  };
}

export function competitionAccountGate(attestation: Record<string, unknown> | null | undefined, account: Record<string, unknown>): RiskGate {
  const passed = attestation?.eligible_preflight === true && String(attestation.account_id ?? "") === alpacaAccountId(account);
  return {
    name: "Competition account attestation",
    passed,
    detail: passed ? "Eligible $100,000 paper preflight matches the connected Alpaca account" : "Competition-account attestation is missing, ineligible, or belongs to another account",
  };
}

export function cliAccountOracleGate(preflight: CliPreflight | null | undefined, account: Record<string, unknown>, now = Date.now()): RiskGate {
  const age = preflight?.created_at ? now - new Date(preflight.created_at).getTime() : Number.POSITIVE_INFINITY;
  const passed = preflight?.healthy === true && preflight.paper === true && preflight.account_id === alpacaAccountId(account);
  return {
    name: "Alpaca CLI account oracle",
    passed,
    detail: passed
      ? `Pinned CLI verified this paper account ${Number.isFinite(age) && age >= 0 ? `${Math.round(age / 3_600_000)}h ago` : "at an unknown time"}; live REST state is revalidated every cycle`
      : "Pinned Alpaca CLI proof is missing, unhealthy, live-mode, or belongs to another account",
  };
}

export function brokerAccountGates(account: Record<string, unknown>, configuration: Record<string, unknown> | null | undefined, requiredDefinedLoss = 0): RiskGate[] {
  const status = String(account.status ?? "").toUpperCase();
  const optionsLevel = number(account.options_trading_level);
  const configuredOptionsLevel = configuration?.max_options_trading_level === undefined || configuration?.max_options_trading_level === null
    ? optionsLevel
    : number(configuration.max_options_trading_level);
  const optionsBuyingPower = number(account.options_buying_power ?? account.buying_power);
  const blocked = enabled(account.trading_blocked) || enabled(account.account_blocked);
  const suspended = enabled(account.trade_suspended_by_user) || enabled(configuration?.suspend_trade);
  return [
    { name: "Broker account status", passed: status === "ACTIVE", detail: status === "ACTIVE" ? "Alpaca paper account is ACTIVE" : `Alpaca account status is ${status || "unknown"}` },
    { name: "Broker trading permission", passed: !blocked, detail: blocked ? "Alpaca reports the account as trading-blocked" : "Alpaca reports no account-level trading block" },
    { name: "Broker suspension", passed: !suspended, detail: suspended ? "Alpaca suspend_trade is active; re-arm the broker before launch" : "Alpaca order submission is not suspended" },
    { name: "Options Level 3", passed: optionsLevel >= 3 && configuredOptionsLevel >= 3, detail: `Account level ${optionsLevel}, configured maximum ${configuredOptionsLevel}; Level 3 required for atomic spreads` },
    { name: "Options buying power", passed: optionsBuyingPower >= requiredDefinedLoss, detail: `$${optionsBuyingPower.toFixed(0)} available / $${requiredDefinedLoss.toFixed(0)} proposed defined loss` },
  ];
}

export function paperLaunchGates(input: {
  heartbeat: ServiceHeartbeat | null | undefined;
  attestation: Record<string, unknown> | null | undefined;
  cliPreflight: CliPreflight | null | undefined;
  account: Record<string, unknown>;
  accountConfiguration: Record<string, unknown> | null | undefined;
}) {
  return [
    paperEndpointGate(),
    executionHeartbeatGate(input.heartbeat),
    competitionAccountGate(input.attestation, input.account),
    cliAccountOracleGate(input.cliPreflight, input.account),
    ...brokerAccountGates(input.account, input.accountConfiguration),
  ];
}
