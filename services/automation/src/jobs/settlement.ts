// Settlement nudger (~4:05 PM ET): for each open StrikeMarket account that
// has reached its expiry, call `settle_market`. Permissionless (DR-002) —
// any signer can crank settlement; we sign with the platform-admin keypair
// only because we already have it loaded for the morning job.
//
// Retry policy (per PRD "Settlement" section):
//   - 30s between attempts, total 15min deadline per market.
//   - Retry on PythConfidenceTooWide (transient — confidence narrows as more
//     publishers report) and PythStale (transient — fresh price will land).
//   - Non-retriable: AlreadySettled (success state — someone else cranked
//     it), NotExpired (premature), PhoenixBadMagic / config errors, etc.
//   - After 15min exhaustion, the market stays Unsettled; admin can call
//     `admin_settle` after the on-chain ≥1hr override window opens.
//
// Cron: NO LONGER A STANDALONE CRON.  DR-006 wraps settlement into Phase 1
// (4:05 PM ET full days) + Phase 1b (1:05 PM ET half-days) — see
// jobs/grid-evolution.ts.  This module retains `runSettlementNudger` as the
// pure orchestration function those wrappers call, plus the operator script
// `scripts/run-settle-once.ts`.

import { loadConfig, type AutomationConfig } from "../config.js";
import { BellMarketsAnchorClient } from "../clients/anchor.js";
import { retryUntilDeadline } from "../lib/retry.js";

/** 30 seconds — PRD-mandated retry cadence. */
export const SETTLE_RETRY_INTERVAL_MS = 30_000;
/** 15 minutes — PRD-mandated retry-deadline window. */
export const SETTLE_RETRY_DEADLINE_MS = 15 * 60 * 1000;

export type OpenMarketRef = {
  pubkey: string;
  ticker?: string;
  expiryUnix: number;
  underlyingPythFeed: string;
};

export type SettleMarketTxFn = (
  client: BellMarketsAnchorClient,
  market: OpenMarketRef,
) => Promise<string>;

export type SettlementJobDeps = {
  runAt: Date;
  ctxRunId?: string;
  config?: AutomationConfig;
  anchorClientFactory?: (cfg: AutomationConfig) => BellMarketsAnchorClient;
  /** Enumerate open markets that need settling. Default scans on-chain via Anchor. */
  listOpenMarkets?: (client: BellMarketsAnchorClient, now: Date) => Promise<OpenMarketRef[]>;
  /** Send a single settle_market tx. Default uses Anchor `.methods.settleMarket(...).rpc()`. */
  settleMarketTx?: SettleMarketTxFn;
  /** Decide if a settle error is retriable. Default checks for Pyth-transient + RPC blips. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Override retry timing (used by tests). */
  retryIntervalMs?: number;
  retryDeadlineMs?: number;
  /** Inject clock + sleep so tests don't actually wait. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (entry: Record<string, unknown>) => void;
};

export type SettlementOutcome = {
  marketPubkey: string;
  ticker?: string;
  status: "settled" | "exhausted" | "non-retriable-error";
  txSig?: string;
  attempts: number;
  elapsedMs: number;
  lastError?: string;
};

export type SettlementJobOutcome = {
  ok: true;
  runAt: string;
  perMarket: SettlementOutcome[];
  stub?: boolean;
};

export async function runSettlementNudger(deps: SettlementJobDeps): Promise<SettlementJobOutcome> {
  const config = deps.config ?? loadConfig();
  const log = deps.log ?? ((e: Record<string, unknown>) => console.info(JSON.stringify(e)));
  const runAtIso = deps.runAt.toISOString();
  const logBase = { jobId: "settlement-nudger", runAt: runAtIso, ctxRunId: deps.ctxRunId };

  if (!config.bellMarketsProgramId) {
    log({ ...logBase, stub: true, reason: "BELL_MARKETS_PROGRAM_ID unset — log-only stub" });
    return { ok: true, runAt: runAtIso, perMarket: [], stub: true };
  }

  let anchorClient: BellMarketsAnchorClient;
  try {
    anchorClient = deps.anchorClientFactory?.(config) ?? defaultAnchorClientFactory(config);
    await anchorClient.getProgram();
  } catch (err) {
    log({ ...logBase, level: "error", stage: "anchor-program-init", error: serializeError(err) });
    throw err;
  }

  const listOpen = deps.listOpenMarkets ?? defaultListOpenMarkets;
  const settleTx = deps.settleMarketTx ?? defaultSettleMarketTx;
  const shouldRetry = deps.shouldRetry ?? defaultShouldRetry;
  const retryIntervalMs = deps.retryIntervalMs ?? SETTLE_RETRY_INTERVAL_MS;
  const retryDeadlineMs = deps.retryDeadlineMs ?? SETTLE_RETRY_DEADLINE_MS;

  const open = await listOpen(anchorClient, deps.runAt);
  log({ ...logBase, openMarketCount: open.length });

  const perMarket: SettlementOutcome[] = [];
  for (const market of open) {
    const result = await retryUntilDeadline(() => settleTx(anchorClient, market), {
      intervalMs: retryIntervalMs,
      deadlineMs: retryDeadlineMs,
      shouldRetry,
      now: deps.now,
      sleep: deps.sleep,
    });

    if (result.ok) {
      perMarket.push({
        marketPubkey: market.pubkey,
        ticker: market.ticker,
        status: "settled",
        txSig: result.value,
        attempts: result.attempts,
        elapsedMs: result.elapsedMs,
      });
      log({
        ...logBase,
        marketPubkey: market.pubkey,
        ticker: market.ticker,
        status: "settled",
        attempts: result.attempts,
        elapsedMs: result.elapsedMs,
        txSig: result.value,
      });
    } else if (result.reason === "exhausted") {
      perMarket.push({
        marketPubkey: market.pubkey,
        ticker: market.ticker,
        status: "exhausted",
        attempts: result.attempts,
        elapsedMs: result.elapsedMs,
        lastError: serializeError(result.error),
      });
      log({
        ...logBase,
        level: "warn",
        marketPubkey: market.pubkey,
        ticker: market.ticker,
        status: "exhausted",
        reason: "retry exhausted; admin_settle window opens at expiry + admin_override_delay_secs",
        attempts: result.attempts,
        elapsedMs: result.elapsedMs,
        lastError: serializeError(result.error),
      });
    } else {
      perMarket.push({
        marketPubkey: market.pubkey,
        ticker: market.ticker,
        status: "non-retriable-error",
        attempts: result.attempts,
        elapsedMs: result.elapsedMs,
        lastError: serializeError(result.error),
      });
      log({
        ...logBase,
        level: "error",
        marketPubkey: market.pubkey,
        ticker: market.ticker,
        status: "non-retriable-error",
        attempts: result.attempts,
        lastError: serializeError(result.error),
      });
    }
  }

  return { ok: true, runAt: runAtIso, perMarket };
}

/**
 * Default retry policy: retry on Pyth-transient errors (`PythConfidenceTooWide`,
 * `PythStale`) per PRD, plus generic RPC blips (503 / timeout / network /
 * fetch-failed / blockhash).
 *
 * Caller can compose their own policy by injecting `shouldRetry` into
 * `SettlementJobDeps`.
 *
 * The "fetch failed" + "blockhash" patterns were added 2026-05-24 after a
 * real-time settle:once on devnet hit `TypeError: fetch failed` from
 * `@solana/web3.js` Connection.getRecentBlockhash during a transient RPC
 * blip — that's clearly retriable from the operator's perspective but
 * wasn't matched by 503/timeout/network. See
 * `.project/.../settle-real-time-evidence.md` for the bug report.
 */
export function defaultShouldRetry(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const anchorErr = err as { error?: { errorCode?: { code?: string } } };
    const code = anchorErr.error?.errorCode?.code;
    if (code === "PythConfidenceTooWide" || code === "PythStale") return true;
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("503") ||
      msg.includes("timeout") ||
      msg.includes("network") ||
      msg.includes("fetch failed") ||
      msg.includes("blockhash")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Default on-chain enumeration: scan all StrikeMarket PDAs and filter to
 * `outcome === Unsettled` + `expiry_unix <= now`.
 *
 * Anchor's `program.account.strikeMarket.all()` is a `getProgramAccounts`
 * RPC call under the hood — one round trip, no per-market reads. Returns
 * up to a few KB per account, which scales fine for the MVP's ~49 markets
 * per trading day.
 */
async function defaultListOpenMarkets(
  client: BellMarketsAnchorClient,
  now: Date,
): Promise<OpenMarketRef[]> {
  const program = await client.getProgram();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accounts = program.account as any;
  if (!accounts.strikeMarket || typeof accounts.strikeMarket.all !== "function") {
    throw new Error(
      "Anchor program is missing `account.strikeMarket.all()` — IDL likely incomplete or wrong shape",
    );
  }
  const all: Array<{ publicKey: { toBase58(): string }; account: StrikeMarketRaw }> =
    await accounts.strikeMarket.all();
  const nowSec = Math.floor(now.getTime() / 1000);
  return all
    .filter((row) => isUnsettled(row.account.outcome))
    .filter((row) => toNumber(row.account.expiryUnix) <= nowSec)
    .map((row) => ({
      pubkey: row.publicKey.toBase58(),
      expiryUnix: toNumber(row.account.expiryUnix),
      underlyingPythFeed: row.account.underlyingPythFeed.toBase58(),
    }));
}

type StrikeMarketRaw = {
  outcome: Record<string, unknown>;
  expiryUnix: number | bigint | { toNumber: () => number };
  underlyingPythFeed: { toBase58: () => string };
};

function isUnsettled(outcome: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(outcome, "unsettled");
}

function toNumber(x: number | bigint | { toNumber: () => number }): number {
  if (typeof x === "number") return x;
  if (typeof x === "bigint") return Number(x);
  return x.toNumber();
}

/**
 * Default on-chain settle: builds + sends `settle_market` against a single
 * market. Deferred imports keep this path off web3.js until live runtime.
 */
async function defaultSettleMarketTx(
  client: BellMarketsAnchorClient,
  market: OpenMarketRef,
): Promise<string> {
  const program = await client.getProgram();
  const web3 = await import("@solana/web3.js");

  const programIdPk = new web3.PublicKey(client.opts.programId);
  const marketPk = new web3.PublicKey(market.pubkey);
  const pythFeedPk = new web3.PublicKey(market.underlyingPythFeed);
  const [configPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("config")], programIdPk);

  const provider = program.provider as unknown as {
    wallet: { publicKey: import("@solana/web3.js").PublicKey };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = program.methods as any;
  return methods
    .settleMarket()
    .accounts({
      settler: provider.wallet.publicKey,
      config: configPda,
      strikeMarket: marketPk,
      underlyingPythFeed: pythFeedPk,
      clock: web3.SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();
}

function defaultAnchorClientFactory(config: AutomationConfig): BellMarketsAnchorClient {
  if (!config.heliusRpcUrl) {
    throw new Error("HELIUS_DEVNET_RPC_URL required when BELL_MARKETS_PROGRAM_ID is set");
  }
  if (!config.platformAdminKeypairPath) {
    throw new Error("PLATFORM_ADMIN_KEYPAIR_PATH required when BELL_MARKETS_PROGRAM_ID is set");
  }
  if (!config.bellMarketsIdlPath) throw new Error("BELL_MARKETS_IDL_PATH required");
  if (!config.bellMarketsProgramId) throw new Error("BELL_MARKETS_PROGRAM_ID required");
  return new BellMarketsAnchorClient({
    rpcUrl: config.heliusRpcUrl,
    programId: config.bellMarketsProgramId,
    keypairPath: config.platformAdminKeypairPath,
    idlPath: config.bellMarketsIdlPath,
  });
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === "object" && err !== null) {
    const anchorErr = err as {
      error?: { errorCode?: { code?: string; number?: number }; errorMessage?: string };
    };
    const code = anchorErr.error?.errorCode?.code;
    if (code) {
      const num = anchorErr.error?.errorCode?.number;
      const msg = anchorErr.error?.errorMessage ? `: ${anchorErr.error.errorMessage}` : "";
      return `AnchorError(${code}${num !== undefined ? ` #${num}` : ""})${msg}`;
    }
  }
  return String(err);
}
