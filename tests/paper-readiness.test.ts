import assert from "node:assert/strict";
import test from "node:test";
import { alpaca } from "../lib/alpaca";
import { brokerAccountGates, cliAccountOracleGate, paperEndpointGate } from "../lib/paper-readiness";

test("Paper order authority is pinned to Alpaca's exact HTTPS paper origin", () => {
  const previous = process.env.ALPACA_PAPER_BASE_URL;
  try {
    process.env.ALPACA_PAPER_BASE_URL = "https://paper-api.alpaca.markets/v2";
    assert.equal(paperEndpointGate().passed, true);
    process.env.ALPACA_PAPER_BASE_URL = "https://api.alpaca.markets";
    assert.equal(paperEndpointGate().passed, false);
    process.env.ALPACA_PAPER_BASE_URL = "https://paper-api.alpaca.markets.example.com";
    assert.equal(paperEndpointGate().passed, false);
  } finally {
    if (previous === undefined) delete process.env.ALPACA_PAPER_BASE_URL;
    else process.env.ALPACA_PAPER_BASE_URL = previous;
  }
});

test("the Alpaca transport refuses untrusted hosts before authenticated fetch", () => {
  const previousPaper = process.env.ALPACA_PAPER_BASE_URL;
  const previousData = process.env.ALPACA_DATA_BASE_URL;
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; return new Response("{}"); };
  try {
    process.env.ALPACA_PAPER_BASE_URL = "https://paper-api.alpaca.markets.example.com";
    assert.throws(() => alpaca.account(), /Refusing untrusted Alpaca endpoint/);
    process.env.ALPACA_DATA_BASE_URL = "https://example.com";
    assert.throws(() => alpaca.stockSnapshot("SPY"), /Refusing untrusted Alpaca endpoint/);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousPaper === undefined) delete process.env.ALPACA_PAPER_BASE_URL;
    else process.env.ALPACA_PAPER_BASE_URL = previousPaper;
    if (previousData === undefined) delete process.env.ALPACA_DATA_BASE_URL;
    else process.env.ALPACA_DATA_BASE_URL = previousData;
  }
});

test("configured options ceiling cannot contradict account Level 3 readiness", () => {
  const gates = brokerAccountGates(
    { id: "paper", status: "ACTIVE", options_trading_level: "3", options_buying_power: "100000", trading_blocked: false },
    { suspend_trade: false, max_options_trading_level: 2 },
    500,
  );
  assert.equal(gates.find((gate) => gate.name === "Options Level 3")?.passed, false);
});

test("CLI proof is account-bound while live state freshness belongs to REST", () => {
  const gate = cliAccountOracleGate({
    account_id: "paper", paper: true, market_open: false, cli_version: "alpaca 0.0.13", evidence_hash: "proof", healthy: true,
    created_at: new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString(), payload: {},
  }, { id: "paper" });
  assert.equal(gate.passed, true);
  assert.match(gate.detail, /live REST state is revalidated every cycle/);
});
