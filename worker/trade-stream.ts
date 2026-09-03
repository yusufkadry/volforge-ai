import { randomUUID } from "crypto";
import WebSocket, { type RawData } from "ws";
import { decodeMulti } from "@msgpack/msgpack";
import { orderEventKey } from "../lib/execution-ledger";
import { reconcileExecution } from "../lib/execution-reconciler";
import { journal } from "../lib/supabase";

const endpoint = process.env.ALPACA_TRADE_STREAM_URL?.trim() || "wss://paper-api.alpaca.markets/stream";

type TradeStreamMessage = { stream?: string; data?: Record<string, unknown> };

function normalizeMessages(value: unknown): TradeStreamMessage[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((entry): entry is TradeStreamMessage => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry));
}

export function decodeTradeStreamMessages(raw: RawData): TradeStreamMessage[] {
  const payload = Array.isArray(raw)
    ? Buffer.concat(raw)
    : raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : raw;
  const text = Buffer.from(payload).toString("utf8").trimStart();

  // Alpaca can set the WebSocket binary flag while carrying UTF-8 JSON.
  if (text.startsWith("{") || text.startsWith("[")) return normalizeMessages(JSON.parse(text));

  return [...decodeMulti(payload)].flatMap(normalizeMessages);
}

export function isPaperTradeStreamEndpoint(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "wss:"
      && url.hostname === "paper-api.alpaca.markets"
      && url.port === ""
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === ""
      && url.pathname.replace(/\/$/, "") === "/stream";
  } catch {
    return false;
  }
}

export function startTradeStream(instanceId: string = randomUUID()) {
  if (!isPaperTradeStreamEndpoint(endpoint)) throw new Error("ALPACA_TRADE_STREAM_URL must be Alpaca's exact WSS paper trade-stream endpoint.");
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) throw new Error("ALPACA_API_KEY and ALPACA_SECRET_KEY are required for the trade stream worker.");
  let socket: WebSocket | null = null;
  let stopped = false;
  let authenticated = false;
  let reconnectAttempt = 0;
  let lastEventAt: string | null = null;

  async function heartbeat(status: "healthy" | "degraded" | "stopped", details: Record<string, unknown> = {}) {
    await journal.heartbeat({ service: "alpaca-trade-stream", instance_id: instanceId, status, last_seen_at: new Date().toISOString(), details: { stream_authenticated: authenticated, last_event_at: lastEventAt, endpoint, reconnect_attempt: reconnectAttempt, ...details } });
  }

  function connect() {
    if (stopped) return;
    socket = new WebSocket(endpoint);
    socket.on("open", () => socket?.send(JSON.stringify({ action: "auth", key, secret })));
    socket.on("message", async (raw) => {
      try {
        for (const message of decodeTradeStreamMessages(raw)) {
          if (message.stream === "authorization") {
            authenticated = message.data?.status === "authorized";
            if (!authenticated) throw new Error(`Alpaca stream authorization failed: ${JSON.stringify(message.data ?? {})}`);
            reconnectAttempt = 0;
            socket?.send(JSON.stringify({ action: "listen", data: { streams: ["trade_updates"] } }));
            await heartbeat("healthy", { event: "authorized" });
            continue;
          }
          if (message.stream !== "trade_updates") continue;
          lastEventAt = new Date().toISOString();
          const order = message.data?.order as Record<string, unknown> | undefined;
          const orderId = String(order?.id ?? "");
          const eventType = String(message.data?.event ?? "trade_update");
          const timestamp = String(message.data?.timestamp ?? order?.updated_at ?? lastEventAt);
          await journal.writeOrderEvent({
            alpaca_order_id: orderId,
            client_order_id: String(order?.client_order_id ?? ""),
            event_key: orderEventKey(orderId, eventType, timestamp, order?.filled_qty),
            event_type: eventType,
            payload: message.data ?? {},
          });
          let reconciliation = "not_required";
          if (orderId) {
            const owner = `stream:${instanceId}:${orderId}:${timestamp}`;
            const acquired = await journal.acquireLease("volforge-capital-loop", owner, 120);
            if (acquired) {
              try {
                const settings = await journal.settings();
                await reconcileExecution({ entriesAllowed: settings.promotion_stage === "paper" && settings.trading_enabled && !settings.emergency_stop });
                reconciliation = "completed";
              } finally {
                await journal.releaseLease("volforge-capital-loop", owner).catch(() => false);
              }
            } else reconciliation = "deferred_to_rest_loop";
          }
          await heartbeat("healthy", { event: eventType, order_id: orderId, reconciliation });
        }
      } catch (error) {
        console.error("Trade-stream event failed", error);
        await heartbeat("degraded", { error: error instanceof Error ? error.message : "unknown stream event error" }).catch(() => undefined);
      }
    });
    socket.on("close", async () => {
      authenticated = false;
      reconnectAttempt += 1;
      await heartbeat(stopped ? "stopped" : "degraded", { event: "closed" }).catch(() => undefined);
      if (!stopped) setTimeout(connect, Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 5)));
    });
    socket.on("error", async (error) => {
      console.error("Trade-stream connection error", error.message);
      await heartbeat("degraded", { error: error.message }).catch(() => undefined);
    });
  }

  const heartbeatTimer = setInterval(() => {
    void heartbeat(authenticated ? "healthy" : "degraded").catch((error) => {
      console.error("Trade-stream heartbeat failed", error instanceof Error ? error.message : error);
    });
  }, 30_000);
  connect();
  return {
    instanceId,
    stop: async () => {
      stopped = true;
      clearInterval(heartbeatTimer);
      socket?.close();
      await heartbeat("stopped");
    },
  };
}

if (process.argv[1]?.endsWith("trade-stream.ts")) startTradeStream();
