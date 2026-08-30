# VolForge AI

## Autonomous options intelligence with evidence-gated capital

VolForge is an autonomous options research and execution control plane built on Alpaca. It searches for liquid contracts whose implied volatility is cheap relative to a robust moneyness-and-tenor fit, combines that evidence with horizon-matched return forecasts, constructs defined-risk vertical spreads, and values each structure across base and adverse P&L distributions. Strategies must earn promotion from research to a shadow digital twin before any Alpaca paper order is permitted.

### AI and quantitative logic

The Research Factory trains separate models for 3, 5, 10, 15, 20, and 25 trading-day horizons from Alpaca stock bars. Inputs include realized volatility, downside volatility, momentum, intraday range, volume surprise, and drawdown. Walk-forward folds are chronological. Every training label that overlaps a test interval is purged, followed by a horizon-scaled embargo. Volatility MAE must beat a recent-volatility baseline, while directional Brier score must beat the recent directional base rate. Live probabilities are shrunk toward 50% according to out-of-sample Brier skill.

The Surface Engine fits option IV against log-moneyness, curvature, tenor, and their interaction. Quotes are weighted by liquidity and robust Huber weights reduce outlier influence. A candidate must exhibit both a minimum relative discount and a negative local residual z-score among neighboring liquid contracts. This distinguishes actual local dislocation from normal skew.

For every candidate, the Structure Engine enumerates same-expiry call or put debit verticals. The Distribution Engine simulates mark-forward P&L over the planned holding horizon using the calibrated return distribution, a fat-tail volatility mixture, partial IV convergence, bid/ask friction, and an adverse case with weaker directional drift, higher volatility, no local IV repair, and greater friction. Black-Scholes is used only to estimate changes in option value; those changes are anchored to the observed spread midpoint so theoretical pricing error cannot manufacture immediate alpha. Outputs include base EV, stress EV, probability of profit, 95% CVaR, P10/P50/P90 P&L, and a hard-capped fractional Kelly fraction. There is no probability floor.

Event Intelligence classifies recent Alpaca news by source reliability, recency, event type, impact, novelty, and directional contradiction. Unmodeled jump events or contradictory evidence veto entry. An OpenAI red-team critic receives the complete structure and assumptions, but it may only veto. It cannot submit an order or override any deterministic gate.

### Risk constitution

VolForge trades only atomic, Level 3, defined-risk Alpaca multi-leg debit spreads. Deterministic gates enforce market session, quote age, pagination completeness, feed provenance, bid/ask spread, open interest, absolute delta, DTE, surface support, forecast validation, stress EV, reward-to-risk, maximum loss, portfolio risk, underlying concentration, delta, vega, CVaR, duplicate exposure, event risk, model calibration, shadow promotion, execution heartbeat, competition deadline, and emergency state.

Research capital cannot trade. Shadow capital uses adverse executable bid/ask prices and the exact paper exit policy. It records every mark, realized P&L, maximum adverse excursion, and maximum favorable excursion. Paper promotion requires a configured sample of closed, profitable shadow structures with acceptable drawdown. Disabling entries never disables exits.

The emergency control blocks entries, cancels working orders, liquidates tracked spreads, closes orphan option legs, reconciles broker flatness, and only then suspends trading. The competition deadline guard blocks late entries and forces closure before judging.

### Alpaca and autonomous infrastructure

Railway is the primary control plane. It reconciles Alpaca REST state every 30 seconds, consumes binary trade-update frames, supervises exits, and runs the strategy every five minutes. GitHub Actions independently refreshes research every four hours, runs a premarket refresh, executes a 15-minute recovery watchdog, and publishes a pinned Alpaca CLI `v0.0.13` oracle that verifies paper mode, account identity, and market clock before entry. Vercel hosts the protected command room; manual scans enter a durable Supabase queue and are claimed by Railway instead of running inside a serverless request. Supabase stores immutable decisions, model manifests, shadow marks, distributed leases, command requests, CLI proofs, execution intents, order events, heartbeats, risk snapshots, and calibration.

Every paper entry is reserved with an idempotency key before submission. Alpaca receives one atomic `mleg` limit order. The price ladder begins near midpoint and never exceeds the model-approved debit cap. REST reconciliation remains authoritative if the WebSocket misses an event. Every closed spread links data, model, decision, order IDs, fill prices, exit reason, realized P&L, and replay proof.

**Submission evidence:** fresh $100,000 paper-account attestation, broker-backed closed spreads and P&L, maximum drawdown, implementation shortfall, replay traces, public repository, live dashboard, demo video, and architecture slides.
