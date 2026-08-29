import { env } from "@/lib/env";

const paperBase = () => env("ALPACA_PAPER_BASE_URL", "https://paper-api.alpaca.markets");
const dataBase = () => env("ALPACA_DATA_BASE_URL", "https://data.alpaca.markets");

async function request<T>(base: string, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("APCA-API-KEY-ID", env("ALPACA_API_KEY"));
  headers.set("APCA-API-SECRET-KEY", env("ALPACA_SECRET_KEY"));
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(`${base}${path}`, { ...init, headers, cache: "no-store" });
  if (!response.ok) throw new Error(`Alpaca ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

export const alpaca = {
  account: () => request<Record<string, unknown>>(paperBase(), "/v2/account"),
  clock: () => request<{ is_open: boolean; next_open?: string }>(paperBase(), "/v2/clock"),
  positions: () => request<Array<Record<string, unknown>>>(paperBase(), "/v2/positions"),
  orders: () => request<Array<Record<string, unknown>>>(paperBase(), "/v2/orders?status=open&direction=desc&limit=20"),
  contracts: (symbol: string, start: string, end: string) => request<{ option_contracts?: Array<Record<string, unknown>> }>(
    paperBase(),
    `/v2/options/contracts?underlying_symbols=${encodeURIComponent(symbol)}&status=active&type=call&expiration_date_gte=${start}&expiration_date_lte=${end}&limit=1000`,
  ),
  snapshots: (symbol: string) => request<{ snapshots?: Record<string, Record<string, unknown>> }>(
    dataBase(),
    `/v1beta1/options/snapshots/${encodeURIComponent(symbol)}?feed=${encodeURIComponent(process.env.ALPACA_OPTIONS_FEED ?? "indicative")}&limit=1000`,
  ),
  submitOrder: (body: Record<string, unknown>) => request<Record<string, unknown>>(paperBase(), "/v2/orders", {
    method: "POST", body: JSON.stringify(body),
  }),
};
