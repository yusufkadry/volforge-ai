import { createHash } from "crypto";
import { alpaca } from "@/lib/alpaca";
import { constitutionHash, STRATEGY_VERSION, traceId } from "@/lib/constitution";
import { numberEnv, universe } from "@/lib/env";
import { average, clamp, dot, inverseNormal, percentile, sigmoid, standardDeviation, weightedRidge } from "@/lib/math";
import { journal } from "@/lib/supabase";
import type { HorizonForecast, HorizonValidation, ModelManifest, ResearchForecast, ResearchRun, ValidationBin } from "@/lib/types";

export type Bar = { o: number; h: number; l: number; c: number; v: number; t: string };
export type Sample = { x: number[]; yVol: number; direction: number; cumulativeReturn: number; asOfIndex: number; labelEndIndex: number };
type Regressor = { means: number[]; scales: number[]; weights: number[]; targetMean: number; targetScale: number };
type Classifier = { means: number[]; scales: number[]; weights: number[] };
type OosOutcome = { actualVol: number; predictedVol: number; baselineVol: number; probability: number; baselineProbability: number; direction: number };

export const FEATURE_NAMES = ["rv5", "rv10", "rv20", "rv60", "downside20", "momentum5", "momentum20", "momentum60", "range20", "volume_z", "drawdown20"];
export const MODEL_VERSION = "purged-horizon-ensemble-v3";

function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function dailyReturns(bars: Bar[]) { return bars.slice(1).map((bar, index) => Math.log(bar.c / bars[index].c)); }
function realizedVol(returns: number[]) { return Math.sqrt(average(returns.map((value) => value * value))) * Math.sqrt(252); }
function sum(values: number[]) { return values.reduce((total, value) => total + value, 0); }

function featureSet(bars: Bar[], returns: number[], volumes: number[], index: number) {
  const rv5 = realizedVol(returns.slice(index - 5, index));
  const rv10 = realizedVol(returns.slice(index - 10, index));
  const rv20 = realizedVol(returns.slice(index - 20, index));
  const rv60 = realizedVol(returns.slice(index - 60, index));
  const downside = returns.slice(index - 20, index).filter((value) => value < 0);
  const downside20 = downside.length ? realizedVol(downside) : 0;
  const momentum5 = sum(returns.slice(index - 5, index));
  const momentum20 = sum(returns.slice(index - 20, index));
  const momentum60 = sum(returns.slice(index - 60, index));
  const range20 = average(bars.slice(Math.max(0, index - 19), index + 1).map((bar) => bar.c > 0 ? (bar.h - bar.l) / bar.c : 0));
  const recentVolume = average(volumes.slice(index - 5, index));
  const volumeWindow = volumes.slice(index - 20, index);
  const volumeZ = (recentVolume - average(volumeWindow)) / Math.max(standardDeviation(volumeWindow), 1);
  const closes = bars.slice(Math.max(0, index - 19), index + 1).map((bar) => bar.c);
  const drawdown20 = closes.length ? closes[closes.length - 1] / Math.max(...closes) - 1 : 0;
  return [rv5, rv10, rv20, rv60, downside20, momentum5, momentum20, momentum60, range20, volumeZ, drawdown20];
}

export function samplesFromBars(bars: Bar[], horizonTradingDays: number): Sample[] {
  const returns = dailyReturns(bars);
  const volumes = bars.slice(1).map((bar) => bar.v);
  const samples: Sample[] = [];
  for (let index = 60; index < returns.length - horizonTradingDays; index += 1) {
    const targetReturns = returns.slice(index, index + horizonTradingDays);
    const cumulativeReturn = sum(targetReturns);
    samples.push({
      x: featureSet(bars, returns, volumes, index),
      yVol: realizedVol(targetReturns),
      direction: cumulativeReturn > 0 ? 1 : 0,
      cumulativeReturn,
      asOfIndex: index,
      labelEndIndex: index + horizonTradingDays - 1,
    });
  }
  return samples;
}

function normalizer(samples: Sample[]) {
  const columns = samples[0]?.x.length ?? 0;
  const means = Array.from({ length: columns }, (_, index) => average(samples.map((sample) => sample.x[index])));
  const scales = Array.from({ length: columns }, (_, index) => Math.max(standardDeviation(samples.map((sample) => sample.x[index])), 0.00001));
  return { means, scales };
}

function normalized(x: number[], model: Pick<Regressor, "means" | "scales">) {
  return x.map((value, index) => (value - model.means[index]) / model.scales[index]);
}

function fitRegression(samples: Sample[]): Regressor {
  const { means, scales } = normalizer(samples);
  const targetMean = average(samples.map((sample) => sample.yVol));
  const targetScale = Math.max(standardDeviation(samples.map((sample) => sample.yVol)), 0.0001);
  const features = samples.map((sample) => [1, ...normalized(sample.x, { means, scales })]);
  const targets = samples.map((sample) => (sample.yVol - targetMean) / targetScale);
  const weights = weightedRidge(features, targets, Array(samples.length).fill(1), 0.08);
  return { means, scales, weights, targetMean, targetScale };
}

function predictRegression(model: Regressor, x: number[]) {
  return clamp(model.targetMean + model.targetScale * dot(model.weights, [1, ...normalized(x, model)]), 0.01, 3);
}

function fitClassifier(samples: Sample[], epochs = 90): Classifier {
  const { means, scales } = normalizer(samples);
  const weights = Array((samples[0]?.x.length ?? 0) + 1).fill(0);
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradient = Array(weights.length).fill(0);
    for (const sample of samples) {
      const values = [1, ...normalized(sample.x, { means, scales })];
      const error = sigmoid(dot(weights, values)) - sample.direction;
      values.forEach((value, index) => { gradient[index] += error * value; });
    }
    weights.forEach((_, index) => { weights[index] -= 0.035 * (gradient[index] / samples.length + (index ? 0.04 * weights[index] : 0)); });
  }
  return { means, scales, weights };
}

function predictClassifier(model: Classifier, x: number[]) {
  return sigmoid(dot(model.weights, [1, ...normalized(x, model)]));
}

function calibrationBins(outcomes: OosOutcome[]): ValidationBin[] {
  return Array.from({ length: 5 }, (_, index) => {
    const lower = index / 5;
    const upper = (index + 1) / 5;
    const bin = outcomes.filter((outcome) => outcome.probability >= lower && (index === 4 ? outcome.probability <= upper : outcome.probability < upper));
    return { lower, upper, predictions: bin.length, meanPrediction: average(bin.map((outcome) => outcome.probability)), observedFrequency: average(bin.map((outcome) => outcome.direction)) };
  });
}

export function walkForward(samples: Sample[], horizonTradingDays: number): HorizonValidation {
  const start = Math.max(100, Math.floor(samples.length * 0.55));
  const stride = Math.max(horizonTradingDays, Math.ceil(Math.max(samples.length - start, 1) / 12));
  const embargoDays = Math.max(2, Math.ceil(horizonTradingDays * 0.1));
  const outcomes: OosOutcome[] = [];
  let purgedSamples = 0;
  let folds = 0;

  for (let point = start; point < samples.length; point += stride) {
    const test = samples[point];
    const eligible = samples.slice(0, point).filter((sample) => sample.labelEndIndex < test.asOfIndex - embargoDays);
    purgedSamples += point - eligible.length;
    const training = eligible.slice(-378);
    if (training.length < 80) continue;
    const regression = fitRegression(training);
    const classifier = fitClassifier(training, 55);
    const recent = training.slice(-Math.min(40, training.length));
    outcomes.push({
      actualVol: test.yVol,
      predictedVol: predictRegression(regression, test.x),
      baselineVol: average(recent.map((sample) => sample.yVol)),
      probability: predictClassifier(classifier, test.x),
      baselineProbability: average(recent.map((sample) => sample.direction)),
      direction: test.direction,
    });
    folds += 1;
  }

  const errors = outcomes.map((outcome) => Math.abs(outcome.predictedVol - outcome.actualVol));
  const baselineErrors = outcomes.map((outcome) => Math.abs(outcome.baselineVol - outcome.actualVol));
  const brier = average(outcomes.map((outcome) => (outcome.probability - outcome.direction) ** 2));
  const baselineBrier = average(outcomes.map((outcome) => (outcome.baselineProbability - outcome.direction) ** 2));
  const highVolThreshold = percentile(outcomes.map((outcome) => outcome.actualVol), 0.8);
  const highVol = outcomes.filter((outcome) => outcome.actualVol >= highVolThreshold);
  const downside = outcomes.filter((outcome) => outcome.direction === 0);
  return {
    mae: average(errors),
    baselineMae: average(baselineErrors),
    brier,
    baselineBrier,
    brierSkill: baselineBrier > 0 ? 1 - brier / baselineBrier : 0,
    directionAccuracy: average(outcomes.map((outcome) => (outcome.probability >= 0.5) === Boolean(outcome.direction) ? 1 : 0)),
    observations: samples.length,
    oosObservations: outcomes.length,
    purgedSamples,
    embargoDays,
    folds,
    calibration: calibrationBins(outcomes),
    stress: {
      highVolatilityMae: average(highVol.map((outcome) => Math.abs(outcome.predictedVol - outcome.actualVol))),
      highVolatilitySamples: highVol.length,
      downsideDirectionAccuracy: average(downside.map((outcome) => outcome.probability < 0.5 ? 1 : 0)),
      downsideSamples: downside.length,
    },
  };
}

export function validationPassed(validation: HorizonValidation) {
  return validation.oosObservations >= numberEnv("MIN_OOS_FOLDS", 8)
    && validation.mae < validation.baselineMae
    && validation.brier < validation.baselineBrier
    && validation.brierSkill > 0
    && validation.directionAccuracy >= numberEnv("MIN_DIRECTION_ACCURACY", 0.48);
}

function datasetHash(bars: Bar[], horizon: number) {
  return createHash("sha256").update(JSON.stringify({ horizon, bars: bars.map((bar) => [bar.t, bar.o, bar.h, bar.l, bar.c, bar.v]) })).digest("hex");
}

function horizonForecast(bars: Bar[], horizonTradingDays: number): HorizonForecast | null {
  const samples = samplesFromBars(bars, horizonTradingDays);
  if (samples.length < 100) return null;
  const validation = walkForward(samples, horizonTradingDays);
  const regression = fitRegression(samples);
  const classifier = fitClassifier(samples);
  const returns = dailyReturns(bars);
  const volumes = bars.slice(1).map((bar) => bar.v);
  const features = featureSet(bars, returns, volumes, returns.length);
  const forecastRv = predictRegression(regression, features);
  const rawProbabilityUp = predictClassifier(classifier, features);
  const probabilityShrinkage = clamp(Math.max(0, validation.brierSkill) * 3, 0, 1);
  const probabilityUp = clamp(0.5 + (rawProbabilityUp - 0.5) * probabilityShrinkage, 0.05, 0.95);
  const sigmaLogReturn = forecastRv * Math.sqrt(horizonTradingDays / 252);
  const expectedLogReturn = clamp(inverseNormal(probabilityUp) * sigmaLogReturn, -sigmaLogReturn, sigmaLogReturn);
  const digest = datasetHash(bars, horizonTradingDays);
  const manifestBase: Omit<ModelManifest, "manifestHash"> = {
    modelVersion: MODEL_VERSION,
    featureNames: FEATURE_NAMES,
    horizonTradingDays,
    dataStart: bars[0]?.t ?? "",
    dataEnd: bars[bars.length - 1]?.t ?? "",
    trainingSamples: samples.length,
    regression,
    classifier: { ...classifier, probabilityShrinkage },
    datasetHash: digest,
  };
  const manifest: ModelManifest = { ...manifestBase, manifestHash: createHash("sha256").update(JSON.stringify(manifestBase)).digest("hex") };
  return { horizonTradingDays, forecastRv, rawProbabilityUp, probabilityUp, expectedLogReturn, sigmaLogReturn, validation, featureValues: features, manifest };
}

function configuredHorizons() {
  return [...new Set((process.env.RESEARCH_HORIZONS ?? "3,5,10,15,20,25").split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0 && value <= 60))].sort((left, right) => left - right);
}

export function forecastForTradingDays(forecast: ResearchForecast, horizonTradingDays: number) {
  return [...forecast.horizons].sort((left, right) => Math.abs(left.horizonTradingDays - horizonTradingDays) - Math.abs(right.horizonTradingDays - horizonTradingDays))[0];
}

export function forecastForDte(forecast: ResearchForecast, calendarDte: number) {
  return forecastForTradingDays(forecast, Math.max(1, Math.round(calendarDte * 252 / 365)));
}

export function researchForecastPassed(forecast: ResearchForecast) {
  const optionHorizon = forecastForTradingDays(forecast, 20);
  const holdingHorizon = forecastForTradingDays(forecast, numberEnv("EXPECTED_HOLDING_DAYS", 3));
  return Boolean(optionHorizon && holdingHorizon && validationPassed(optionHorizon.validation) && validationPassed(holdingHorizon.validation));
}

export function forecastsFromRun(run: ResearchRun | null | undefined): ResearchForecast[] {
  if (!run || !run.report || !Array.isArray(run.report.forecasts)) return [];
  return run.report.forecasts as ResearchForecast[];
}

export async function runResearch(): Promise<{ run: ResearchRun; forecasts: ResearchForecast[] }> {
  const end = new Date();
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - numberEnv("RESEARCH_LOOKBACK_YEARS", 3));
  const symbols = universe();
  const response = await alpaca.stockBars(symbols, start.toISOString(), end.toISOString());
  if (response.meta.truncated) throw new Error(`Alpaca stock-bar history exceeded ALPACA_MAX_DATA_PAGES after ${response.meta.pages} pages; research refused as incomplete.`);
  const generatedAt = new Date().toISOString();
  const horizons = configuredHorizons();
  const forecasts = symbols.flatMap((symbol) => {
    const bars = (response.bars?.[symbol] ?? []).map((bar) => ({
      o: number(bar.o), h: number(bar.h), l: number(bar.l), c: number(bar.c), v: number(bar.v), t: String(bar.t ?? ""),
    })).filter((bar) => bar.c > 0 && bar.h >= bar.l).sort((left, right) => left.t.localeCompare(right.t));
    const horizonForecasts = horizons.flatMap((horizon) => {
      const result = horizonForecast(bars, horizon);
      return result ? [result] : [];
    });
    const representative = [...horizonForecasts].sort((left, right) => Math.abs(left.horizonTradingDays - 20) - Math.abs(right.horizonTradingDays - 20))[0];
    if (!representative) return [];
    return [{ symbol, generatedAt, horizons: horizonForecasts, forecastRv: representative.forecastRv, probabilityUp: representative.probabilityUp, validation: representative.validation, featureValues: representative.featureValues } satisfies ResearchForecast];
  });
  const validated = forecasts.filter(researchForecastPassed);
  const minimumValidated = Math.min(symbols.length, numberEnv("MIN_VALIDATED_SYMBOLS", 2));
  const recommendation: ResearchRun["promotion_recommendation"] = validated.length >= minimumValidated ? "shadow" : "reject";
  const trace_id = traceId();
  const report = {
    generated_at: generatedAt,
    constitution_hash: constitutionHash(),
    model_version: MODEL_VERSION,
    data_source: { provider: "Alpaca", stock_feed: process.env.ALPACA_STOCK_FEED ?? "iex", start: start.toISOString(), end: end.toISOString() },
    validation_protocol: { type: "purged_walk_forward", horizons, minimum_oos_folds: numberEnv("MIN_OOS_FOLDS", 8), label_overlap_removed: true, embargo: "max(2, 10% of horizon)", baselines: ["recent realized-volatility mean", "recent directional base rate"] },
    strongest_models: validated.length,
    required_models: minimumValidated,
    validated_symbols: validated.map((forecast) => forecast.symbol),
    forecasts,
  };
  const run: ResearchRun = { strategy_version: STRATEGY_VERSION, universe: symbols, trace_id, promotion_recommendation: recommendation, report };
  await journal.writeModelManifests(forecasts.flatMap((forecast) => forecast.horizons.map((horizon) => ({
    manifest_hash: horizon.manifest.manifestHash,
    strategy_version: STRATEGY_VERSION,
    symbol: forecast.symbol,
    horizon_trading_days: horizon.horizonTradingDays,
    dataset_hash: horizon.manifest.datasetHash,
    manifest: horizon.manifest,
    validation: horizon.validation,
  }))));
  await journal.writeStrategy({
    version: STRATEGY_VERSION,
    status: recommendation === "shadow" ? "shadow" : "research",
    hypothesis: "Horizon-matched realized variance and calibrated directional distributions can identify liquid vertical spreads whose mark-forward payoff remains positive after conservative execution costs.",
    parameters: { horizons_trading_days: horizons, features: FEATURE_NAMES, validation: "purged walk-forward with embargo", model_version: MODEL_VERSION },
    validation: report,
    constitution_hash: constitutionHash(),
  });
  await journal.writeResearch(run);
  return { run, forecasts };
}
