-- VolForge v3: broker-safe execution ledger. Run once in Supabase SQL Editor.
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
alter table public.execution_intents enable row level security;

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
alter table public.market_observations enable row level security;
alter table public.engine_evaluations enable row level security;

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
alter table public.calibration_snapshots enable row level security;
notify pgrst, 'reload schema';
