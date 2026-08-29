import WebSocket from "ws";
import { journal } from "../lib/supabase";

const endpoint = process.env.ALPACA_TRADE_STREAM_URL ?? "wss://paper-api.alpaca.markets/stream";
const key = process.env.ALPACA_API_KEY;
const secret = process.env.ALPACA_SECRET_KEY;

if (!key || !secret) throw new Error("ALPACA_API_KEY and ALPACA_SECRET_KEY are required for the trade stream worker.");

function connect() {
  const socket = new WebSocket(endpoint);
  socket.on("open", () => socket.send(JSON.stringify({ action: "auth", key, secret })));
  socket.on("message", async (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as { stream?: string; data?: Record<string, unknown> };
      if (message.stream === "authorization" && message.data?.status === "authorized") {
        socket.send(JSON.stringify({ action: "listen", data: { streams: ["trade_updates"] } }));
        return;
      }
      if (message.stream !== "trade_updates") return;
      const order = message.data?.order as Record<string, unknown> | undefined;
      await journal.writeOrderEvent({
        alpaca_order_id: String(order?.id ?? ""),
        client_order_id: String(order?.client_order_id ?? ""),
        event_type: String(message.data?.event ?? "trade_update"),
        payload: message.data ?? {},
      });
    } catch (error) { console.error("Trade-stream event failed", error); }
  });
  socket.on("close", () => setTimeout(connect, 3_000));
  socket.on("error", (error) => console.error("Trade-stream connection error", error.message));
}

connect();
