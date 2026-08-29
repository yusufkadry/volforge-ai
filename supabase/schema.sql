create table if not exists public.agent_settings (
  id boolean primary key default true check (id),
  trading_enabled boolean not null default false,
  max_premium_per_trade numeric not null default 500 check (max_premium_per_trade > 0),
  max_daily_loss numeric not null default 1000 check (max_daily_loss > 0),
  max_open_positions integer not null default 3 check (max_open_positions > 0),
  promotion_stage text not null default 'research' check (promotion_stage in ('research', 'shadow', 'paper')),
  updated_at timestamptz not null default now()
);

insert into public.agent_settings (id, trading_enabled, max_premium_per_trade)
values (true, false, 500)
on conflict (id) do nothing;

create table if not exists public.agent_decisions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source text not null,
  underlying text not null,
  option_symbol text,
  side text,
  score numeric,
  implied_volatility numeric,
  expected_move numeric,
  status text not null check (status in ('SCANNED', 'REJECTED', 'APPROVED', 'SUBMITTED', 'ERROR')),
  rationale text not null,
  risk_gates jsonb not null default '[]'::jsonb,
  order_id text,
  raw jsonb,
  trace_id uuid,
  strategy_version text,
  model_score numeric,
  data_freshness_ms integer
);

create index if not exists agent_decisions_created_at_idx on public.agent_decisions (created_at desc);
create index if not exists agent_decisions_trace_id_idx on public.agent_decisions (trace_id);

create table if not exists public.strategy_versions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  version text not null unique,
  status text not null check (status in ('research', 'shadow', 'champion', 'retired')),
  hypothesis text not null,
  parameters jsonb not null,
  validation jsonb not null default '{}'::jsonb,
  constitution_hash text not null
);

create table if not exists public.research_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  strategy_version text not null,
  universe text[] not null,
  report jsonb not null,
  promotion_recommendation text not null check (promotion_recommendation in ('reject', 'shadow', 'paper')),
  trace_id uuid not null
);

create table if not exists public.shadow_positions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  trace_id uuid not null,
  strategy_version text not null,
  decision_id uuid references public.agent_decisions(id) on delete set null,
  symbol text not null,
  underlying text not null,
  side text not null,
  entry_price numeric not null,
  current_price numeric not null,
  exit_price numeric,
  quantity integer not null default 1,
  status text not null check (status in ('open', 'closed', 'rejected')),
  rationale text not null,
  pnl numeric not null default 0,
  exit_reason text
);

create table if not exists public.order_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  trace_id uuid,
  alpaca_order_id text,
  client_order_id text,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists order_events_order_idx on public.order_events (alpaca_order_id, created_at desc);

create table if not exists public.execution_intents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  trace_id uuid not null,
  strategy_version text not null,
  idempotency_key text not null unique,
  stage text not null check (stage in ('paper')),
  status text not null check (status in ('entry_pending', 'entry_submitted', 'open', 'exit_submitted', 'closed', 'canceled', 'error')),
  underlying text not null,
  long_leg text not null,
  short_leg text not null,
  quantity integer not null check (quantity > 0),
  entry_debit numeric not null check (entry_debit > 0),
  current_debit numeric,
  max_loss numeric not null check (max_loss > 0),
  max_reward numeric not null check (max_reward >= 0),
  entry_order_id text,
  exit_order_id text,
  exit_reason text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists execution_intents_active_idx on public.execution_intents (underlying, status, created_at desc);
create index if not exists execution_intents_entry_order_idx on public.execution_intents (entry_order_id);
create index if not exists execution_intents_exit_order_idx on public.execution_intents (exit_order_id);

create table if not exists public.market_observations (
  id uuid primary key default gen_random_uuid(),
  captured_at timestamptz not null default now(),
  trace_id uuid,
  engine text not null,
  underlying text not null,
  option_symbol text,
  payload jsonb not null default '{}'::jsonb
);

create table if not exists public.engine_evaluations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  trace_id uuid not null,
  engine text not null,
  verdict text not null check (verdict in ('approve', 'veto', 'abstain')),
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  expires_at timestamptz,
  evidence_hash text not null,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists market_observations_engine_idx on public.market_observations (engine, underlying, captured_at desc);
create index if not exists engine_evaluations_trace_idx on public.engine_evaluations (trace_id, created_at desc);

create table if not exists public.calibration_snapshots (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  strategy_version text not null,
  sample_size integer not null,
  predicted_ev numeric not null,
  realized_pnl numeric not null,
  predicted_win_rate numeric not null,
  realized_win_rate numeric not null,
  status text not null check (status in ('warming', 'calibrated', 'degraded')),
  report jsonb not null default '{}'::jsonb
);

create index if not exists calibration_snapshots_strategy_idx on public.calibration_snapshots (strategy_version, created_at desc);

create table if not exists public.risk_snapshots (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  trace_id uuid,
  account_equity numeric,
  daily_pnl numeric,
  premium_at_risk numeric,
  open_positions integer not null,
  exposure jsonb not null default '{}'::jsonb,
  circuit_breakers jsonb not null default '[]'::jsonb
);

-- Allows the same SQL to upgrade an earlier VolForge deployment.
alter table public.agent_settings add column if not exists max_daily_loss numeric not null default 1000;
alter table public.agent_settings add column if not exists max_open_positions integer not null default 3;
alter table public.agent_settings add column if not exists promotion_stage text not null default 'research';
alter table public.agent_decisions add column if not exists trace_id uuid;
alter table public.agent_decisions add column if not exists strategy_version text;
alter table public.agent_decisions add column if not exists model_score numeric;
alter table public.agent_decisions add column if not exists data_freshness_ms integer;

alter table public.agent_settings enable row level security;
alter table public.agent_decisions enable row level security;
alter table public.strategy_versions enable row level security;
alter table public.research_runs enable row level security;
alter table public.shadow_positions enable row level security;
alter table public.order_events enable row level security;
alter table public.execution_intents enable row level security;
alter table public.market_observations enable row level security;
alter table public.engine_evaluations enable row level security;
alter table public.calibration_snapshots enable row level security;
alter table public.risk_snapshots enable row level security;
