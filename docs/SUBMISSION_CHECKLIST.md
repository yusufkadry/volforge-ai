# Submission Checklist

## Eligibility

- [ ] Brand-new Alpaca paper account
- [ ] Exactly $100,000 starting balance
- [ ] Options Level 3
- [ ] Competition account attestation passes before first trade
- [ ] Paper account ID added to submission
- [x] MIT license
- [x] Original source repository

## Technical proof

- [x] Alpaca Trading API
- [x] Alpaca Market Data API
- [x] Alpaca CLI pinned and enforced as an account-bound paper-mode proof
- [x] Autonomous GitHub and Railway scheduling
- [x] Atomic options `mleg` orders
- [x] Defined-risk call and put verticals
- [x] Research, shadow, and paper capital stages
- [x] Purged walk-forward validation
- [x] Broker REST and stream reconciliation
- [x] Emergency liquidation
- [ ] At least one broker-backed autonomous entry
- [ ] At least one broker-backed autonomous exit
- [ ] Realized paper P&L captured
- [ ] Final maximum drawdown captured
- [ ] Implementation shortfall captured

## Submission package

- [x] One-page write-up draft
- [x] Architecture document
- [x] 90-second demo script
- [x] Judge Q&A
- [x] Operator runbook
- [ ] Public GitHub URL
- [ ] Live Vercel URL
- [ ] Demo video URL
- [ ] Slide-deck URL/file
- [ ] Final paper account ID
- [ ] Final P&L and drawdown values inserted
- [ ] Up to five social post URLs

## Final audit

- [ ] CI is green on submitted commit
- [ ] Dependency audit reports zero high vulnerabilities
- [ ] Supabase v4 migration applied
- [ ] Railway heartbeat healthy
- [ ] Competition attestation matches connected account
- [ ] CLI proof is healthy, paper-mode, and account-matched
- [ ] Dashboard Run Agent queue completes through Railway
- [ ] Thursday timing variables are exact: `COMPETITION_EXIT_AT=2026-09-03T19:30:00Z`, `COMPETITION_ENTRY_BUFFER_MINUTES=90`
- [ ] No orphan broker positions
- [ ] No working orders after Thursday cutoff
- [ ] All competition positions closed and reconciled
- [ ] Dashboard screenshot shows final account state
- [ ] Decision replay opens correctly
- [ ] Secrets absent from repository and video
- [ ] Submit before September 4, 2026 at 8:00 AM PDT
