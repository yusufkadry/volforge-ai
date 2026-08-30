import { runResearch } from "../lib/research";
import { journal } from "../lib/supabase";

runResearch()
  .then(async ({ run, forecasts }) => {
    const validated = forecasts.filter((forecast) => forecast.validation.mae < forecast.validation.baselineMae && forecast.validation.directionAccuracy >= 0.52);
    await journal.writeDecision({
      source: "weekend_research_factory",
      underlying: "RESEARCH",
      option_symbol: null,
      side: null,
      score: null,
      implied_volatility: null,
      expected_move: null,
      status: "SCANNED",
      rationale: `Autonomous research completed: ${forecasts.length} forecasts, ${validated.length} walk-forward validated. Promotion recommendation: ${run.promotion_recommendation}. No broker or options-order capability is available to this workflow.`,
      risk_gates: [
        { name: "Research-only boundary", passed: true, detail: "No trading credentials or order route are used." },
        { name: "Walk-forward validation", passed: validated.length > 0, detail: `${validated.length}/${forecasts.length} forecasts beat their validation baseline.` },
      ],
      trace_id: run.trace_id,
      strategy_version: run.strategy_version,
      model_score: forecasts.length ? validated.length / forecasts.length : 0,
      data_freshness_ms: null,
      raw: { research_run: run, forecasts: forecasts.map((forecast) => ({ symbol: forecast.symbol, validation: forecast.validation })) },
    });
    console.log(JSON.stringify({ mode: "research_only", trace_id: run.trace_id, recommendation: run.promotion_recommendation, forecasts: forecasts.length, validated: validated.length, stress: forecasts.map((forecast) => ({ symbol: forecast.symbol, ...forecast.validation.stress })), generated_at: new Date().toISOString() }, null, 2));
  })
  .catch((error) => { console.error(error); process.exitCode = 1; });
