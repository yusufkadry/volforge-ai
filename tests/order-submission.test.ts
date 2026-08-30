import assert from "node:assert/strict";
import test from "node:test";
import { AmbiguousOrderSubmissionError, submitOrderRecoverably } from "../lib/order-submission";

const originalFetch = globalThis.fetch;

function configure() {
  process.env.ALPACA_API_KEY = "paper-key";
  process.env.ALPACA_SECRET_KEY = "paper-secret";
  process.env.ALPACA_PAPER_BASE_URL = "https://paper-api.alpaca.markets";
  process.env.ORDER_ACK_RECOVERY_ATTEMPTS = "1";
  process.env.ORDER_ACK_RECOVERY_BACKOFF_MS = "100";
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("recovers a broker-accepted order after the POST acknowledgement is lost", async () => {
  configure();
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (calls.length === 1) throw new TypeError("socket closed after write");
    return new Response(JSON.stringify({ id: "broker-order-1", status: "new" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await submitOrderRecoverably({ client_order_id: "vf-entry-test" }, "vf-entry-test");
  assert.equal(result.recovered, true);
  assert.equal(result.order.id, "broker-order-1");
  assert.equal(calls.length, 2);
  assert.match(calls[1], /orders:by_client_order_id\?client_order_id=vf-entry-test/);
});

test("does not classify deterministic broker rejection as an ambiguous submission", async () => {
  configure();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ message: "invalid order" }), { status: 422, headers: { "content-type": "application/json" } });
  };
  await assert.rejects(() => submitOrderRecoverably({ client_order_id: "vf-entry-reject" }, "vf-entry-reject"), /Alpaca 422/);
  assert.equal(calls, 1);
});

test("fails into durable reconciliation when acknowledgement remains unknown", async () => {
  configure();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("request timed out");
    return new Response(JSON.stringify({ message: "order not found" }), { status: 404, headers: { "content-type": "application/json" } });
  };
  await assert.rejects(
    () => submitOrderRecoverably({ client_order_id: "vf-entry-pending" }, "vf-entry-pending"),
    (error) => error instanceof AmbiguousOrderSubmissionError && error.clientOrderId === "vf-entry-pending",
  );
  assert.equal(calls, 2);
});
