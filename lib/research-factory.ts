import { researchForecastPassed, runResearch } from "@/lib/research";
import { journal } from "@/lib/supabase";

export async function runAutonomousResearch(source = "autonomous_research_factory") {
  const { run, forecasts } = await runResearch();
  const validated = forecasts.filter(researchForecastPassed);
  await journal.writeDecision({
    source,
    underlying: "RESEARCH",
    option_symbol: null,
    side: null,
    score: null,
    implied_volatility: null,
    expected_move: null,
    status: "SCANNED",
    rationale: `Autonomous research completed: ${forecasts.length} symbols, ${validated.length} passed purged volatility and probability baselines at both holding and option horizons. Promotion recommendation: ${run.promotion_recommendation}. This workflow has no order-submission code path.`,
    risk_gates: [
      { name: "Research-only boundary", passed: true, detail: "No order-submission function is called by the research factory." },
      { name: "Purged walk-forward validation", passed: validated.length > 0, detail: `${validated.length}/${forecasts.length} symbols beat both realized-volatility and Brier baselines without overlapping labels.` },
    ],
    trace_id: run.trace_id,
    strategy_version: run.strategy_version,
    model_score: forecasts.length ? validated.length / forecasts.length : 0,
    data_freshness_ms: null,
    raw: { research_run: run, forecasts: forecasts.map((forecast) => ({ symbol: forecast.symbol, horizons: forecast.horizons.map((horizon) => ({ horizon: horizon.horizonTradingDays, validation: horizon.validation, manifest_hash: horizon.manifest.manifestHash })) })) },
  });
  return { run, forecasts, validated };
}
