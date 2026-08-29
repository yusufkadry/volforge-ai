import { alpaca } from "@/lib/alpaca";
import { constitutionHash, STRATEGY_VERSION, traceId } from "@/lib/constitution";
import { universe } from "@/lib/env";
import { journal } from "@/lib/supabase";
import type { ResearchRun } from "@/lib/types";

type Bar = { c: number; v: number; t: string };
type Sample = { x: number[]; y: number; direction: number };
type Regressor = { means: number[]; scales: number[]; weights: number[] };
type Classifier = Regressor;

function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function average(values: number[]) { return values.reduce((total, value) => total + value, 0) / Math.max(values.length, 1); }
function std(values: number[]) { const mean = average(values); return Math.sqrt(average(values.map((value) => (value - mean) ** 2))); }
function sigmoid(value: number) { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value)))); }
function percentile(values: number[], value: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * value)))] ?? 0;
}

function dailyReturns(bars: Bar[]) {
  return bars.slice(1).map((bar, index) => Math.log(bar.c / bars[index].c));
}

function realizedVol(returns: number[]) { return std(returns) * Math.sqrt(252); }

function featureSet(returns: number[], volumes: number[], index: number) {
  const rv5 = realizedVol(returns.slice(index - 5, index));
  const rv10 = realizedVol(returns.slice(index - 10, index));
  const rv20 = realizedVol(returns.slice(index - 20, index));
  const momentum5 = returns.slice(index - 5, index).reduce((sum, value) => sum + value, 0);
  const momentum20 = returns.slice(index - 20, index).reduce((sum, value) => sum + value, 0);
  const recentVolume = average(volumes.slice(index - 5, index));
  const volumeZ = (recentVolume - average(volumes.slice(index - 20, index))) / Math.max(std(volumes.slice(index - 20, index)), 1);
  return [rv5, rv10, rv20, momentum5, momentum20, volumeZ];
}

function samplesFromBars(bars: Bar[]): Sample[] {
  const returns = dailyReturns(bars);
  const volumes = bars.slice(1).map((bar) => bar.v);
  const samples: Sample[] = [];
  for (let index = 21; index < returns.length - 5; index += 1) {
    const targetReturns = returns.slice(index, index + 5);
    samples.push({ x: featureSet(returns, volumes, index), y: realizedVol(targetReturns), direction: targetReturns.reduce((sum, value) => sum + value, 0) > 0 ? 1 : 0 });
  }
  return samples;
}

function normalizer(samples: Sample[]) {
  const columns = samples[0]?.x.length ?? 0;
  const means = Array.from({ length: columns }, (_, index) => average(samples.map((sample) => sample.x[index])));
  const scales = Array.from({ length: columns }, (_, index) => Math.max(std(samples.map((sample) => sample.x[index])), 0.00001));
  return { means, scales };
}

function normalized(x: number[], model: Pick<Regressor, "means" | "scales">) { return x.map((value, index) => (value - model.means[index]) / model.scales[index]); }
function dot(weights: number[], values: number[]) { return weights.reduce((sum, weight, index) => sum + weight * values[index], 0); }

function fitRegression(samples: Sample[], epochs = 350): Regressor {
  const { means, scales } = normalizer(samples);
  const weights = Array(samples[0].x.length + 1).fill(0);
  const targetMean = average(samples.map((sample) => sample.y));
  const targetScale = Math.max(std(samples.map((sample) => sample.y)), 0.0001);
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradient = Array(weights.length).fill(0);
    for (const sample of samples) {
      const values = [1, ...normalized(sample.x, { means, scales })];
      const error = dot(weights, values) - ((sample.y - targetMean) / targetScale);
      values.forEach((value, index) => { gradient[index] += error * value; });
    }
    weights.forEach((_, index) => { weights[index] -= 0.035 * (gradient[index] / samples.length + (index ? 0.01 * weights[index] : 0)); });
  }
  return { means, scales, weights: [targetMean, targetScale, ...weights] };
}

function predictRegression(model: Regressor, x: number[]) {
  const [targetMean, targetScale, ...weights] = model.weights;
  return Math.max(0.01, targetMean + targetScale * dot(weights, [1, ...normalized(x, model)]));
}

function fitClassifier(samples: Sample[], epochs = 250): Classifier {
  const { means, scales } = normalizer(samples);
  const weights = Array(samples[0].x.length + 1).fill(0);
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradient = Array(weights.length).fill(0);
    for (const sample of samples) {
      const values = [1, ...normalized(sample.x, { means, scales })];
      const error = sigmoid(dot(weights, values)) - sample.direction;
      values.forEach((value, index) => { gradient[index] += error * value; });
    }
    weights.forEach((_, index) => { weights[index] -= 0.04 * (gradient[index] / samples.length + (index ? 0.01 * weights[index] : 0)); });
  }
  return { means, scales, weights };
}

function predictClassifier(model: Classifier, x: number[]) { return sigmoid(dot(model.weights, [1, ...normalized(x, model)])); }

function walkForward(samples: Sample[]) {
  const start = Math.max(70, Math.floor(samples.length * 0.55));
  const errors: number[] = [];
  const baselineErrors: number[] = [];
  const directions: boolean[] = [];
  const stressOutcomes: Array<{ actualVol: number; error: number; directionCorrect: boolean; direction: number }> = [];
  for (let point = start; point < samples.length; point += 5) {
    const training = samples.slice(0, point);
    const test = samples.slice(point, Math.min(point + 5, samples.length));
    const model = fitRegression(training, 180);
    const classifier = fitClassifier(training, 140);
    const baseline = average(training.slice(-20).map((sample) => sample.y));
    for (const sample of test) {
      const error = Math.abs(predictRegression(model, sample.x) - sample.y);
      errors.push(error);
      baselineErrors.push(Math.abs(baseline - sample.y));
      const directionCorrect = (predictClassifier(classifier, sample.x) >= 0.5) === Boolean(sample.direction);
      directions.push(directionCorrect);
      stressOutcomes.push({ actualVol: sample.y, error, directionCorrect, direction: sample.direction });
    }
  }
  const highVolThreshold = percentile(stressOutcomes.map((outcome) => outcome.actualVol), 0.8);
  const highVol = stressOutcomes.filter((outcome) => outcome.actualVol >= highVolThreshold);
  const downside = stressOutcomes.filter((outcome) => outcome.direction === 0);
  return {
    mae: average(errors), baselineMae: average(baselineErrors), directionAccuracy: average(directions.map((value) => value ? 1 : 0)), observations: samples.length,
    stress: {
      highVolatilityMae: average(highVol.map((outcome) => outcome.error)),
      highVolatilitySamples: highVol.length,
      downsideDirectionAccuracy: average(downside.map((outcome) => outcome.directionCorrect ? 1 : 0)),
      downsideSamples: downside.length,
    },
  };
}

export type ResearchForecast = { symbol: string; forecastRv: number; probabilityUp: number; validation: ReturnType<typeof walkForward>; featureValues: number[] };

export async function runResearch(): Promise<{ run: ResearchRun; forecasts: ResearchForecast[] }> {
  const end = new Date();
  const start = new Date(end); start.setUTCFullYear(start.getUTCFullYear() - 2);
  const symbols = universe();
  const response = await alpaca.stockBars(symbols, start.toISOString(), end.toISOString());
  const forecasts = symbols.flatMap((symbol) => {
    const bars = (response.bars?.[symbol] ?? []).map((bar) => ({ c: number(bar.c), v: number(bar.v), t: String(bar.t ?? "") })).filter((bar) => bar.c > 0);
    const samples = samplesFromBars(bars);
    if (samples.length < 90) return [];
    const forecastModel = fitRegression(samples);
    const directionModel = fitClassifier(samples);
    const returns = dailyReturns(bars);
    const volumes = bars.slice(1).map((bar) => bar.v);
    const features = featureSet(returns, volumes, returns.length);
    return [{ symbol, forecastRv: predictRegression(forecastModel, features), probabilityUp: predictClassifier(directionModel, features), validation: walkForward(samples), featureValues: features }];
  });
  const strongest = forecasts.map((forecast) => forecast.validation.mae < forecast.validation.baselineMae && forecast.validation.directionAccuracy >= 0.52).filter(Boolean).length;
  const recommendation: ResearchRun["promotion_recommendation"] = strongest >= 3 ? "shadow" : "reject";
  const trace_id = traceId();
  const run: ResearchRun = {
    strategy_version: STRATEGY_VERSION,
    universe: symbols,
    trace_id,
    promotion_recommendation: recommendation,
    report: { generated_at: new Date().toISOString(), constitution_hash: constitutionHash(), strongest_models: strongest, forecasts },
  };
  await journal.writeStrategy({ version: STRATEGY_VERSION, status: recommendation === "shadow" ? "shadow" : "research", hypothesis: "Forecast next-five-day realized volatility and direction, then compare forecast volatility with live implied volatility after friction.", parameters: { horizon_days: 5, features: ["rv5", "rv10", "rv20", "momentum5", "momentum20", "volume_z"] }, validation: run.report, constitution_hash: constitutionHash() });
  await journal.writeResearch(run);
  return { run, forecasts };
}
