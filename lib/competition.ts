import { numberEnv } from "@/lib/env";

export function competitionExitAt() {
  const raw = process.env.COMPETITION_EXIT_AT?.trim() || "2026-09-03T19:30:00Z";
  const value = new Date(raw);
  return Number.isFinite(value.getTime()) ? value : null;
}

export function competitionExitRequired(now = new Date()) {
  const cutoff = competitionExitAt();
  return Boolean(cutoff && now.getTime() >= cutoff.getTime());
}

export function competitionEntryAllowed(now = new Date()) {
  const cutoff = competitionExitAt();
  if (!cutoff) return true;
  return now.getTime() < cutoff.getTime() - numberEnv("COMPETITION_ENTRY_BUFFER_MINUTES", 90) * 60_000;
}
