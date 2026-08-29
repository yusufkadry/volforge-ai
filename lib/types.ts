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
};

export type AgentSettings = {
  trading_enabled: boolean;
  max_premium_per_trade: number;
  updated_at?: string;
};

export type DashboardSnapshot = {
  account: Record<string, unknown> | null;
  positions: Array<Record<string, unknown>>;
  orders: Array<Record<string, unknown>>;
  decisions: Decision[];
  settings: AgentSettings;
  marketOpen: boolean;
  nextOpen: string | null;
  errors: string[];
};
