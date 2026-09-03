import { env, numberEnv } from "@/lib/env";

function trustedBase(configured: string, hostname: string, allowedPaths: string[]) {
  let url: URL;
  try { url = new URL(configured); }
  catch { throw new Error(`Refusing malformed Alpaca endpoint for ${hostname}.`); }
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (url.protocol !== "https:" || url.hostname !== hostname || url.port || !allowedPaths.includes(path) || url.username || url.password || url.search || url.hash) {
    throw new Error(`Refusing untrusted Alpaca endpoint for ${hostname}.`);
  }
  return url.origin;
}

const paperBase = () => trustedBase(env("ALPACA_PAPER_BASE_URL", "https://paper-api.alpaca.markets"), "paper-api.alpaca.markets", ["/", "/v2"]);
const dataBase = () => trustedBase(env("ALPACA_DATA_BASE_URL", "https://data.alpaca.markets"), "data.alpaca.markets", ["/"]);

export class AlpacaRequestError extends Error {
  constructor(public readonly status: number, public readonly responseBody: string) {
    super(`Alpaca ${status}: ${responseBody || "Request failed"}`);
    this.name = "AlpacaRequestError";
  }
}

async function request<T>(base: string, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("APCA-API-KEY-ID", env("ALPACA_API_KEY"));
  headers.set("APCA-API-SECRET-KEY", env("ALPACA_SECRET_KEY"));
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  const timeout = numberEnv("ALPACA_REQUEST_TIMEOUT_MS", 30_000);
  const response = await fetch(`${base}${path}`, { ...init, headers, cache: "no-store", redirect: "error", signal: init.signal ?? AbortSignal.timeout(timeout) });
  const text = await response.text();
  if (!response.ok) throw new AlpacaRequestError(response.status, text || response.statusText);
  return (text ? JSON.parse(text) : null) as T;
}

function withPageToken(path: string, token: string) {
  return `${path}${path.includes("?") ? "&" : "?"}page_token=${encodeURIComponent(token)}`;
}

async function paginatedRecords<T extends Record<string, unknown>>(base: string, path: string, field: string) {
  const records: T[] = [];
  let token = "";
  let pages = 0;
  const maxPages = numberEnv("ALPACA_MAX_OPTION_PAGES", 12);
  do {
    const page = await request<Record<string, unknown>>(base, token ? withPageToken(path, token) : path);
    const values = page[field];
    if (Array.isArray(values)) records.push(...values as T[]);
    token = typeof page.next_page_token === "string" ? page.next_page_token : "";
    pages += 1;
  } while (token && pages < maxPages);
  return { records, pages, truncated: Boolean(token), nextPageToken: token || null };
}

async function paginatedSnapshots(symbol: string, filters: { start?: string; end?: string; type?: "call" | "put" } = {}) {
  const feed = process.env.ALPACA_OPTIONS_FEED ?? "indicative";
  const params = new URLSearchParams({ feed, limit: "1000" });
  if (filters.start) params.set("expiration_date_gte", filters.start);
  if (filters.end) params.set("expiration_date_lte", filters.end);
  if (filters.type) params.set("type", filters.type);
  const basePath = `/v1beta1/options/snapshots/${encodeURIComponent(symbol)}?${params.toString()}`;
  const snapshots: Record<string, Record<string, unknown>> = {};
  let token = "";
  let pages = 0;
  const maxPages = numberEnv("ALPACA_MAX_OPTION_PAGES", 12);
  do {
    const page = await request<{ snapshots?: Record<string, Record<string, unknown>>; next_page_token?: string }>(dataBase(), token ? withPageToken(basePath, token) : basePath);
    Object.assign(snapshots, page.snapshots ?? {});
    token = page.next_page_token ?? "";
    pages += 1;
  } while (token && pages < maxPages);
  return { snapshots, next_page_token: token || null, meta: { feed, pages, truncated: Boolean(token), contracts: Object.keys(snapshots).length } };
}

async function paginatedStockBars(symbols: string[], start: string, end: string) {
  const feed = process.env.ALPACA_STOCK_FEED ?? "iex";
  const params = new URLSearchParams({ symbols: symbols.join(","), timeframe: "1Day", start, end, adjustment: "all", feed, limit: "10000" });
  const basePath = `/v2/stocks/bars?${params.toString()}`;
  const bars: Record<string, Array<Record<string, unknown>>> = {};
  let token = "";
  let pages = 0;
  const maxPages = numberEnv("ALPACA_MAX_DATA_PAGES", 20);
  do {
    const page = await request<{ bars?: Record<string, Array<Record<string, unknown>>>; next_page_token?: string }>(dataBase(), token ? withPageToken(basePath, token) : basePath);
    for (const [symbol, values] of Object.entries(page.bars ?? {})) bars[symbol] = [...(bars[symbol] ?? []), ...values];
    token = page.next_page_token ?? "";
    pages += 1;
  } while (token && pages < maxPages);
  return { bars, next_page_token: token || null, meta: { feed, pages, truncated: Boolean(token), bars: Object.values(bars).reduce((total, values) => total + values.length, 0) } };
}

async function paginatedNews(symbols: string[], totalLimit: number, start?: string) {
  const news: Array<Record<string, unknown>> = [];
  let token = "";
  let pages = 0;
  const maxPages = numberEnv("ALPACA_MAX_NEWS_PAGES", 4);
  do {
    const remaining = Math.max(1, totalLimit - news.length);
    const params = new URLSearchParams({ symbols: symbols.join(","), limit: String(Math.min(50, remaining)), sort: "desc" });
    if (start) params.set("start", start);
    const basePath = `/v1beta1/news?${params.toString()}`;
    const page = await request<{ news?: Array<Record<string, unknown>>; next_page_token?: string }>(dataBase(), token ? withPageToken(basePath, token) : basePath);
    news.push(...(page.news ?? []));
    token = page.next_page_token ?? "";
    pages += 1;
  } while (token && pages < maxPages && news.length < totalLimit);
  return { news: news.slice(0, totalLimit), next_page_token: token || null, meta: { pages, truncated: Boolean(token && news.length < totalLimit), articles: Math.min(news.length, totalLimit) } };
}

export const alpaca = {
  account: () => request<Record<string, unknown>>(paperBase(), "/v2/account"),
  clock: () => request<{ is_open: boolean; next_open?: string; next_close?: string; timestamp?: string }>(paperBase(), "/v2/clock"),
  calendar: (start: string, end: string) => request<Array<Record<string, unknown>>>(paperBase(), `/v2/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),
  positions: () => request<Array<Record<string, unknown>>>(paperBase(), "/v2/positions"),
  orders: (status: "open" | "closed" | "all" = "open", limit = 500) => request<Array<Record<string, unknown>>>(paperBase(), `/v2/orders?status=${status}&direction=desc&nested=true&limit=${limit}`),
  order: (orderId: string) => request<Record<string, unknown>>(paperBase(), `/v2/orders/${encodeURIComponent(orderId)}?nested=true`),
  orderByClientOrderId: (clientOrderId: string) => request<Record<string, unknown>>(paperBase(), `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`),
  portfolioHistory: () => request<{ timestamp?: number[]; equity?: number[]; profit_loss?: number[]; profit_loss_pct?: number[] }>(paperBase(), "/v2/account/portfolio/history?period=1M&timeframe=1D"),
  accountConfig: () => request<Record<string, unknown>>(paperBase(), "/v2/account/configurations"),
  updateAccountConfig: (body: Record<string, unknown>) => request<Record<string, unknown>>(paperBase(), "/v2/account/configurations", {
    method: "PATCH", body: JSON.stringify(body),
  }),
  cancelAllOrders: () => request<Array<Record<string, unknown>> | null>(paperBase(), "/v2/orders", { method: "DELETE" }),
  cancelOrder: (orderId: string) => request<null>(paperBase(), `/v2/orders/${encodeURIComponent(orderId)}`, { method: "DELETE" }),
  contracts: async (symbol: string, start: string, end: string, type: "call" | "put" = "call") => {
    const path = `/v2/options/contracts?underlying_symbols=${encodeURIComponent(symbol)}&status=active&type=${type}&expiration_date_gte=${start}&expiration_date_lte=${end}&limit=10000`;
    const page = await paginatedRecords<Record<string, unknown>>(paperBase(), path, "option_contracts");
    return { option_contracts: page.records, next_page_token: page.nextPageToken, meta: { pages: page.pages, truncated: page.truncated, contracts: page.records.length } };
  },
  snapshots: paginatedSnapshots,
  optionSnapshots: async (symbols: string[]) => {
    const feed = process.env.ALPACA_OPTIONS_FEED ?? "indicative";
    if (!symbols.length) return { snapshots: {}, meta: { feed, pages: 0, truncated: false, contracts: 0 } };
    const response = await request<{ snapshots?: Record<string, Record<string, unknown>> }>(dataBase(), `/v1beta1/options/snapshots?symbols=${encodeURIComponent(symbols.join(","))}&feed=${encodeURIComponent(feed)}`);
    return { snapshots: response.snapshots ?? {}, meta: { feed, pages: 1, truncated: false, contracts: Object.keys(response.snapshots ?? {}).length } };
  },
  stockSnapshot: (symbol: string) => request<Record<string, unknown>>(dataBase(), `/v2/stocks/${encodeURIComponent(symbol)}/snapshot?feed=${encodeURIComponent(process.env.ALPACA_STOCK_FEED ?? "iex")}`),
  stockBars: paginatedStockBars,
  news: paginatedNews,
  submitOrder: (body: Record<string, unknown>) => request<Record<string, unknown>>(paperBase(), "/v2/orders", {
    method: "POST", body: JSON.stringify(body),
  }),
};
