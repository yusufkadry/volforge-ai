export type RiskGate = { name: string; passed: boolean; detail: string };

export type SurfaceDiagnostics = {
  fairIv: number;
  residualIv: number;
  relativeResidual: number;
  residualZScore: number;
  fitRmse: number;
  localScale: number;
  neighborCount: number;
  model: "robust-moneyness-tenor-v1";
};

export type Candidate = {
  optionSymbol: string;
  underlying: string;
  contractType: "call" | "put";
  strike: number;
  expirationDate: string;
  dte: number;
  bid: number;
  ask: number;
  midpoint: number;
  impliedVolatility: number;
  spot: number;
  logMoneyness: number;
  surface: SurfaceDiagnostics;
  /** Backward-compatible aliases used by historical decision records. */
  expiryMedianIv: number;
  anomalyScore: number;
  delta?: number;
  vega?: number;
  openInterest?: number;
  quoteTimestamp?: string;
  dataFeed: string;
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
  /** Controls new paper entries only. Existing exposure is always managed. */
  trading_enabled: boolean;
  emergency_stop: boolean;
  max_premium_per_trade: number;
  max_daily_loss: number;
  max_open_positions: number;
  promotion_stage: "research" | "shadow" | "paper";
  updated_at?: string;
};

export type ModelManifest = {
  modelVersion: string;
  featureNames: string[];
  horizonTradingDays: number;
  dataStart: string;
  dataEnd: string;
  trainingSamples: number;
  regression: { means: number[]; scales: number[]; weights: number[]; targetMean: number; targetScale: number };
  classifier: { means: number[]; scales: number[]; weights: number[]; probabilityShrinkage: number };
  datasetHash: string;
  manifestHash: string;
};

export type ValidationBin = {
  lower: number;
  upper: number;
  predictions: number;
  meanPrediction: number;
  observedFrequency: number;
};

export type HorizonValidation = {
  mae: number;
  baselineMae: number;
  brier: number;
  baselineBrier: number;
  brierSkill: number;
  directionAccuracy: number;
  observations: number;
  oosObservations: number;
  purgedSamples: number;
  embargoDays: number;
  folds: number;
  calibration: ValidationBin[];
  stress: {
    highVolatilityMae: number;
    highVolatilitySamples: number;
    downsideDirectionAccuracy: number;
    downsideSamples: number;
  };
};

export type HorizonForecast = {
  horizonTradingDays: number;
  forecastRv: number;
  rawProbabilityUp: number;
  probabilityUp: number;
  expectedLogReturn: number;
  sigmaLogReturn: number;
  validation: HorizonValidation;
  featureValues: number[];
  manifest: ModelManifest;
};

export type ResearchForecast = {
  symbol: string;
  generatedAt: string;
  horizons: HorizonForecast[];
  /** The 20-trading-day forecast used for directional chain selection. */
  forecastRv: number;
  probabilityUp: number;
  validation: HorizonValidation;
  featureValues: number[];
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
  updated_at?: string;
  closed_at?: string | null;
  trace_id: string;
  strategy_version: string;
  decision_id?: string | null;
  idempotency_key: string;
  symbol: string;
  underlying: string;
  long_leg: string;
  short_leg: string;
  contract_type: "call" | "put";
  side: string;
  entry_price: number;
  current_price: number;
  exit_price?: number | null;
  quantity: number;
  max_loss: number;
  max_reward: number;
  status: "open" | "closed" | "rejected";
  rationale: string;
  pnl: number;
  max_adverse_excursion: number;
  max_favorable_excursion: number;
  last_mark_at?: string | null;
  exit_reason?: string | null;
  metadata?: Record<string, unknown>;
};

export type ExecutionStatus =
  | "entry_pending"
  | "entry_submitted"
  | "entry_partial"
  | "entry_cancel_pending"
  | "open"
  | "exit_pending"
  | "exit_submitted"
  | "exit_partial"
  | "exit_cancel_pending"
  | "closed"
  | "canceled"
  | "reconciliation_error"
  | "error";

export type ExecutionIntent = {
  id?: string;
  created_at?: string;
  updated_at?: string;
  trace_id: string;
  strategy_version: string;
  idempotency_key: string;
  stage: "paper";
  status: ExecutionStatus;
  underlying: string;
  contract_type: "call" | "put";
  long_leg: string;
  short_leg: string;
  quantity: number;
  filled_quantity?: number;
  entry_debit: number;
  entry_limit_price?: number | null;
  max_entry_debit?: number | null;
  current_debit?: number | null;
  exit_credit?: number | null;
  max_loss: number;
  max_reward: number;
  entry_order_id?: string | null;
  exit_order_id?: string | null;
  entry_attempts?: number;
  exit_attempts?: number;
  last_reconciled_at?: string | null;
  exit_reason?: string | null;
  last_error?: string | null;
  metadata?: Record<string, unknown>;
};

export type CalibrationSnapshot = {
  id?: string;
  created_at?: string;
  strategy_version: string;
  sample_size: number;
  predicted_ev: number;
  realized_pnl: number;
  predicted_win_rate: number;
  realized_win_rate: number;
  brier_score?: number;
  mean_absolute_error?: number;
  status: "warming" | "calibrated" | "degraded";
  report: Record<string, unknown>;
};

export type ServiceHeartbeat = {
  service: string;
  instance_id: string;
  status: "healthy" | "degraded" | "stopped";
  last_seen_at: string;
  details: Record<string, unknown>;
};

export type CliPreflight = {
  id?: string;
  created_at?: string;
  account_id: string;
  paper: boolean;
  market_open: boolean;
  cli_version: string;
  evidence_hash: string;
  healthy: boolean;
  payload: Record<string, unknown>;
};

export type ControlRequest = {
  id: string;
  created_at?: string;
  updated_at?: string;
  action: "run_agent";
  status: "pending" | "running" | "completed" | "error";
  requested_by: string;
  claimed_by?: string | null;
  claimed_at?: string | null;
  completed_at?: string | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
};

export type DashboardSnapshot = {
  account: Record<string, unknown> | null;
  positions: Array<Record<string, unknown>>;
  orders: Array<Record<string, unknown>>;
  decisions: Decision[];
  decisionTotal: number;
  submittedDecisionTotal: number;
  latestMarketDecision: Decision | null;
  latestResearchDecision: Decision | null;
  settings: AgentSettings;
  research: ResearchRun[];
  shadowPositions: ShadowPosition[];
  riskSnapshot: Record<string, unknown> | null;
  intents: ExecutionIntent[];
  calibration: CalibrationSnapshot | null;
  executionHeartbeat: ServiceHeartbeat | null;
  cliPreflight: CliPreflight | null;
  latestControlRequest: ControlRequest | null;
  accountAttestation: Record<string, unknown> | null;
  portfolioHistory?: { timestamp?: number[]; equity?: number[]; profit_loss?: number[]; profit_loss_pct?: number[] } | null;
  marketOpen: boolean;
  nextOpen: string | null;
  errors: string[];
};
