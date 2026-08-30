import assert from "node:assert/strict";
import test from "node:test";
import { blackScholesPrice, inverseNormal, normalCdf } from "../lib/math";
import { evaluateVerticalSpread, verticalExpirationPayoff } from "../lib/options-model";
import { fitVolatilitySurface } from "../lib/surface-engine";
import { riskGates } from "../lib/strategy";
import { candidate, horizon } from "./fixtures";

test("normal CDF and inverse remain numerically consistent", () => {
  for (const probability of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) assert.ok(Math.abs(normalCdf(inverseNormal(probability)) - probability) < 0.0002);
});

test("Black-Scholes prices satisfy basic bounds", () => {
  const call = blackScholesPrice({ spot: 100, strike: 100, years: 30 / 365, volatility: 0.2, rate: 0.04, type: "call" });
  const put = blackScholesPrice({ spot: 100, strike: 100, years: 30 / 365, volatility: 0.2, rate: 0.04, type: "put" });
  assert.ok(call > 0 && call < 100);
  assert.ok(put > 0 && put < 100);
  assert.ok(Math.abs((call - put) - (100 - 100 * Math.exp(-0.04 * 30 / 365))) < 0.01);
});

test("vertical payoff is bounded and symmetric for calls and puts", () => {
  for (const spot of [50, 95, 100, 102, 105, 110, 150]) {
    const call = verticalExpirationPayoff("call", 100, 105, spot);
    const mirroredPut = verticalExpirationPayoff("put", 100, 95, 200 - spot);
    assert.ok(call >= 0 && call <= 5);
    assert.ok(mirroredPut >= 0 && mirroredPut <= 5);
  }
  assert.equal(verticalExpirationPayoff("call", 100, 105, 103), 3);
  assert.equal(verticalExpirationPayoff("put", 100, 95, 97), 3);
});

test("robust surface fit removes normal skew and isolates a local cheap contract", () => {
  const spot = 100;
  const points = Array.from({ length: 25 }, (_, index) => {
    const strike = 76 + index * 2;
    const x = Math.log(strike / spot);
    const fair = 0.24 - 0.18 * x + 0.7 * x * x;
    return { strike, dte: 28, impliedVolatility: fair - (strike === 100 ? 0.035 : 0), bid: 1.9, ask: 2, openInterest: 1500 };
  });
  const fits = fitVolatilitySurface(points, spot);
  const cheap = fits[points.findIndex((point) => point.strike === 100)];
  const ordinary = fits[points.findIndex((point) => point.strike === 80)];
  assert.ok(cheap.relativeResidual < -0.08);
  assert.ok(cheap.residualZScore < -1);
  assert.ok(Math.abs(ordinary.relativeResidual) < 0.04);
});

test("negative put delta passes the absolute directional gate", () => {
  const put = candidate({ optionSymbol: "TEST261218P00100000", contractType: "put", delta: -0.45 });
  const gate = riskGates(put, true).find((value) => value.name === "Absolute delta target");
  assert.equal(gate?.passed, true);
});

test("distributional valuation has no artificial 25 percent probability floor", () => {
  const longLeg = candidate({ strike: 120, optionSymbol: "TEST261218C00120000", bid: 0.4, ask: 0.5, midpoint: 0.45, delta: 0.1 });
  const shortLeg = candidate({ strike: 125, optionSymbol: "TEST261218C00125000", bid: 0.1, ask: 0.2, midpoint: 0.15, delta: 0.05 });
  const valuation = evaluateVerticalSpread({ longLeg, shortLeg, entryDebit: 4.5, valuationForecast: horizon(20, { forecastRv: 0.15, sigmaLogReturn: 0.042 }), holdingForecast: horizon(3, { forecastRv: 0.15, sigmaLogReturn: 0.016 }) });
  assert.ok(valuation.probabilityProfit < 0.25);
  assert.ok(valuation.conservativeExpectedValue < 0);
  assert.ok(valuation.fractionalKelly <= 0.25);
  assert.ok(valuation.scenarioCount >= 300);
});

test("mark-forward valuation is anchored to observed spread prices", () => {
  const shortLeg = candidate({ strike: 105, optionSymbol: "TEST261218C00105000", bid: 0.5, ask: 0.6, midpoint: 0.55 });
  const originalLong = candidate({ bid: 2, ask: 2.1, midpoint: 2.05 });
  const repricedLong = candidate({ bid: 3, ask: 3.1, midpoint: 3.05 });
  const forecast = horizon(3, { expectedLogReturn: 0, sigmaLogReturn: 0.001 });
  const original = evaluateVerticalSpread({ longLeg: originalLong, shortLeg, entryDebit: 1.6, valuationForecast: forecast, holdingForecast: forecast });
  const repriced = evaluateVerticalSpread({ longLeg: repricedLong, shortLeg, entryDebit: 1.6, valuationForecast: forecast, holdingForecast: forecast });
  const observedShift = repriced.expectedExitValue - original.expectedExitValue;
  assert.ok(observedShift > 0.95 && observedShift < 1.05);
  assert.equal(repriced.assumptions.pricing_anchor, "Observed spread midpoint plus modeled change in theoretical value");
});
