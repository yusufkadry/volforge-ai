# VolForge Architecture

```mermaid
flowchart LR
  A[Alpaca stock bars] --> R[Research Factory]
  R --> M[(Model manifests)]
  B[Alpaca option chains] --> S[Surface Engine]
  C[Alpaca news] --> E[Event Intelligence]
  M --> D[Distribution Engine]
  S --> D
  E --> X[Model Court]
  D --> X
  G[Portfolio Governor] --> X
  L[LLM Red Team veto-only] --> X
  X --> K{Deterministic constitution}
  K -->|Research| J[(Decision journal)]
  K -->|Shadow| V[Shadow digital twin]
  V --> P{Promotion evidence}
  P -->|Passed| I[Execution intent]
  C1[Alpaca CLI oracle] --> K
  I --> O[Alpaca atomic MLeg order]
  O --> W[Trade stream and REST reconciler]
  W --> Q[Position supervisor]
  Q --> J
  V --> J
```

## Trust boundaries

| Boundary | Rule |
|---|---|
| Browser | Receives no Alpaca, OpenAI, or Supabase service-role credentials. |
| LLM | Receives a bounded evidence packet. It can veto only. |
| Research workflow | Calls data and persistence paths, never the agent order route. |
| Dashboard command | Enters a durable Supabase queue; only the Railway worker claims and executes it. |
| CLI oracle | Independently verifies paper mode, account identity, market clock, and pinned CLI version before paper entry. |
| Capital loop | Requires a distributed Supabase lease before mutation. |
| Broker | Alpaca REST state is authoritative; WebSocket events reduce latency. |
| Database | Service-role access remains server-side. All tables use RLS. |

## Decision sequence

```mermaid
sequenceDiagram
  participant Scheduler as Railway/GitHub
  participant DB as Supabase
  participant Alpaca
  participant Quant as Quant Engines
  participant AI as Red Team

  Scheduler->>DB: Acquire capital lease
  Scheduler->>DB: Verify account attestation and fresh CLI oracle
  Scheduler->>Alpaca: Reconcile orders and positions
  Scheduler->>Alpaca: Fetch complete paginated chain and spot
  Scheduler->>DB: Load fresh model manifests
  Scheduler->>Quant: Surface, distribution, stress, portfolio
  Scheduler->>AI: Bounded evidence packet
  AI-->>Scheduler: Approve or veto
  Scheduler->>DB: Persist decision and proof hash
  alt Shadow stage
    Scheduler->>DB: Reserve and mark digital-twin spread
  else Paper stage and every gate passes
    Scheduler->>DB: Reserve idempotent intent
    Scheduler->>Alpaca: Submit atomic MLeg limit
    Alpaca-->>Scheduler: Broker order ID
    Scheduler->>DB: Persist lifecycle event
  end
  Scheduler->>DB: Release lease
```

## Failure invariants

1. No complete chain, no candidate.
2. No fresh validated model, no entry.
3. No database lease, no capital decision.
4. No healthy execution heartbeat, no paper entry.
5. No matching fresh-account attestation and CLI oracle, no paper entry.
6. No positive adverse-stress EV, no allocation.
7. No closed shadow evidence, no paper promotion.
8. Entry disablement never disables position management.
9. Emergency suspension occurs only after broker flatness.
10. Every nonterminal order is reconciled from REST.
11. No model or LLM can exceed the defined-loss constitution.
