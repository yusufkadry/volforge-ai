# VolForge AI

VolForge is an autonomous, paper-only options agent that searches for implied-volatility surface distortions, asks an LLM critic to challenge each proposal, enforces deterministic risk gates, and records its full decision trail.

The competitive build adds a numerical realized-volatility research model, walk-forward baseline validation, a frozen strategy constitution, a shadow portfolio, promotion stages, broker-level hard kill, and an Alpaca trade-update worker.

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
2. In Supabase, create a project. Open **SQL Editor**, paste [supabase/schema.sql](supabase/schema.sql), and click **Run**. If you ran an earlier VolForge schema, run this current file again; its `add column if not exists` statements upgrade it.
3. In Vercel, click **Add New > Project**, import the GitHub repository, accept the detected Next.js settings, and add every value from `.env.example` under **Settings > Environment Variables**. Add them to Production and Preview.
4. In the GitHub repository, open **Settings > Secrets and variables > Actions** and add the same values used by the agent: `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `ALPACA_PAPER_BASE_URL`, `ALPACA_DATA_BASE_URL`, `ALPACA_OPTIONS_FEED`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `VOLFORGE_UNIVERSE`, `MAX_PREMIUM_PER_TRADE`, `MAX_QUOTE_SPREAD_PCT`, `MIN_DTE`, `MAX_DTE`, `MIN_OPEN_INTEREST`, `MAX_DATA_AGE_MS`, and `ENABLE_MULTI_LEG=false`.
5. In Railway, create a **New Project > Deploy from GitHub repo**, select this repository, and add: `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, plus optional `ALPACA_TRADE_STREAM_URL=https://paper-api.alpaca.markets/stream`. Railway reads `railway.toml` and starts the broker-event worker automatically.
6. Open the deployed Vercel URL. Log in with `DASHBOARD_PASSWORD`. The agent starts in **Research**. Promote it to **Shadow**, collect evidence, then promote it to **Paper** and arm paper trading only after inspection.

Vercel's own password protection for a production URL is a paid feature. This project includes its own password gate, so the dashboard remains private on the free tier. Vercel credentials can be added as a second layer later.

## Agent logic

1. The research factory trains a regularized realized-volatility regression and direction classifier from historical stock bars. It evaluates both with rolling walk-forward validation against a naive volatility baseline.
2. The surface agent fetches the live chain in the model-predicted direction, normalizes IV by expiry, and retains the deepest liquid discount.
3. The critic agent receives a compact market thesis and must return a structured `approve` or `reject` verdict.
4. The constitution independently blocks stale quotes, insufficient open interest, wide quotes, invalid DTE, excess premium, risk-budget breaches, a closed market, and a disabled kill switch.
5. A validated strategy advances through `research → shadow → paper`. Shadow positions are logged at adverse executable bid/ask prices. Only a promoted, armed strategy can submit a bounded long option to Alpaca.
6. The position sentinel submits exits at profit, loss, and 14-DTE thresholds. Railway journals Alpaca trade updates for submitted, filled, canceled, and rejected orders.

Set `ENABLE_MULTI_LEG=true` only after the paper account reports options trading level 3 and the debit-spread path has been exercised in shadow mode. At level 3, VolForge can atomically submit a debit spread; otherwise it uses a bounded single long option.

The current long-option implementation is deliberately constrained while the paper account gathers evidence. The next strategy module can add defined-risk vertical spreads using the same risk and journal contracts.

## Hackathon checklist

- [x] Autonomous scheduled agent
- [x] Alpaca Trading API and paper account support
- [x] Options strategy and execution path
- [x] Numerical ML research factory with walk-forward validation
- [x] AI critic, strategy constitution, shadow book, promotion gate, and deterministic risk gates
- [x] Position sentinel, hard kill, cancellation, and Alpaca order-event worker
- [x] Protected live control dashboard
- [x] Decision journal for presentation and one-page write-up
- [x] Official Alpaca CLI invoked on every autonomous GitHub Actions run (`alpaca clock`, `alpaca account get`)
- [ ] Create the required fresh $100,000 competition paper account for final judging

## Important

This is paper-trading software, not financial advice. Do not reuse these credentials or controls for real-money trading.
