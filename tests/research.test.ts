import assert from "node:assert/strict";
import test from "node:test";
import { forecastForTradingDays, forecastsFromRun, samplesFromBars, walkForward, type Bar } from "../lib/research";
import type { ResearchForecast, ResearchRun } from "../lib/types";

function syntheticBars(length = 760): Bar[] {
  let close = 100;
  return Array.from({ length }, (_, index) => {
    const dailyReturn = 0.0003 + Math.sin(index / 17) * 0.008 + Math.cos(index / 41) * 0.004;
    const open = close;
    close *= Math.exp(dailyReturn);
    return { o: open, h: Math.max(open, close) * 1.006, l: Math.min(open, close) * 0.994, c: close, v: 1_000_000 + Math.sin(index / 9) * 100_000, t: new Date(Date.UTC(2023, 0, 1 + index)).toISOString() };
  });
}

test("purged walk-forward excludes every overlapping label", () => {
  const horizon = 20;
  const samples = samplesFromBars(syntheticBars(), horizon);
  const result = walkForward(samples, horizon);
  assert.ok(result.oosObservations >= 8);
  assert.ok(result.purgedSamples > 0);
  assert.ok(result.embargoDays >= 2);
  assert.equal(result.folds, result.oosObservations);
  assert.ok(Number.isFinite(result.brier));
  assert.ok(Number.isFinite(result.baselineBrier));
});

test("forward labels carry explicit end indices for leakage audits", () => {
  const horizon = 15;
  const samples = samplesFromBars(syntheticBars(300), horizon);
  assert.ok(samples.length > 100);
  for (const sample of samples.slice(0, 30)) assert.equal(sample.labelEndIndex - sample.asOfIndex + 1, horizon);
});

test("legacy research rows without horizon manifests fail closed", () => {
  const legacyForecast = { symbol: "NVDA", forecastRv: 0.38, probabilityUp: 0.59, validation: { directionAccuracy: 0.55 } };
  const run = { report: { forecasts: [legacyForecast] } } as unknown as ResearchRun;
  assert.deepEqual(forecastsFromRun(run), []);
  assert.equal(forecastForTradingDays(legacyForecast as unknown as ResearchForecast, 20), undefined);
});
