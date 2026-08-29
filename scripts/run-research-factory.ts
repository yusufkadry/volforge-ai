import { runResearch } from "../lib/research";

runResearch()
  .then(({ run, forecasts }) => {
    const validated = forecasts.filter((forecast) => forecast.validation.mae < forecast.validation.baselineMae && forecast.validation.directionAccuracy >= 0.52);
    console.log(JSON.stringify({ mode: "research_only", trace_id: run.trace_id, recommendation: run.promotion_recommendation, forecasts: forecasts.length, validated: validated.length, stress: forecasts.map((forecast) => ({ symbol: forecast.symbol, ...forecast.validation.stress })), generated_at: new Date().toISOString() }, null, 2));
  })
  .catch((error) => { console.error(error); process.exitCode = 1; });
