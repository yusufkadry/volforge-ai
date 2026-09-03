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

- Standard path: select Paper after eligible closed Shadow evidence is visible.
- Compressed competition path: selecting Paper and confirming the warning records an explicit bootstrap authorization without claiming Shadow evidence, re-arms Alpaca, and enables entries in one operation.
- Both paths require a healthy Railway heartbeat, matching eligible competition attestation, account-bound paper CLI proof, ACTIVE Alpaca account, no broker suspension, Options Level 3, and sufficient options buying power.
- Do not turn off Railway while positions or working orders exist.
- Turning off entries is safe; exits continue.
- Do not loosen gates merely to manufacture a trade.

## Competition timeline

| Date | Objective |
|---|---|
| Aug 30 | Deploy v4, run CI, collect research manifests, verify Railway heartbeat. |
| Aug 31 | Live research and shadow validation. Drill one canceled-entry recovery with entries disarmed afterward. |
| Sep 1 | Finish verification and authorize the documented compressed Paper launch if the Shadow sample is still incomplete. |
| Sep 2 | Collect broker-backed entries, exits, slippage, and replay traces at conservative size. |
| Sep 3 | No late entries after the configured buffer. Forced liquidation defaults to 3:30 PM ET. Reconcile and record final P&L. |
| Sep 4 | Submit before 8:00 AM PDT. No strategy changes. |

## Final one-session launch: Thursday, September 3

- Deploy and authorize Paper before the session. Do not wait until the opening bell to discover a failed prerequisite.
- `09:30 ET / 06:30 PDT`: regular market opens; opening-auction gate still blocks entries.
- `09:35 ET / 06:35 PDT`: first eligible entry time. Railway continues its offset five-minute strategy loop automatically.
- `14:00 ET / 11:00 PDT`: the 90-minute competition buffer blocks all new entries.
- `15:30 ET / 12:30 PDT`: autonomous competition liquidation begins. Atomic spread exits are price-laddered first; after four exhausted attempts, VolForge closes the short leg before the long leg and suppresses duplicate closes.
- `16:00 ET / 13:00 PDT`: regular market closes. Verify Alpaca has no option positions or working orders and the execution ledger is reconciled.

The operator does not need to press **Run agent now** after Paper is authorized. That button is only an immediate durable request; Railway remains the autonomous authority.

## Expected healthy state

- Railway heartbeat younger than 120 seconds
- No orphan broker legs
- No stale nonterminal intents
- Current-strategy research manifest present, constitution hash matched, and younger than 30 hours; Railway refreshes mismatched or stale research automatically
- CLI proof healthy, paper-mode, and matched to the connected paper account; live REST state current
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
| Alpaca stream disconnects | The separate stream heartbeat degrades; 30-second REST reconciliation remains authoritative and the execution heartbeat is not overwritten. |
| Entry does not fill | Cancel-pending state, bounded price step, retry cap, then cancellation. |
| Order POST times out after transmission | Durable client-order lookup recovers the broker order; no duplicate is submitted while acknowledgement is unknown. |
| Partial fill | Exact filled quantity is reconciled and managed; multi-order exit credits are quantity-weighted before realized P&L is published. |
| Railway dies after intent reservation but before broker submission | The incomplete reservation waits through the acknowledgement window, then self-cancels without claiming an Alpaca order. |
| Broker rejects an entry | Reconciliation degrades for that cycle and the underlying enters a 30-minute cooldown rather than being resubmitted repeatedly. |
| One leg is missing | Intent enters reconciliation error and no new exposure is allowed. |
| Supabase fails | No new intent can be reserved, therefore no broker order is submitted. |
| OpenAI fails | The failure is journaled as advisory; deterministic numerical and broker gates remain authoritative and exits continue. |
| Dashboard request outlives Vercel | The request remains in Supabase and Railway claims it exactly once; stale claims are recoverable. |
| CLI proof is unhealthy, live-mode, or account-mismatched | Paper authorization, arming, and entry fail closed. |
| Hard kill pressed | Entries block; risk-increasing orders cancel while working closes remain supervised. The spread ladder escalates after its bounded emergency retry limit to short-leg-first closes, flatness reconciles, and broker suspension happens last. |
| Competition cutoff reached | Entries are already blocked; spread exits ladder automatically. After four exhausted atomic attempts, short-leg-first closes activate without waiting for the dashboard. |

## Evidence capture

For the final closed spread, capture the decision replay, risk gates, model manifest hash, surface residual, base/stress EV, Alpaca order IDs, price-ladder attempts, fills, exit reason, realized P&L, and account equity curve. This is the spine of the demo.
