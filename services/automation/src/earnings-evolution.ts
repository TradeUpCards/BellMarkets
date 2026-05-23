// DR-011 earnings-calendar pre-expansion / restoration orchestration.
//
// Cron firing pattern (single cron at 4:30 PM ET on every trading day):
//   1. Compute tickersToPreExpand(today)  — any ticker that reports AMC on
//      the next trading day
//   2. Compute tickersToRestore(today)    — any ticker that reported AMC on
//      the previous trading day
//   3. For each pre-expand ticker: read current TickerConfig; update with
//      deviationCapBps = EARNINGS_PREEXPAND_BPS[ticker] (e.g., 5000 = 50%),
//      phase = "earnings-pre"
//   4. For each restore ticker: read current TickerConfig; update with
//      deviationCapBps = TICKER_DEFAULTS[ticker].defaultDeviationCapBps,
//      phase = "earnings-restore"
//
// Both pre-expand and restore are layered ON TOP OF the DR-006 anchor (Phase
// 1 / 1b at 4:05 PM ET writes the default cap; this cron at 4:30 PM ET may
// overwrite it for tomorrow's earnings event). The 25-minute gap between
// Phase 1 and this is deliberate — Phase 1 establishes the anchor; we layer
// the earnings adjustment.
//
// Behavior when Aria's `update_ticker_config` ix isn't yet deployed:
//   tx-send returns ok=false with "Awaiting Aria's deploy"; we log the
//   intent + continue. Same stub-friendly pattern as grid-evolution.ts.

import { TICKER_DEFAULTS, type TickerConfigView } from "./ticker-config.js";
import {
  EARNINGS_PREEXPAND_BPS,
  tickersToPreExpand,
  tickersToRestore,
} from "./earnings-calendar.js";
import { isTradingDay } from "./calendar.js";
import { loadConfig, type AutomationConfig } from "./config.js";
import { PythClient } from "./clients/pyth.js";
import { BellMarketsAnchorClient } from "./clients/anchor.js";
import {
  type UpdateTickerConfigFn,
  type ReadTickerConfigFn,
  defaultUpdateTickerConfigTx,
  defaultReadTickerConfig,
} from "./grid-evolution.js";
import type { Ticker } from "./types.js";
import { PYTH_HERMES_FEED_IDS } from "./config.js";

export type EarningsCronDeps = {
  runAt: Date;
  ctxRunId?: string;
  config?: AutomationConfig;
  pythClientFactory?: (cfg: AutomationConfig) => PythClient;
  anchorClientFactory?: (cfg: AutomationConfig) => BellMarketsAnchorClient;
  updateTickerConfig?: UpdateTickerConfigFn;
  readTickerConfig?: ReadTickerConfigFn;
  log?: (entry: Record<string, unknown>) => void;
};

export type EarningsActionOutcome = {
  ticker: Ticker;
  action: "pre-expand" | "restore";
  status: "updated" | "skipped" | "errored";
  reason?: string;
  oldDeviationCapBps?: number;
  newDeviationCapBps?: number;
  txSig?: string;
  error?: string;
};

export type EarningsCronOutcome = {
  ok: true;
  runAt: string;
  preExpand: EarningsActionOutcome[];
  restore: EarningsActionOutcome[];
  stub?: boolean;
  skipped?: boolean;
  reason?: string;
};

/**
 * Single 4:30 PM ET trading-day cron. Idempotent — re-running the same day
 * is a no-op (TickerConfig already in target state).
 *
 * IMPORTANT: this assumes Phase 1 / Phase 1b already ran at 4:05 PM ET on
 * the same day to anchor TickerConfig. If TickerConfig doesn't exist yet
 * (anchor never ran for a ticker), this skip with reason "no TickerConfig"
 * — the next anchor establishes it.
 */
export async function runEarningsCronOnce(deps: EarningsCronDeps): Promise<EarningsCronOutcome> {
  const config = deps.config ?? loadConfig();
  const log = deps.log ?? ((e: Record<string, unknown>) => console.info(JSON.stringify(e)));
  const runAtIso = deps.runAt.toISOString();
  const logBase = { jobId: "earnings-evolution", runAt: runAtIso, ctxRunId: deps.ctxRunId };

  if (!isTradingDay(deps.runAt)) {
    log({ ...logBase, skipped: true, reason: "not a trading day" });
    return { ok: true, runAt: runAtIso, preExpand: [], restore: [], skipped: true, reason: "not a trading day" };
  }

  if (!config.bellMarketsProgramId) {
    log({ ...logBase, stub: true, reason: "BELL_MARKETS_PROGRAM_ID unset — log-only stub" });
    return { ok: true, runAt: runAtIso, preExpand: [], restore: [], stub: true };
  }

  let preExpandList: Ticker[];
  let restoreList: Ticker[];
  try {
    preExpandList = tickersToPreExpand(deps.runAt);
    restoreList = tickersToRestore(deps.runAt);
  } catch (err) {
    log({ ...logBase, level: "error", stage: "lookup", error: serializeError(err) });
    throw err;
  }

  log({
    ...logBase,
    preExpandList,
    restoreList,
    preExpandCount: preExpandList.length,
    restoreCount: restoreList.length,
  });

  // Fast path: nothing to do today.
  if (preExpandList.length === 0 && restoreList.length === 0) {
    return { ok: true, runAt: runAtIso, preExpand: [], restore: [] };
  }

  let anchorClient: BellMarketsAnchorClient;
  let pythClient: PythClient;
  try {
    pythClient = deps.pythClientFactory?.(config) ?? defaultPythClientFactory(config);
    anchorClient = deps.anchorClientFactory?.(config) ?? defaultAnchorClientFactory(config);
    await anchorClient.getProgram();
  } catch (err) {
    log({ ...logBase, level: "error", stage: "client-init", error: serializeError(err) });
    throw err;
  }

  const updateFn = deps.updateTickerConfig ?? (await loadDefaultUpdateFn());
  const readFn = deps.readTickerConfig ?? (await loadDefaultReadFn());

  const preExpand: EarningsActionOutcome[] = [];
  for (const ticker of preExpandList) {
    preExpand.push(
      await runOne(ticker, "pre-expand", EARNINGS_PREEXPAND_BPS[ticker], {
        config,
        anchorClient,
        pythClient,
        readFn,
        updateFn,
        log,
        logBase,
      }),
    );
  }

  const restore: EarningsActionOutcome[] = [];
  for (const ticker of restoreList) {
    restore.push(
      await runOne(ticker, "restore", TICKER_DEFAULTS[ticker].defaultDeviationCapBps, {
        config,
        anchorClient,
        pythClient,
        readFn,
        updateFn,
        log,
        logBase,
      }),
    );
  }

  return { ok: true, runAt: runAtIso, preExpand, restore };
}

// ---------------------------------------------------------------------------
// Per-ticker action helper
// ---------------------------------------------------------------------------

type ActionContext = {
  config: AutomationConfig;
  anchorClient: BellMarketsAnchorClient;
  pythClient: PythClient;
  readFn: ReadTickerConfigFn;
  updateFn: UpdateTickerConfigFn;
  log: (entry: Record<string, unknown>) => void;
  logBase: Record<string, unknown>;
};

async function runOne(
  ticker: Ticker,
  action: "pre-expand" | "restore",
  newDeviationCapBps: number,
  ctx: ActionContext,
): Promise<EarningsActionOutcome> {
  const pythPriceAccount = ctx.config.pythPriceAccounts[ticker];
  const hermesFeedId = PYTH_HERMES_FEED_IDS[ticker];

  if (!pythPriceAccount) {
    ctx.log({ ...ctx.logBase, ticker, action, status: "skipped", reason: `PYTH_PRICE_ACCOUNT_${ticker} unset` });
    return { ticker, action, status: "skipped", reason: "no Pyth on-chain price account" };
  }
  if (!hermesFeedId) {
    return { ticker, action, status: "errored", error: "missing Hermes feed id" };
  }

  // Read Pyth FIRST so we have expo for descaling the TickerConfig read.
  let priceRead: { price: number; expo: number };
  try {
    priceRead = await ctx.pythClient.getPreviousClose({ ticker, feedId: hermesFeedId });
  } catch (err) {
    const error = serializeError(err);
    ctx.log({ ...ctx.logBase, ticker, action, status: "errored", stage: "pyth-read", error });
    return { ticker, action, status: "errored", error };
  }

  let current: TickerConfigView | undefined;
  try {
    current = await ctx.readFn(ctx.anchorClient, ticker, pythPriceAccount, priceRead.expo);
  } catch (err) {
    const error = serializeError(err);
    ctx.log({ ...ctx.logBase, ticker, action, status: "errored", stage: "read", error });
    return { ticker, action, status: "errored", error };
  }
  if (!current) {
    ctx.log({ ...ctx.logBase, ticker, action, status: "skipped", reason: "TickerConfig PDA does not exist yet" });
    return { ticker, action, status: "skipped", reason: "TickerConfig PDA does not exist yet" };
  }

  // Idempotency: if the cap is already in target state, no write.
  if (current.deviationCapBps === newDeviationCapBps) {
    return {
      ticker,
      action,
      status: "skipped",
      reason: `deviation cap already ${newDeviationCapBps} bps`,
      oldDeviationCapBps: current.deviationCapBps,
      newDeviationCapBps,
    };
  }

  const result = await ctx.updateFn({
    ticker,
    capCenter: current.capCenter,
    allowedStrikes: current.allowedStrikes,
    deviationCapBps: newDeviationCapBps,
    tickSizeUsd: current.tickSizeUsd,
    thresholdBps: current.thresholdBps,
    phase: action === "pre-expand" ? "earnings-pre" : "earnings-restore",
    pythPriceAccount,
    expo: priceRead.expo,
    config: ctx.config,
    anchorClient: ctx.anchorClient,
  });

  if (result.ok) {
    ctx.log({
      ...ctx.logBase,
      ticker,
      action,
      status: "updated",
      oldDeviationCapBps: current.deviationCapBps,
      newDeviationCapBps,
      txSig: result.txSig,
    });
    return {
      ticker,
      action,
      status: "updated",
      oldDeviationCapBps: current.deviationCapBps,
      newDeviationCapBps,
      txSig: result.txSig,
    };
  } else {
    ctx.log({ ...ctx.logBase, ticker, action, status: "errored", error: result.error });
    return {
      ticker,
      action,
      status: "errored",
      oldDeviationCapBps: current.deviationCapBps,
      newDeviationCapBps,
      error: result.error,
    };
  }
}

// ---------------------------------------------------------------------------
// Default fns delegate to grid-evolution.ts — single source of truth for the
// `update_ticker_config` IDL shape + `ticker_config` PDA seeds.
// ---------------------------------------------------------------------------

async function loadDefaultUpdateFn(): Promise<UpdateTickerConfigFn> {
  return defaultUpdateTickerConfigTx;
}

async function loadDefaultReadFn(): Promise<ReadTickerConfigFn> {
  return defaultReadTickerConfig;
}

// (Stale local duplicates of `defaultUpdateTickerConfigTx` /
// `defaultReadTickerConfig` removed — both now delegate to grid-evolution.ts
// to maintain a single source of truth for Aria's deploy-5 ix shape.)

function defaultPythClientFactory(config: AutomationConfig): PythClient {
  if (!config.pythHttpBaseUrl) {
    throw new Error("PYTH_HTTP_BASE_URL required when BELL_MARKETS_PROGRAM_ID is set");
  }
  return new PythClient({ baseUrl: config.pythHttpBaseUrl });
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
