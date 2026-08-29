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
  portfolioHistory: () => request<{ timestamp?: number[]; equity?: number[]; profit_loss?: number[]; profit_loss_pct?: number[] }>(paperBase(), "/v2/account/portfolio/history?period=1M&timeframe=1D"),
  accountConfig: () => request<Record<string, unknown>>(paperBase(), "/v2/account/configurations"),
  updateAccountConfig: (body: Record<string, unknown>) => request<Record<string, unknown>>(paperBase(), "/v2/account/configurations", {
    method: "PATCH", body: JSON.stringify(body),
  }),
  cancelAllOrders: () => request<Array<Record<string, unknown>>>(paperBase(), "/v2/orders", { method: "DELETE" }),
  contracts: (symbol: string, start: string, end: string, type: "call" | "put" = "call") => request<{ option_contracts?: Array<Record<string, unknown>> }>(
    paperBase(),
    `/v2/options/contracts?underlying_symbols=${encodeURIComponent(symbol)}&status=active&type=${type}&expiration_date_gte=${start}&expiration_date_lte=${end}&limit=1000`,
  ),
  snapshots: (symbol: string) => request<{ snapshots?: Record<string, Record<string, unknown>> }>(
    dataBase(),
    `/v1beta1/options/snapshots/${encodeURIComponent(symbol)}?feed=${encodeURIComponent(process.env.ALPACA_OPTIONS_FEED ?? "indicative")}&limit=1000`,
  ),
  stockBars: (symbols: string[], start: string, end: string) => request<{ bars?: Record<string, Array<Record<string, unknown>>> }>(
    dataBase(),
    `/v2/stocks/bars?symbols=${encodeURIComponent(symbols.join(","))}&timeframe=1Day&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&adjustment=all&feed=iex&limit=10000`,
  ),
  news: (symbols: string[], limit = 30) => request<{ news?: Array<Record<string, unknown>> }>(
    dataBase(),
    `/v1beta1/news?symbols=${encodeURIComponent(symbols.join(","))}&limit=${limit}&sort=desc`,
  ),
  submitOrder: (body: Record<string, unknown>) => request<Record<string, unknown>>(paperBase(), "/v2/orders", {
    method: "POST", body: JSON.stringify(body),
  }),
};
