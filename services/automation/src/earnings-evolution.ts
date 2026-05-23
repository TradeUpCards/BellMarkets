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

  let current: TickerConfigView | undefined;
  try {
    current = await ctx.readFn(ctx.anchorClient, ticker, pythPriceAccount);
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

  let priceRead: { price: number; expo: number };
  try {
    priceRead = await ctx.pythClient.getPreviousClose({ ticker, feedId: hermesFeedId });
  } catch (err) {
    const error = serializeError(err);
    ctx.log({ ...ctx.logBase, ticker, action, status: "errored", stage: "pyth-read", error });
    return { ticker, action, status: "errored", error };
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
// Defaults (deferred imports — same pattern as grid-evolution.ts)
// ---------------------------------------------------------------------------

async function loadDefaultUpdateFn(): Promise<UpdateTickerConfigFn> {
  // Dynamic re-export so we share the exact same `defaultUpdateTickerConfigTx`
  // adapter as grid-evolution. Keeps the IDL-shape coupling in one place.
  const gridEvolution = await import("./grid-evolution.js");
  // The default adapter is module-private in grid-evolution.ts; we expose
  // the behavior through `runAnchorPhase` / `runWildSwingPhase`. For the
  // earnings cron, we replicate the same fallback semantics via a thin
  // wrapper that always returns ok=false until Aria deploys (matching the
  // existing grid-evolution behavior).
  // Using an injected fn is the test path; the live path uses an inline
  // implementation here that defers imports.
  void gridEvolution;
  return defaultUpdateTickerConfigTx;
}

async function loadDefaultReadFn(): Promise<ReadTickerConfigFn> {
  return defaultReadTickerConfig;
}

const defaultUpdateTickerConfigTx: UpdateTickerConfigFn = async (input) => {
  try {
    const program = await input.anchorClient.getProgram();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const methods = program.methods as any;
    if (typeof methods.updateTickerConfig !== "function") {
      return {
        ok: false,
        error:
          "IDL is missing `updateTickerConfig` instruction. Awaiting Aria's deploy of the DR-005/DR-006 admin ix.",
      };
    }
    const anchor = await import("@coral-xyz/anchor");
    const web3 = await import("@solana/web3.js");
    const programIdPk = new web3.PublicKey(input.anchorClient.opts.programId);
    const underlyingPythFeedPk = new web3.PublicKey(input.pythPriceAccount);
    const [configPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      programIdPk,
    );
    const [tickerConfigPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("ticker_config"), underlyingPythFeedPk.toBuffer()],
      programIdPk,
    );
    const provider = program.provider as unknown as {
      wallet: { publicKey: import("@solana/web3.js").PublicKey };
    };
    const adminPk = provider.wallet.publicKey;

    // Earnings-pre/restore updates carry capCenter + allowedStrikes verbatim
    // from the previous on-chain TickerConfig (re-read upstream). We're only
    // changing deviationCapBps + phase.
    const { scaleStrikeToI64 } = await import("./jobs/morning.js");
    const capCenterI64 = scaleStrikeToI64(input.capCenter, input.expo);
    const allowedStrikesI64 = input.allowedStrikes.map((s) => scaleStrikeToI64(s, input.expo));
    const { phaseLabelToOnChainCode } = await import("./ticker-config.js");

    const txSig: string = await methods
      .updateTickerConfig(
        new anchor.BN(capCenterI64.toString()),
        allowedStrikesI64.map((bn: bigint) => new anchor.BN(bn.toString())),
        input.deviationCapBps,
        new anchor.BN(input.tickSizeUsd),
        input.thresholdBps,
        phaseLabelToOnChainCode(input.phase),
        input.expiryUnix !== undefined ? new anchor.BN(input.expiryUnix) : new anchor.BN(0),
      )
      .accounts({
        admin: adminPk,
        config: configPda,
        tickerConfig: tickerConfigPda,
        underlyingPythFeed: underlyingPythFeedPk,
        systemProgram: web3.SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    return { ok: true, txSig };
  } catch (err) {
    return { ok: false, error: serializeError(err) };
  }
};

const defaultReadTickerConfig: ReadTickerConfigFn = async (client, ticker, pythPriceAccount) => {
  const program = await client.getProgram();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accounts = program.account as any;
  if (!accounts.tickerConfig || typeof accounts.tickerConfig.fetchNullable !== "function") {
    return undefined;
  }
  const web3 = await import("@solana/web3.js");
  const programIdPk = new web3.PublicKey(client.opts.programId);
  const underlyingPythFeedPk = new web3.PublicKey(pythPriceAccount);
  const [tickerConfigPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("ticker_config"), underlyingPythFeedPk.toBuffer()],
    programIdPk,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any = await accounts.tickerConfig.fetchNullable(tickerConfigPda);
  if (!raw) return undefined;
  return {
    ticker,
    capCenter: typeof raw.capCenter?.toNumber === "function" ? raw.capCenter.toNumber() : Number(raw.capCenter ?? 0),
    allowedStrikes: Array.isArray(raw.allowedStrikes)
      ? raw.allowedStrikes.map((s: unknown) =>
          typeof (s as { toNumber?: () => number })?.toNumber === "function"
            ? (s as { toNumber: () => number }).toNumber()
            : Number(s),
        )
      : [],
    deviationCapBps: Number(raw.maxUserStrikeDeviationBps ?? raw.deviationCapBps ?? 0),
    tickSizeUsd:
      typeof raw.strikeTickSize?.toNumber === "function"
        ? raw.strikeTickSize.toNumber()
        : Number(raw.strikeTickSize ?? raw.tickSize ?? 0),
    thresholdBps: Number(raw.thresholdBps ?? 0),
    updatedByPhase: "anchor",
  };
};

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
