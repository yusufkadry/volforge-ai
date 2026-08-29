import WebSocket, { type RawData } from "ws";
import { decode } from "@msgpack/msgpack";
import { journal } from "../lib/supabase";

const endpoint = process.env.ALPACA_TRADE_STREAM_URL ?? "wss://paper-api.alpaca.markets/stream";
const key = process.env.ALPACA_API_KEY;
const secret = process.env.ALPACA_SECRET_KEY;

if (!key || !secret) throw new Error("ALPACA_API_KEY and ALPACA_SECRET_KEY are required for the trade stream worker.");

function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }

function decodeMessage(raw: RawData, isBinary: boolean) {
  if (!isBinary) return JSON.parse(raw.toString()) as { stream?: string; data?: Record<string, unknown> };
  const payload = Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
  return decode(payload) as { stream?: string; data?: Record<string, unknown> };
}

async function reconcileIntent(orderId: string, eventType: string, filledPrice: number) {
  const entryIntent = await journal.intentByEntryOrder(orderId);
  const exitIntent = entryIntent ? null : await journal.intentByExitOrder(orderId);
  const intent = entryIntent ?? exitIntent;
  if (!intent?.id) return;
  if (entryIntent) {
    if (eventType === "fill") await journal.updateIntent(intent.id, { status: "open", entry_debit: filledPrice > 0 ? filledPrice : intent.entry_debit, current_debit: filledPrice > 0 ? filledPrice : intent.current_debit });
    if (["canceled", "rejected", "expired"].includes(eventType)) await journal.updateIntent(intent.id, { status: eventType === "canceled" ? "canceled" : "error" });
    return;
  }
  if (eventType === "fill") await journal.updateIntent(intent.id, { status: "closed", current_debit: filledPrice > 0 ? filledPrice : intent.current_debit });
  if (["canceled", "rejected", "expired"].includes(eventType)) await journal.updateIntent(intent.id, { status: "open" });
}

function connect() {
  const socket = new WebSocket(endpoint);
  socket.on("open", () => socket.send(JSON.stringify({ action: "auth", key, secret })));
  socket.on("message", async (raw, isBinary) => {
    try {
      const message = decodeMessage(raw, isBinary);
      if (message.stream === "authorization" && message.data?.status === "authorized") {
        socket.send(JSON.stringify({ action: "listen", data: { streams: ["trade_updates"] } }));
        return;
      }
      if (message.stream !== "trade_updates") return;
      const order = message.data?.order as Record<string, unknown> | undefined;
      const orderId = String(order?.id ?? "");
      const eventType = String(message.data?.event ?? "trade_update");
      await journal.writeOrderEvent({
        alpaca_order_id: orderId,
        client_order_id: String(order?.client_order_id ?? ""),
        event_type: eventType,
        payload: message.data ?? {},
      });
      if (orderId) await reconcileIntent(orderId, eventType, number(order?.filled_avg_price));
    } catch (error) { console.error("Trade-stream event failed", error); }
  });
  socket.on("close", () => setTimeout(connect, 3_000));
  socket.on("error", (error) => console.error("Trade-stream connection error", error.message));
}

connect();
