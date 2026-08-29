"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Bot, CircleDollarSign, Clock3, LogOut, Play, RefreshCw, ShieldCheck, SlidersHorizontal, Sparkles, TriangleAlert, Zap } from "lucide-react";
import type { DashboardSnapshot, Decision } from "@/lib/types";

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function asNumber(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function shortTime(value?: string) { return value ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }).format(new Date(value)) : "No data"; }
function statusTone(status: Decision["status"]) { return status === "SUBMITTED" ? "good" : status === "APPROVED" ? "accent" : status === "ERROR" ? "bad" : "neutral"; }

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
    setNotice(response.ok ? `Scan complete: ${body.status}` : body.error ?? "Scan failed");
    setRunning(false); void refresh();
  }

  async function saveSettings(next: DashboardSnapshot["settings"]) {
    setSaving(true); setNotice("");
    const response = await fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
    if (!response.ok) setNotice("Settings could not be saved.");
    else setData((current) => current ? { ...current, settings: { ...current.settings, ...next } } : current);
    setSaving(false);
  }

  async function logout() { await fetch("/api/auth/logout", { method: "POST" }); window.location.assign("/login"); }
  const account = data?.account ?? {};
  const equity = asNumber(account.equity);
  const lastEquity = asNumber(account.last_equity);
  const pnl = equity - lastEquity;
  const latest = data?.decisions[0];
  const warnings = data?.errors ?? [];
  const score = latest?.score ?? 0;
  const mode = data?.settings.trading_enabled ? "PAPER TRADING ARMED" : "ANALYSIS ONLY";
  const decisionCount = data?.decisions.length ?? 0;
  const submitted = data?.decisions.filter((decision) => decision.status === "SUBMITTED").length ?? 0;
  const summary = useMemo(() => `${decisionCount} journaled / ${submitted} submitted`, [decisionCount, submitted]);

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
        <div className={`mode-indicator ${data?.settings.trading_enabled ? "armed" : "idle"}`}><ShieldCheck size={18} /><span>{mode}</span></div>
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
          <div className="panel-heading"><div><p className="eyebrow">SURFACE AGENT</p><h2>Relative IV anomaly</h2></div><span className="score-chip">{score ? `${(score * 100).toFixed(1)}%` : "Awaiting scan"}</span></div>
          <SurfacePlot decisions={data?.decisions ?? []} />
          <div className="plot-labels"><span>IV premium</span><span>expiry median</span><span>IV discount</span></div>
          <div className="thesis"><Sparkles size={18} /><p>{latest?.rationale ?? "The agent has not written a thesis yet. Run a first scan after configuring the environment variables."}</p></div>
        </section>

        <section className="panel controls-panel">
          <div className="panel-heading"><div><p className="eyebrow">EXECUTION AGENT</p><h2>Control plane</h2></div><SlidersHorizontal size={19} /></div>
          <div className="control-row"><div><strong>Paper trading</strong><p>Only approved decisions can reach Alpaca.</p></div><label className="switch"><input type="checkbox" checked={Boolean(data?.settings.trading_enabled)} disabled={!data || saving} onChange={(event) => data && void saveSettings({ ...data.settings, trading_enabled: event.target.checked })} /><span /></label></div>
          <label className="cap-input"><span>Max premium per trade</span><div><b>$</b><input type="number" min="1" value={data?.settings.max_premium_per_trade ?? 500} disabled={!data || saving} onChange={(event) => data && setData({ ...data, settings: { ...data.settings, max_premium_per_trade: Number(event.target.value) } })} onBlur={() => data && void saveSettings(data.settings)} /></div></label>
          <button className="primary-button run-button" type="button" disabled={!data || running} onClick={() => void runScan()}><Play size={17} fill="currentColor" />{running ? "Surface scan running" : "Run agent now"}</button>
          <p className="control-note"><Clock3 size={15} />Scheduled scan runs every five minutes on weekdays.</p>
        </section>
      </section>

      <section className="panel journal-panel">
        <div className="panel-heading"><div><p className="eyebrow">AUDIT TRAIL</p><h2>Decision journal</h2></div><span className="muted">Last 24 evaluations</span></div>
        <div className="table-wrap"><table><thead><tr><th>Time</th><th>Contract</th><th>Surface score</th><th>Agent verdict</th><th>Risk gates</th></tr></thead>
          <tbody>{(data?.decisions ?? []).map((decision) => <tr key={decision.id ?? `${decision.option_symbol}-${decision.created_at}`}><td>{shortTime(decision.created_at)}</td><td><strong>{decision.option_symbol ?? decision.underlying}</strong><span>{decision.underlying}</span></td><td className="score-cell">{decision.score === null ? "--" : `${(decision.score * 100).toFixed(1)}%`}</td><td><span className={`status ${statusTone(decision.status)}`}>{decision.status}</span></td><td><span className="gate-count">{decision.risk_gates.filter((gate) => gate.passed).length}/{decision.risk_gates.length} cleared</span></td></tr>)}
          {!loading && !data?.decisions.length && <tr><td colSpan={5} className="empty-cell">No decisions have been journaled yet.</td></tr>}</tbody>
        </table></div>
      </section>
    </div>
  </main>;
}
