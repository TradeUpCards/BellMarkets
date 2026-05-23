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

/** Optional read of the current on-chain TickerConfig (Phase 2/3 only).
 *
 * `expo` is the Pyth-feed exponent (e.g. -5 for META). On-chain TickerConfig
 * stores cap_center / allowed_strikes / strike_tick_size as i64 in the
 * Pyth-expo-scaled domain; the read function de-scales them to human-dollar
 * `number` values for the caller's `driftBps(spot, capCenter)` comparison.
 */
export type ReadTickerConfigFn = (
  client: BellMarketsAnchorClient,
  ticker: Ticker,
  pythPriceAccount: string,
  expo: number,
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

    // Read Pyth FIRST so we have `expo` to pass into readTickerConfig.
    // TickerConfig stores cap_center as Pyth-expo-scaled i64; we need the
    // expo to de-scale into human dollars for the drift comparison.
    let priceRead: { price: number; expo: number };
    try {
      priceRead = await pythClient.getPreviousClose({ ticker, feedId: hermesFeedId });
    } catch (err) {
      const error = serializeError(err);
      perTicker.push({ ticker, status: "errored", error });
      continue;
    }

    let current: TickerConfigView | undefined;
    try {
      current = await readFn(anchorClient, ticker, pythPriceAccount, priceRead.expo);
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
 * Maximum slot count in TickerConfig.allowed_strikes — matches
 * MAX_ALLOWED_STRIKES in programs/bell-markets/src/state.rs. Fixed-size
 * array on chain; we pad to exactly 16 i64 entries.
 */
export const MAX_ALLOWED_STRIKES = 16;

/**
 * Real-runtime send path for `update_ticker_config`. Matches Aria's deploy-5
 * shape (programs/bell-markets/src/instructions/update_ticker_config.rs):
 *
 *   Seeds: [b"ticker", pyth_feed.key().as_ref()]
 *   Args:  (cap_center: i64,
 *           allowed_strikes: [i64; 16],   // PADDED with 0s past strike_count
 *           strike_count: u8,
 *           max_user_strike_deviation_bps: u16,
 *           strike_tick_size: i64,
 *           threshold_bps: u16)
 *   Accounts: { admin, config, pyth_feed, ticker_config (init_if_needed), system_program }
 *
 * STUB FALLBACK: if IDL lacks `updateTickerConfig`, returns ok=false with a
 * clear reason. No throw — the cron continues.
 */
export async function defaultUpdateTickerConfigTx(
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
    const pythFeedPk = new web3.PublicKey(input.pythPriceAccount);
    const [configPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      programIdPk,
    );
    // Aria's seed is b"ticker" (NOT b"ticker_config") per update_ticker_config.rs.
    const [tickerConfigPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("ticker"), pythFeedPk.toBuffer()],
      programIdPk,
    );

    const provider = program.provider as unknown as {
      wallet: { publicKey: import("@solana/web3.js").PublicKey };
    };
    const adminPk = provider.wallet.publicKey;

    // Strikes + capCenter scaled to i64 using the live Pyth expo, matching
    // on-chain comparisons (StrikeMarket.strike_price is i64 in same expo).
    const capCenterI64 = scaleStrikeToI64(input.capCenter, input.expo);
    const allowedStrikesI64Raw = input.allowedStrikes.map((s) => scaleStrikeToI64(s, input.expo));
    if (allowedStrikesI64Raw.length === 0) {
      return {
        ok: false,
        error:
          "update_ticker_config: allowed_strikes must be non-empty (post-P1-audit footgun guard requires strike_count > 0).",
      };
    }
    if (allowedStrikesI64Raw.length > MAX_ALLOWED_STRIKES) {
      return {
        ok: false,
        error: `update_ticker_config: allowed_strikes too large (${allowedStrikesI64Raw.length} > ${MAX_ALLOWED_STRIKES} cap).`,
      };
    }
    const strikeCount = allowedStrikesI64Raw.length;
    // Pad to exactly MAX_ALLOWED_STRIKES with zeros (Anchor's [i64; 16] decode).
    const padded: bigint[] = [...allowedStrikesI64Raw];
    while (padded.length < MAX_ALLOWED_STRIKES) padded.push(0n);
    const allowedStrikesBN = padded.map((v) => new anchor.BN(v.toString()));

    // Convert tickSizeUsd (human dollars, e.g. 5 / 2 / 1) into the same scaled
    // i64 units. Pyth expo is negative; tickSize is integer dollars; scale
    // up via 10^(-expo). E.g. tickSize=5 with expo=-5 → 500_000.
    const tickSizeI64 = scaleStrikeToI64(input.tickSizeUsd, input.expo);

    const txSig: string = await methods
      .updateTickerConfig(
        new anchor.BN(capCenterI64.toString()),
        allowedStrikesBN,
        strikeCount,
        input.deviationCapBps,
        new anchor.BN(tickSizeI64.toString()),
        input.thresholdBps,
      )
      .accounts({
        admin: adminPk,
        config: configPda,
        pythFeed: pythFeedPk,
        tickerConfig: tickerConfigPda,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();

    return { ok: true, txSig };
  } catch (err) {
    return { ok: false, error: serializeError(err) };
  }
}

/**
 * Default read of an on-chain TickerConfig PDA per Aria's deploy-5 shape.
 *
 *   Seeds: [b"ticker", pyth_feed.key().as_ref()]
 *   Account fields (programs/bell-markets/src/state.rs):
 *     pyth_feed: Pubkey
 *     cap_center: i64                       — Pyth-expo-scaled
 *     allowed_strikes: [i64; 16]            — Pyth-expo-scaled; only [..strike_count] valid
 *     strike_count: u8
 *     max_user_strike_deviation_bps: u16
 *     strike_tick_size: i64                 — Pyth-expo-scaled
 *     threshold_bps: u16
 *     last_updated_unix: i64
 *
 * Returns the values as Pyth-expo-SCALED i64 (NOT human dollars). The caller
 * (`runWildSwingPhase`) currently compares against `priceRead.price` in
 * human dollars — so we down-convert here using `input.expo` injected from
 * the live Pyth read.
 *
 * STUB FALLBACK: if IDL lacks the account type or PDA doesn't exist on chain,
 * return undefined. Phase 2/3 skips with "TickerConfig PDA does not exist yet".
 */
export async function defaultReadTickerConfig(
  client: BellMarketsAnchorClient,
  ticker: Ticker,
  pythPriceAccount: string,
  expo: number,
): Promise<TickerConfigView | undefined> {
  const program = await client.getProgram();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accounts = program.account as any;
  if (!accounts.tickerConfig || typeof accounts.tickerConfig.fetchNullable !== "function") {
    return undefined;
  }
  const web3 = await import("@solana/web3.js");
  const programIdPk = new web3.PublicKey(client.opts.programId);
  const pythFeedPk = new web3.PublicKey(pythPriceAccount);
  const [tickerConfigPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("ticker"), pythFeedPk.toBuffer()],
    programIdPk,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any = await accounts.tickerConfig.fetchNullable(tickerConfigPda);
  if (!raw) return undefined;

  const descale = (scaled: number): number => scaled * Math.pow(10, expo);
  const toNum = (v: unknown): number => {
    if (typeof v === "number") return v;
    if (typeof v === "bigint") return Number(v);
    if (typeof (v as { toNumber?: () => number })?.toNumber === "function") {
      return (v as { toNumber: () => number }).toNumber();
    }
    return Number(v ?? 0);
  };

  const strikeCount = toNum(raw.strikeCount ?? raw.strike_count ?? 0);
  const allowedRaw: unknown[] = Array.isArray(raw.allowedStrikes) ? raw.allowedStrikes : [];
  const allowedStrikes = allowedRaw.slice(0, strikeCount).map((s) => descale(toNum(s)));

  return {
    ticker,
    capCenter: descale(toNum(raw.capCenter)),
    allowedStrikes,
    deviationCapBps: toNum(raw.maxUserStrikeDeviationBps ?? raw.max_user_strike_deviation_bps),
    tickSizeUsd: descale(toNum(raw.strikeTickSize ?? raw.strike_tick_size)),
    thresholdBps: toNum(raw.thresholdBps ?? raw.threshold_bps),
    // Aria's deploy-5 TickerConfig has no `updated_by_phase` field; we default
    // to "anchor" for the view (informational only — no on-chain semantics).
    updatedByPhase: "anchor",
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
