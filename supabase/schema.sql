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

-- VolForge v4: calibrated quant models, digital-twin shadowing, and failure-safe execution.
-- Safe to run repeatedly in the Supabase SQL Editor.

alter table public.agent_settings
  add column if not exists emergency_stop boolean not null default false;

alter table public.shadow_positions add column if not exists updated_at timestamptz not null default now();
alter table public.shadow_positions add column if not exists idempotency_key text;
alter table public.shadow_positions add column if not exists long_leg text;
alter table public.shadow_positions add column if not exists short_leg text;
alter table public.shadow_positions add column if not exists contract_type text;
alter table public.shadow_positions add column if not exists max_loss numeric;
alter table public.shadow_positions add column if not exists max_reward numeric;
alter table public.shadow_positions add column if not exists max_adverse_excursion numeric not null default 0;
alter table public.shadow_positions add column if not exists max_favorable_excursion numeric not null default 0;
alter table public.shadow_positions add column if not exists last_mark_at timestamptz;
alter table public.shadow_positions add column if not exists metadata jsonb not null default '{}'::jsonb;

update public.shadow_positions
set
  idempotency_key = coalesce(idempotency_key, 'legacy:shadow:' || id::text),
  long_leg = coalesce(long_leg, split_part(symbol, '/', 1)),
  short_leg = coalesce(short_leg, nullif(split_part(symbol, '/', 2), ''), split_part(symbol, '/', 1)),
  contract_type = coalesce(contract_type, case when split_part(symbol, '/', 1) ~ '\d{6}P\d{8}$' then 'put' else 'call' end),
  max_loss = coalesce(max_loss, entry_price * 100 * quantity),
  max_reward = coalesce(max_reward, 0)
where idempotency_key is null
   or long_leg is null
   or short_leg is null
   or contract_type is null
   or max_loss is null
   or max_reward is null;

alter table public.shadow_positions alter column idempotency_key set not null;
alter table public.shadow_positions alter column long_leg set not null;
alter table public.shadow_positions alter column short_leg set not null;
alter table public.shadow_positions alter column contract_type set not null;
alter table public.shadow_positions alter column max_loss set not null;
alter table public.shadow_positions alter column max_reward set not null;

create unique index if not exists shadow_positions_idempotency_uidx
  on public.shadow_positions (idempotency_key);
create index if not exists shadow_positions_active_idx
  on public.shadow_positions (underlying, status, created_at desc);

alter table public.execution_intents add column if not exists contract_type text not null default 'call';
alter table public.execution_intents add column if not exists filled_quantity integer not null default 0;
alter table public.execution_intents add column if not exists entry_limit_price numeric;
alter table public.execution_intents add column if not exists max_entry_debit numeric;
alter table public.execution_intents add column if not exists exit_credit numeric;
alter table public.execution_intents add column if not exists entry_attempts integer not null default 0;
alter table public.execution_intents add column if not exists exit_attempts integer not null default 0;
alter table public.execution_intents add column if not exists last_reconciled_at timestamptz;
alter table public.execution_intents add column if not exists last_error text;

update public.execution_intents
set
  contract_type = case when long_leg ~ '\d{6}P\d{8}$' then 'put' else 'call' end,
  entry_limit_price = coalesce(entry_limit_price, entry_debit),
  max_entry_debit = coalesce(max_entry_debit, entry_debit),
  entry_attempts = greatest(entry_attempts, case when entry_order_id is null then 0 else 1 end)
where entry_limit_price is null
   or max_entry_debit is null
   or entry_attempts = 0;

alter table public.execution_intents drop constraint if exists execution_intents_status_check;
alter table public.execution_intents add constraint execution_intents_status_check check (
  status in (
    'entry_pending',
    'entry_submitted',
    'entry_partial',
    'entry_cancel_pending',
    'open',
    'exit_pending',
    'exit_submitted',
    'exit_partial',
    'exit_cancel_pending',
    'closed',
    'canceled',
    'reconciliation_error',
    'error'
  )
);

alter table public.order_events add column if not exists event_key text;
create unique index if not exists order_events_event_key_uidx
  on public.order_events (event_key);

alter table public.calibration_snapshots add column if not exists brier_score numeric;
alter table public.calibration_snapshots add column if not exists mean_absolute_error numeric;

create table if not exists public.model_manifests (
  manifest_hash text primary key,
  created_at timestamptz not null default now(),
  strategy_version text not null,
  symbol text not null,
  horizon_trading_days integer not null check (horizon_trading_days > 0),
  dataset_hash text not null,
  manifest jsonb not null,
  validation jsonb not null
);

create index if not exists model_manifests_strategy_idx
  on public.model_manifests (strategy_version, symbol, horizon_trading_days, created_at desc);

create table if not exists public.shadow_marks (
  id uuid primary key default gen_random_uuid(),
  shadow_position_id uuid not null references public.shadow_positions(id) on delete cascade,
  trace_id uuid not null,
  marked_at timestamptz not null default now(),
  executable_price numeric not null,
  midpoint_price numeric not null,
  pnl numeric not null,
  quote_age_ms integer,
  feed text,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists shadow_marks_position_idx
  on public.shadow_marks (shadow_position_id, marked_at desc);

create table if not exists public.service_heartbeats (
  service text primary key,
  instance_id text not null,
  status text not null check (status in ('healthy', 'degraded', 'stopped')),
  last_seen_at timestamptz not null,
  details jsonb not null default '{}'::jsonb
);

create table if not exists public.agent_leases (
  name text primary key,
  owner text not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create or replace function public.acquire_agent_lease(
  p_lease_name text,
  p_lease_owner text,
  p_ttl_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  if p_ttl_seconds < 1 or p_ttl_seconds > 3600 then
    raise exception 'ttl outside permitted range';
  end if;

  insert into public.agent_leases (name, owner, acquired_at, expires_at)
  values (p_lease_name, p_lease_owner, now(), now() + make_interval(secs => p_ttl_seconds))
  on conflict (name) do update
    set owner = excluded.owner,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at
    where public.agent_leases.expires_at <= now()
       or public.agent_leases.owner = excluded.owner;

  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.release_agent_lease(
  p_lease_name text,
  p_lease_owner text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  delete from public.agent_leases
  where name = p_lease_name
    and owner = p_lease_owner;

  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.renew_agent_lease(
  p_lease_name text,
  p_lease_owner text,
  p_ttl_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  if p_ttl_seconds < 1 or p_ttl_seconds > 3600 then
    raise exception 'ttl outside permitted range';
  end if;

  update public.agent_leases
  set expires_at = now() + make_interval(secs => p_ttl_seconds)
  where name = p_lease_name
    and owner = p_lease_owner;

  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

grant execute on function public.acquire_agent_lease(text, text, integer) to service_role;
grant execute on function public.release_agent_lease(text, text) to service_role;
grant execute on function public.renew_agent_lease(text, text, integer) to service_role;

alter table public.model_manifests enable row level security;
alter table public.shadow_marks enable row level security;
alter table public.service_heartbeats enable row level security;
alter table public.agent_leases enable row level security;

create table if not exists public.competition_attestations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  account_id text not null,
  account_fingerprint text not null,
  observed_equity numeric not null,
  options_level integer not null,
  position_count integer not null,
  historical_order_count integer not null,
  eligible_preflight boolean not null,
  gates jsonb not null default '[]'::jsonb,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists competition_attestations_created_idx
  on public.competition_attestations (created_at desc);

alter table public.competition_attestations enable row level security;

create table if not exists public.cli_preflights (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  account_id text not null,
  paper boolean not null,
  market_open boolean not null,
  cli_version text not null,
  evidence_hash text not null,
  healthy boolean not null,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists cli_preflights_created_idx
  on public.cli_preflights (created_at desc);

create table if not exists public.control_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  action text not null check (action in ('run_agent')),
  status text not null check (status in ('pending', 'running', 'completed', 'error')),
  requested_by text not null,
  claimed_by text,
  claimed_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  error text
);

create index if not exists control_requests_claim_idx
  on public.control_requests (status, created_at);
create unique index if not exists control_requests_single_active_idx
  on public.control_requests (action)
  where status in ('pending', 'running');

create or replace function public.claim_control_request(p_worker text)
returns setof public.control_requests
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_worker is null or length(p_worker) < 3 then
    raise exception 'invalid control worker';
  end if;

  return query
  with next_request as (
    select id
    from public.control_requests
    where status = 'pending'
       or (status = 'running' and claimed_at < now() - interval '15 minutes')
    order by created_at asc
    for update skip locked
    limit 1
  )
  update public.control_requests request
  set status = 'running',
      claimed_by = p_worker,
      claimed_at = now(),
      updated_at = now(),
      error = null
  from next_request
  where request.id = next_request.id
  returning request.*;
end;
$$;

create table if not exists public.dashboard_login_limits (
  fingerprint text primary key,
  window_started_at timestamptz not null default now(),
  failures integer not null default 0,
  blocked_until timestamptz,
  updated_at timestamptz not null default now()
);

create or replace function public.register_dashboard_login(
  p_fingerprint text,
  p_success boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_failures integer := 0;
  current_blocked_until timestamptz;
  retry_after integer := 0;
begin
  if p_fingerprint is null or length(p_fingerprint) < 16 then
    raise exception 'invalid login fingerprint';
  end if;

  select failures, blocked_until
  into current_failures, current_blocked_until
  from public.dashboard_login_limits
  where fingerprint = p_fingerprint
  for update;

  if current_blocked_until is not null and current_blocked_until > now() then
    retry_after := greatest(1, ceil(extract(epoch from (current_blocked_until - now())))::integer);
    return jsonb_build_object('allowed', false, 'blocked', true, 'retry_after_seconds', retry_after);
  end if;

  if p_success then
    delete from public.dashboard_login_limits where fingerprint = p_fingerprint;
    return jsonb_build_object('allowed', true, 'blocked', false, 'retry_after_seconds', 0);
  end if;

  insert into public.dashboard_login_limits (fingerprint, window_started_at, failures, blocked_until, updated_at)
  values (p_fingerprint, now(), 1, null, now())
  on conflict (fingerprint) do update
    set failures = case
          when public.dashboard_login_limits.window_started_at <= now() - interval '10 minutes' then 1
          else public.dashboard_login_limits.failures + 1
        end,
        window_started_at = case
          when public.dashboard_login_limits.window_started_at <= now() - interval '10 minutes' then now()
          else public.dashboard_login_limits.window_started_at
        end,
        blocked_until = case
          when public.dashboard_login_limits.window_started_at > now() - interval '10 minutes'
           and public.dashboard_login_limits.failures + 1 >= 5
          then now() + interval '15 minutes'
          else null
        end,
        updated_at = now()
  returning failures, blocked_until into current_failures, current_blocked_until;

  retry_after := case
    when current_blocked_until is not null and current_blocked_until > now()
    then greatest(1, ceil(extract(epoch from (current_blocked_until - now())))::integer)
    else 0
  end;

  return jsonb_build_object(
    'allowed', false,
    'blocked', retry_after > 0,
    'retry_after_seconds', retry_after,
    'failures', current_failures
  );
end;
$$;

revoke execute on function public.acquire_agent_lease(text, text, integer) from public, anon, authenticated;
revoke execute on function public.release_agent_lease(text, text) from public, anon, authenticated;
revoke execute on function public.renew_agent_lease(text, text, integer) from public, anon, authenticated;
revoke execute on function public.claim_control_request(text) from public, anon, authenticated;
revoke execute on function public.register_dashboard_login(text, boolean) from public, anon, authenticated;
grant execute on function public.claim_control_request(text) to service_role;
grant execute on function public.register_dashboard_login(text, boolean) to service_role;

alter table public.cli_preflights enable row level security;
alter table public.control_requests enable row level security;
alter table public.dashboard_login_limits enable row level security;

notify pgrst, 'reload schema';
