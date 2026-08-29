create table if not exists public.agent_settings (
  id boolean primary key default true check (id),
  trading_enabled boolean not null default false,
  max_premium_per_trade numeric not null default 500 check (max_premium_per_trade > 0),
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
  raw jsonb
);

create index if not exists agent_decisions_created_at_idx on public.agent_decisions (created_at desc);

alter table public.agent_settings enable row level security;
alter table public.agent_decisions enable row level security;
