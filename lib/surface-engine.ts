import { average, clamp, median, medianAbsoluteDeviation, weightedRidge } from "@/lib/math";

export type SurfacePoint = {
  strike: number;
  dte: number;
  impliedVolatility: number;
  bid: number;
  ask: number;
  openInterest?: number;
};

export type SurfaceFit = {
  fairIv: number;
  residualIv: number;
  relativeResidual: number;
  residualZScore: number;
  fitRmse: number;
  localScale: number;
  neighborCount: number;
  logMoneyness: number;
};

function features(point: SurfacePoint, spot: number) {
  const logMoneyness = Math.log(point.strike / spot);
  const tenor = Math.sqrt(Math.max(point.dte, 1) / 365) - 0.25;
  return [1, logMoneyness, logMoneyness * logMoneyness, tenor, logMoneyness * tenor];
}

function liquidityWeight(point: SurfacePoint) {
  const midpoint = (point.bid + point.ask) / 2;
  const quoteSpread = midpoint > 0 ? (point.ask - point.bid) / midpoint : 1;
  const depth = Math.log1p(Math.max(0, point.openInterest ?? 0));
  return clamp((1 + depth) / (1 + quoteSpread * 25), 0.1, 10);
}

export function fitVolatilitySurface(points: SurfacePoint[], spot: number): SurfaceFit[] {
  if (!Number.isFinite(spot) || spot <= 0) throw new Error("A positive underlying spot is required for surface fitting.");
  if (!points.length) return [];
  const usable = points.map((point, index) => ({ point, index })).filter(({ point }) => point.impliedVolatility > 0.01 && point.impliedVolatility < 5 && point.strike > 0);
  if (usable.length < 6) {
    const fallback = median(usable.map(({ point }) => point.impliedVolatility));
    const scale = Math.max(medianAbsoluteDeviation(usable.map(({ point }) => point.impliedVolatility)), 0.01);
    return points.map((point) => {
      const residual = point.impliedVolatility - fallback;
      return { fairIv: fallback, residualIv: residual, relativeResidual: residual / Math.max(fallback, 0.01), residualZScore: residual / scale, fitRmse: scale, localScale: scale, neighborCount: usable.length, logMoneyness: Math.log(point.strike / spot) };
    });
  }

  const matrix = usable.map(({ point }) => features(point, spot));
  const targets = usable.map(({ point }) => point.impliedVolatility);
  const baseWeights = usable.map(({ point }) => liquidityWeight(point));
  let weights = [...baseWeights];
  let coefficients = weightedRidge(matrix, targets, weights, 0.002);

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const residuals = matrix.map((row, index) => targets[index] - row.reduce((sum, value, column) => sum + value * coefficients[column], 0));
    const scale = Math.max(medianAbsoluteDeviation(residuals), 0.005);
    weights = baseWeights.map((weight, index) => {
      const standardized = Math.abs(residuals[index]) / scale;
      const huber = standardized <= 1.5 ? 1 : 1.5 / standardized;
      return weight * huber;
    });
    coefficients = weightedRidge(matrix, targets, weights, 0.002);
  }

  const fittedUsable = matrix.map((row) => clamp(row.reduce((sum, value, column) => sum + value * coefficients[column], 0), 0.01, 5));
  const residuals = targets.map((target, index) => target - fittedUsable[index]);
  const fitRmse = Math.sqrt(average(residuals.map((residual, index) => weights[index] * residual * residual)) / Math.max(average(weights), 0.0001));

  return points.map((point) => {
    const row = features(point, spot);
    const fairIv = clamp(row.reduce((sum, value, column) => sum + value * coefficients[column], 0), 0.01, 5);
    const residualIv = point.impliedVolatility - fairIv;
    const logMoneyness = Math.log(point.strike / spot);
    const neighbors = usable.filter(({ point: other }) => Math.abs(other.dte - point.dte) <= 7 && Math.abs(Math.log(other.strike / spot) - logMoneyness) <= 0.08);
    const localResiduals = neighbors.map(({ index }) => residuals[index]);
    const localScale = Math.max(medianAbsoluteDeviation(localResiduals), fitRmse, 0.005);
    return {
      fairIv,
      residualIv,
      relativeResidual: residualIv / Math.max(fairIv, 0.01),
      residualZScore: residualIv / localScale,
      fitRmse,
      localScale,
      neighborCount: neighbors.length,
      logMoneyness,
    };
  });
}
