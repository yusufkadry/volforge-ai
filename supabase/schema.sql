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
alter table public.risk_snapshots enable row level security;
