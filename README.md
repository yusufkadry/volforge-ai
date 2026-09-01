# VolForge AI

VolForge is an autonomous options research, shadow-validation, and Alpaca paper-execution control plane. It promotes evidence through three capital stages: statistically validated research, an executable-price shadow digital twin, and atomic defined-risk paper spreads.

The system is designed for the Alpaca AI Trading Agents Hackathon. It uses Alpaca Trading and Market Data APIs, Alpaca CLI preflights, Level 3 multi-leg options orders, GitHub Actions, an always-on Railway execution worker, Supabase, OpenAI, and a protected Vercel command room.

## What makes it different

VolForge does not ask an LLM to invent a trade. Independent numerical engines produce auditable evidence:

| Engine | Authority |
|---|---|
| Surface | Rejects non-economic chain artifacts, fits robust IV against log-moneyness and tenor, then measures liquid local residuals and z-scores. |
| Dual-alpha router | Admits either a true surface-value dislocation or a calibrated holding-horizon directional thesis; both routes still face identical payoff and risk gates. |
| Regime | Trains horizon-specific volatility and direction models with purged walk-forward validation and embargoes. |
| Distribution | Integrates vertical-spread mark-forward P&L across calibrated base, fat-tail, and adverse stress scenarios. |
| Event Intelligence | Deduplicates and scores source-qualified news by recency, event type, impact, and contradiction. It may veto only. |
| Portfolio Governor | Enforces defined loss, concentration, delta, vega, CVaR, session, deadline, and account-level limits. |
| Red Team | Challenges evidence consistency. The LLM can veto but can never override deterministic controls. |
| Execution | Reserves idempotent intent, submits atomic `mleg` orders, ladders limits, reconciles REST and stream truth, and manages exits. |

Every model decision stores a strategy version, constitution hash, dataset hash, model manifest, validation evidence, quote feed, market trace, court opinions, risk snapshot, and broker lifecycle.

## Runtime architecture

| Service | Responsibility |
|---|---|
| Railway | Primary five-minute strategy cycle, 30-second broker reconciliation, position supervision, emergency liquidation, and Alpaca trade stream. |
| GitHub Actions | Independent 15-minute market watchdog, pinned Alpaca CLI entry oracle, four-hour research factory, premarket refresh, CI, and competition-account attestation. |
| Vercel | Password-protected command room. Manual scans are durable commands consumed by Railway, not long-running Vercel requests. |
| Supabase | Immutable decisions, research runs, model manifests, shadow marks, execution intents, order events, leases, heartbeats, calibration, and settings. |
| Alpaca Paper | Account truth, market data, options contracts, atomic multi-leg paper orders, positions, and portfolio history. |

Railway and GitHub share a renewable Supabase lease. Dashboard requests enter a durable, deduplicated command queue that Railway claims under the same lease, so only one process may make a capital decision at a time.

## Required deployment update

For an existing VolForge database, open **Supabase > SQL Editor**, paste the complete contents of [`supabase/upgrade_v4.sql`](supabase/upgrade_v4.sql), and run it once. It is idempotent and reloads the PostgREST schema cache.

For a new Supabase project, run [`supabase/schema.sql`](supabase/schema.sql) instead. It contains the consolidated schema including v4.

Then commit this repository. Vercel, Railway, and GitHub Actions redeploy from GitHub.

## Environment placement

The authoritative list and defaults are in [`.env.example`](.env.example).

### Vercel

Required secrets:

- `ALPACA_API_KEY`
- `ALPACA_SECRET_KEY`
- `ALPACA_PAPER_BASE_URL=https://paper-api.alpaca.markets`
- `ALPACA_DATA_BASE_URL=https://data.alpaca.markets`
- `ALPACA_OPTIONS_FEED=indicative` or `opra` when entitled
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `DASHBOARD_PASSWORD`
- `AUTH_SECRET`

Add optional strategy variables from `.env.example` only when overriding the audited defaults.

### GitHub Actions

Under **Settings > Secrets and variables > Actions**, add:

- `ALPACA_API_KEY`
- `ALPACA_SECRET_KEY`
- `ALPACA_PAPER_BASE_URL`
- `ALPACA_DATA_BASE_URL`
- `ALPACA_OPTIONS_FEED`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `VOLFORGE_UNIVERSE`

Existing numerical override secrets in `volforge-agent.yml` remain supported. Workflow files must live under `.github/workflows/`, not at the repository root.

### Railway

Railway runs the full control plane and needs:

- `ALPACA_API_KEY`
- `ALPACA_SECRET_KEY`
- `ALPACA_PAPER_BASE_URL`
- `ALPACA_DATA_BASE_URL`
- `ALPACA_TRADE_STREAM_URL=wss://paper-api.alpaca.markets/stream`
- `ALPACA_OPTIONS_FEED`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `VOLFORGE_UNIVERSE`

Railway reads `railway.toml` and starts `npm run worker:control-plane`. A healthy heartbeat appears in the dashboard within approximately 30 seconds. Paper promotion and paper entries fail closed without it.

## Operating sequence

1. Keep the stage at **Research** while the research workflow generates purged horizon models.
2. When the latest run recommends `shadow`, select **Shadow**. The settings API rejects promotion if validation did not pass.
3. Shadow entries, marks, exits, MAE/MFE, and realized P&L use adverse executable quotes. A configurable 90-minute shadow evaluation window collects multiple execution and short-window directional samples during the compressed competition timeline; records explicitly state that this is not a substitute for the modeled holding horizon.
4. Paper promotion is rejected until the configured number of closed shadow trades has positive expectancy, positive total P&L, and acceptable drawdown.
5. Run the GitHub agent workflow once and require a fresh, healthy Alpaca CLI oracle for the same attested paper account.
6. Select **Paper**, then arm **New paper entries**. The API also requires a matching competition attestation and healthy Railway heartbeat. Existing positions are supervised regardless of this switch.
7. The competition deadline guard blocks late entries and forces all positions closed at `COMPETITION_EXIT_AT`.

The system does not automatically arm paper capital. Once a stage is authorized, opportunity discovery, decision making, submission, repricing, position management, exit, and reconciliation are autonomous.

## Research and valuation

1. Three years of Alpaca daily bars feed 3, 5, 10, 15, 20, and 25 trading-day models.
2. Each validation fold purges every training label that overlaps the test window and adds a horizon-scaled embargo.
3. Volatility MAE must beat a recent-volatility baseline; directional Brier score must beat the recent directional base rate.
4. Current probabilities are shrunk toward 50% according to out-of-sample Brier skill. The validated holding horizon, rather than the representative option horizon, chooses call versus put exposure.
5. Option DTE is converted to a matching trading-day forecast horizon.
6. IV is fitted across moneyness, curvature, tenor, and moneyness-tenor interaction only after removing deep, penny-priced, wide, and low-interest artifacts, with liquidity weighting and Huber robustness.
7. Every vertical is valued over a planned holding horizon. Black-Scholes is used only for theoretical changes, anchored to the observed spread midpoint so model level error cannot create instant alpha.
8. Base and adverse cases include bid/ask friction, fat-tail volatility regimes, IV-convergence assumptions, P&L percentiles, probability of profit, and 95% CVaR.
9. Fractional Kelly is optimized from the full P&L distribution and hard-capped by the constitution. Defined-loss portfolio limits remain authoritative.
10. The allocator supports two validated routes: volatility-surface value with an RV edge, or directional-distribution value with strict IV price discipline. Both require positive base and adverse-stress EV.

## Execution and emergency behavior

- Entry starts near midpoint and advances toward a model-approved maximum debit; it never chases beyond the EV cap.
- Exit starts near midpoint and advances toward the natural executable credit.
- Every broker POST stores its client order ID before transmission. If the acknowledgement is lost, VolForge queries Alpaca by that ID and suppresses all duplicate submissions until the ambiguity resolves.
- Alpaca REST reconciliation is authoritative even when the trade stream misses an event.
- Partial fills, cancel-pending states, retries, expiration, rejection, mismatch, and reconciliation errors have explicit states.
- Option-chain pagination must complete or the scan fails closed.
- Indicative-feed decisions carry feed provenance and conservative friction. OPRA is preferred when available.
- Issuer and macro news are paginated and independently classified. An unavailable news feed vetoes new entries.
- Turning off new entries never disables exits.
- Emergency mode blocks entries, cancels working orders, closes tracked spreads, cleans up orphan option legs, reconciles flatness, and only then suspends the broker.

## Verification

```text
npm run typecheck
npm test
npm audit --audit-level=high
npm run build
```

CI executes the same sequence. Quantitative, leakage, infrastructure, and safety invariants live under `tests/`.

## Competition account

The final submission must use a brand-new Alpaca paper account starting at exactly $100,000. Before any competition trade, run the **VolForge competition account attestation** workflow manually. It records:

- Paper endpoint
- Observed $100,000 equity
- Zero prior positions
- Zero prior orders
- Active status
- Options Level 3
- Account fingerprint and API limitation statement

The API preflight cannot independently prove when Alpaca created the account. Final eligibility remains Alpaca and judge authority.

After attestation, run **VolForge autonomous options agent** once. Its pinned Alpaca CLI records an independent paper-account, market-clock, and CLI-version oracle in Supabase. Paper promotion and entry require that proof to be fresh and matched to the connected account.

## Submission assets

- [`docs/ONE_PAGE_WRITEUP.md`](docs/ONE_PAGE_WRITEUP.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/OPERATOR_RUNBOOK.md`](docs/OPERATOR_RUNBOOK.md)
- [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md)
- [`docs/JUDGE_QA.md`](docs/JUDGE_QA.md)
- [`docs/SUBMISSION_CHECKLIST.md`](docs/SUBMISSION_CHECKLIST.md)

## Paper-trading limitation

Alpaca paper trading does not reproduce market impact, queue priority, all latency slippage, or every price-improvement behavior. VolForge records implementation shortfall and adds conservative quote friction, but paper P&L is evidence of system behavior, not a guarantee of live performance.

Licensed under MIT. This is paper-trading software, not financial advice.
