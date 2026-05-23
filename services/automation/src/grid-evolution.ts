// DR-006 strike-grid evolution — orchestration for the 3-phase rolling
// per-ticker TickerConfig update cycle.
//
// Phase 1  — 4:05 PM ET (5 21 * * 1-5 EDT / 5 22 * * 1-5 EST; gated by
//            isTradingDay + !isHalfDay).  After settle: anchor next trading
//            day's grid from TODAY's close.  ANCHOR.
//
// Phase 1b — 1:05 PM ET on half-days  (5 18 * * 1-5 EDT / 5 19 * * 1-5 EST;
//            gated by isHalfDay).  Same as Phase 1 logic; different timing.
//
// Phase 2  — Every 30 min, 4:30 PM ET → 8:00 PM ET, trading days.  Reads
//            live spot per ticker; if drift > ticker threshold, expands
//            grid (preserves existing strikes; adds new fresh ones).  AH.
//
// Phase 3  — Every 30 min, 4:00 AM ET → 9:00 AM ET, trading days.  Same
//            as Phase 2 logic; pre-market window.  PM.
//
// All four phases are pure(-ish) functions taking injected deps; Trigger.dev
// wrappers (see jobs/grid-evolution.ts) are thin shells over these.
//
// What we send on-chain via Aria's `update_ticker_config` admin ix:
//   - capCenter, allowedStrikes, deviationCapBps, tickSizeUsd, thresholdBps,
//     phaseCode
//
// Stub behavior:
//   - When `BELL_MARKETS_PROGRAM_ID` unset → log-only stub (same as morning.ts).
//   - When the IDL doesn't yet have `update_ticker_config` (Aria hasn't
//     deployed) → the tx-send adapter returns `{ ok: false, error: "..." }`
//     and we log + continue. No retries; the next 30-min phase fire will
//     just try again.
//
// DR-002 reminder: TickerConfig updates are admin-only on chain (we are
// the platform admin keypair). Same as `create_strike_market`. No special
// authority here vs morning.ts.

import { MAG7, type Ticker } from "./types.js";
import {
  TICKER_DEFAULTS,
  computeStrikeGrid,
  driftBps,
  expandedStrikeGrid,
  phaseLabelToOnChainCode,
  type PhaseLabel,
  type TickerConfigView,
} from "./ticker-config.js";
import {
  loadConfig,
  PYTH_HERMES_FEED_IDS,
  type AutomationConfig,
} from "./config.js";
import { PythClient } from "./clients/pyth.js";
import { BellMarketsAnchorClient } from "./clients/anchor.js";
import { scaleStrikeToI64 } from "./jobs/morning.js";
import { isTradingDay, isHalfDay, nextTradingDay, getCloseTime } from "./calendar.js";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** What we send to Aria's on-chain `update_ticker_config` ix. */
export type UpdateTickerConfigInput = {
  ticker: Ticker;
  capCenter: number; // human USD
  allowedStrikes: number[]; // human USD
  deviationCapBps: number;
  tickSizeUsd: number;
  thresholdBps: number;
  phase: PhaseLabel;
  /** Per-ticker Pyth on-chain price account pubkey (for TickerConfig PDA seed). */
  pythPriceAccount: string;
  /** Next trading day's close as Unix seconds — Phase 1/1b anchor uses this. */
  expiryUnix?: number;
  /** Pyth feed exponent at read time (for i64 scaling of capCenter / strikes). */
  expo: number;
  config: AutomationConfig;
  anchorClient: BellMarketsAnchorClient;
};

export type UpdateTickerConfigResult =
  | { ok: true; txSig: string }
  | { ok: false; error: string };

export type UpdateTickerConfigFn = (input: UpdateTickerConfigInput) => Promise<UpdateTickerConfigResult>;

/** Optional read of the current on-chain TickerConfig (Phase 2/3 only). */
export type ReadTickerConfigFn = (
  client: BellMarketsAnchorClient,
  ticker: Ticker,
  pythPriceAccount: string,
) => Promise<TickerConfigView | undefined>;

export type GridPhaseDeps = {
  runAt: Date;
  ctxRunId?: string;
  config?: AutomationConfig;
  pythClientFactory?: (cfg: AutomationConfig) => PythClient;
  anchorClientFactory?: (cfg: AutomationConfig) => BellMarketsAnchorClient;
  updateTickerConfig?: UpdateTickerConfigFn;
  readTickerConfig?: ReadTickerConfigFn;
  log?: (entry: Record<string, unknown>) => void;
};

export type PerTickerOutcome = {
  ticker: Ticker;
  status: "updated" | "skipped" | "no-drift" | "stubbed" | "errored";
  reason?: string;
  capCenter?: number;
  allowedStrikes?: number[];
  driftBps?: number;
  txSig?: string;
  error?: string;
};

export type GridPhaseOutcome = {
  ok: true;
  phase: PhaseLabel;
  runAt: string;
  perTicker: PerTickerOutcome[];
  stub?: boolean;
  /** Phase 1/1b only — the next trading day's close anchored into TickerConfig.expiry_unix. */
  anchoredExpiryIso?: string;
};

// ---------------------------------------------------------------------------
// Phase 1 + 1b — anchor next trading day
// ---------------------------------------------------------------------------

/**
 * Phase 1 / 1b: anchor the next trading day's TickerConfig from today's
 * (just-settled) close.
 *
 * Workflow per ticker:
 *   1. Hermes read latest verified price for the ticker (= today's close,
 *      since we run 5 minutes after the close cron). This is `capCenter`.
 *   2. Compute strike grid: ATM ± 3/6/9% of capCenter, rounded to per-ticker
 *      tickSize, deduped + sorted.
 *   3. Read per-ticker defaults from `TICKER_DEFAULTS` for deviationCapBps,
 *      thresholdBps.
 *   4. Determine next trading day's close time → store as TickerConfig.expiry_unix.
 *   5. Call `update_ticker_config` admin ix on chain (or log+continue if
 *      Aria's program lacks the ix yet).
 */
export async function runAnchorPhase(deps: GridPhaseDeps): Promise<GridPhaseOutcome> {
  const phase: PhaseLabel = "anchor";
  const config = deps.config ?? loadConfig();
  const log = deps.log ?? ((e: Record<string, unknown>) => console.info(JSON.stringify(e)));
  const runAtIso = deps.runAt.toISOString();
  const logBase = { jobId: "grid-anchor", phase, runAt: runAtIso, ctxRunId: deps.ctxRunId };

  if (!config.bellMarketsProgramId) {
    log({ ...logBase, stub: true, reason: "BELL_MARKETS_PROGRAM_ID unset — log-only stub" });
    return { ok: true, phase, runAt: runAtIso, stub: true, perTicker: stubAllTickers() };
  }

  // Anchor expiry: next trading day's close.
  let anchoredExpiry: Date;
  try {
    const nextDay = nextTradingDay(deps.runAt);
    anchoredExpiry = getCloseTime(nextDay);
  } catch (err) {
    log({ ...logBase, level: "error", stage: "next-trading-day", error: serializeError(err) });
    throw err;
  }
  const anchoredExpiryIso = anchoredExpiry.toISOString();
  const anchoredExpiryUnix = Math.floor(anchoredExpiry.getTime() / 1000);
  log({ ...logBase, anchoredExpiry: anchoredExpiryIso });

  const { pythClient, anchorClient } = await initClients(config, deps, log, logBase);

  const updateFn = deps.updateTickerConfig ?? defaultUpdateTickerConfigTx;
  const perTicker: PerTickerOutcome[] = [];

  for (const ticker of MAG7) {
    const tickerDefaults = TICKER_DEFAULTS[ticker];
    const pythPriceAccount = config.pythPriceAccounts[ticker];
    const hermesFeedId = PYTH_HERMES_FEED_IDS[ticker];

    if (!pythPriceAccount) {
      perTicker.push({ ticker, status: "skipped", reason: "no Pyth on-chain price account configured" });
      log({ ...logBase, ticker, status: "skipped", reason: `PYTH_PRICE_ACCOUNT_${ticker} unset` });
      continue;
    }
    if (!hermesFeedId) {
      perTicker.push({ ticker, status: "errored", error: "missing Hermes feed id" });
      continue;
    }

    let priceRead: { price: number; expo: number };
    try {
      priceRead = await pythClient.getPreviousClose({ ticker, feedId: hermesFeedId });
    } catch (err) {
      const error = serializeError(err);
      perTicker.push({ ticker, status: "errored", error });
      log({ ...logBase, ticker, status: "errored", stage: "hermes-spot-read", error });
      continue;
    }

    const capCenter = priceRead.price;
    const allowedStrikes = computeStrikeGrid(capCenter, tickerDefaults.strikeTickSizeUsd);

    const result = await updateFn({
      ticker,
      capCenter,
      allowedStrikes,
      deviationCapBps: tickerDefaults.defaultDeviationCapBps,
      tickSizeUsd: tickerDefaults.strikeTickSizeUsd,
      thresholdBps: tickerDefaults.wildSwingThresholdBps,
      phase,
      pythPriceAccount,
      expiryUnix: anchoredExpiryUnix,
      expo: priceRead.expo,
      config,
      anchorClient,
    });

    if (result.ok) {
      perTicker.push({
        ticker,
        status: "updated",
        capCenter,
        allowedStrikes,
        txSig: result.txSig,
      });
      log({ ...logBase, ticker, status: "updated", capCenter, allowedStrikes, txSig: result.txSig });
    } else {
      perTicker.push({ ticker, status: "errored", capCenter, allowedStrikes, error: result.error });
      log({ ...logBase, level: "warn", ticker, status: "errored", capCenter, error: result.error });
    }
  }

  return { ok: true, phase, runAt: runAtIso, perTicker, anchoredExpiryIso };
}

// ---------------------------------------------------------------------------
// Phase 2 + 3 — wild-swing checks (AH + PM)
// ---------------------------------------------------------------------------

/**
 * Phase 2 / 3 wild-swing check.
 *
 * Workflow per ticker:
 *   1. Read current on-chain TickerConfig (capCenter + existing allowed_strikes).
 *      If TickerConfig doesn't exist yet (anchor hasn't run, or program lacks
 *      the field), skip with reason.
 *   2. Hermes read latest verified price → `spot`.
 *   3. Compute `driftBps(spot, capCenter)`.
 *   4. If drift ≤ threshold → no-op, no write.
 *   5. If drift > threshold → expanded grid (union of existing + fresh around
 *      new spot), update TickerConfig with new capCenter + expandedGrid.
 *
 * Trigger.dev fires this every 30 min in a wider cron window than the actual
 * intended ET window; we filter calls outside the window with `isInPhaseWindow`.
 */
export async function runWildSwingPhase(
  deps: GridPhaseDeps & { phase: "ah" | "pm" },
): Promise<GridPhaseOutcome> {
  const phase: PhaseLabel = deps.phase;
  const config = deps.config ?? loadConfig();
  const log = deps.log ?? ((e: Record<string, unknown>) => console.info(JSON.stringify(e)));
  const runAtIso = deps.runAt.toISOString();
  const logBase = { jobId: `grid-${phase}`, phase, runAt: runAtIso, ctxRunId: deps.ctxRunId };

  // Outside-window early exit: Trigger.dev cron strings cover a slightly
  // wider hour range than DR-006 specifies. Gate at runtime.
  if (!isInPhaseWindow(deps.runAt, phase)) {
    log({ ...logBase, status: "out-of-window", reason: `${phase} check outside ET window` });
    return { ok: true, phase, runAt: runAtIso, perTicker: [] };
  }

  if (!config.bellMarketsProgramId) {
    log({ ...logBase, stub: true, reason: "BELL_MARKETS_PROGRAM_ID unset — log-only stub" });
    return { ok: true, phase, runAt: runAtIso, stub: true, perTicker: stubAllTickers() };
  }

  const { pythClient, anchorClient } = await initClients(config, deps, log, logBase);
  const updateFn = deps.updateTickerConfig ?? defaultUpdateTickerConfigTx;
  const readFn = deps.readTickerConfig ?? defaultReadTickerConfig;

  const perTicker: PerTickerOutcome[] = [];

  for (const ticker of MAG7) {
    const tickerDefaults = TICKER_DEFAULTS[ticker];
    const pythPriceAccount = config.pythPriceAccounts[ticker];
    const hermesFeedId = PYTH_HERMES_FEED_IDS[ticker];

    if (!pythPriceAccount) {
      perTicker.push({ ticker, status: "skipped", reason: "no Pyth on-chain price account configured" });
      continue;
    }
    if (!hermesFeedId) {
      perTicker.push({ ticker, status: "errored", error: "missing Hermes feed id" });
      continue;
    }

    let current: TickerConfigView | undefined;
    try {
      current = await readFn(anchorClient, ticker, pythPriceAccount);
    } catch (err) {
      const error = serializeError(err);
      perTicker.push({ ticker, status: "errored", error });
      log({ ...logBase, ticker, status: "errored", stage: "read-ticker-config", error });
      continue;
    }
    if (!current) {
      perTicker.push({ ticker, status: "skipped", reason: "TickerConfig PDA does not exist yet (anchor not run)" });
      continue;
    }

    let priceRead: { price: number; expo: number };
    try {
      priceRead = await pythClient.getPreviousClose({ ticker, feedId: hermesFeedId });
    } catch (err) {
      const error = serializeError(err);
      perTicker.push({ ticker, status: "errored", error });
      continue;
    }

    const spot = priceRead.price;
    const drift = driftBps(spot, current.capCenter);

    if (drift <= tickerDefaults.wildSwingThresholdBps) {
      perTicker.push({ ticker, status: "no-drift", capCenter: current.capCenter, driftBps: drift });
      log({ ...logBase, ticker, status: "no-drift", capCenter: current.capCenter, spot, driftBps: drift });
      continue;
    }

    const expanded = expandedStrikeGrid(spot, tickerDefaults.strikeTickSizeUsd, current.allowedStrikes);
    const result = await updateFn({
      ticker,
      capCenter: spot, // re-center on the new spot
      allowedStrikes: expanded,
      deviationCapBps: tickerDefaults.defaultDeviationCapBps,
      tickSizeUsd: tickerDefaults.strikeTickSizeUsd,
      thresholdBps: tickerDefaults.wildSwingThresholdBps,
      phase,
      pythPriceAccount,
      expo: priceRead.expo,
      config,
      anchorClient,
    });

    if (result.ok) {
      perTicker.push({
        ticker,
        status: "updated",
        capCenter: spot,
        allowedStrikes: expanded,
        driftBps: drift,
        txSig: result.txSig,
      });
      log({ ...logBase, ticker, status: "updated", capCenter: spot, allowedStrikes: expanded, driftBps: drift, txSig: result.txSig });
    } else {
      perTicker.push({ ticker, status: "errored", capCenter: spot, allowedStrikes: expanded, driftBps: drift, error: result.error });
      log({ ...logBase, level: "warn", ticker, status: "errored", capCenter: spot, error: result.error });
    }
  }

  return { ok: true, phase, runAt: runAtIso, perTicker };
}

// ---------------------------------------------------------------------------
// Window gating + helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if `date` is within the ET wall-clock window for the given
 * wild-swing phase:
 *   - Phase 2 (AH): 16:30 ≤ hh:mm ≤ 20:00 ET on a trading day
 *   - Phase 3 (PM): 04:00 ≤ hh:mm ≤ 09:00 ET on a trading day
 * Used to gate Trigger.dev fires that may land slightly outside DR-006's
 * specified window due to cron-string approximation.
 */
export function isInPhaseWindow(date: Date, phase: "ah" | "pm"): boolean {
  if (!isTradingDay(date)) return false;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hh = Number(parts.find((p) => p.type === "hour")?.value);
  const mm = Number(parts.find((p) => p.type === "minute")?.value);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return false;
  const minutesFromMidnight = hh * 60 + mm;
  if (phase === "ah") {
    return minutesFromMidnight >= 16 * 60 + 30 && minutesFromMidnight <= 20 * 60;
  }
  // pm
  return minutesFromMidnight >= 4 * 60 && minutesFromMidnight <= 9 * 60;
}

/**
 * Returns true if `date` is a trading day AND a regular (non-half) day.
 * Used by the Phase 1 cron to skip half-days (Phase 1b handles those).
 */
export function isRegularTradingDay(date: Date): boolean {
  return isTradingDay(date) && !isHalfDay(date);
}

// ---------------------------------------------------------------------------
// Default tx-send adapters (deferred imports — same pattern as morning.ts)
// ---------------------------------------------------------------------------

/**
 * Real-runtime send path for `update_ticker_config`. STUB FALLBACK:
 *   - If the IDL doesn't expose `updateTickerConfig` (Aria's ix not deployed),
 *     log + return ok=false with a clear reason. No throw — the cron continues.
 *   - When Aria lands the ix, this picks it up via IDL parsing automatically.
 *
 * Accounts shape (proposed; Aria's final design wins):
 *   { admin (signer), config, ticker_config, underlying_pyth_feed, system_program, rent }
 *
 * PDA seeds (proposed): [b"ticker_config", underlying_pyth_feed.key().as_ref()]
 */
async function defaultUpdateTickerConfigTx(
  input: UpdateTickerConfigInput,
): Promise<UpdateTickerConfigResult> {
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

    // Strikes + capCenter scaled to i64 using the live Pyth expo, matching
    // on-chain settle comparisons (StrikeMarket.strike_price is i64 in same
    // expo). Re-uses morning.ts `scaleStrikeToI64`.
    const capCenterI64 = scaleStrikeToI64(input.capCenter, input.expo);
    const allowedStrikesI64 = input.allowedStrikes.map((s) => scaleStrikeToI64(s, input.expo));

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
}

/**
 * Default read of an on-chain TickerConfig PDA. STUB FALLBACK:
 *   - If the IDL doesn't expose the `tickerConfig` account type, return undefined.
 *     Phase 2/3 will skip the ticker with "TickerConfig PDA does not exist yet".
 */
async function defaultReadTickerConfig(
  client: BellMarketsAnchorClient,
  ticker: Ticker,
  pythPriceAccount: string,
): Promise<TickerConfigView | undefined> {
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
  // Off-chain expects human-readable USD; on-chain stores i64 scaled by Pyth
  // expo. Aria's read-helper returns the inverse scaling. For MVP we trust
  // the on-chain values are already de-scaled by Aria's `Account.fetch` IDL
  // wrapper. If divergence is observed, swap to manual scaling here.
  const phaseLabel = (function (code: number): PhaseLabel {
    switch (code) {
      case 0:
        return "anchor";
      case 1:
        return "ah";
      case 2:
        return "pm";
      case 3:
        return "earnings-pre";
      case 4:
        return "earnings-restore";
      default:
        return "anchor";
    }
  })(typeof raw.updatedByPhase === "number" ? raw.updatedByPhase : 0);
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
    tickSizeUsd: typeof raw.strikeTickSize?.toNumber === "function" ? raw.strikeTickSize.toNumber() : Number(raw.strikeTickSize ?? raw.tickSize ?? 0),
    thresholdBps: Number(raw.thresholdBps ?? 0),
    updatedByPhase: phaseLabel,
  };
}

async function initClients(
  config: AutomationConfig,
  deps: GridPhaseDeps,
  log: (e: Record<string, unknown>) => void,
  logBase: Record<string, unknown>,
): Promise<{ pythClient: PythClient; anchorClient: BellMarketsAnchorClient }> {
  let pythClient: PythClient;
  let anchorClient: BellMarketsAnchorClient;
  try {
    pythClient = deps.pythClientFactory?.(config) ?? defaultPythClientFactory(config);
    anchorClient = deps.anchorClientFactory?.(config) ?? defaultAnchorClientFactory(config);
  } catch (err) {
    log({ ...logBase, level: "error", stage: "client-init", error: serializeError(err) });
    throw err;
  }
  try {
    await anchorClient.getProgram();
  } catch (err) {
    log({ ...logBase, level: "error", stage: "anchor-program-init", error: serializeError(err) });
    throw err;
  }
  return { pythClient, anchorClient };
}

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

function stubAllTickers(): PerTickerOutcome[] {
  return MAG7.map((ticker) => ({ ticker, status: "stubbed", reason: "BELL_MARKETS_PROGRAM_ID unset" }));
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
