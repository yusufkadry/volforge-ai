import { runAutonomousResearch } from "../lib/research-factory";

runAutonomousResearch()
  .then(({ run, forecasts, validated }) => {
    console.log(JSON.stringify({ mode: "research_only", validation: "purged_walk_forward", trace_id: run.trace_id, recommendation: run.promotion_recommendation, forecasts: forecasts.length, validated: validated.length, stress: forecasts.map((forecast) => ({ symbol: forecast.symbol, horizons: forecast.horizons.map((horizon) => ({ days: horizon.horizonTradingDays, brier_skill: horizon.validation.brierSkill, ...horizon.validation.stress })) })), generated_at: new Date().toISOString() }, null, 2));
  })
  .catch((error) => { console.error(error); process.exitCode = 1; });
