# VolForge Model Card

## Intended use

Rank liquid, defined-risk Alpaca paper option verticals over a short competition holding horizon. The model is not intended for real-money deployment.

## Inputs

- Alpaca adjusted daily stock bars from IEX by default
- Alpaca option contracts and snapshots from indicative or OPRA feed
- Alpaca symbol and broad-market news
- Alpaca account, order, position, clock, and portfolio state

## Outputs

- Horizon annualized realized-volatility forecast
- Calibrated directional probability and log-return distribution
- Robust local IV residual and z-score
- Base and adverse mark-forward EV
- Probability of profit, CVaR, P10/P50/P90 P&L
- Capped fractional Kelly and defined-loss quantity

## Validation

- Chronological purged walk-forward folds
- Label-horizon embargo
- Non-overlapping test points
- Volatility MAE baseline
- Directional Brier baseline
- Reliability bins
- High-volatility and downside diagnostics
- Dataset and model-manifest hashes

## Known limitations

1. Daily bars cannot model intraday path dependence in full.
2. Black-Scholes scenario changes simplify dividends, early exercise, volatility dynamics, and microstructure.
3. The indicative options feed can contain delayed or modified observations.
4. News classification does not guarantee event completeness.
5. Small shadow and paper samples have high statistical uncertainty.
6. Alpaca paper fills do not reproduce all live-market frictions.

## Mitigations

- Theoretical changes are anchored to observed market midpoints.
- Base and adverse distributions include explicit quote friction and fat tails.
- Event Intelligence vetoes unmodeled jump catalysts.
- Probabilities shrink toward 50% when Brier skill is weak.
- Shadow evidence is required before paper promotion.
- Defined loss and account-level circuit breakers dominate model output.
- The LLM has veto-only authority.

## Monitoring

Closed paper trades update predicted versus realized EV, win-rate calibration, Brier score, and mean absolute outcome error. Degraded calibration blocks new exposure while exits continue.
