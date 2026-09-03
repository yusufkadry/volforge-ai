import { alpaca } from "@/lib/alpaca";
import { calibrate } from "@/lib/calibration";
import { constitutionHash, STRATEGY_VERSION, traceId } from "@/lib/constitution";
import { critic } from "@/lib/critic";
import { advanceEmergencyStop } from "@/lib/emergency";
import { numberEnv, universe } from "@/lib/env";
import { reconcileExecution } from "@/lib/execution-reconciler";
import { executionKey, intentClientOrderId } from "@/lib/execution-ledger";
import { supervisionIssues } from "@/lib/execution-health";
import { conveneCourt } from "@/lib/model-court";
import { AmbiguousOrderSubmissionError, submitOrderRecoverably } from "@/lib/order-submission";
import { brokerAccountGates, cliAccountOracleGate, competitionAccountGate, executionHeartbeatGate, paperEndpointGate } from "@/lib/paper-readiness";
import { managePositions } from "@/lib/position-manager";
import { governPortfolio } from "@/lib/portfolio-governor";
import { DEFAULT_RESEARCH_MAX_AGE_MS, forecastsFromRun, forecastForDte, forecastForTradingDays, holdingDirection, researchForecastPassed, selectResearchRun, validationPassed } from "@/lib/research";
import { analyzeTradePlans, candidatesWithoutActiveExposure, rewardPlanFailure } from "@/lib/reward-engine";
import { createRiskSnapshot, portfolioGates } from "@/lib/risk-book";
import { manageShadowPositions, reserveShadowPosition, shadowPromotionEvidence } from "@/lib/shadow-manager";
import { composeStructure } from "@/lib/structure-composer";
import { journal } from "@/lib/supabase";
import { riskGates, scanSurface, selectCandidate, thesis } from "@/lib/strategy";
import { assessWorldIntelligence } from "@/lib/world-intelligence";
import type { Decision, ResearchForecast, ResearchRun } from "@/lib/types";

function researchTimestamp(run: ResearchRun | null | undefined) {
  const generated = typeof run?.report?.generated_at === "string" ? run.report.generated_at : run?.created_at;
  return generated ? new Date(generated).getTime() : 0;
}

function validationDetail(forecast: ResearchForecast | undefined, dte: number) {
  if (!forecast) return "No forecast";
  const option = forecastForDte(forecast, dte);
  const holding = forecastForTradingDays(forecast, numberEnv("EXPECTED_HOLDING_DAYS", 3));
  if (!option || !holding) return "Required option and holding horizons are missing";
  return `${option.horizonTradingDays}d: MAE ${option.validation.mae.toFixed(3)} vs ${option.validation.baselineMae.toFixed(3)}, Brier ${option.validation.brier.toFixed(3)} vs ${option.validation.baselineBrier.toFixed(3)}; ${holding.horizonTradingDays}d holding model also ${validationPassed(holding.validation) ? "passed" : "failed"}`;
}

async function liveCapitalAuthorization(stage: "research" | "shadow" | "paper", maximumLoss: number) {
  const current = await journal.settings();
  const stageMatches = current.promotion_stage === stage;
  const armed = stage === "shadow" || (stage === "paper" && current.trading_enabled);
  const withinCurrentCap = maximumLoss <= current.max_premium_per_trade;
  const passed = stage !== "research" && stageMatches && armed && !current.emergency_stop && withinCurrentCap;
  return { passed, current, detail: passed ? `${stage} allocation remains authorized at commit time` : `Capital changed during evaluation: stage ${current.promotion_stage}, entries ${current.trading_enabled ? "armed" : "disarmed"}, emergency ${current.emergency_stop ? "active" : "clear"}, $${maximumLoss.toFixed(0)} loss / $${current.max_premium_per_trade.toFixed(0)} current cap` };
}

export async function runAgent(source: "scheduled" | "manual" = "scheduled") {
  const trace_id = traceId();
  const leaseName = "volforge-capital-loop";
  const leaseOwner = `${source}:${trace_id}`;
  const leaseTtl = numberEnv("AGENT_LEASE_TTL_SECONDS", 240);
  const acquired = await journal.acquireLease(leaseName, leaseOwner, leaseTtl);
  if (!acquired) {
    return write({ source, underlying: "CONTROL", option_symbol: null, side: null, score: null, implied_volatility: null, expected_move: null, status: "SCANNED", rationale: "Another VolForge control loop owns the capital lease; this overlapping run exited without evaluating or submitting risk.", risk_gates: [{ name: "Distributed capital lease", passed: false, detail: "Concurrent run safely suppressed" }], trace_id, strategy_version: STRATEGY_VERSION, raw: { constitution_hash: constitutionHash(), lease: leaseName } });
  }
  const renewLease = async () => {
    try { return await journal.renewLease(leaseName, leaseOwner, leaseTtl); }
    catch { return false; }
  };
  const renewalTimer = setInterval(() => void renewLease(), Math.max(30, Math.min(60, Math.floor(leaseTtl / 3))) * 1000);
  try {
    return await runLeasedAgent(source, trace_id, renewLease);
  } finally {
    clearInterval(renewalTimer);
    await journal.releaseLease(leaseName, leaseOwner).catch(() => false);
  }
}

async function runLeasedAgent(source: "scheduled" | "manual", trace_id: string, renewLease: () => Promise<boolean>) {
  const [settings, clock, researchRuns, account, accountConfiguration, heartbeat, accountAttestation, cliPreflight] = await Promise.all([
    journal.settings(), alpaca.clock(), journal.research(), alpaca.account(), alpaca.accountConfig(), journal.latestHeartbeat("execution-control-plane"), journal.latestAccountAttestation(), journal.latestCliPreflight(),
  ]);
  const researchSelection = selectResearchRun(researchRuns, settings.promotion_stage === "shadow" || settings.promotion_stage === "paper");
  const latestResearch = researchSelection.selected;
  const researchSelectionEvidence = {
    selected_trace_id: researchSelection.selected?.trace_id ?? null,
    newest_trace_id: researchSelection.newest?.trace_id ?? null,
    champion_trace_id: researchSelection.champion?.trace_id ?? null,
    used_prior_champion: researchSelection.usedChampion,
  };
  const entriesAllowed = settings.promotion_stage === "paper" && settings.trading_enabled && !settings.emergency_stop;
  const reconciliation = await reconcileExecution({ entriesAllowed, leaseGuard: renewLease });
  const managementLease = await renewLease();
  const positionActions = managementLease && clock.is_open && !settings.emergency_stop ? await managePositions() : [];
  const shadowActions = managementLease ? await manageShadowPositions(clock.is_open) : [];
  const emergency = settings.emergency_stop && managementLease ? await advanceEmergencyStop() : null;
  const riskSnapshot = await createRiskSnapshot(trace_id, settings);
  const shadowEvidence = await shadowPromotionEvidence();

  if (settings.emergency_stop) {
    return write({
      source, underlying: "CONTROL", option_symbol: null, side: null, score: null, implied_volatility: null, expected_move: null,
      status: "SCANNED", rationale: emergency?.complete ? "Emergency liquidation is complete and the Alpaca broker is suspended." : "Emergency liquidation remains active. New entries are blocked while every tracked and orphaned option exposure is reconciled and closed.",
      risk_gates: [{ name: "Emergency stop", passed: false, detail: emergency?.complete ? "Liquidation complete" : "Liquidation in progress" }], trace_id, strategy_version: STRATEGY_VERSION,
      raw: { constitution_hash: constitutionHash(), reconciliation, position_actions: positionActions, shadow_actions: shadowActions, emergency },
    });
  }

  const researchAgeMs = Date.now() - researchTimestamp(latestResearch);
  const researchFresh = Boolean(latestResearch && researchAgeMs >= 0 && researchAgeMs <= numberEnv("RESEARCH_MAX_AGE_MS", DEFAULT_RESEARCH_MAX_AGE_MS));
  const forecasts = forecastsFromRun(latestResearch);
  const researchBySymbol = new Map(forecasts.map((forecast) => [forecast.symbol, forecast]));
  if (!latestResearch || !forecasts.length) {
    const rationale = latestResearch
      ? "The latest persisted research run uses a legacy or incomplete forecast schema. Run the autonomous research factory once with this release before market evaluation."
      : "No persisted research forecast is available. The dedicated research workflow must complete before market evaluation.";
    return write({ source, underlying: "RESEARCH", option_symbol: null, side: null, score: null, implied_volatility: null, expected_move: null, status: "ERROR", rationale, risk_gates: [{ name: "Research availability", passed: false, detail: latestResearch ? "Selected research run has no valid horizon manifests" : "No versioned forecast manifest found" }], trace_id, strategy_version: STRATEGY_VERSION, raw: { constitution_hash: constitutionHash(), research_trace_id: latestResearch?.trace_id ?? null, research_selection: researchSelectionEvidence, reconciliation, position_actions: positionActions, shadow_actions: shadowActions } });
  }

  const symbols = universe();
  const scans = await Promise.allSettled(symbols.map(async (symbol) => {
    const forecast = researchBySymbol.get(symbol);
    const executionStage = settings.promotion_stage === "shadow" || settings.promotion_stage === "paper";
    if (!forecast || (executionStage && !researchForecastPassed(forecast))) return [];
    const direction = holdingDirection(forecast);
    if (!direction || direction.conviction < numberEnv("MIN_DIRECTIONAL_CONVICTION", 0.015)) return [];
    return scanSurface(symbol, direction.contractType);
  }));
  const scanErrors = scans.flatMap((result, index) => result.status === "rejected" ? [`${symbols[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : []);
  const allCandidates = scans.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  await journal.writeObservations(scans.map((result, index) => {
    const candidates = result.status === "fulfilled" ? result.value : [];
    const leader = selectCandidate(candidates);
    return { trace_id, engine: "Surface", underlying: symbols[index], option_symbol: leader?.optionSymbol ?? null, payload: { contracts_seen: candidates.length, leader, complete: result.status === "fulfilled", scan_error: result.status === "rejected" ? String(result.reason) : null, research_trace_id: latestResearch.trace_id } };
  }));
  const failureCooldownMinutes = Math.max(1, numberEnv("ENTRY_FAILURE_COOLDOWN_MINUTES", 30));
  const failureCutoff = new Date(Date.now() - failureCooldownMinutes * 60_000).toISOString();
  const [activeIntents, activeShadows, recentFailedIntents] = await Promise.all([
    journal.activeIntents(), journal.activeShadowPositions(), settings.promotion_stage === "paper" ? journal.recentFailedIntents(failureCutoff) : Promise.resolve([]),
  ]);
  const activeExposure = settings.promotion_stage === "shadow" ? activeShadows : activeIntents;
  const failedUnderlyings = new Set(recentFailedIntents.map((intent) => intent.underlying));
  const blockedUnderlyings = new Set([...activeExposure.map((position) => position.underlying), ...failedUnderlyings]);
  const allocationCandidates = candidatesWithoutActiveExposure(allCandidates, blockedUnderlyings);
  const blockedCandidateCount = allCandidates.length - allocationCandidates.length;
  const allocationAnalysis = analyzeTradePlans(allocationCandidates, researchBySymbol, Number(account.equity ?? 0), settings.max_premium_per_trade);
  const tradePlan = allocationAnalysis.plans[0];
  const candidate = tradePlan?.candidate ?? selectCandidate(allocationCandidates) ?? selectCandidate(allCandidates);
  const allocationFailure = blockedCandidateCount > 0 && !allocationCandidates.length
    ? `${blockedCandidateCount} contracts were excluded by active ${settings.promotion_stage} exposure or a ${failureCooldownMinutes}-minute broker-failure cooldown.`
    : rewardPlanFailure(allocationCandidates, researchBySymbol, Number(account.equity ?? 0), settings.max_premium_per_trade, allocationAnalysis.diagnostics);

  if (!candidate) {
    const reason = scanErrors.length === symbols.length
      ? `Every option-chain scan failed closed: ${scanErrors.join(" | ")}`
      : `No complete option chain passed the model-directed scan. ${allocationFailure}`;
    return write({ source, underlying: "MARKET", option_symbol: null, side: null, score: null, implied_volatility: null, expected_move: null, status: scanErrors.length === symbols.length ? "ERROR" : "SCANNED", rationale: reason, risk_gates: [{ name: "Research freshness", passed: researchFresh, detail: researchFresh ? `${Math.round(researchAgeMs / 60_000)} minutes old` : "Persisted research is stale" }], trace_id, strategy_version: STRATEGY_VERSION, raw: { constitution_hash: constitutionHash(), research_trace_id: latestResearch.trace_id, research_selection: researchSelectionEvidence, scan_errors: scanErrors, reconciliation, position_actions: positionActions, shadow_actions: shadowActions, allocation: { status: "unavailable", reason, funnel: allocationAnalysis.diagnostics, blocked_candidate_count: blockedCandidateCount, blocked_underlyings: [...blockedUnderlyings], broker_failure_cooldown_underlyings: [...failedUnderlyings] } } });
  }

  const forecast = researchBySymbol.get(candidate.underlying);
  const optionForecast = forecast ? forecastForDte(forecast, candidate.dte) : undefined;
  const activeIntent = activeIntents.find((intent) => intent.underlying === candidate.underlying) ?? null;
  const activeShadow = activeShadows.find((position) => position.underlying === candidate.underlying) ?? null;
  const marketNow = clock.timestamp && Number.isFinite(new Date(clock.timestamp).getTime()) ? new Date(clock.timestamp) : new Date();
  const idempotencyKey = tradePlan ? executionKey(tradePlan, marketNow, trace_id) : null;
  const world = await assessWorldIntelligence(candidate);
  const governor = tradePlan ? await governPortfolio(tradePlan, Number(account.equity ?? 0), clock.is_open, settings.promotion_stage, marketNow) : null;
  const calibration = await calibrate();
  const forecastEdge = tradePlan?.forecastEdge ?? (optionForecast?.forecastRv ?? 0) - candidate.impliedVolatility;
  const gates = riskGates(candidate, clock.is_open);
  const managementIssues = supervisionIssues(positionActions);
  const reconciliationFailures = reconciliation.intents.filter((item) => !["open", "filled", "closed", "new", "accepted", "pending_new", "working", "canceled", "cancel_requested", "resubmitted", "submitted", "skipped"].includes(item.state));
  gates.push({
    name: "Execution reconciliation",
    passed: reconciliation.healthy,
    detail: reconciliation.healthy
      ? `${reconciliation.intents.length} active intent(s) reconciled; no orphan broker option legs`
      : `${reconciliation.orphanPositions.length} orphan leg(s); unresolved states ${reconciliationFailures.map((item) => item.state).join(", ") || "broker-state mismatch"}`,
  });
  gates.push({ name: "Position supervision", passed: managementIssues.length === 0, detail: managementIssues.length ? `${managementIssues.length} unresolved mark, exit, or broker-persistence action(s)` : `${positionActions.length} position-management action(s); no unresolved supervision errors` });
  gates.push(...portfolioGates(riskSnapshot));
  gates.push(...(governor?.gates ?? [{ name: "Portfolio governor", passed: false, detail: "No qualifying structure available for portfolio simulation" }]));
  gates.push({ name: "Research freshness", passed: researchFresh, detail: researchFresh ? `${Math.round(researchAgeMs / 60_000)} minutes old; trace ${latestResearch.trace_id.slice(0, 8)}` : `${Math.round(researchAgeMs / 3_600_000)} hours old; refresh required` });
  gates.push({ name: "Alpha thesis", passed: Boolean(tradePlan), detail: tradePlan ? `${tradePlan.alphaSource}: ${tradePlan.alphaRationale}` : allocationFailure });
  gates.push({ name: "Horizon distribution", passed: Boolean(optionForecast && validationPassed(optionForecast.validation)), detail: optionForecast ? `${optionForecast.horizonTradingDays}-trading-day RV ${(optionForecast.forecastRv * 100).toFixed(1)}%; observed IV ${(candidate.impliedVolatility * 100).toFixed(1)}%; spread ${(forecastEdge * 100).toFixed(1)} points` : `No forecast matched ${candidate.dte} calendar DTE` });
  gates.push({ name: "Purged validation", passed: Boolean(forecast && researchForecastPassed(forecast)), detail: validationDetail(forecast, candidate.dte) });
  gates.push({ name: "Reward-to-risk", passed: Boolean(tradePlan && tradePlan.rewardRisk >= numberEnv("MIN_REWARD_RISK", 1.25)), detail: tradePlan ? `${tradePlan.rewardRisk.toFixed(2)}x maximum reward / approved maximum debit loss` : rewardPlanFailure(allCandidates, researchBySymbol, Number(account.equity ?? 0), settings.max_premium_per_trade) });
  gates.push({ name: "Distributional expected value", passed: Boolean(tradePlan && tradePlan.baseExpectedValue >= numberEnv("MIN_EXPECTED_VALUE", 8)), detail: tradePlan ? `$${tradePlan.baseExpectedValue.toFixed(2)} base mark-forward EV across ${tradePlan.valuation.scenarioCount} scenarios` : "No valid payoff integration" });
  gates.push({ name: "Adverse-stress expected value", passed: Boolean(tradePlan && tradePlan.stressedExpectedValue >= numberEnv("MIN_STRESS_EXPECTED_VALUE", 0)), detail: tradePlan ? `$${tradePlan.stressedExpectedValue.toFixed(2)} EV under fat-tail, zero-convergence, higher-friction stress` : "No adverse valuation" });
  gates.push({ name: "Risk-sized allocation", passed: Boolean(tradePlan && tradePlan.quantity >= 1), detail: tradePlan ? `${tradePlan.quantity} spread${tradePlan.quantity === 1 ? "" : "s"}; $${(tradePlan.maxLoss * tradePlan.quantity).toFixed(2)} approved maximum loss within $${tradePlan.riskBudget.toFixed(2)} budget` : "No spread fits the risk budget" });
  const multiLegAuthorized = process.env.ENABLE_MULTI_LEG !== "false" && Number(account.options_trading_level ?? 0) >= 3;
  gates.push({ name: "Multi-leg authorization", passed: multiLegAuthorized, detail: multiLegAuthorized ? `Alpaca options level ${String(account.options_trading_level)} supports atomic debit spreads` : "Atomic multi-leg paper authority is unavailable" });
  const duplicate = settings.promotion_stage === "shadow" ? activeShadow : activeIntent;
  gates.push({ name: "Duplicate exposure", passed: !duplicate, detail: duplicate ? `Existing active ${settings.promotion_stage} structure on ${candidate.underlying}` : `No active ${settings.promotion_stage} structure on this underlying` });
  gates.push({ name: "Event intelligence", passed: world.verdict !== "veto", detail: world.rationale });
  gates.push({ name: "Calibration integrity", passed: calibration.status !== "degraded", detail: `${calibration.status}; ${calibration.sample_size} closed paper spreads, realized $${calibration.realized_pnl.toFixed(0)} versus predicted $${calibration.predicted_ev.toFixed(0)}` });
  const decisionLease = await renewLease();
  gates.push({ name: "Distributed capital lease", passed: decisionLease, detail: decisionLease ? "Exclusive renewable capital lease is held" : "Capital lease was lost; all allocation is suppressed" });
  const authorization = await liveCapitalAuthorization(settings.promotion_stage, tradePlan ? tradePlan.maxLoss * tradePlan.quantity : 0);
  gates.push({ name: "Live capital authorization", passed: authorization.passed, detail: authorization.detail });
  const paperOnlyGates = [
    paperEndpointGate(),
    executionHeartbeatGate(heartbeat),
    competitionAccountGate(accountAttestation, account),
    cliAccountOracleGate(cliPreflight, account),
    ...brokerAccountGates(account, accountConfiguration, tradePlan ? tradePlan.maxLoss * tradePlan.quantity : 0),
  ];
  gates.push(...paperOnlyGates.map((gate) => settings.promotion_stage === "paper" ? gate : { ...gate, passed: true, detail: `${gate.name} is enforced only after explicit Paper-stage authorization` }));
  const criticResult = await critic(candidate, tradePlan, world);
  gates.push({ name: "AI critic hard veto", passed: !criticResult.hardVeto, detail: criticResult.hardVeto ? `Hard veto: ${criticResult.rationale}` : criticResult.approve ? `Approved: ${criticResult.rationale}` : `Advisory concerns only: ${criticResult.rationale}` });
  gates.push({ name: "Capital promotion", passed: settings.promotion_stage !== "research", detail: `Current stage: ${settings.promotion_stage}` });
  gates.push({ name: "New-entry arm", passed: settings.promotion_stage === "shadow" || entriesAllowed, detail: settings.promotion_stage === "shadow" ? "Shadow allocation enabled without broker submission" : entriesAllowed ? "Paper entries armed" : "Paper entries disabled" });
  const excluded = new Set(["Capital promotion", "New-entry arm"]);
  const researchApproved = gates.filter((gate) => !excluded.has(gate.name)).every((gate) => gate.passed);
  const approved = settings.promotion_stage === "shadow"
    ? researchApproved
    : settings.promotion_stage === "paper" && researchApproved && entriesAllowed;
  const court = conveneCourt(candidate, forecast, gates, tradePlan, world);
  const decision: Decision = {
    source, underlying: candidate.underlying, option_symbol: candidate.optionSymbol, side: "buy",
    score: candidate.surface.relativeResidual, implied_volatility: candidate.impliedVolatility,
    expected_move: optionForecast?.forecastRv ?? null, status: approved ? "APPROVED" : "REJECTED",
    rationale: `${thesis(candidate)}${tradePlan ? ` ${tradePlan.alphaSource} thesis: ${tradePlan.alphaRationale}. Proposed ${candidate.contractType} debit spread: buy ${candidate.optionSymbol}, sell ${tradePlan.shortLeg.optionSymbol}; $${tradePlan.debit.toFixed(2)} initial limit, $${tradePlan.maxEntryDebit.toFixed(2)} absolute model-approved debit cap, $${tradePlan.maxLoss.toFixed(0)} maximum loss, $${tradePlan.maxReward.toFixed(0)} maximum reward, $${tradePlan.baseExpectedValue.toFixed(0)} base EV, and $${tradePlan.stressedExpectedValue.toFixed(0)} adverse-stress EV per spread.` : ""} ${criticResult.rationale}`,
    risk_gates: gates,
    trace_id, strategy_version: STRATEGY_VERSION, model_score: optionForecast?.validation.brierSkill ?? null,
    data_freshness_ms: candidate.quoteTimestamp ? Math.max(0, Date.now() - new Date(candidate.quoteTimestamp).getTime()) : null,
    raw: {
      constitution_hash: constitutionHash(), evidence_hash: court.evidenceHash, research_trace_id: latestResearch.trace_id, research_selection: researchSelectionEvidence,
      forecast, selected_horizon: optionForecast, court: court.opinions, world, portfolio_governor: governor, calibration, shadow_evidence: shadowEvidence,
      execution_heartbeat: heartbeat, account_attestation: accountAttestation, cli_preflight: cliPreflight, account_configuration: accountConfiguration, reconciliation, risk_snapshot: riskSnapshot, position_actions: positionActions, shadow_actions: shadowActions, scan_errors: scanErrors,
      allocation: tradePlan ? {
        status: "ranked", model: tradePlan.valuation.model, alpha_source: tradePlan.alphaSource, alpha_rationale: tradePlan.alphaRationale, structure: `${candidate.contractType} debit spread`, short_leg: tradePlan.shortLeg.optionSymbol,
        initial_limit: tradePlan.debit, entry_mid: tradePlan.entryMid, natural_debit: tradePlan.naturalDebit, maximum_approved_debit: tradePlan.maxEntryDebit,
        max_loss: tradePlan.maxLoss, max_reward: tradePlan.maxReward, reward_risk: tradePlan.rewardRisk,
        payoff_probability: tradePlan.payoffProbability, base_expected_value: tradePlan.baseExpectedValue, stressed_expected_value: tradePlan.stressedExpectedValue,
        expected_value: tradePlan.expectedValue, kelly_fraction: tradePlan.kellyFraction, raw_kelly_fraction: tradePlan.rawKellyFraction,
        cvar_95: tradePlan.valuation.cvar95, pnl_percentiles: { p10: tradePlan.valuation.pnlP10, p50: tradePlan.valuation.pnlP50, p90: tradePlan.valuation.pnlP90 },
        risk_budget: tradePlan.riskBudget, quantity: tradePlan.quantity, allocation_score: tradePlan.allocationScore, idempotency_key: idempotencyKey, assumptions: tradePlan.valuation.assumptions, funnel: allocationAnalysis.diagnostics, blocked_candidate_count: blockedCandidateCount, blocked_underlyings: [...blockedUnderlyings], broker_failure_cooldown_underlyings: [...failedUnderlyings],
      } : { status: "rejected", reason: allocationFailure, funnel: allocationAnalysis.diagnostics, blocked_candidate_count: blockedCandidateCount, blocked_underlyings: [...blockedUnderlyings], broker_failure_cooldown_underlyings: [...failedUnderlyings] },
    },
  };

  const rejectForLostLease = async (intentId?: string | null) => {
    const leaseGate = decision.risk_gates.find((gate) => gate.name === "Distributed capital lease");
    if (leaseGate) Object.assign(leaseGate, { passed: false, detail: "Capital lease was lost before allocation reached its destination" });
    if (intentId) await journal.updateIntent(intentId, { status: "canceled", exit_reason: "lease_lost_before_submission", last_error: "Capital lease lost before Alpaca submission" }).catch(() => []);
    return write({ ...decision, status: "REJECTED", rationale: `${decision.rationale} Allocation suppressed because the renewable capital lease could not be verified.` });
  };
  const rejectForAuthorizationChange = async (intentId?: string | null) => {
    const authorizationGate = decision.risk_gates.find((gate) => gate.name === "Live capital authorization");
    const current = await liveCapitalAuthorization(settings.promotion_stage, tradePlan ? tradePlan.maxLoss * tradePlan.quantity : 0);
    if (authorizationGate) Object.assign(authorizationGate, { passed: false, detail: current.detail });
    if (intentId) await journal.updateIntent(intentId, { status: "canceled", exit_reason: "authorization_changed_before_submission", last_error: current.detail }).catch(() => []);
    return write({ ...decision, status: "REJECTED", rationale: `${decision.rationale} Allocation suppressed because capital authorization changed before submission.` });
  };

  await journal.writeEngineEvaluations([
    ...court.opinions.map((opinion) => ({ trace_id, engine: opinion.agent, verdict: opinion.vote === "reject" ? "veto" : opinion.vote, confidence: opinion.agent === "Regime" ? Math.min(1, Math.max(0, optionForecast?.validation.brierSkill ?? 0)) : opinion.agent === "Event Intelligence" ? world.confidence : opinion.vote === "approve" ? 0.8 : 0.5, expires_at: opinion.agent === "Event Intelligence" ? world.expiresAt : new Date(Date.now() + 5 * 60_000).toISOString(), evidence_hash: court.evidenceHash, payload: { opinion, candidate: candidate.optionSymbol, forecast_edge: forecastEdge } })),
    ...(governor ? [{ trace_id, engine: "Portfolio Governor", verdict: governor.gates.every((gate) => gate.passed) ? "approve" : "veto", confidence: 1, expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), evidence_hash: governor.evidenceHash, payload: governor.payload }] : []),
    { trace_id, engine: "Calibration Engine", verdict: calibration.status === "degraded" ? "veto" : calibration.status === "calibrated" ? "approve" : "abstain", confidence: calibration.sample_size ? Math.min(1, calibration.sample_size / 20) : 0, expires_at: new Date(Date.now() + 4 * 60 * 60_000).toISOString(), evidence_hash: constitutionHash(), payload: calibration },
  ]);

  if (!approved) return write(decision);
  if (!await renewLease()) return rejectForLostLease();
  if (!(await liveCapitalAuthorization(settings.promotion_stage, tradePlan ? tradePlan.maxLoss * tradePlan.quantity : 0)).passed) return rejectForAuthorizationChange();
  if (settings.promotion_stage === "shadow") {
    if (!tradePlan) return write(decision);
    const reservation = await reserveShadowPosition(tradePlan, trace_id, decision.rationale);
    return write({ ...decision, status: reservation.created ? "APPROVED" : "REJECTED", rationale: `${decision.rationale} ${reservation.reason}${reservation.created ? " No broker order was submitted." : ""}` });
  }

  let reservationId: string | null = null;
  let acknowledgedOrder: { orderId: string; clientOrderId: string } | null = null;
  try {
    if (!tradePlan) return write(decision);
    const reservation = await journal.reserveIntent({
      trace_id, strategy_version: STRATEGY_VERSION, idempotency_key: idempotencyKey ?? executionKey(tradePlan, marketNow, trace_id), stage: "paper", status: "entry_pending",
      underlying: candidate.underlying, contract_type: candidate.contractType, long_leg: candidate.optionSymbol, short_leg: tradePlan.shortLeg.optionSymbol, quantity: tradePlan.quantity, filled_quantity: 0,
      entry_debit: tradePlan.debit, entry_limit_price: tradePlan.debit, max_entry_debit: tradePlan.maxEntryDebit,
      max_loss: tradePlan.maxLoss * tradePlan.quantity, max_reward: tradePlan.maxReward * tradePlan.quantity, entry_attempts: 1, exit_attempts: 0,
      metadata: { alpha_source: tradePlan.alphaSource, alpha_rationale: tradePlan.alphaRationale, allocation_score: tradePlan.allocationScore, reward_risk: tradePlan.rewardRisk, expected_value: tradePlan.expectedValue, base_expected_value: tradePlan.baseExpectedValue, stressed_expected_value: tradePlan.stressedExpectedValue, payoff_probability: tradePlan.payoffProbability, cvar_95: tradePlan.valuation.cvar95, max_entry_debit: tradePlan.maxEntryDebit, model_manifest_hash: optionForecast?.manifest.manifestHash, valuation: tradePlan.valuation, arrival_quote: { mid: tradePlan.entryMid, natural: tradePlan.naturalDebit } },
    });
    if (!reservation.created || !reservation.intent?.id) return write({ ...decision, status: "REJECTED", rationale: `${decision.rationale} Entry skipped: an execution intent with this idempotency key already exists.` });
    reservationId = reservation.intent.id;
    if (!await renewLease()) return rejectForLostLease(reservationId);
    if (!(await liveCapitalAuthorization("paper", tradePlan.maxLoss * tradePlan.quantity)).passed) return rejectForAuthorizationChange(reservationId);
    const clientOrderId = intentClientOrderId(trace_id, "entry");
    const structure = composeStructure(tradePlan, clientOrderId);
    const submissionStartedAt = new Date().toISOString();
    const pendingMetadata = { ...(reservation.intent.metadata ?? {}), pending_entry_client_order_id: clientOrderId, entry_submission_started_at: submissionStartedAt };
    await journal.updateIntent(reservationId, { status: "entry_pending", entry_order_id: null, metadata: pendingMetadata });
    const submission = await submitOrderRecoverably(structure.payload, clientOrderId);
    const order = submission.order;
    const orderId = String(order.id ?? "");
    acknowledgedOrder = { orderId, clientOrderId };
    const acknowledgedMetadata = { ...pendingMetadata, entry_acknowledged_at: new Date().toISOString(), entry_ack_recovered: submission.recovered, entry_submission_error: submission.submissionError };
    const postSubmitAuthorization = await liveCapitalAuthorization("paper", tradePlan.maxLoss * tradePlan.quantity);
    if (!postSubmitAuthorization.passed) {
      await alpaca.cancelOrder(orderId).catch(() => null);
      await journal.updateIntent(reservationId, { status: "entry_cancel_pending", entry_order_id: orderId, last_error: postSubmitAuthorization.detail, metadata: acknowledgedMetadata });
      await journal.writeOrderEvent({ trace_id, alpaca_order_id: orderId, client_order_id: clientOrderId, event_key: `${orderId}:authorization_cancel_requested`, event_type: "authorization_cancel_requested", payload: { candidate, structure, order, authorization: postSubmitAuthorization.detail, acknowledgement_recovered: submission.recovered } });
      return write({ ...decision, status: "SUBMITTED", rationale: `${decision.rationale} Alpaca acknowledged the order while capital authorization changed; immediate cancellation was requested and reconciliation remains active.`, order_id: orderId });
    }
    await journal.updateIntent(reservationId, { status: "entry_submitted", entry_order_id: orderId, metadata: acknowledgedMetadata });
    await journal.writeOrderEvent({ trace_id, alpaca_order_id: orderId, client_order_id: clientOrderId, event_key: `${orderId}:entry_submitted`, event_type: "entry_submitted", payload: { candidate, selected_horizon: optionForecast, structure, order, acknowledgement_recovered: submission.recovered } });
    return write({ ...decision, status: "SUBMITTED", rationale: `${decision.rationale} Atomic structure submitted at the first price-ladder limit; broker ID ${orderId}.${submission.recovered ? " The broker acknowledgement was recovered idempotently by client order ID after the POST response failed." : ""}`, order_id: orderId });
  } catch (error) {
    if (reservationId && acknowledgedOrder) {
      await alpaca.cancelOrder(acknowledgedOrder.orderId).catch(() => null);
      await journal.updateIntent(reservationId, { status: "entry_cancel_pending", entry_order_id: acknowledgedOrder.orderId, last_error: `Post-acknowledgement persistence failed; cancellation requested. ${error instanceof Error ? error.message : "unknown error"}` }).catch(() => []);
      await journal.writeOrderEvent({ trace_id, alpaca_order_id: acknowledgedOrder.orderId, client_order_id: acknowledgedOrder.clientOrderId, event_key: `${acknowledgedOrder.orderId}:persistence_cancel_requested`, event_type: "persistence_cancel_requested", payload: { intent_id: reservationId, error: error instanceof Error ? error.message : "unknown error" } }).catch(() => []);
      return write({ ...decision, status: "ERROR", rationale: `${decision.rationale} Alpaca acknowledged broker order ${acknowledgedOrder.orderId}, but post-acknowledgement persistence failed. Cancellation was requested and the durable intent remains active for reconciliation.`, order_id: acknowledgedOrder.orderId });
    }
    if (reservationId && error instanceof AmbiguousOrderSubmissionError) {
      await journal.updateIntent(reservationId, { status: "entry_pending", last_error: error.message });
      return write({ ...decision, status: "ERROR", rationale: `${decision.rationale} Alpaca submission acknowledgement is temporarily unknown. The durable execution intent remains pending and reconciliation will query client order ID ${error.clientOrderId}; VolForge will not submit a duplicate.` });
    }
    if (reservationId) await journal.updateIntent(reservationId, { status: "error", last_error: error instanceof Error ? error.message : "unknown error" });
    return write({ ...decision, status: "ERROR", rationale: `${decision.rationale} Order submission failed: ${error instanceof Error ? error.message : "unknown error"}` });
  }
}

async function write(decision: Decision) {
  await journal.writeDecision(decision);
  return decision;
}
