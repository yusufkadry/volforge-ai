# Competition Operator Runbook

## One-time deployment

1. In Supabase SQL Editor, run `supabase/upgrade_v4.sql` against the current project.
2. Commit the full repository, including `.github/workflows/`, `package-lock.json`, `tests/`, and `docs/`.
3. Confirm Vercel redeploys successfully.
4. Confirm Railway deploys `worker:control-plane` and shows a healthy deployment.
5. Add the required Railway variables listed in `README.md`. Railway needs OpenAI and market-data settings because it now runs the full strategy loop.
6. Open GitHub Actions. Confirm four workflows appear: autonomous options agent, autonomous research factory, deterministic verification, and competition account attestation.
7. Run **VolForge deterministic verification** manually. Require typecheck, every test, zero high vulnerabilities, and production build to pass.

## Fresh competition account

1. Create the required brand-new Alpaca paper account with exactly $100,000.
2. Enable Options Level 3.
3. Replace Alpaca keys in Vercel, GitHub Actions, and Railway.
4. Redeploy Vercel and Railway after changing keys.
5. Run **VolForge competition account attestation** before any trade.
6. Run **VolForge autonomous options agent** once. Require its pinned CLI preflight to publish a healthy paper oracle for the same account.
7. Require every attestation and CLI gate to pass. Save both GitHub run URLs and the dashboard screenshot.

The attestation cannot independently prove account creation time. Keep Alpaca’s account confirmation as submission evidence.

## Stage operations

### Research

- Leave `promotion_stage=research` and new paper entries off.
- The research Action runs every four hours and once before the weekday session.
- Require the latest run to report purged validation, manifest hashes, and at least the configured number of validated symbols.
- A market scan can journal rejected candidates, but no shadow or broker exposure is created.

### Shadow

- Select Shadow only after the settings API accepts the latest research recommendation.
- The agent autonomously discovers, reserves, marks, and exits virtual spreads.
- Require closed structures, positive total and mean P&L, and drawdown within policy.
- Do not count open marks as promotion evidence.

### Paper

- Select Paper only after the dashboard shows eligible shadow evidence, a healthy Railway heartbeat, a matching competition attestation, and a fresh CLI oracle.
- Arm **New paper entries**.
- Do not turn off Railway while positions or working orders exist.
- Turning off entries is safe; exits continue.
- Do not loosen gates merely to manufacture a trade.

## Competition timeline

| Date | Objective |
|---|---|
| Aug 30 | Deploy v4, run CI, collect research manifests, verify Railway heartbeat. |
| Aug 31 | Live research and shadow validation. Drill one canceled-entry recovery with entries disarmed afterward. |
| Sep 1 | Continue shadow. Promote to paper only if closed evidence gates pass. |
| Sep 2 | Collect broker-backed entries, exits, slippage, and replay traces at conservative size. |
| Sep 3 | No late entries after the configured buffer. Forced liquidation defaults to 3:30 PM ET. Reconcile and record final P&L. |
| Sep 4 | Submit before 8:00 AM PDT. No strategy changes. |

## Expected healthy state

- Railway heartbeat younger than 120 seconds
- No orphan broker legs
- No stale nonterminal intents
- Research younger than 12 hours
- CLI oracle younger than 45 minutes and matched to the connected paper account
- Eligible competition attestation matched to the connected paper account
- All option pages complete
- Paper account active and Level 3
- Emergency stop false
- Competition entry window open
- Daily loss and portfolio risk breakers green

## Failure drills

| Failure | Expected response |
|---|---|
| Two schedulers overlap | One acquires the lease; the other journals a safe suppression. |
| Alpaca stream disconnects | Heartbeat degrades; REST reconciliation continues; new paper entries fail closed if the control plane becomes stale. |
| Entry does not fill | Cancel-pending state, bounded price step, retry cap, then cancellation. |
| Order POST times out after transmission | Durable client-order lookup recovers the broker order; no duplicate is submitted while acknowledgement is unknown. |
| Partial fill | Exact filled quantity is reconciled and managed; no assumed full spread. |
| One leg is missing | Intent enters reconciliation error and no new exposure is allowed. |
| Supabase fails | No new intent can be reserved, therefore no broker order is submitted. |
| OpenAI fails | Red-team critic fails closed; existing exits continue. |
| Dashboard request outlives Vercel | The request remains in Supabase and Railway claims it exactly once; stale claims are recoverable. |
| CLI preflight is stale or mismatched | Paper promotion, arming, and entry fail closed. |
| Hard kill pressed | Entries block, orders cancel, exposure liquidates, flatness reconciles, broker suspends last. |

## Evidence capture

For the final closed spread, capture the decision replay, risk gates, model manifest hash, surface residual, base/stress EV, Alpaca order IDs, price-ladder attempts, fills, exit reason, realized P&L, and account equity curve. This is the spine of the demo.
