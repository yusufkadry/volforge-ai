import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { journal } from "../lib/supabase";

async function read(path: string) { return readFile(path, "utf8"); }

async function main() {
  const [versionText, clockText, accountText] = await Promise.all([
    read("evidence/alpaca-cli-version.txt"),
    read("evidence/alpaca-clock.json"),
    read("evidence/alpaca-account.json"),
  ]);
  const clock = JSON.parse(clockText) as Record<string, unknown>;
  const account = JSON.parse(accountText) as Record<string, unknown>;
  const accountId = String(account.id ?? account.account_number ?? "");
  const paper = process.env.ALPACA_LIVE_TRADE !== "true";
  const marketOpen = typeof clock.is_open === "boolean" ? clock.is_open : false;
  const cliVersion = versionText.trim().split("\n")[0] ?? "unknown";
  const evidenceHash = createHash("sha256").update(versionText).update(clockText).update(accountText).digest("hex");
  const healthy = Boolean(accountId && cliVersion && typeof clock.is_open === "boolean" && paper);
  const preflight = {
    account_id: accountId,
    paper,
    market_open: marketOpen,
    cli_version: cliVersion,
    evidence_hash: evidenceHash,
    healthy,
    payload: {
      source: "alpaca-cli",
      clock_timestamp: clock.timestamp ?? null,
      account_status: account.status ?? null,
      observed_at: new Date().toISOString(),
      workflow_run_id: process.env.GITHUB_RUN_ID ?? null,
    },
  };
  await journal.writeCliPreflight(preflight);
  console.log(JSON.stringify({ ...preflight, account_id: createHash("sha256").update(accountId).digest("hex").slice(0, 12) }, null, 2));
  if (!healthy) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
