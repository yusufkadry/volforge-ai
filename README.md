# VolForge AI

VolForge is an autonomous, paper-only options agent that searches for implied-volatility surface distortions, asks an LLM critic to challenge each proposal, enforces deterministic risk gates, and records its full decision trail.

## Architecture

| Service | Responsibility |
| --- | --- |
| GitHub Actions | Runs the agent every five minutes on weekdays; no laptop required. It runs the official Alpaca CLI paper preflight before the AI loop. |
| Vercel | Private dashboard, live Alpaca account view, manual scan control. |
| Supabase | Immutable decision journal and the trading-enabled kill switch. |
| Alpaca Paper | Options market data, account, positions, and paper orders. |

The browser never receives an Alpaca, Supabase service-role, or OpenAI key. The dashboard calls server-side routes only.

## Deploy without a terminal

1. In GitHub, create an empty private repository named `volforge-ai` and upload this folder's contents through **Add file > Upload files**.
2. In Supabase, create a project. Open **SQL Editor**, paste [supabase/schema.sql](supabase/schema.sql), and click **Run**.
3. In Vercel, click **Add New > Project**, import the GitHub repository, accept the detected Next.js settings, and add every value from `.env.example` under **Settings > Environment Variables**. Add them to Production and Preview.
4. In the GitHub repository, open **Settings > Secrets and variables > Actions** and add the same values used by the agent: `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `ALPACA_PAPER_BASE_URL`, `ALPACA_DATA_BASE_URL`, `ALPACA_OPTIONS_FEED`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `VOLFORGE_UNIVERSE`, `MAX_PREMIUM_PER_TRADE`, `MAX_QUOTE_SPREAD_PCT`, `MIN_DTE`, and `MAX_DTE`.
5. Open the deployed Vercel URL. Log in with `DASHBOARD_PASSWORD`. The agent begins as analysis-only. Turn on paper trading only after you have inspected several decisions.

Vercel's own password protection for a production URL is a paid feature. This project includes its own password gate, so the dashboard remains private on the free tier. Vercel credentials can be added as a second layer later.

## Agent logic

1. The surface agent fetches active call contracts and live option snapshots for every configured symbol.
2. It computes each contract's implied-volatility discount/premium versus its expiry bucket and retains the deepest liquid discount.
3. The critic agent receives a compact market thesis and must return a structured `approve` or `reject` verdict.
4. The risk engine independently blocks wide quotes, contracts outside 14-45 DTE, excessive premium, untradable contracts, a closed market, and a disabled kill switch.
5. An approved decision submits a **single long call**, which has bounded maximum loss. Every candidate, rejection, and submitted order is journaled to Supabase.

The current long-option implementation is deliberately constrained while the paper account gathers evidence. The next strategy module can add defined-risk vertical spreads using the same risk and journal contracts.

## Hackathon checklist

- [x] Autonomous scheduled agent
- [x] Alpaca Trading API and paper account support
- [x] Options strategy and execution path
- [x] AI critic with deterministic risk gates
- [x] Protected live control dashboard
- [x] Decision journal for presentation and one-page write-up
- [x] Official Alpaca CLI invoked on every autonomous GitHub Actions run (`alpaca clock`, `alpaca account get`)
- [ ] Create the required fresh $100,000 competition paper account for final judging

## Important

This is paper-trading software, not financial advice. Do not reuse these credentials or controls for real-money trading.
