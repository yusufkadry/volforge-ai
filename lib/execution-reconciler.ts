import { alpaca, AlpacaRequestError } from "@/lib/alpaca";
import { numberEnv } from "@/lib/env";
import { economicMlegCredit, intentClientOrderId } from "@/lib/execution-ledger";
import { AmbiguousOrderSubmissionError, submitOrderRecoverably } from "@/lib/order-submission";
import { spreadQuotes } from "@/lib/spread-quotes";
import { journal } from "@/lib/supabase";
import type { ExecutionIntent } from "@/lib/types";

function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function text(value: unknown) { return typeof value === "string" ? value : ""; }
const working = new Set(["new", "accepted", "pending_new", "accepted_for_bidding", "partially_filled", "pending_cancel", "pending_replace", "calculated"]);
const canceled = new Set(["canceled", "expired", "replaced", "done_for_day"]);
const failed = new Set(["rejected", "stopped", "suspended"]);

function orderAgeMs(order: Record<string, unknown>) {
  const timestamp = text(order.updated_at ?? order.submitted_at ?? order.created_at);
  return timestamp ? Math.max(0, Date.now() - new Date(timestamp).getTime()) : 0;
}

function positionMap(positions: Array<Record<string, unknown>>) {
  return new Map(positions.filter((position) => String(position.asset_class) === "us_option").map((position) => [String(position.symbol), position]));
}

function matchedQuantity(intent: ExecutionIntent, positions: Map<string, Record<string, unknown>>) {
  const long = positions.get(intent.long_leg);
  const short = positions.get(intent.short_leg);
  if (!long || !short || number(long.qty) <= 0 || number(short.qty) >= 0) return 0;
  return Math.min(Math.abs(number(long.qty)), Math.abs(number(short.qty)));
}

function elapsedMs(start: string | undefined, end: string | undefined) {
  const startTime = start ? new Date(start).getTime() : Number.NaN;
  const endTime = end ? new Date(end).getTime() : Date.now();
  return Number.isFinite(startTime) && Number.isFinite(endTime) ? Math.max(0, endTime - startTime) : null;
}

function entryMetadata(intent: ExecutionIntent, order: Record<string, unknown>, fillPrice: number, quantity: number) {
  const arrival = (intent.metadata?.arrival_quote ?? {}) as Record<string, unknown>;
  const arrivalMid = number(arrival.mid);
  const filledAt = text(order.filled_at) || text(order.updated_at) || new Date().toISOString();
  return {
    ...(intent.metadata ?? {}),
    opened_at: filledAt,
    entry_broker_order: order,
    entry_fill_latency_ms: elapsedMs(intent.created_at, filledAt),
    entry_implementation_shortfall: arrivalMid > 0 ? (fillPrice - arrivalMid) * 100 * quantity : null,
  };
}

function exitMetadata(intent: ExecutionIntent, order: Record<string, unknown>, fillCredit: number) {
  const arrival = (intent.metadata?.exit_arrival_quote ?? intent.metadata?.last_exit_quote ?? {}) as Record<string, unknown>;
  const arrivalMid = number(arrival.closeMid);
  const filledAt = text(order.filled_at) || text(order.updated_at) || new Date().toISOString();
  const entryShortfall = number(intent.metadata?.entry_implementation_shortfall);
  const exitShortfall = arrivalMid > 0 ? (arrivalMid - fillCredit) * 100 * intent.quantity : 0;
  return {
    ...(intent.metadata ?? {}),
    closed_at: filledAt,
    exit_broker_order: order,
    exit_fill_latency_ms: elapsedMs(text(intent.metadata?.exit_requested_at), filledAt),
    exit_implementation_shortfall: arrivalMid > 0 ? exitShortfall : null,
    round_trip_implementation_shortfall: entryShortfall + exitShortfall,
    realized_pnl: (fillCredit - intent.entry_debit) * 100 * intent.quantity,
  };
}

async function event(intent: ExecutionIntent, type: string, payload: Record<string, unknown>) {
  const orderId = payload.order_id ?? intent.entry_order_id ?? intent.exit_order_id ?? "";
  const eventKey = [intent.id, type, orderId, payload.status ?? "", payload.filled_qty ?? "", payload.attempt ?? ""].join(":");
  await journal.writeOrderEvent({ trace_id: intent.trace_id, alpaca_order_id: orderId, client_order_id: payload.client_order_id, event_key: eventKey, event_type: type, payload: { intent_id: intent.id, ...payload } });
}

type PendingOrderLookup =
  | { state: "none" | "waiting" | "missing" | "lookup_error"; clientOrderId: string; error?: string }
  | { state: "found"; clientOrderId: string; orderId: string; order: Record<string, unknown> };

async function recoverPendingOrder(intent: ExecutionIntent, phase: "entry" | "exit"): Promise<PendingOrderLookup> {
  const clientOrderId = text(intent.metadata?.[`pending_${phase}_client_order_id`]);
  if (!clientOrderId) return { state: "none", clientOrderId: "" };
  try {
    const order = await alpaca.orderByClientOrderId(clientOrderId);
    const orderId = text(order.id);
    if (!orderId) return { state: "lookup_error", clientOrderId, error: "Broker lookup returned an order without an ID." };
    return { state: "found", clientOrderId, orderId, order };
  } catch (error) {
    const errorText = error instanceof Error ? error.message : "client-order lookup failed";
    if (!(error instanceof AlpacaRequestError) || error.status !== 404) return { state: "lookup_error", clientOrderId, error: errorText };
    const startedAt = text(intent.metadata?.[`${phase}_submission_started_at`]) || intent.updated_at || intent.created_at;
    const age = startedAt ? Math.max(0, Date.now() - new Date(startedAt).getTime()) : 0;
    const timeout = numberEnv("ORDER_ACK_RECONCILIATION_SECONDS", 90) * 1000;
    return age < timeout ? { state: "waiting", clientOrderId, error: errorText } : { state: "missing", clientOrderId, error: errorText };
  }
}

async function resubmitEntry(intent: ExecutionIntent) {
  if (!intent.id) return "skipped";
  const quotes = await spreadQuotes(intent.underlying, intent.long_leg, intent.short_leg);
  if (!quotes || !quotes.fresh) throw new Error("Cannot reprice entry without a fresh complete quote.");
  const maxEntry = number(intent.max_entry_debit ?? intent.metadata?.max_entry_debit ?? intent.entry_limit_price ?? intent.entry_debit);
  const attempts = (intent.entry_attempts ?? 1) + 1;
  const fraction = Math.min(1, numberEnv("INITIAL_PRICE_FRACTION", 0.25) + (attempts - 1) * numberEnv("PRICE_LADDER_STEP_FRACTION", 0.25));
  const limit = Math.round(Math.min(maxEntry, quotes.entryMid + (quotes.entryNatural - quotes.entryMid) * fraction) * 100) / 100;
  if (limit <= 0 || limit > maxEntry) throw new Error("Repriced entry exceeded its model-approved debit cap.");
  const clientOrderId = intentClientOrderId(intent.trace_id, "entry");
  const submissionStartedAt = new Date().toISOString();
  const pendingMetadata = { ...(intent.metadata ?? {}), pending_entry_client_order_id: clientOrderId, entry_submission_started_at: submissionStartedAt, last_entry_quote: quotes };
  await journal.updateIntent(intent.id, { status: "entry_pending", entry_order_id: null, entry_attempts: attempts, entry_limit_price: limit, metadata: pendingMetadata });
  let submission: Awaited<ReturnType<typeof submitOrderRecoverably>>;
  try {
    submission = await submitOrderRecoverably({
      order_class: "mleg", qty: intent.quantity, type: "limit", time_in_force: "day", limit_price: limit.toFixed(2), client_order_id: clientOrderId,
      legs: [
        { symbol: intent.long_leg, ratio_qty: 1, side: "buy", position_intent: "buy_to_open" },
        { symbol: intent.short_leg, ratio_qty: 1, side: "sell", position_intent: "sell_to_open" },
      ],
    }, clientOrderId);
  } catch (error) {
    if (error instanceof AmbiguousOrderSubmissionError) {
      await journal.updateIntent(intent.id, { status: "entry_pending", last_error: error.message, metadata: pendingMetadata });
      await event(intent, "entry_ack_pending", { client_order_id: clientOrderId, attempt: attempts, error: error.message });
      return "pending";
    }
    throw error;
  }
  const order = submission.order;
  const orderId = String(order.id ?? "");
  try {
    await journal.updateIntent(intent.id, { status: "entry_submitted", entry_order_id: orderId, entry_attempts: attempts, entry_limit_price: limit, last_error: null, metadata: { ...pendingMetadata, entry_acknowledged_at: new Date().toISOString(), entry_ack_recovered: submission.recovered, entry_submission_error: submission.submissionError } });
    await event(intent, "entry_resubmitted", { order_id: orderId, client_order_id: clientOrderId, attempt: attempts, limit_price: limit, acknowledgement_recovered: submission.recovered });
  } catch {
    // The durable pending client ID was written before POST, so the next cycle can recover this acknowledged order without resubmitting it.
    return "pending";
  }
  return "submitted";
}

async function reconcileEntry(intent: ExecutionIntent, positions: Map<string, Record<string, unknown>>, entriesAllowed: boolean) {
  if (!intent.id) return "skipped";
  const brokerQuantity = matchedQuantity(intent, positions);
  let orderId = intent.entry_order_id ?? "";
  let order: Record<string, unknown> | null = null;
  if (!orderId) {
    if (brokerQuantity > 0) {
      await journal.updateIntent(intent.id, { status: "open", filled_quantity: brokerQuantity, last_reconciled_at: new Date().toISOString(), metadata: { ...(intent.metadata ?? {}), opened_at: new Date().toISOString() } });
      return "opened_from_positions";
    }
    const recovered = await recoverPendingOrder(intent, "entry");
    if (recovered.state === "found") {
      orderId = recovered.orderId;
      order = recovered.order;
      await journal.updateIntent(intent.id, { status: intent.status === "entry_cancel_pending" ? "entry_cancel_pending" : "entry_submitted", entry_order_id: orderId, last_error: null, last_reconciled_at: new Date().toISOString(), metadata: { ...(intent.metadata ?? {}), entry_acknowledged_at: new Date().toISOString(), entry_ack_recovered: true } });
      await event(intent, "entry_ack_recovered", { order_id: orderId, client_order_id: recovered.clientOrderId, status: text(order.status) });
    } else if (recovered.state === "waiting") {
      await journal.updateIntent(intent.id, { status: intent.status === "entry_cancel_pending" ? "entry_cancel_pending" : "entry_pending", last_error: `Waiting for broker acknowledgement of ${recovered.clientOrderId}.`, last_reconciled_at: new Date().toISOString() });
      return "entry_ack_pending";
    } else if (recovered.state === "lookup_error") {
      await journal.updateIntent(intent.id, { status: "reconciliation_error", last_error: recovered.error ?? "Client-order lookup failed.", last_reconciled_at: new Date().toISOString() });
      return "lookup_error";
    } else if (recovered.state === "missing") {
      await journal.updateIntent(intent.id, { status: "canceled", exit_reason: "submission_not_acknowledged", last_error: `No Alpaca order appeared for client order ID ${recovered.clientOrderId} within the recovery window.`, last_reconciled_at: new Date().toISOString() });
      return "submission_not_found";
    }
    if (intent.status === "entry_cancel_pending" || !entriesAllowed) {
      await journal.updateIntent(intent.id, { status: "canceled", exit_reason: intent.exit_reason ?? "entries_disabled", last_reconciled_at: new Date().toISOString() });
      return "canceled_without_order";
    }
    return "pending_without_order";
  }
  if (!order) {
    try { order = await alpaca.order(orderId); }
    catch (error) {
      await journal.updateIntent(intent.id, { status: "reconciliation_error", last_error: error instanceof Error ? error.message : "entry order lookup failed", last_reconciled_at: new Date().toISOString() });
      return "lookup_error";
    }
  }
  const status = text(order.status);
  const filledQuantity = Math.max(number(order.filled_qty), brokerQuantity);
  const fillPrice = number(order.filled_avg_price) || intent.entry_debit;
  if (status === "filled" || (filledQuantity >= intent.quantity && brokerQuantity > 0)) {
    const quantity = filledQuantity || intent.quantity;
    await journal.updateIntent(intent.id, { status: "open", quantity, filled_quantity: quantity, entry_debit: fillPrice, current_debit: fillPrice, last_reconciled_at: new Date().toISOString(), last_error: null, metadata: entryMetadata(intent, order, fillPrice, quantity) });
    return "open";
  }
  if (status === "partially_filled") {
    await journal.updateIntent(intent.id, { status: "entry_partial", filled_quantity: filledQuantity, entry_debit: fillPrice, last_reconciled_at: new Date().toISOString() });
  }
  if (working.has(status)) {
    if ((!entriesAllowed || intent.status === "entry_cancel_pending" || orderAgeMs(order) >= numberEnv("ENTRY_ORDER_TIMEOUT_SECONDS", 75) * 1000) && status !== "pending_cancel") {
      await alpaca.cancelOrder(orderId);
      await journal.updateIntent(intent.id, { status: "entry_cancel_pending", filled_quantity: filledQuantity, last_reconciled_at: new Date().toISOString() });
      await event(intent, "entry_cancel_requested", { order_id: orderId, status, filled_qty: filledQuantity, reason: !entriesAllowed ? "entries_disabled" : intent.status === "entry_cancel_pending" ? "preexisting_cancel_request" : "entry_timeout" });
      return "cancel_requested";
    }
    return status || "working";
  }
  if (canceled.has(status)) {
    if (filledQuantity > 0 || brokerQuantity > 0) {
      const quantity = filledQuantity || brokerQuantity;
      await journal.updateIntent(intent.id, { status: "open", quantity, filled_quantity: quantity, entry_debit: fillPrice, current_debit: fillPrice, last_reconciled_at: new Date().toISOString(), metadata: entryMetadata(intent, order, fillPrice, quantity) });
      return "partial_open";
    }
    if (entriesAllowed && (intent.entry_attempts ?? 1) < numberEnv("MAX_ENTRY_ATTEMPTS", 4)) {
      try {
        const state = await resubmitEntry(intent);
        return state === "pending" ? "resubmission_ack_pending" : "resubmitted";
      } catch (error) {
        await journal.updateIntent(intent.id, { status: "error", last_error: error instanceof Error ? error.message : "entry resubmission failed", last_reconciled_at: new Date().toISOString() });
        return "resubmission_error";
      }
    }
    await journal.updateIntent(intent.id, { status: "canceled", last_reconciled_at: new Date().toISOString(), exit_reason: entriesAllowed ? "entry_attempts_exhausted" : "entries_disabled" });
    return "canceled";
  }
  if (failed.has(status)) {
    await journal.updateIntent(intent.id, { status: "error", last_error: `Alpaca entry order ${status}: ${text(order.reject_reason)}`, last_reconciled_at: new Date().toISOString() });
    return status;
  }
  await journal.updateIntent(intent.id, { status: "reconciliation_error", last_error: `Unhandled Alpaca entry status: ${status || "missing"}`, last_reconciled_at: new Date().toISOString() });
  return "unknown";
}

async function reconcileExit(intent: ExecutionIntent, positions: Map<string, Record<string, unknown>>) {
  if (!intent.id) return "skipped";
  const remainingBeforeLookup = matchedQuantity(intent, positions);
  let orderId = intent.exit_order_id ?? "";
  let order: Record<string, unknown> | null = null;
  if (!orderId) {
    const recovered = await recoverPendingOrder(intent, "exit");
    if (recovered.state === "found") {
      orderId = recovered.orderId;
      order = recovered.order;
      await journal.updateIntent(intent.id, { status: "exit_submitted", exit_order_id: orderId, last_error: null, last_reconciled_at: new Date().toISOString(), metadata: { ...(intent.metadata ?? {}), exit_acknowledged_at: new Date().toISOString(), exit_ack_recovered: true } });
      await event(intent, "exit_ack_recovered", { order_id: orderId, client_order_id: recovered.clientOrderId, status: text(order.status) });
    } else if (recovered.state === "waiting") {
      await journal.updateIntent(intent.id, { status: "exit_pending", last_error: `Waiting for broker acknowledgement of ${recovered.clientOrderId}.`, last_reconciled_at: new Date().toISOString() });
      return "exit_ack_pending";
    } else if (recovered.state === "lookup_error") {
      await journal.updateIntent(intent.id, { status: "reconciliation_error", last_error: recovered.error ?? "Client-order lookup failed.", last_reconciled_at: new Date().toISOString() });
      return "lookup_error";
    } else if (recovered.state === "missing") {
      if (remainingBeforeLookup > 0) {
        await journal.updateIntent(intent.id, { status: "open", exit_order_id: null, last_error: `No Alpaca exit appeared for client order ID ${recovered.clientOrderId}; exposure remains open and may be repriced safely.`, last_reconciled_at: new Date().toISOString(), metadata: { ...(intent.metadata ?? {}), pending_exit_client_order_id: null, exit_submission_resolution: "not_found" } });
        return "exit_submission_not_found";
      }
      await journal.updateIntent(intent.id, { status: "reconciliation_error", last_error: `The broker is flat but no verifiable exit order appeared for client order ID ${recovered.clientOrderId}.`, last_reconciled_at: new Date().toISOString() });
      return "unverified_flatness";
    } else {
      await journal.updateIntent(intent.id, { status: remainingBeforeLookup > 0 ? "open" : "reconciliation_error", last_error: "Exit intent had no broker order ID or durable client order ID.", last_reconciled_at: new Date().toISOString() });
      return remainingBeforeLookup > 0 ? "reopened_without_order" : "unverified_flatness";
    }
  }
  if (!order) {
    try { order = await alpaca.order(orderId); }
    catch (error) {
      await journal.updateIntent(intent.id, { status: "reconciliation_error", last_error: error instanceof Error ? error.message : "exit order lookup failed", last_reconciled_at: new Date().toISOString() });
      return "lookup_error";
    }
  }
  const status = text(order.status);
  const filledQuantity = number(order.filled_qty);
  const remaining = matchedQuantity(intent, positions);
  const fillPrice = economicMlegCredit(order.filled_avg_price, intent.current_debit ?? 0);
  if (status === "filled" || (remaining === 0 && filledQuantity > 0)) {
    await journal.updateIntent(intent.id, { status: "closed", current_debit: fillPrice, exit_credit: fillPrice, filled_quantity: intent.quantity, last_reconciled_at: new Date().toISOString(), last_error: null, metadata: exitMetadata(intent, order, fillPrice) });
    return "closed";
  }
  if (status === "partially_filled") await journal.updateIntent(intent.id, { status: "exit_partial", filled_quantity: Math.max(0, intent.quantity - remaining), last_reconciled_at: new Date().toISOString() });
  if (working.has(status)) {
    if (orderAgeMs(order) >= numberEnv("EXIT_ORDER_TIMEOUT_SECONDS", 60) * 1000 && status !== "pending_cancel") {
      await alpaca.cancelOrder(orderId);
      await journal.updateIntent(intent.id, { status: "exit_cancel_pending", last_reconciled_at: new Date().toISOString() });
      await event(intent, "exit_cancel_requested", { order_id: orderId, status, filled_qty: filledQuantity });
      return "cancel_requested";
    }
    return status || "working";
  }
  if (canceled.has(status)) {
    if (remaining <= 0 && filledQuantity > 0) {
      await journal.updateIntent(intent.id, { status: "closed", current_debit: fillPrice, exit_credit: fillPrice, last_reconciled_at: new Date().toISOString(), metadata: exitMetadata(intent, order, fillPrice) });
      return "closed_after_partial_fill";
    }
    if (remaining <= 0) {
      await journal.updateIntent(intent.id, { status: "reconciliation_error", last_error: "Broker position disappeared without a verifiable exit fill.", last_reconciled_at: new Date().toISOString() });
      return "unverified_flatness";
    }
    await journal.updateIntent(intent.id, { status: "open", last_reconciled_at: new Date().toISOString(), last_error: null });
    return "reopened";
  }
  if (failed.has(status)) {
    await journal.updateIntent(intent.id, { status: remaining > 0 ? "open" : "reconciliation_error", last_error: `Alpaca exit order ${status}: ${text(order.reject_reason)}${remaining <= 0 ? "; broker flatness has no verified fill" : ""}`, last_reconciled_at: new Date().toISOString() });
    return status;
  }
  await journal.updateIntent(intent.id, { status: "reconciliation_error", last_error: `Unhandled Alpaca exit status: ${status || "missing"}`, last_reconciled_at: new Date().toISOString() });
  return "unknown";
}

export async function reconcileExecution(options: { entriesAllowed: boolean; leaseGuard?: () => Promise<boolean> }) {
  const [intents, brokerPositions] = await Promise.all([journal.activeIntents(), alpaca.positions()]);
  const positions = positionMap(brokerPositions);
  const results: Array<{ intentId?: string; state: string }> = [];
  for (const intent of intents) {
    if (options.leaseGuard && !await options.leaseGuard()) {
      results.push({ intentId: intent.id, state: "lease_lost" });
      break;
    }
    const exitState = ["exit_pending", "exit_submitted", "exit_partial", "exit_cancel_pending"].includes(intent.status)
      || (intent.status === "reconciliation_error" && Boolean(intent.exit_order_id || text(intent.metadata?.pending_exit_client_order_id)));
    const state = exitState ? await reconcileExit(intent, positions) : await reconcileEntry(intent, positions, options.entriesAllowed);
    results.push({ intentId: intent.id, state });
  }
  const tracked = new Set(intents.flatMap((intent) => [intent.long_leg, intent.short_leg]));
  const orphanPositions = [...positions.keys()].filter((symbol) => !tracked.has(symbol));
  return { reconciledAt: new Date().toISOString(), intents: results, orphanPositions, healthy: !results.some((result) => ["lookup_error", "unknown", "unverified_flatness", "lease_lost", "resubmission_error"].includes(result.state)) };
}
