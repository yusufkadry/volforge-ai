import { alpaca, AlpacaRequestError } from "@/lib/alpaca";
import { numberEnv } from "@/lib/env";

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function couldHaveReachedBroker(error: unknown) {
  if (!(error instanceof AlpacaRequestError)) return true;
  return error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500;
}

export class AmbiguousOrderSubmissionError extends Error {
  constructor(public readonly clientOrderId: string, public readonly submissionError: unknown) {
    super(`Alpaca order acknowledgement is unknown for ${clientOrderId}; reconciliation by client_order_id is required. Original error: ${message(submissionError)}`);
    this.name = "AmbiguousOrderSubmissionError";
  }
}

export async function submitOrderRecoverably(payload: Record<string, unknown>, clientOrderId: string) {
  try {
    const order = await alpaca.submitOrder(payload);
    if (String(order.id ?? "")) return { order, recovered: false, submissionError: null as string | null };
    throw new Error("Alpaca accepted the submission but returned no broker order ID.");
  } catch (error) {
    if (!couldHaveReachedBroker(error)) throw error;
    const attempts = Math.max(1, Math.floor(numberEnv("ORDER_ACK_RECOVERY_ATTEMPTS", 4)));
    const backoffMs = Math.max(100, numberEnv("ORDER_ACK_RECOVERY_BACKOFF_MS", 750));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(backoffMs * attempt);
      try {
        const order = await alpaca.orderByClientOrderId(clientOrderId);
        if (String(order.id ?? "")) return { order, recovered: true, submissionError: message(error) };
      } catch {
        // A timed-out POST can become queryable a moment later; bounded retries preserve idempotency.
      }
    }
    throw new AmbiguousOrderSubmissionError(clientOrderId, error);
  }
}
