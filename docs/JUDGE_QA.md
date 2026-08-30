# Judge Q&A

## “Is this really a volatility surface?”

Yes, within the available liquid chain. IV is fitted against log-moneyness, its curvature, square-root tenor, and moneyness-tenor interaction. Liquidity and Huber weights reduce unreliable points. The trade signal is a local standardized residual, not an expiry-wide median.

## “Where does the probability of profit come from?”

From the empirical mark-forward P&L distribution. The holding-horizon return model produces calibrated mean and volatility, probabilities are shrunk according to out-of-sample Brier skill, and each terminal spot scenario reprices both legs. Profit probability is the weighted fraction of scenarios with P&L above zero. There is no floor.

## “Why should we trust the backtest?”

Training labels overlapping a test point are purged and followed by an embargo. Test windows advance chronologically without overlap. Volatility must beat a recent-volatility baseline and directional probability must beat a recent base-rate Brier score. Results, folds, hashes, weights, features, and data windows are persisted.

## “Why use Black-Scholes if markets are not Black-Scholes?”

It is not used as an absolute truth price. VolForge anchors to the observed spread midpoint and uses Black-Scholes only for scenario changes as spot, time, and IV change. A fat-tail mixture, adverse scenario, and quote friction explicitly attack its assumptions.

## “Is the LLM trading?”

No. OpenAI acts as a red-team veto. It cannot approve around a failed gate, size a position, call Alpaca, or change the constitution. Numerical and deterministic engines own authority.

## “What is autonomous?”

After the operator authorizes a capital stage, Railway and GitHub schedule discovery, evaluate evidence, reserve idempotent state, submit and reprice orders, reconcile fills, mark positions, trigger exits, calibrate outcomes, and enforce the competition deadline without a button click.

## “What happens if GitHub runs twice?”

GitHub concurrency serializes its own workflow. A Supabase lease also serializes GitHub, Railway, and manual calls. A loser records suppression and exits before evaluating risk.

## “How is the Alpaca CLI actually part of capital control?”

The pinned CLI queries the paper account and market clock in GitHub Actions, hashes the evidence, and publishes a short-lived oracle to Supabase. Paper promotion, arming, and each paper entry require that oracle to be healthy, recent, explicitly paper, and matched to the independently attested account.

## “What happens when I press Run Agent on Vercel?”

Vercel authenticates the request and writes a deduplicated command to Supabase. The always-on Railway worker atomically claims it, acquires the same renewable capital lease used by scheduled scans, executes the cycle, and persists completion or failure. The work does not depend on a serverless request remaining alive.

## “What happens if the WebSocket drops?”

The stream degrades its heartbeat, but Alpaca REST remains authoritative. Railway reconciles every nonterminal order and broker position every 30 seconds. New paper exposure fails closed when the execution control plane is stale.

## “Does the kill switch actually close positions?”

Yes. It blocks entries first, keeps the broker available for risk-reducing actions, cancels working orders, closes tracked verticals, cleans up orphan option legs, confirms broker flatness, and only then suspends trading.

## “How do you account for unrealistic paper fills?”

Every decision records arrival midpoint, natural price, submitted limit, fill, latency, and implementation shortfall. Valuation charges quote friction and a harsher stress haircut. The submission explicitly states that Alpaca paper trading does not model all market impact, queue priority, and latency.

## “What is the actual innovation?”

Not the number of agents. The innovation is evidence-gated capital promotion: a statistically audited model, an executable-price digital twin, deterministic portfolio authority, and a broker-reconciled proof chain for every spread.
