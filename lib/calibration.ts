import { STRATEGY_VERSION } from "@/lib/constitution";
import { journal } from "@/lib/supabase";
import type { CalibrationSnapshot, ExecutionIntent } from "@/lib/types";

function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }

function outcome(intent: ExecutionIntent) {
  const entry = number(intent.entry_debit);
  const exit = number(intent.current_debit);
  const quantity = number(intent.quantity);
  const metadata = intent.metadata ?? {};
  return {
    predictedEv: number(metadata.expected_value) * quantity,
    predictedWin: number(metadata.payoff_probability),
    realizedPnl: (exit - entry) * 100 * quantity,
  };
}

export async function calibrate() {
  const intents = await journal.closedIntents();
  const outcomes = intents.map(outcome).filter((value) => Number.isFinite(value.realizedPnl));
  const sampleSize = outcomes.length;
  const predictedEv = outcomes.reduce((total, value) => total + value.predictedEv, 0);
  const realizedPnl = outcomes.reduce((total, value) => total + value.realizedPnl, 0);
  const predictedWinRate = sampleSize ? outcomes.reduce((total, value) => total + value.predictedWin, 0) / sampleSize : 0;
  const realizedWinRate = sampleSize ? outcomes.filter((value) => value.realizedPnl > 0).length / sampleSize : 0;
  const brierScore = sampleSize ? outcomes.reduce((total, value) => total + (value.predictedWin - (value.realizedPnl > 0 ? 1 : 0)) ** 2, 0) / sampleSize : 0;
  const meanAbsoluteError = sampleSize ? outcomes.reduce((total, value) => total + Math.abs(value.realizedPnl - value.predictedEv), 0) / sampleSize : 0;
  const divergence = predictedEv === 0 ? 0 : (realizedPnl - predictedEv) / Math.max(Math.abs(predictedEv), 1);
  const status: CalibrationSnapshot["status"] = sampleSize < 5 ? "warming" : (realizedPnl < 0 && divergence < -0.75) || brierScore > 0.35 ? "degraded" : "calibrated";
  const snapshot: CalibrationSnapshot = {
    strategy_version: STRATEGY_VERSION, sample_size: sampleSize, predicted_ev: predictedEv, realized_pnl: realizedPnl,
    predicted_win_rate: predictedWinRate, realized_win_rate: realizedWinRate, brier_score: brierScore, mean_absolute_error: meanAbsoluteError, status,
    report: { divergence, brier_score: brierScore, mean_absolute_error: meanAbsoluteError, closed_intents: intents.map((intent) => ({ id: intent.id, underlying: intent.underlying, entry_debit: intent.entry_debit, exit_debit: intent.current_debit, quantity: intent.quantity })) },
  };
  const latest = await journal.latestCalibration();
  if (latest && latest.sample_size === snapshot.sample_size && Date.now() - new Date(latest.created_at ?? 0).getTime() < 4 * 60 * 60_000) return latest;
  await journal.writeCalibration(snapshot);
  return snapshot;
}
