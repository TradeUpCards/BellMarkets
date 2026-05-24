import { describe, it, expect, vi } from "vitest";
import { runEarningsCronOnce } from "../../services/automation/src/earnings-evolution.js";
import { EARNINGS_PREEXPAND_BPS } from "../../services/automation/src/earnings-calendar.js";
import { TICKER_DEFAULTS } from "../../services/automation/src/ticker-config.js";
import type { AutomationConfig } from "../../services/automation/src/config.js";
import type {
  UpdateTickerConfigFn,
  ReadTickerConfigFn,
  UpdateTickerConfigInput,
} from "../../services/automation/src/grid-evolution.js";
import type { PythClient, PreviousCloseResponse, PythPriceFeed } from "../../services/automation/src/clients/pyth.js";
import type { BellMarketsAnchorClient } from "../../services/automation/src/clients/anchor.js";
import type { Ticker } from "../../services/automation/src/types.js";

function makeConfig(over: Partial<AutomationConfig> = {}): AutomationConfig {
  const phoenix: Partial<Record<Ticker, string>> = {};
  const pyth: Partial<Record<Ticker, string>> = {};
  for (const t of ["NVDA", "META", "AAPL", "AMZN", "GOOGL", "MSFT", "TSLA"] as const) {
    phoenix[t] = `Phx${t}11111111111111111111111111111111111111`.slice(0, 44);
    pyth[t] = `Pth${t}11111111111111111111111111111111111111`.slice(0, 44);
  }
  return {
    triggerProjectRef: undefined,
    heliusRpcUrl: "https://test",
    pythHttpBaseUrl: "https://test-pyth",
    bellMarketsProgramId: "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV",
    platformAdminKeypairPath: "/test/admin.json",
    bellMarketsIdlPath: "/test/idl.json",
    usdcDevnetMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    phoenixMarkets: phoenix,
    pythPriceAccounts: pyth,
    ...over,
  };
}

function makeFakePyth(): PythClient {
  return {
    getPreviousClose: vi.fn(async (feed: PythPriceFeed): Promise<PreviousCloseResponse> => ({
      ticker: feed.ticker,
      price: 100,
      expo: -5,
      publishTime: 1748000000,
    })),
  } as unknown as PythClient;
}

function makeFakeAnchorClient(): BellMarketsAnchorClient {
  return {
    opts: { programId: "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getProgram: vi.fn(async () => ({ provider: {} }) as any),
  } as unknown as BellMarketsAnchorClient;
}

function makeReadFn(opts: { override?: Partial<Record<Ticker, number | undefined>> } = {}): ReadTickerConfigFn {
  // Returns a TickerConfig with capCenter 100, default deviation cap per ticker.
  // `opts.override` lets specific tickers return a non-default deviation cap
  // (to test idempotency / already-expanded scenarios).
  return async (_c, ticker) => {
    const override = opts.override?.[ticker];
    return {
      ticker,
      capCenter: 100,
      allowedStrikes: [91, 94, 97, 100, 103, 106, 109],
      deviationCapBps: override ?? TICKER_DEFAULTS[ticker].defaultDeviationCapBps,
      tickSizeUsd: TICKER_DEFAULTS[ticker].strikeTickSizeUsd,
      thresholdBps: TICKER_DEFAULTS[ticker].wildSwingThresholdBps,
      updatedByPhase: "anchor",
    };
  };
}

// ---------------------------------------------------------------------------
// runEarningsCronOnce — branches
// ---------------------------------------------------------------------------

describe("runEarningsCronOnce — skip branches", () => {
  it("skips when runAt is not a trading day", async () => {
    const cfg = makeConfig();
    const outcome = await runEarningsCronOnce({
      runAt: new Date(Date.UTC(2026, 4, 23, 20, 30, 0)), // Saturday
      config: cfg,
      log: () => {},
    });
    expect(outcome.skipped).toBe(true);
    expect(outcome.preExpand).toEqual([]);
    expect(outcome.restore).toEqual([]);
  });

  it("returns stub outcome when BELL_MARKETS_PROGRAM_ID unset", async () => {
    const cfg = makeConfig({ bellMarketsProgramId: undefined });
    const outcome = await runEarningsCronOnce({
      runAt: new Date(Date.UTC(2026, 4, 4, 20, 30, 0)), // Mon
      config: cfg,
      log: () => {},
    });
    expect(outcome.stub).toBe(true);
  });

  it("fast-paths when neither pre-expand nor restore have candidates", async () => {
    // Mon Jun 15 2026 is a quiet day in our calendar.
    const cfg = makeConfig();
    const outcome = await runEarningsCronOnce({
      runAt: new Date(Date.UTC(2026, 5, 15, 20, 30, 0)),
      config: cfg,
      log: () => {},
    });
    expect(outcome.preExpand).toEqual([]);
    expect(outcome.restore).toEqual([]);
  });
});

describe("runEarningsCronOnce — pre-expansion path", () => {
  it("Wed Jan 28 2026 → calls updateTickerConfig for AAPL+GOOGL+AMZN+META with 2500/2500/3000/5000 bps", async () => {
    const cfg = makeConfig();
    const updates: UpdateTickerConfigInput[] = [];
    const updateFn: UpdateTickerConfigFn = async (input) => {
      updates.push(input);
      return { ok: true, txSig: `sig-${input.ticker}-${input.phase}` };
    };

    // Wed Jan 28 2026 16:30 EST → 21:30 UTC
    const outcome = await runEarningsCronOnce({
      runAt: new Date(Date.UTC(2026, 0, 28, 21, 30, 0)),
      config: cfg,
      pythClientFactory: () => makeFakePyth(),
      anchorClientFactory: () => makeFakeAnchorClient(),
      updateTickerConfig: updateFn,
      readTickerConfig: makeReadFn(),
      log: () => {},
    });

    expect(outcome.preExpand).toHaveLength(4);
    const updatedTickers = outcome.preExpand.map((a) => a.ticker).sort();
    expect(updatedTickers).toEqual(["AAPL", "AMZN", "GOOGL", "META"]);
    // All marked "updated" with correct expanded values
    for (const action of outcome.preExpand) {
      expect(action.status).toBe("updated");
      expect(action.action).toBe("pre-expand");
      expect(action.newDeviationCapBps).toBe(EARNINGS_PREEXPAND_BPS[action.ticker]);
    }
    // All updateFn calls have phase="earnings-pre"
    for (const update of updates) {
      expect(update.phase).toBe("earnings-pre");
    }
  });

  it("is idempotent — second run when cap already expanded does nothing", async () => {
    const cfg = makeConfig();
    const updateFn: UpdateTickerConfigFn = vi.fn(async () => ({ ok: true, txSig: "sig" }));

    // Wed Jan 28 → pre-expand AAPL et al. Simulate "already expanded" state.
    const outcome = await runEarningsCronOnce({
      runAt: new Date(Date.UTC(2026, 0, 28, 21, 30, 0)),
      config: cfg,
      pythClientFactory: () => makeFakePyth(),
      anchorClientFactory: () => makeFakeAnchorClient(),
      updateTickerConfig: updateFn,
      readTickerConfig: makeReadFn({
        override: {
          AAPL: EARNINGS_PREEXPAND_BPS.AAPL,
          AMZN: EARNINGS_PREEXPAND_BPS.AMZN,
          GOOGL: EARNINGS_PREEXPAND_BPS.GOOGL,
          META: EARNINGS_PREEXPAND_BPS.META,
        },
      }),
      log: () => {},
    });

    // All 4 should be skipped due to idempotency.
    for (const action of outcome.preExpand) {
      expect(action.status).toBe("skipped");
      expect(action.reason).toContain("already");
    }
    expect(updateFn).not.toHaveBeenCalled();
  });
});

describe("runEarningsCronOnce — restore path", () => {
  it("Fri Jan 30 2026 → calls updateTickerConfig for AAPL+GOOGL+AMZN+META back to defaults", async () => {
    const cfg = makeConfig();
    const updates: UpdateTickerConfigInput[] = [];
    const updateFn: UpdateTickerConfigFn = async (input) => {
      updates.push(input);
      return { ok: true, txSig: `sig-${input.ticker}-${input.phase}` };
    };

    // Fri Jan 30 2026 16:30 EST. Yesterday = Thu Jan 29 = multi-ticker earnings day.
    // Simulate "still expanded" state in the read (so we have something to restore).
    const outcome = await runEarningsCronOnce({
      runAt: new Date(Date.UTC(2026, 0, 30, 21, 30, 0)),
      config: cfg,
      pythClientFactory: () => makeFakePyth(),
      anchorClientFactory: () => makeFakeAnchorClient(),
      updateTickerConfig: updateFn,
      readTickerConfig: makeReadFn({
        override: {
          AAPL: EARNINGS_PREEXPAND_BPS.AAPL,
          AMZN: EARNINGS_PREEXPAND_BPS.AMZN,
          GOOGL: EARNINGS_PREEXPAND_BPS.GOOGL,
          META: EARNINGS_PREEXPAND_BPS.META,
        },
      }),
      log: () => {},
    });

    expect(outcome.restore).toHaveLength(4);
    for (const action of outcome.restore) {
      expect(action.status).toBe("updated");
      expect(action.action).toBe("restore");
      expect(action.newDeviationCapBps).toBe(TICKER_DEFAULTS[action.ticker].defaultDeviationCapBps);
    }
    for (const update of updates) {
      expect(update.phase).toBe("earnings-restore");
    }
  });

  it("Restore skipped (idempotent) when cap already at default", async () => {
    const cfg = makeConfig();
    const updateFn: UpdateTickerConfigFn = vi.fn(async () => ({ ok: true, txSig: "sig" }));

    const outcome = await runEarningsCronOnce({
      runAt: new Date(Date.UTC(2026, 0, 30, 21, 30, 0)),
      config: cfg,
      pythClientFactory: () => makeFakePyth(),
      anchorClientFactory: () => makeFakeAnchorClient(),
      updateTickerConfig: updateFn,
      readTickerConfig: makeReadFn(), // default caps
      log: () => {},
    });

    for (const action of outcome.restore) {
      expect(action.status).toBe("skipped");
      expect(action.reason).toContain("already");
    }
    expect(updateFn).not.toHaveBeenCalled();
  });
});

describe("runEarningsCronOnce — error handling", () => {
  it("captures per-ticker error without aborting", async () => {
    const cfg = makeConfig();
    const updateFn: UpdateTickerConfigFn = async (input) => {
      if (input.ticker === "META") return { ok: false, error: "tx failed" };
      return { ok: true, txSig: `sig-${input.ticker}` };
    };

    const outcome = await runEarningsCronOnce({
      runAt: new Date(Date.UTC(2026, 0, 28, 21, 30, 0)),
      config: cfg,
      pythClientFactory: () => makeFakePyth(),
      anchorClientFactory: () => makeFakeAnchorClient(),
      updateTickerConfig: updateFn,
      readTickerConfig: makeReadFn(),
      log: () => {},
    });

    const meta = outcome.preExpand.find((a) => a.ticker === "META")!;
    expect(meta.status).toBe("errored");
    expect(meta.error).toBe("tx failed");
    const aapl = outcome.preExpand.find((a) => a.ticker === "AAPL")!;
    expect(aapl.status).toBe("updated");
  });

  it("skips ticker when TickerConfig PDA doesn't exist yet", async () => {
    const cfg = makeConfig();
    const readFn: ReadTickerConfigFn = vi.fn(async () => undefined);
    const updateFn: UpdateTickerConfigFn = vi.fn(async () => ({ ok: true, txSig: "sig" }));

    const outcome = await runEarningsCronOnce({
      runAt: new Date(Date.UTC(2026, 0, 28, 21, 30, 0)),
      config: cfg,
      pythClientFactory: () => makeFakePyth(),
      anchorClientFactory: () => makeFakeAnchorClient(),
      updateTickerConfig: updateFn,
      readTickerConfig: readFn,
      log: () => {},
    });

    for (const action of outcome.preExpand) {
      expect(action.status).toBe("skipped");
      expect(action.reason).toContain("does not exist yet");
    }
    expect(updateFn).not.toHaveBeenCalled();
  });
});
