import { describe, it, expect, vi } from "vitest";
import {
  runAnchorPhase,
  runWildSwingPhase,
  isInPhaseWindow,
  isRegularTradingDay,
  type UpdateTickerConfigFn,
  type ReadTickerConfigFn,
  type UpdateTickerConfigInput,
} from "../../services/automation/src/grid-evolution.js";
import { TICKER_DEFAULTS } from "../../services/automation/src/ticker-config.js";
import type { AutomationConfig } from "../../services/automation/src/config.js";
import type { PythClient, PreviousCloseResponse, PythPriceFeed } from "../../services/automation/src/clients/pyth.js";
import type { BellMarketsAnchorClient } from "../../services/automation/src/clients/anchor.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeConfig(over: Partial<AutomationConfig> = {}): AutomationConfig {
  return {
    triggerProjectRef: undefined,
    heliusRpcUrl: "https://test",
    pythHttpBaseUrl: "https://test-pyth",
    bellMarketsProgramId: "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV",
    platformAdminKeypairPath: "/test/admin.json",
    bellMarketsIdlPath: "/test/idl.json",
    usdcDevnetMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    phoenixMarkets: {
      META: "CS2H8nbAVVEUHWPF5extCSymqheQdkd4d7thik6eet9N",
      AAPL: "PhoenixAAPL11111111111111111111111111111111",
    },
    pythPriceAccounts: {
      META: "J83w4HKfFqVghYYjAYTQTzAQ9QQbpDgN1qmcQxk8q1QH",
      AAPL: "PythAAPL1111111111111111111111111111111111",
    },
    ...over,
  };
}

function makeFakePyth(prices: Partial<Record<string, number>>): PythClient {
  return {
    getPreviousClose: vi.fn(async (feed: PythPriceFeed): Promise<PreviousCloseResponse> => {
      const price = prices[feed.ticker];
      if (price === undefined) throw new Error(`no fake price for ${feed.ticker}`);
      return {
        ticker: feed.ticker,
        price,
        expo: -5, // META real Hermes expo from Day-4
        publishTime: 1748000000,
      };
    }),
  } as unknown as PythClient;
}

function makeFakeAnchorClient(): BellMarketsAnchorClient {
  // grid-evolution.ts only calls .getProgram() during initClients(). For
  // tests that inject updateFn / readFn, the Program object itself is never
  // dereferenced. We return a stub that resolves the preflight call.
  return {
    opts: { programId: "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getProgram: vi.fn(async () => ({ provider: {} }) as any),
  } as unknown as BellMarketsAnchorClient;
}

// ---------------------------------------------------------------------------
// isInPhaseWindow — ET-time gating
// ---------------------------------------------------------------------------

describe("isInPhaseWindow — DR-006 ET wall-clock gating", () => {
  it("AH: 16:30 ET is IN window (Mon May 4 2026 EDT)", () => {
    // 16:30 EDT = 20:30 UTC
    const date = new Date(Date.UTC(2026, 4, 4, 20, 30, 0));
    expect(isInPhaseWindow(date, "ah")).toBe(true);
  });

  it("AH: 16:00 ET is OUT of window (before 16:30)", () => {
    const date = new Date(Date.UTC(2026, 4, 4, 20, 0, 0)); // 16:00 EDT
    expect(isInPhaseWindow(date, "ah")).toBe(false);
  });

  it("AH: 20:00 ET is IN window (boundary closed)", () => {
    const date = new Date(Date.UTC(2026, 4, 4, 24 % 24, 0, 0)); // 20:00 EDT = 00:00 UTC next day
    // 20:00 EDT = 24:00 UTC = 00:00 next-day UTC
    const date2 = new Date(Date.UTC(2026, 4, 5, 0, 0, 0));
    expect(isInPhaseWindow(date2, "ah")).toBe(true);
  });

  it("AH: 20:30 ET is OUT of window (past 20:00)", () => {
    const date = new Date(Date.UTC(2026, 4, 5, 0, 30, 0)); // 20:30 EDT = 00:30 UTC next day
    expect(isInPhaseWindow(date, "ah")).toBe(false);
  });

  it("AH: returns false on weekend", () => {
    const sat = new Date(Date.UTC(2026, 4, 23, 20, 30, 0)); // Sat 16:30 EDT
    expect(isInPhaseWindow(sat, "ah")).toBe(false);
  });

  it("PM: 04:00 ET is IN window (boundary open)", () => {
    const date = new Date(Date.UTC(2026, 4, 4, 8, 0, 0)); // 04:00 EDT
    expect(isInPhaseWindow(date, "pm")).toBe(true);
  });

  it("PM: 09:00 ET is IN window (boundary closed)", () => {
    const date = new Date(Date.UTC(2026, 4, 4, 13, 0, 0)); // 09:00 EDT
    expect(isInPhaseWindow(date, "pm")).toBe(true);
  });

  it("PM: 09:30 ET is OUT of window (past 09:00)", () => {
    const date = new Date(Date.UTC(2026, 4, 4, 13, 30, 0));
    expect(isInPhaseWindow(date, "pm")).toBe(false);
  });

  it("PM: 03:59 ET is OUT of window (before 04:00)", () => {
    const date = new Date(Date.UTC(2026, 4, 4, 7, 59, 0));
    expect(isInPhaseWindow(date, "pm")).toBe(false);
  });

  it("Handles DST correctly — Phase 2 at 16:30 EST (Nov 16 2026 = post-DST)", () => {
    // 16:30 EST = 21:30 UTC
    const date = new Date(Date.UTC(2026, 10, 16, 21, 30, 0));
    expect(isInPhaseWindow(date, "ah")).toBe(true);
  });
});

describe("isRegularTradingDay", () => {
  it("Mon May 4 2026 (regular) → true", () => {
    expect(isRegularTradingDay(new Date(Date.UTC(2026, 4, 4, 12, 0, 0)))).toBe(true);
  });

  it("Fri Nov 27 2026 (half-day) → false (Phase 1b handles)", () => {
    expect(isRegularTradingDay(new Date(Date.UTC(2026, 10, 27, 12, 0, 0)))).toBe(false);
  });

  it("Sat May 23 2026 (weekend) → false", () => {
    expect(isRegularTradingDay(new Date(Date.UTC(2026, 4, 23, 12, 0, 0)))).toBe(false);
  });

  it("Mon May 25 2026 (Memorial Day full holiday) → false", () => {
    expect(isRegularTradingDay(new Date(Date.UTC(2026, 4, 25, 12, 0, 0)))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runAnchorPhase — Phase 1 / 1b
// ---------------------------------------------------------------------------

describe("runAnchorPhase — stub branch (no program id)", () => {
  it("returns stubbed perTicker outcomes when BELL_MARKETS_PROGRAM_ID unset", async () => {
    const cfg = makeConfig({ bellMarketsProgramId: undefined });
    const outcome = await runAnchorPhase({ runAt: new Date(), config: cfg });
    expect(outcome.stub).toBe(true);
    expect(outcome.perTicker).toHaveLength(7);
    expect(outcome.perTicker.every((t) => t.status === "stubbed")).toBe(true);
  });
});

describe("runAnchorPhase — live branch with injected deps", () => {
  it("calls updateTickerConfig per ticker that has Pyth+Phoenix configured", async () => {
    const cfg = makeConfig();
    const fakePyth = makeFakePyth({ META: 610, AAPL: 230 });
    const updateCalls: UpdateTickerConfigInput[] = [];
    const updateFn: UpdateTickerConfigFn = async (input) => {
      updateCalls.push(input);
      return { ok: true, txSig: `sig-${input.ticker}` };
    };

    const outcome = await runAnchorPhase({
      runAt: new Date(Date.UTC(2026, 4, 4, 20, 5, 0)), // Mon 16:05 EDT
      config: cfg,
      pythClientFactory: () => fakePyth,
      anchorClientFactory: () => makeFakeAnchorClient(),
      updateTickerConfig: updateFn,
      log: () => {},
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.phase).toBe("anchor");
    // Only META + AAPL have Pyth+Phoenix configured in our fixture
    const updated = outcome.perTicker.filter((t) => t.status === "updated");
    expect(updated.map((t) => t.ticker).sort()).toEqual(["AAPL", "META"]);
    // The other 5 tickers skipped
    const skipped = outcome.perTicker.filter((t) => t.status === "skipped");
    expect(skipped).toHaveLength(5);
    // updateFn called with correct shapes
    expect(updateCalls).toHaveLength(2);
    const metaCall = updateCalls.find((c) => c.ticker === "META")!;
    expect(metaCall.capCenter).toBe(610);
    expect(metaCall.allowedStrikes).toEqual([555, 575, 590, 610, 630, 645, 665]);
    expect(metaCall.deviationCapBps).toBe(TICKER_DEFAULTS.META.defaultDeviationCapBps);
    expect(metaCall.tickSizeUsd).toBe(TICKER_DEFAULTS.META.strikeTickSizeUsd);
    expect(metaCall.phase).toBe("anchor");
    expect(metaCall.expiryUnix).toBeDefined();
  });

  it("anchors expiry to NEXT trading day's close (Mon → Tue 16:00 ET)", async () => {
    const cfg = makeConfig();
    const fakePyth = makeFakePyth({ META: 610, AAPL: 230 });
    const updateCalls: UpdateTickerConfigInput[] = [];
    const updateFn: UpdateTickerConfigFn = async (input) => {
      updateCalls.push(input);
      return { ok: true, txSig: `sig-${input.ticker}` };
    };

    // Mon May 4 2026 16:05 EDT → expiry should be Tue May 5 16:00 EDT = 20:00 UTC
    const outcome = await runAnchorPhase({
      runAt: new Date(Date.UTC(2026, 4, 4, 20, 5, 0)),
      config: cfg,
      pythClientFactory: () => fakePyth,
      anchorClientFactory: () => makeFakeAnchorClient(),
      updateTickerConfig: updateFn,
      log: () => {},
    });

    expect(outcome.anchoredExpiryIso).toBe("2026-05-05T20:00:00.000Z");
    expect(updateCalls[0]!.expiryUnix).toBe(Math.floor(Date.UTC(2026, 4, 5, 20, 0, 0) / 1000));
  });

  it("anchors expiry across Memorial Day weekend (Fri → Tue, skipping Mon holiday)", async () => {
    const cfg = makeConfig();
    const fakePyth = makeFakePyth({ META: 610, AAPL: 230 });
    const updateFn: UpdateTickerConfigFn = vi.fn(async () => ({ ok: true, txSig: "sig" }));

    // Fri May 22 2026 16:05 EDT → next trading day is Tue May 26 (skip Sat/Sun/Mon Memorial Day)
    const outcome = await runAnchorPhase({
      runAt: new Date(Date.UTC(2026, 4, 22, 20, 5, 0)),
      config: cfg,
      pythClientFactory: () => fakePyth,
      anchorClientFactory: () => makeFakeAnchorClient(),
      updateTickerConfig: updateFn,
      log: () => {},
    });

    expect(outcome.anchoredExpiryIso).toBe("2026-05-26T20:00:00.000Z");
  });

  it("anchors to half-day close (Wed → Fri Nov 27 1:00 PM ET, day-after-Thanksgiving)", async () => {
    const cfg = makeConfig();
    const fakePyth = makeFakePyth({ META: 610, AAPL: 230 });
    const updateFn: UpdateTickerConfigFn = vi.fn(async () => ({ ok: true, txSig: "sig" }));

    // Wed Nov 25 2026 16:05 EST → next trading day is Fri Nov 27 (skip Thanksgiving Thu)
    // Nov 27 is a HALF-DAY → close at 1 PM EST = 18:00 UTC
    const outcome = await runAnchorPhase({
      runAt: new Date(Date.UTC(2026, 10, 25, 21, 5, 0)),
      config: cfg,
      pythClientFactory: () => fakePyth,
      anchorClientFactory: () => makeFakeAnchorClient(),
      updateTickerConfig: updateFn,
      log: () => {},
    });

    expect(outcome.anchoredExpiryIso).toBe("2026-11-27T18:00:00.000Z");
  });

  it("captures updateFn errors per-ticker without aborting the run", async () => {
    const cfg = makeConfig();
    const fakePyth = makeFakePyth({ META: 610, AAPL: 230 });
    const updateFn: UpdateTickerConfigFn = async (input) => {
      if (input.ticker === "META") return { ok: false, error: "IDL missing updateTickerConfig" };
      return { ok: true, txSig: `sig-${input.ticker}` };
    };

    const outcome = await runAnchorPhase({
      runAt: new Date(Date.UTC(2026, 4, 4, 20, 5, 0)),
      config: cfg,
      pythClientFactory: () => fakePyth,
      anchorClientFactory: () => makeFakeAnchorClient(),
      updateTickerConfig: updateFn,
      log: () => {},
    });

    const meta = outcome.perTicker.find((t) => t.ticker === "META")!;
    expect(meta.status).toBe("errored");
    expect(meta.error).toContain("IDL missing");
    const aapl = outcome.perTicker.find((t) => t.ticker === "AAPL")!;
    expect(aapl.status).toBe("updated");
  });
});

// ---------------------------------------------------------------------------
// runWildSwingPhase — Phase 2 / 3
// ---------------------------------------------------------------------------

describe("runWildSwingPhase — out-of-window early exit", () => {
  it("skips entire run if outside ET wall-clock window", async () => {
    const cfg = makeConfig();
    const outcome = await runWildSwingPhase({
      phase: "ah",
      runAt: new Date(Date.UTC(2026, 4, 4, 12, 0, 0)), // 08:00 EDT — outside AH window
      config: cfg,
      log: () => {},
    });
    expect(outcome.perTicker).toEqual([]);
  });
});

describe("runWildSwingPhase — drift-detection logic with injected deps", () => {
  it("no-drift status when |spot - capCenter| ≤ threshold", async () => {
    // META threshold = 800 bps (8%). Drift of 2% → no expansion.
    const cfg = makeConfig();
    const fakePyth = makeFakePyth({ META: 622, AAPL: 232 });
    const fakeRead: ReadTickerConfigFn = async (_c, ticker) => ({
      ticker,
      capCenter: ticker === "META" ? 610 : 230, // META drift = 197 bps; AAPL drift = 87 bps
      allowedStrikes: [555, 575, 590, 610, 630, 645, 665],
      deviationCapBps: TICKER_DEFAULTS[ticker].defaultDeviationCapBps,
      tickSizeUsd: TICKER_DEFAULTS[ticker].strikeTickSizeUsd,
      thresholdBps: TICKER_DEFAULTS[ticker].wildSwingThresholdBps,
      updatedByPhase: "anchor",
    });
    const updateFn: UpdateTickerConfigFn = vi.fn(async () => ({ ok: true, txSig: "sig" }));

    const outcome = await runWildSwingPhase({
      phase: "ah",
      runAt: new Date(Date.UTC(2026, 4, 4, 21, 0, 0)), // 17:00 EDT in AH window
      config: cfg,
      pythClientFactory: () => fakePyth,
      anchorClientFactory: () => makeFakeAnchorClient(),
      updateTickerConfig: updateFn,
      readTickerConfig: fakeRead,
      log: () => {},
    });

    const meta = outcome.perTicker.find((t) => t.ticker === "META")!;
    expect(meta.status).toBe("no-drift");
    expect(meta.driftBps).toBeLessThanOrEqual(TICKER_DEFAULTS.META.wildSwingThresholdBps);
    expect(updateFn).not.toHaveBeenCalled();
  });

  it("expands grid when drift > threshold", async () => {
    // META capCenter 610, new spot 700 → drift ~1475 bps > 800 bps threshold
    const cfg = makeConfig();
    const fakePyth = makeFakePyth({ META: 700, AAPL: 230 });
    const existing = [555, 575, 590, 610, 630, 645, 665];
    const fakeRead: ReadTickerConfigFn = async (_c, ticker) => ({
      ticker,
      capCenter: ticker === "META" ? 610 : 230,
      allowedStrikes: ticker === "META" ? existing : [225, 230, 235],
      deviationCapBps: TICKER_DEFAULTS[ticker].defaultDeviationCapBps,
      tickSizeUsd: TICKER_DEFAULTS[ticker].strikeTickSizeUsd,
      thresholdBps: TICKER_DEFAULTS[ticker].wildSwingThresholdBps,
      updatedByPhase: "anchor",
    });
    const updateCalls: UpdateTickerConfigInput[] = [];
    const updateFn: UpdateTickerConfigFn = async (input) => {
      updateCalls.push(input);
      return { ok: true, txSig: `sig-${input.ticker}` };
    };

    const outcome = await runWildSwingPhase({
      phase: "ah",
      runAt: new Date(Date.UTC(2026, 4, 4, 21, 0, 0)),
      config: cfg,
      pythClientFactory: () => fakePyth,
      anchorClientFactory: () => makeFakeAnchorClient(),
      updateTickerConfig: updateFn,
      readTickerConfig: fakeRead,
      log: () => {},
    });

    const meta = outcome.perTicker.find((t) => t.ticker === "META")!;
    expect(meta.status).toBe("updated");
    expect(meta.capCenter).toBe(700); // re-centered on new spot
    // Existing 555-665 strikes preserved; new strikes around 700 added.
    expect(meta.allowedStrikes).toContain(555);
    expect(meta.allowedStrikes).toContain(700);
    expect(meta.allowedStrikes).toContain(665);
    const metaCall = updateCalls.find((c) => c.ticker === "META")!;
    expect(metaCall.phase).toBe("ah");
  });

  it("skips ticker when TickerConfig PDA doesn't exist (anchor not run yet)", async () => {
    const cfg = makeConfig();
    const fakePyth = makeFakePyth({ META: 610, AAPL: 230 });
    const fakeRead: ReadTickerConfigFn = vi.fn(async () => undefined);

    const outcome = await runWildSwingPhase({
      phase: "pm",
      runAt: new Date(Date.UTC(2026, 4, 4, 13, 0, 0)), // 09:00 EDT in PM window (boundary)
      config: cfg,
      pythClientFactory: () => fakePyth,
      anchorClientFactory: () => makeFakeAnchorClient(),
      updateTickerConfig: vi.fn(),
      readTickerConfig: fakeRead,
      log: () => {},
    });

    const meta = outcome.perTicker.find((t) => t.ticker === "META")!;
    expect(meta.status).toBe("skipped");
    expect(meta.reason).toContain("does not exist yet");
  });
});
