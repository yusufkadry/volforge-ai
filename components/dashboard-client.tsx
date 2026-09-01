"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Bot, CircleDollarSign, Clock3, FlaskConical, LogOut, Play, RefreshCw, RotateCcw, ShieldAlert, ShieldCheck, SlidersHorizontal, Sparkles, TriangleAlert, Zap } from "lucide-react";
import type { DashboardSnapshot, Decision } from "@/lib/types";

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function asNumber(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function shortTime(value?: string) { return value ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }).format(new Date(value)) : "No data"; }
function statusTone(status: Decision["status"]) { return status === "SUBMITTED" ? "good" : status === "APPROVED" ? "accent" : status === "ERROR" ? "bad" : "neutral"; }
function maxDrawdown(equity: number[]) {
  let peak = 0;
  let drawdown = 0;
  equity.forEach((value) => { peak = Math.max(peak, value); if (peak > 0) drawdown = Math.min(drawdown, (value - peak) / peak); });
  return drawdown;
}

function SurfacePlot({ decisions }: { decisions: Decision[] }) {
  const values = decisions.slice(0, 12).reverse().map((decision) => asNumber(decision.score));
  const points = values.length ? values.map((value, index) => {
    const x = 12 + (index / Math.max(values.length - 1, 1)) * 476;
    const y = 76 - Math.max(-1, Math.min(1, value * 4)) * 42;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ") : "12,76 488,76";
  return <svg className="surface-plot" viewBox="0 0 500 120" role="img" aria-label="Volatility anomaly history">
    <line x1="12" x2="488" y1="34" y2="34" /><line x1="12" x2="488" y1="76" y2="76" /><line x1="12" x2="488" y1="108" y2="108" />
    <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
    {points.split(" ").map((point, index) => { const [cx, cy] = point.split(","); return <circle key={index} cx={cx} cy={cy} r="3.5" />; })}
  </svg>;
}

function Stat({ label, value, detail, icon: Icon, tone = "" }: { label: string; value: string; detail: string; icon: typeof Activity; tone?: string }) {
  return <section className={`stat ${tone}`}><div className="stat-icon"><Icon size={18} /></div><p>{label}</p><strong>{value}</strong><span>{detail}</span></section>;
}

export default function DashboardClient() {
  const [data, setData] = useState<DashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [replay, setReplay] = useState<Decision | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load live agent state");
      setData(await response.json());
    } catch (error) { setNotice(error instanceof Error ? error.message : "Dashboard unavailable"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 60_000); return () => window.clearInterval(timer); }, [refresh]);

  async function runScan() {
    setRunning(true); setNotice("");
    const response = await fetch("/api/agent/run", { method: "POST" });
    const body = await response.json();
    setNotice(response.ok ? `Agent request ${String(body.status ?? "queued").toLowerCase()} on the Railway control plane.` : body.error ?? "Agent request failed");
    setRunning(false); void refresh();
  }

  async function saveSettings(next: DashboardSnapshot["settings"]) {
    setSaving(true); setNotice("");
    const response = await fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
    const body = await response.json().catch(() => ({})) as { error?: string } & Partial<DashboardSnapshot["settings"]>;
    if (!response.ok) setNotice(body.error ?? "Settings could not be saved.");
    else setData((current) => current ? { ...current, settings: body as DashboardSnapshot["settings"] } : current);
    setSaving(false);
  }

  async function logout() { await fetch("/api/auth/logout", { method: "POST" }); window.location.assign("/login"); }
  async function hardKill() {
    if (!window.confirm("Block new entries, cancel working orders, and liquidate every tracked or orphaned paper option position?")) return;
    const response = await fetch("/api/controls/hard-kill", { method: "POST" });
    const body = await response.json();
    setNotice(response.ok ? `Emergency liquidation active. ${body.canceled_orders} working orders canceled; exits remain supervised.` : body.error ?? "Hard kill failed");
    void refresh();
  }
  async function rearmBroker() {
    if (!window.confirm("Re-enable Alpaca paper-order capability? Paper trading remains disabled until you explicitly arm it.")) return;
    const response = await fetch("/api/controls/rearm", { method: "POST" });
    const body = await response.json();
    setNotice(response.ok ? "Alpaca paper broker re-armed. Trading remains disabled." : body.error ?? "Broker re-arm failed");
    void refresh();
  }
  const account = data?.account ?? {};
  const equity = asNumber(account.equity);
  const lastEquity = asNumber(account.last_equity);
  const pnl = lastEquity > 0 ? equity - lastEquity : 0;
  const latest = data?.latestMarketDecision ?? null;
  const latestResearchDecision = data?.latestResearchDecision ?? null;
  const warnings = data?.errors ?? [];
  const score = latest?.score ?? null;
  const mode = data?.settings.emergency_stop ? "EMERGENCY LIQUIDATION" : data?.settings.promotion_stage === "shadow" ? "SHADOW PORTFOLIO" : data?.settings.trading_enabled ? "PAPER ENTRIES ARMED" : data?.settings.promotion_stage === "paper" ? "PAPER ENTRIES DISARMED" : "RESEARCH ONLY";
  const decisionCount = data?.decisionTotal ?? 0;
  const submitted = data?.submittedDecisionTotal ?? 0;
  const displayedDecisions = data?.decisions.length ?? 0;
  const summary = useMemo(() => `${submitted} submitted / ${displayedDecisions} recent shown`, [displayedDecisions, submitted]);
  const research = data?.research[0];
  const researchReport = research?.report as { strongest_models?: number; forecasts?: Array<{ validation?: { directionAccuracy?: number } }> } | undefined;
  const shadowPositions = data?.shadowPositions ?? [];
  const shadowPnl = shadowPositions.reduce((total, position) => total + asNumber(position.pnl), 0);
  const closedShadow = shadowPositions.filter((position) => position.status === "closed");
  const court = (latest?.raw?.court as Array<{ agent: string; vote: string; rationale: string }> | undefined) ?? [];
  const evidenceHash = typeof latest?.raw?.evidence_hash === "string" ? latest.raw.evidence_hash : null;
  const allocation = latest?.raw?.allocation as {
    status?: string; reason?: string; alpha_source?: string; alpha_rationale?: string; structure?: string; short_leg?: string; max_loss?: number; max_reward?: number;
    reward_risk?: number; expected_value?: number; base_expected_value?: number; stressed_expected_value?: number; payoff_probability?: number; kelly_fraction?: number; risk_budget?: number; quantity?: number; cvar_95?: number;
    funnel?: { candidatesSeen?: number; executableLongLegs?: number; alphaQualified?: number; spreadsPriced?: number; valuationsRun?: number; plansRanked?: number };
  } | undefined;
  const allocationReady = allocation?.status === "ranked";
  const intents = data?.intents ?? [];
  const calibration = data?.calibration;
  const equityCurve = data?.portfolioHistory?.equity ?? [];
  const closedIntents = intents.filter((intent) => intent.status === "closed");
  const realizedPnl = closedIntents.reduce((total, intent) => total + (asNumber(intent.exit_credit ?? intent.current_debit) - asNumber(intent.entry_debit)) * 100 * asNumber(intent.quantity), 0);
  const realizedWinRate = closedIntents.length ? closedIntents.filter((intent) => asNumber(intent.exit_credit ?? intent.current_debit) > asNumber(intent.entry_debit)).length / closedIntents.length : 0;
  const implementationShortfall = closedIntents.reduce((total, intent) => total + asNumber(intent.metadata?.round_trip_implementation_shortfall), 0);
  const heartbeatAge = data?.executionHeartbeat?.last_seen_at ? Math.max(0, Date.now() - new Date(data.executionHeartbeat.last_seen_at).getTime()) : Number.POSITIVE_INFINITY;
  const workerHealthy = data?.executionHeartbeat?.status === "healthy" && heartbeatAge <= 120_000;
  const accountEligible = data?.accountAttestation?.eligible_preflight === true && String(data.accountAttestation.account_id ?? "") === String(account.id ?? account.account_number ?? "");
  const cliAge = data?.cliPreflight?.created_at ? Math.max(0, Date.now() - new Date(data.cliPreflight.created_at).getTime()) : Number.POSITIVE_INFINITY;
  const cliHealthy = data?.cliPreflight?.healthy === true && data.cliPreflight.paper === true && data.cliPreflight.account_id === String(account.id ?? account.account_number ?? "") && cliAge <= 45 * 60_000;
  const controlRequestActive = data?.latestControlRequest?.status === "pending" || data?.latestControlRequest?.status === "running";

  return <main className="app-shell">
    <header className="topbar">
      <div className="wordmark"><div className="brand-mark compact"><Sparkles size={17} /></div><span>VOLFORGE</span><small>AI</small></div>
      <div className="market-status"><i className={data?.marketOpen ? "live-dot" : "closed-dot"} />{data?.marketOpen ? "MARKET OPEN" : "MARKET CLOSED"}</div>
      <div className="top-actions">
        <button className="icon-button" onClick={() => void refresh()} aria-label="Refresh dashboard" title="Refresh dashboard"><RefreshCw size={18} className={loading ? "spin" : ""} /></button>
        <button className="icon-button" onClick={() => void logout()} aria-label="Sign out" title="Sign out"><LogOut size={18} /></button>
      </div>
    </header>

    <div className="dashboard-main">
      <section className="hero-row">
        <div><p className="eyebrow">OPTIONS INTELLIGENCE / PAPER ACCOUNT</p><h1>Volatility command room</h1><p className="muted">Surface anomalies, autonomous critique, deterministic execution gates.</p></div>
        <div className={`mode-indicator ${data?.settings.trading_enabled && !data?.settings.emergency_stop ? "armed" : "idle"}`}><ShieldCheck size={18} /><span>{mode}</span></div>
      </section>

      {notice && <div className="notice"><Activity size={17} />{notice}</div>}
      {warnings.map((warning, index) => <div className="notice warning" key={index}><TriangleAlert size={17} />{warning}</div>)}

      <section className="stat-grid" aria-label="Account metrics">
        <Stat label="Paper equity" value={equity ? money.format(equity) : "--"} detail={`Buying power ${money.format(asNumber(account.buying_power))}`} icon={CircleDollarSign} />
        <Stat label="Today's P&L" value={equity ? `${pnl >= 0 ? "+" : ""}${money.format(pnl)}` : "--"} detail="Equity versus prior close" icon={Activity} tone={pnl >= 0 ? "positive" : "negative"} />
        <Stat label="Open positions" value={number.format(data?.positions.length ?? 0)} detail={`${data?.orders.length ?? 0} working orders`} icon={Zap} />
        <Stat label="Decision journal" value={number.format(decisionCount)} detail={summary} icon={Bot} />
      </section>

      <section className="dashboard-grid">
        <section className="panel surface-panel">
          <div className="panel-heading"><div><p className="eyebrow">SURFACE ENGINE</p><h2>Moneyness-tenor IV residual</h2></div><span className="score-chip">{score !== null ? `${(score * 100).toFixed(1)}%` : "Awaiting market scan"}</span></div>
          <SurfacePlot decisions={data?.decisions ?? []} />
          <div className="plot-labels"><span>IV premium</span><span>fitted surface</span><span>IV discount</span></div>
          <div className="thesis"><Sparkles size={18} /><p>{latest?.rationale ?? latestResearchDecision?.rationale ?? "The autonomous market loop has not published a candidate yet."}</p></div>
        </section>

        <section className="panel controls-panel">
          <div className="panel-heading"><div><p className="eyebrow">EXECUTION AGENT</p><h2>Control plane</h2></div><SlidersHorizontal size={19} /></div>
          <div className="control-row"><div><strong>New paper entries</strong><p>Disabling entries never disables position exits.</p></div><label className="switch"><input type="checkbox" checked={Boolean(data?.settings.trading_enabled)} disabled={!data || saving || data.settings.emergency_stop} onChange={(event) => data && void saveSettings({ ...data.settings, trading_enabled: event.target.checked })} /><span /></label></div>
          <label className="mode-select"><span>Capital stage</span><select value={data?.settings.promotion_stage ?? "research"} disabled={!data || saving} onChange={(event) => data && void saveSettings({ ...data.settings, promotion_stage: event.target.value as "research" | "shadow" | "paper" })}><option value="research">Research</option><option value="shadow">Shadow</option><option value="paper">Paper</option></select></label>
          <label className="cap-input"><span>Max premium per trade</span><div><b>$</b><input type="number" min="1" value={data?.settings.max_premium_per_trade ?? 500} disabled={!data || saving} onChange={(event) => data && setData({ ...data, settings: { ...data.settings, max_premium_per_trade: Number(event.target.value) } })} onBlur={() => data && void saveSettings(data.settings)} /></div></label>
          <button className="primary-button run-button" type="button" disabled={!data || running || controlRequestActive} onClick={() => void runScan()}><Play size={17} fill="currentColor" />{running || controlRequestActive ? "Agent request in progress" : "Run agent now"}</button>
          <button className="hard-kill" type="button" disabled={!data || saving} onClick={() => void hardKill()}><ShieldAlert size={16} />Emergency liquidate and lock</button>
          <button className="rearm-button" type="button" disabled={!data || saving} onClick={() => void rearmBroker()}><RotateCcw size={15} />Re-arm broker</button>
          <p className="control-note"><Clock3 size={15} />{workerHealthy ? `Execution worker healthy; heartbeat ${Math.round(heartbeatAge / 1000)}s ago.` : "Execution worker missing or stale; paper entries fail closed."}</p>
        </section>
      </section>

      <section className="panel allocation-panel">
        <div className="panel-heading"><div><p className="eyebrow">PAYOFF ENGINE / CAPITAL ALLOCATOR</p><h2>Expected-value ranked execution</h2></div><span className={`score-chip ${allocationReady ? "" : "allocation-waiting"}`}>{allocationReady ? allocation.structure?.toUpperCase() : "NO QUALIFYING PAYOFF"}</span></div>
        {allocationReady ? <><div className="allocation-grid">
          <div><span>Maximum loss</span><strong>{money.format(asNumber(allocation.max_loss) * asNumber(allocation.quantity))}</strong><small>{number.format(asNumber(allocation.quantity))} spread{asNumber(allocation.quantity) === 1 ? "" : "s"} allocated</small></div>
          <div><span>Maximum reward</span><strong>{money.format(asNumber(allocation.max_reward) * asNumber(allocation.quantity))}</strong><small>Defined at entry</small></div>
          <div><span>Reward / risk</span><strong>{asNumber(allocation.reward_risk).toFixed(2)}x</strong><small>Payoff geometry</small></div>
          <div><span>Base / stress EV</span><strong>{money.format(asNumber(allocation.base_expected_value) * asNumber(allocation.quantity))} / {money.format(asNumber(allocation.stressed_expected_value) * asNumber(allocation.quantity))}</strong><small>Mark-forward distribution</small></div>
          <div><span>Profit probability</span><strong>{(asNumber(allocation.payoff_probability) * 100).toFixed(0)}%</strong><small>No probability floor</small></div>
          <div><span>Fractional Kelly</span><strong>{(asNumber(allocation.kelly_fraction) * 100).toFixed(1)}%</strong><small>Hard-capped; CVaR {money.format(asNumber(allocation.cvar_95))}</small></div>
        </div><p className="allocation-note"><strong>{allocation.alpha_source?.replace("-", " ")}</strong>: {allocation.alpha_rationale}. Long {latest?.option_symbol} / short {allocation.short_leg}. EV comes from calibrated return scenarios, option repricing, quote friction, and an adverse tail stress before deterministic capital gates run.</p></> : <><p className="allocation-note muted">{allocation?.reason ?? "The payoff engine will publish an allocation after the next executable surface scan."}</p>{allocation?.funnel && <div className="allocation-grid"><div><span>Surface contracts</span><strong>{number.format(asNumber(allocation.funnel.candidatesSeen))}</strong><small>Economic fit universe</small></div><div><span>Executable longs</span><strong>{number.format(asNumber(allocation.funnel.executableLongLegs))}</strong><small>Fresh and liquid</small></div><div><span>Alpha-qualified</span><strong>{number.format(asNumber(allocation.funnel.alphaQualified))}</strong><small>Dual-alpha router</small></div><div><span>Priced verticals</span><strong>{number.format(asNumber(allocation.funnel.spreadsPriced))}</strong><small>Both legs executable</small></div><div><span>Stress valuations</span><strong>{number.format(asNumber(allocation.funnel.valuationsRun))}</strong><small>Distributional engine</small></div><div><span>Ranked plans</span><strong>{number.format(asNumber(allocation.funnel.plansRanked))}</strong><small>All hard gates passed</small></div></div>}</>}
      </section>

      <section className="panel ledger-panel">
        <div className="panel-heading"><div><p className="eyebrow">EXECUTION LEDGER / BROKER RECONCILIATION</p><h2>Atomic spread lifecycle</h2></div><span className="score-chip">{intents.filter((intent) => !["closed", "canceled", "error"].includes(intent.status)).length} active</span></div>
        <div className="table-wrap"><table><thead><tr><th>Time</th><th>Structure</th><th>State</th><th>Maximum loss</th><th>Broker IDs</th></tr></thead><tbody>
          {intents.slice(0, 8).map((intent) => <tr key={intent.id ?? intent.idempotency_key}><td>{shortTime(intent.created_at)}</td><td><strong>{intent.underlying} debit spread</strong><span>{intent.long_leg} / {intent.short_leg}</span></td><td><span className={`status ${intent.status === "open" || intent.status === "closed" ? "good" : intent.status === "error" ? "bad" : "neutral"}`}>{intent.status.replace("_", " ")}</span></td><td>{money.format(asNumber(intent.max_loss))}</td><td><span className="ledger-id">{intent.entry_order_id ?? "Awaiting entry"}{intent.exit_order_id ? ` / ${intent.exit_order_id}` : ""}</span></td></tr>)}
          {!intents.length && <tr><td colSpan={5} className="empty-cell">No broker execution intents yet. Paper orders are reserved here before Alpaca receives them.</td></tr>}
        </tbody></table></div>
      </section>

      <section className="panel calibration-panel">
        <div className="panel-heading"><div><p className="eyebrow">RELIABILITY LOOP / MODEL CALIBRATION</p><h2>Expected versus realized paper outcomes</h2></div><span className={`status ${calibration?.status === "degraded" ? "bad" : calibration?.status === "calibrated" ? "good" : "neutral"}`}>{calibration?.status ?? "warming"}</span></div>
        <div className="calibration-grid"><div><span>Closed spreads</span><strong>{number.format(calibration?.sample_size ?? 0)}</strong></div><div><span>Predicted EV</span><strong>{money.format(asNumber(calibration?.predicted_ev))}</strong></div><div><span>Realized P&L</span><strong className={asNumber(calibration?.realized_pnl) >= 0 ? "positive-text" : "negative-text"}>{money.format(asNumber(calibration?.realized_pnl))}</strong></div><div><span>Outcome Brier</span><strong>{asNumber(calibration?.brier_score).toFixed(3)}</strong></div><div><span>Realized win rate</span><strong>{(asNumber(calibration?.realized_win_rate) * 100).toFixed(0)}%</strong></div></div>
        <p className="allocation-note">VolForge records a calibration state after each closed spread. It warms up first, then blocks new paper exposure if realized outcomes materially diverge from the model’s claimed expectancy.</p>
      </section>

      <section className="panel calibration-panel">
        <div className="panel-heading"><div><p className="eyebrow">JUDGE MODE / ALPACA PAPER PERFORMANCE</p><h2>Broker-backed performance record</h2></div><span className="score-chip">PAPER ACCOUNT</span></div>
        <div className="judge-grid"><div><span>Closed structures</span><strong>{number.format(closedIntents.length)}</strong></div><div><span>Realized P&L</span><strong className={realizedPnl >= 0 ? "positive-text" : "negative-text"}>{money.format(realizedPnl)}</strong></div><div><span>Win rate</span><strong>{(realizedWinRate * 100).toFixed(0)}%</strong></div><div><span>Implementation shortfall</span><strong>{money.format(implementationShortfall)}</strong></div><div><span>Maximum drawdown</span><strong className="negative-text">{(maxDrawdown(equityCurve) * 100).toFixed(2)}%</strong></div><div><span>Evidence trails</span><strong>{number.format(decisionCount)}</strong></div><div><span>Account preflight</span><strong className={accountEligible ? "positive-text" : "negative-text"}>{accountEligible ? "PASSED" : "PENDING"}</strong></div><div><span>CLI oracle</span><strong className={cliHealthy ? "positive-text" : "negative-text"}>{cliHealthy ? "FRESH" : "PENDING"}</strong></div></div>
        <p className="allocation-note">Performance is computed from reconciled Alpaca paper structures. The account attestation and pinned CLI oracle must both match the connected account before paper entry.</p>
      </section>

      <section className="research-grid">
        <section className="panel research-panel"><div className="panel-heading"><div><p className="eyebrow">RESEARCH FACTORY</p><h2>Champion promotion</h2></div><FlaskConical size={19} /></div><div className="ladder"><span className={data?.settings.promotion_stage === "research" ? "active" : ""}>Research</span><i /><span className={data?.settings.promotion_stage === "shadow" ? "active" : ""}>Shadow</span><i /><span className={data?.settings.promotion_stage === "paper" ? "active" : ""}>Paper</span></div><div className="research-metrics"><div><strong>{researchReport?.strongest_models ?? 0}</strong><span>validated symbols</span></div><div><strong>{researchReport?.forecasts?.length ?? 0}</strong><span>model forecasts</span></div><div><strong>{research?.promotion_recommendation ?? "pending"}</strong><span>recommendation</span></div></div><p className="muted">Last autonomous research: {shortTime(research?.created_at)}. Walk-forward score must beat its baseline before a strategy may enter shadow mode.</p></section>
        <section className="panel research-panel"><div className="panel-heading"><div><p className="eyebrow">COUNTERFACTUAL VAULT</p><h2>Shadow digital twin</h2></div><Bot size={19} /></div><div className="shadow-number">{money.format(shadowPnl)}</div><p className="muted">{closedShadow.length} closed / {shadowPositions.filter((position) => position.status === "open").length} open, marked and exited at adverse executable quotes.</p><div className="constitution"><ShieldCheck size={17} /><span>Promotion is calculated only from closed out-of-sample shadow structures.</span></div></section>
        <section className="panel research-panel"><div className="panel-heading"><div><p className="eyebrow">RISK CONSTITUTION</p><h2>Portfolio circuit breakers</h2></div><ShieldCheck size={19} /></div><div className="risk-list">{((data?.riskSnapshot?.circuit_breakers as Array<{ name: string; passed: boolean; detail: string }> | undefined) ?? []).map((gate) => <div key={gate.name}><i className={gate.passed ? "live-dot" : "closed-dot"} /><span>{gate.name}</span><strong>{gate.detail}</strong></div>)}{!data?.riskSnapshot && <p className="muted">The first research run writes a portfolio snapshot here.</p>}</div></section>
      </section>

      <section className="panel court-panel"><div className="panel-heading"><div><p className="eyebrow">MODEL COURT / DECISION REPLAY</p><h2>Adversarial evidence for the latest candidate</h2></div><span className="score-chip">{evidenceHash ? `Proof ${evidenceHash.slice(0, 10)}` : "Awaiting evidence"}</span></div><div className="court-grid">{court.map((opinion) => <div key={opinion.agent} className={`court-opinion ${opinion.vote}`}><div><strong>{opinion.agent}</strong><span>{opinion.vote}</span></div><p>{opinion.rationale}</p></div>)}{!court.length && <p className="muted">Run the agent to convene the Surface, Regime, Execution, and Red Team agents.</p>}</div></section>

      <section className="panel journal-panel">
        <div className="panel-heading"><div><p className="eyebrow">AUDIT TRAIL / TIME MACHINE</p><h2>Decision journal</h2></div><span className="muted">Last 24 evaluations</span></div>
        <div className="table-wrap"><table><thead><tr><th>Time</th><th>Contract</th><th>Surface score</th><th>Agent verdict</th><th>Risk gates</th><th /></tr></thead>
          <tbody>{(data?.decisions ?? []).map((decision) => <tr key={decision.id ?? `${decision.option_symbol}-${decision.created_at}`}><td>{shortTime(decision.created_at)}</td><td><strong>{decision.option_symbol ?? decision.underlying}</strong><span>{decision.underlying}</span></td><td className="score-cell">{decision.score === null ? "--" : `${(decision.score * 100).toFixed(1)}%`}</td><td><span className={`status ${statusTone(decision.status)}`}>{decision.status}</span></td><td><span className="gate-count">{decision.risk_gates.filter((gate) => gate.passed).length}/{decision.risk_gates.length} cleared</span></td><td><button className="replay-button" type="button" onClick={() => setReplay(decision)}>Replay</button></td></tr>)}
          {!loading && !data?.decisions.length && <tr><td colSpan={6} className="empty-cell">No decisions have been journaled yet.</td></tr>}</tbody>
        </table></div>
      </section>
      {replay && <section className="panel replay-panel"><div className="panel-heading"><div><p className="eyebrow">TRACE {replay.trace_id?.slice(0, 12) ?? "UNVERSIONED"}</p><h2>{replay.option_symbol ?? replay.underlying}</h2></div><button className="replay-button" type="button" onClick={() => setReplay(null)}>Close replay</button></div><p className="replay-rationale">{replay.rationale}</p><div className="replay-gates">{replay.risk_gates.map((gate) => <div key={gate.name} className={gate.passed ? "pass" : "fail"}><strong>{gate.name}</strong><span>{gate.detail}</span></div>)}</div></section>}
    </div>
  </main>;
}
