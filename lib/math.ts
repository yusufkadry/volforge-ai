export function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function average(values: number[]) {
  return values.reduce((total, value) => total + value, 0) / Math.max(values.length, 1);
}

export function standardDeviation(values: number[]) {
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

export function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function medianAbsoluteDeviation(values: number[]) {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center))) * 1.4826;
}

export function percentile(values: number[], probability: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = clamp(probability, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function sigmoid(value: number) {
  return 1 / (1 + Math.exp(-clamp(value, -30, 30)));
}

export function dot(left: number[], right: number[]) {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

/** Gaussian elimination with partial pivoting for the small dense systems used here. */
export function solveLinearSystem(matrix: number[][], vector: number[]) {
  const n = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    if (Math.abs(divisor) < 1e-12) continue;
    for (let value = column; value <= n; value += 1) augmented[column][value] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let value = column; value <= n; value += 1) augmented[row][value] -= factor * augmented[column][value];
    }
  }
  return augmented.map((row, index) => Number.isFinite(row[n]) ? row[n] : (index === 0 ? average(vector) : 0));
}

export function weightedRidge(features: number[][], targets: number[], weights: number[], ridge = 1e-4) {
  const dimensions = features[0]?.length ?? 0;
  const gram = Array.from({ length: dimensions }, () => Array(dimensions).fill(0));
  const rhs = Array(dimensions).fill(0);
  features.forEach((row, sample) => {
    const weight = Math.max(0, weights[sample] ?? 1);
    row.forEach((left, i) => {
      rhs[i] += weight * left * targets[sample];
      row.forEach((right, j) => { gram[i][j] += weight * left * right; });
    });
  });
  for (let index = 1; index < dimensions; index += 1) gram[index][index] += ridge;
  return solveLinearSystem(gram, rhs);
}

export function normalCdf(value: number) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const coefficients = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const erf = 1 - (((((coefficients[4] * t + coefficients[3]) * t + coefficients[2]) * t + coefficients[1]) * t + coefficients[0]) * t) * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

/** Peter Acklam's rational approximation. */
export function inverseNormal(probability: number) {
  const p = clamp(probability, 1e-9, 1 - 1e-9);
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function blackScholesPrice(input: { spot: number; strike: number; years: number; volatility: number; rate: number; type: "call" | "put" }) {
  const { spot, strike, type } = input;
  const years = Math.max(input.years, 1 / 3650);
  const volatility = Math.max(input.volatility, 0.0001);
  const denominator = volatility * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (input.rate + volatility * volatility / 2) * years) / denominator;
  const d2 = d1 - denominator;
  if (type === "call") return Math.max(0, spot * normalCdf(d1) - strike * Math.exp(-input.rate * years) * normalCdf(d2));
  return Math.max(0, strike * Math.exp(-input.rate * years) * normalCdf(-d2) - spot * normalCdf(-d1));
}
