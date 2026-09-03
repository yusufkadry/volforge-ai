import { createHash } from "crypto";
import { alpaca } from "../lib/alpaca";
import { paperEndpointGate } from "../lib/paper-readiness";
import { journal } from "../lib/supabase";

function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }

Promise.all([alpaca.account(), alpaca.positions(), alpaca.orders("all", 500)])
  .then(async ([account, positions, orders]) => {
    const accountId = String(account.id ?? account.account_number ?? "");
    const equity = number(account.equity);
    const optionsLevel = number(account.options_trading_level);
    const gates = [
      paperEndpointGate(),
      { name: "$100,000 starting balance", passed: Math.abs(equity - 100_000) < 0.01, detail: `$${equity.toFixed(2)} observed equity` },
      { name: "No prior positions", passed: positions.length === 0, detail: `${positions.length} broker positions` },
      { name: "No prior orders", passed: orders.length === 0, detail: `${orders.length} historical orders returned` },
      { name: "Options Level 3", passed: optionsLevel >= 3, detail: `Options level ${optionsLevel}` },
      { name: "Account active", passed: String(account.status ?? "").toUpperCase() === "ACTIVE", detail: String(account.status ?? "unknown") },
    ];
    const attestation = {
      account_id: accountId,
      account_fingerprint: createHash("sha256").update(accountId).digest("hex"),
      observed_equity: equity,
      options_level: optionsLevel,
      position_count: positions.length,
      historical_order_count: orders.length,
      eligible_preflight: gates.every((gate) => gate.passed),
      gates,
      payload: { account_status: account.status, currency: account.currency, observed_at: new Date().toISOString(), limitation: "API preflight verifies balance and inactivity; final account-newness eligibility remains Alpaca/judge authority." },
    };
    await journal.writeAccountAttestation(attestation);
    console.log(JSON.stringify(attestation, null, 2));
    if (!attestation.eligible_preflight) process.exitCode = 1;
  })
  .catch((error) => { console.error(error); process.exitCode = 1; });
