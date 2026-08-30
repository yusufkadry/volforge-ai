import assert from "node:assert/strict";
import test from "node:test";
import { encode } from "@msgpack/msgpack";
import { decodeTradeStreamMessages } from "../worker/trade-stream";

test("trade stream decodes Alpaca JSON carried in a binary WebSocket frame", () => {
  const message = { stream: "authorization", data: { status: "authorized" } };
  assert.deepEqual(decodeTradeStreamMessages(Buffer.from(JSON.stringify(message))), [message]);
});

test("trade stream decodes JSON message batches", () => {
  const messages = [
    { stream: "authorization", data: { status: "authorized" } },
    { stream: "listening", data: { streams: ["trade_updates"] } },
  ];
  assert.deepEqual(decodeTradeStreamMessages(Buffer.from(JSON.stringify(messages))), messages);
});

test("trade stream decodes concatenated MessagePack messages", () => {
  const messages = [
    { stream: "authorization", data: { status: "authorized" } },
    { stream: "trade_updates", data: { event: "fill", order: { id: "order-1" } } },
  ];
  const payload = Buffer.concat(messages.map((message) => Buffer.from(encode(message))));
  assert.deepEqual(decodeTradeStreamMessages(payload), messages);
});
