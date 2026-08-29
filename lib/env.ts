export function env(name: string, fallback?: string) {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function numberEnv(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value)) throw new Error(`Invalid number in ${name}`);
  return value;
}

export function universe() {
  return (process.env.VOLFORGE_UNIVERSE ?? "SPY,QQQ,AAPL,MSFT,NVDA,TSLA")
    .split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
}
