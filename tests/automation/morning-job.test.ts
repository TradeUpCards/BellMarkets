import { describe, it, expect } from "vitest";
import {
  runMorningCreateMarkets,
  scaleStrikeToI64,
  type SendCreateStrikeMarketInput,
  type SendCreateStrikeMarketResult,
} from "../../services/automation/src/jobs/morning.js";
import { loadConfig } from "../../services/automation/src/config.js";
import { BellMarketsAnchorClient } from "../../services/automation/src/clients/anchor.js";
import { PythClient } from "../../services/automation/src/clients/pyth.js";
import type { AutomationConfig } from "../../services/automation/src/config.js";

// Fixed run-at for deterministic logs.
const RUN_AT = new Date(Date.UTC(2026, 4, 22, 12, 0, 0)); // 2026-05-22 12:00 UTC = 08:00 EDT

// A PythClient with .getPreviousClose monkey-patched to return ticker-specific
// canned prices. Avoids constructing a URL-aware fetch fake — the morning job
// only needs the public method to return well-shaped data.
function tickerAwarePyth(prevCloseByTicker: Record<string, number>, expo = -8): PythClient {
  const client = new PythClient({ baseUrl: "https://hermes.example/api", fetchImpl: async () => new Response("{}") });
  (client as unknown as { getPreviousClose: typeof client.getPreviousClose }).getPreviousClose = async (feed) => ({
    ticker: feed.ticker,
    price: prevCloseByTicker[feed.ticker] ?? 100,
    expo,
    publishTime: 1,
  });
  return client;
}

function fakeAnchorClient(): BellMarketsAnchorClient {
  // Inject a programFactory + IDL + keypair so getProgram() never touches disk.
  return new BellMarketsAnchorClient({
    rpcUrl: "https://api.devnet.solana.com",
    programId: "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV",
    keypairPath: "ignored",
    idlPath: "ignored",
    idlOverride: { instructions: [{ name: "noop", accounts: [], args: [] }] } as unknown as import("@coral-xyz/anchor").Idl,
    keypairOverride: { __mock: "kp" } as unknown as import("@solana/web3.js").Keypair,
    programFactory: () => ({ __mock: "program" } as unknown as import("@coral-xyz/anchor").Program<import("@coral-xyz/anchor").Idl>),
  });
}

const FULL_CONFIG: AutomationConfig = {
  triggerProjectRef: "proj_x",
  heliusRpcUrl: "https://api.devnet.solana.com",
  pythHttpBaseUrl: "https://hermes.example/api",
  bellMarketsProgramId: "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV",
  platformAdminKeypairPath: "/k.json",
  bellMarketsIdlPath: "/idl.json",
  usdcDevnetMint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  phoenixMarkets: {
    AAPL: "PhxAAPL11111111111111111111111111111111111",
    MSFT: "PhxMSFT11111111111111111111111111111111111",
    GOOGL: "PhxGOOGL1111111111111111111111111111111111",
    AMZN: "PhxAMZN11111111111111111111111111111111111",
    NVDA: "PhxNVDA11111111111111111111111111111111111",
    META: "PhxMETA11111111111111111111111111111111111",
    TSLA: "PhxTSLA11111111111111111111111111111111111",
  },
  pythPriceAccounts: {
    AAPL: "PyAAPL11111111111111111111111111111111111",
    MSFT: "PyMSFT11111111111111111111111111111111111",
    GOOGL: "PyGOOGL1111111111111111111111111111111111",
    AMZN: "PyAMZN11111111111111111111111111111111111",
    NVDA: "PyNVDA11111111111111111111111111111111111",
    META: "PyMETA11111111111111111111111111111111111",
    TSLA: "PyTSLA11111111111111111111111111111111111",
  },
};

describe("scaleStrikeToI64 — Pyth-feed-native i64 scaling", () => {
  it("scales $230 with expo=-8 to 23_000_000_000n", () => {
    expect(scaleStrikeToI64(230, -8)).toBe(23_000_000_000n);
  });

  it("scales $680 with expo=-8 to 68_000_000_000n", () => {
    expect(scaleStrikeToI64(680, -8)).toBe(68_000_000_000n);
  });

  it("handles expo=0 (integer-only price feeds)", () => {
    expect(scaleStrikeToI64(680, 0)).toBe(680n);
  });

  it("rejects non-finite strikes", () => {
    expect(() => scaleStrikeToI64(NaN, -8)).toThrow();
    expect(() => scaleStrikeToI64(0, -8)).toThrow();
    expect(() => scaleStrikeToI64(-5, -8)).toThrow();
  });

  it("rejects non-integer expo", () => {
    expect(() => scaleStrikeToI64(230, -8.5)).toThrow();
  });
});

describe("runMorningCreateMarkets — stub branch", () => {
  it("when BELL_MARKETS_PROGRAM_ID is unset, returns stub:true with all tickers skipped", async () => {
    const logEntries: Record<string, unknown>[] = [];
    const outcome = await runMorningCreateMarkets({
      runAt: RUN_AT,
      ctxRunId: "test-run-id",
      config: loadConfig({}),
      log: (e) => logEntries.push(e),
    });
    expect(outcome.stub).toBe(true);
    expect(outcome.perTicker).toHaveLength(7);
    expect(outcome.perTicker.every((t) => t.status === "skipped")).toBe(true);
    expect(logEntries[0]?.stub).toBe(true);
  });
});

describe("runMorningCreateMarkets — live branch with injected deps", () => {
  it("calls sendCreateStrikeMarketTx for each unique strike per ticker, collecting tx sigs", async () => {
    const sent: SendCreateStrikeMarketInput[] = [];
    const logEntries: Record<string, unknown>[] = [];

    const outcome = await runMorningCreateMarkets({
      runAt: RUN_AT,
      ctxRunId: "test-run-id",
      config: FULL_CONFIG,
      pythClientFactory: () =>
        tickerAwarePyth({
          AAPL: 230,
          MSFT: 437.5,
          GOOGL: 175,
          AMZN: 188,
          NVDA: 970,
          META: 680,
          TSLA: 245,
        }),
      anchorClientFactory: () => fakeAnchorClient(),
      sendCreateStrikeMarketTx: async (input): Promise<SendCreateStrikeMarketResult> => {
        sent.push(input);
        return { ok: true, txSig: `sig-${input.ticker}-${input.strikeUsd}` };
      },
      log: (e) => logEntries.push(e),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.stub).toBeUndefined();
    expect(outcome.perTicker).toHaveLength(7);
    expect(outcome.perTicker.every((t) => t.status === "submitted")).toBe(true);

    // Every ticker has at least one strike submitted (META → 7 unique strikes per PRD)
    const meta = outcome.perTicker.find((t) => t.ticker === "META");
    expect(meta?.txSigs?.length).toBe(meta?.strikes?.length);
    expect(meta?.strikes).toEqual([620, 640, 660, 680, 700, 720, 740]);

    // PDA inputs to sendTx are well-formed: scaled to i64, expiry today @ 20:00 UTC.
    const metaSends = sent.filter((s) => s.ticker === "META");
    expect(metaSends[0]?.expiryUnix).toBe(Math.floor(Date.UTC(2026, 4, 22, 20, 0, 0) / 1000));
    expect(metaSends[0]?.strikePriceI64).toBe(scaleStrikeToI64(metaSends[0]?.strikeUsd ?? 0, -8));
  });

  it("skips a ticker whose PHOENIX_MARKET_<T> is unset, without aborting the batch", async () => {
    const sent: SendCreateStrikeMarketInput[] = [];
    const cfg: AutomationConfig = {
      ...FULL_CONFIG,
      phoenixMarkets: { ...FULL_CONFIG.phoenixMarkets, NVDA: undefined },
    };
    const outcome = await runMorningCreateMarkets({
      runAt: RUN_AT,
      config: cfg,
      pythClientFactory: () => tickerAwarePyth({}),
      anchorClientFactory: () => fakeAnchorClient(),
      sendCreateStrikeMarketTx: async (input) => {
        sent.push(input);
        return { ok: true, txSig: "ok" };
      },
      log: () => {
        /* noop */
      },
    });
    const nvda = outcome.perTicker.find((t) => t.ticker === "NVDA");
    expect(nvda?.status).toBe("skipped");
    expect(nvda?.reason).toMatch(/Phoenix/);
    expect(sent.every((s) => s.ticker !== "NVDA")).toBe(true);
    // Other tickers still went through.
    expect(sent.some((s) => s.ticker === "META")).toBe(true);
  });

  it("skips a ticker whose PYTH_PRICE_ACCOUNT_<T> is unset", async () => {
    const cfg: AutomationConfig = { ...FULL_CONFIG, pythPriceAccounts: {} };
    const outcome = await runMorningCreateMarkets({
      runAt: RUN_AT,
      config: cfg,
      pythClientFactory: () => tickerAwarePyth({ META: 680 }),
      anchorClientFactory: () => fakeAnchorClient(),
      sendCreateStrikeMarketTx: async () => ({ ok: true, txSig: "shouldnt-happen" }),
      log: () => {
        /* noop */
      },
    });
    expect(outcome.perTicker.every((t) => t.status === "skipped")).toBe(true);
    expect(outcome.perTicker.find((t) => t.ticker === "META")?.reason).toMatch(/Pyth/);
  });

  it("continues across per-strike send failures and records errors per ticker", async () => {
    let n = 0;
    const sent: SendCreateStrikeMarketInput[] = [];
    const cfg: AutomationConfig = {
      ...FULL_CONFIG,
      // Force one ticker (META) by clearing all other Phoenix entries; keep
      // Pyth devnet accounts dense so META survives the price-account check.
      phoenixMarkets: { META: "PhxMETA1111111111111111111111111111111111" },
    };
    const outcome = await runMorningCreateMarkets({
      runAt: RUN_AT,
      config: cfg,
      pythClientFactory: () => tickerAwarePyth({ META: 680 }),
      anchorClientFactory: () => fakeAnchorClient(),
      sendCreateStrikeMarketTx: async (input) => {
        sent.push(input);
        n += 1;
        if (n === 2) return { ok: false, error: "RPC 503 (synthetic)" };
        return { ok: true, txSig: `sig-${n}` };
      },
      log: () => {
        /* noop */
      },
    });
    // Other 6 MAG7 tickers were Phoenix-unset so they skip; META should error
    // overall (one bad strike) but still have 5 successful tx sigs.
    const meta = outcome.perTicker.find((t) => t.ticker === "META");
    expect(meta?.status).toBe("errored");
    expect(meta?.txSigs?.length).toBe((meta?.strikes?.length ?? 0) - 1);
    expect(meta?.errors?.[0]).toMatch(/RPC 503/);
  });
});
