export type RiskGate = { name: string; passed: boolean; detail: string };

export type Candidate = {
  optionSymbol: string;
  underlying: string;
  contractType: "call" | "put";
  strike: number;
  expirationDate: string;
  dte: number;
  bid: number;
  ask: number;
  impliedVolatility: number;
  expiryMedianIv: number;
  anomalyScore: number;
  delta?: number;
  openInterest?: number;
  quoteTimestamp?: string;
  tradable: boolean;
};

export type Decision = {
  id?: string;
  created_at?: string;
  source: string;
  underlying: string;
  option_symbol: string | null;
  side: string | null;
  score: number | null;
  implied_volatility: number | null;
  expected_move: number | null;
  status: "SCANNED" | "REJECTED" | "APPROVED" | "SUBMITTED" | "ERROR";
  rationale: string;
  risk_gates: RiskGate[];
  order_id?: string | null;
  trace_id?: string;
  strategy_version?: string;
  model_score?: number | null;
  data_freshness_ms?: number | null;
  raw?: Record<string, unknown>;
};

export type AgentSettings = {
  trading_enabled: boolean;
  max_premium_per_trade: number;
  max_daily_loss: number;
  max_open_positions: number;
  promotion_stage: "research" | "shadow" | "paper";
  updated_at?: string;
};

export type ResearchRun = {
  id?: string;
  created_at?: string;
  strategy_version: string;
  universe: string[];
  report: Record<string, unknown>;
  promotion_recommendation: "reject" | "shadow" | "paper";
  trace_id: string;
};

export type ShadowPosition = {
  id?: string;
  created_at?: string;
  closed_at?: string | null;
  trace_id: string;
  strategy_version: string;
  decision_id?: string | null;
  symbol: string;
  underlying: string;
  side: string;
  entry_price: number;
  current_price: number;
  exit_price?: number | null;
  quantity: number;
  status: "open" | "closed" | "rejected";
  rationale: string;
  pnl: number;
  exit_reason?: string | null;
};

export type DashboardSnapshot = {
  account: Record<string, unknown> | null;
  positions: Array<Record<string, unknown>>;
  orders: Array<Record<string, unknown>>;
  decisions: Decision[];
  settings: AgentSettings;
  research: ResearchRun[];
  shadowPositions: ShadowPosition[];
  riskSnapshot: Record<string, unknown> | null;
  marketOpen: boolean;
  nextOpen: string | null;
  errors: string[];
};
