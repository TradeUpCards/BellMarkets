import { describe, it, expect } from "vitest";
import {
  runSettlementNudger,
  defaultShouldRetry,
  SETTLE_RETRY_INTERVAL_MS,
  SETTLE_RETRY_DEADLINE_MS,
  type OpenMarketRef,
} from "../../services/automation/src/jobs/settlement.js";
import { loadConfig, type AutomationConfig } from "../../services/automation/src/config.js";
import { BellMarketsAnchorClient } from "../../services/automation/src/clients/anchor.js";

const RUN_AT = new Date(Date.UTC(2026, 4, 22, 21, 5, 0)); // 2026-05-22 21:05 UTC = 4:05pm EDT

function makeFakeClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function fakeAnchorClient(): BellMarketsAnchorClient {
  return new BellMarketsAnchorClient({
    rpcUrl: "https://api.devnet.solana.com",
    programId: "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV",
    keypairPath: "ignored",
    idlPath: "ignored",
    idlOverride: {
      instructions: [{ name: "settleMarket", accounts: [], args: [] }],
    } as unknown as import("@coral-xyz/anchor").Idl,
    keypairOverride: { __mock: "kp" } as unknown as import("@solana/web3.js").Keypair,
    programFactory: () =>
      ({ __mock: "program" }) as unknown as import("@coral-xyz/anchor").Program<
        import("@coral-xyz/anchor").Idl
      >,
  });
}

const FULL_CONFIG: AutomationConfig = {
  triggerProjectRef: undefined,
  heliusRpcUrl: "https://api.devnet.solana.com",
  pythHttpBaseUrl: "https://hermes.example/api",
  bellMarketsProgramId: "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV",
  platformAdminKeypairPath: "/k.json",
  bellMarketsIdlPath: "/idl.json",
  usdcDevnetMint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  phoenixMarkets: {},
  pythPriceAccounts: {},
};

const OPEN_MARKETS: OpenMarketRef[] = [
  {
    pubkey: "Mkt1AAPL11111111111111111111111111111111111",
    ticker: "AAPL",
    expiryUnix: 1716_400_000,
    underlyingPythFeed: "PyAAPL11111111111111111111111111111111111",
  },
  {
    pubkey: "Mkt2META11111111111111111111111111111111111",
    ticker: "META",
    expiryUnix: 1716_400_000,
    underlyingPythFeed: "PyMETA11111111111111111111111111111111111",
  },
];

describe("defaultShouldRetry — PRD retry policy", () => {
  it("retries on Anchor PythConfidenceTooWide errors", () => {
    const err = { error: { errorCode: { code: "PythConfidenceTooWide", number: 6010 } } };
    expect(defaultShouldRetry(err)).toBe(true);
  });

  it("retries on Anchor PythStale errors", () => {
    const err = { error: { errorCode: { code: "PythStale", number: 6009 } } };
    expect(defaultShouldRetry(err)).toBe(true);
  });

  it("does NOT retry on AlreadySettled (success state — someone else cranked)", () => {
    const err = { error: { errorCode: { code: "AlreadySettled", number: 6002 } } };
    expect(defaultShouldRetry(err)).toBe(false);
  });

  it("does NOT retry on NotExpired (premature call)", () => {
    const err = { error: { errorCode: { code: "NotExpired", number: 6003 } } };
    expect(defaultShouldRetry(err)).toBe(false);
  });

  it("does NOT retry on PhoenixBadMagic / PythFeedMismatch (config errors)", () => {
    const a = { error: { errorCode: { code: "PhoenixBadMagic" } } };
    const b = { error: { errorCode: { code: "PythFeedMismatch" } } };
    expect(defaultShouldRetry(a)).toBe(false);
    expect(defaultShouldRetry(b)).toBe(false);
  });

  it("retries on generic 503 / timeout / network errors", () => {
    expect(defaultShouldRetry(new Error("RPC 503 from devnet"))).toBe(true);
    expect(defaultShouldRetry(new Error("request timeout"))).toBe(true);
    expect(defaultShouldRetry(new Error("network unreachable"))).toBe(true);
  });

  it("retries on `TypeError: fetch failed` (Node fetch transient blip)", () => {
    // Real error observed 2026-05-24 in live settle:once — Node fetch fails
    // on TCP reset / TLS handshake / DNS hiccup. See
    // .project/.../settle-real-time-evidence.md for the bug-report context.
    expect(defaultShouldRetry(new TypeError("fetch failed"))).toBe(true);
  });

  it("retries on `failed to get recent blockhash` (Connection.getRecentBlockhash transient)", () => {
    // Web3.js wraps fetch failures during getRecentBlockhash with this prefix.
    // Same root cause as fetch-failed; treat as retriable.
    expect(
      defaultShouldRetry(
        new Error("failed to get recent blockhash: TypeError: fetch failed"),
      ),
    ).toBe(true);
  });

  it("does NOT retry on arbitrary unknown errors", () => {
    expect(defaultShouldRetry(new Error("something exploded"))).toBe(false);
    expect(defaultShouldRetry("string error")).toBe(false);
    expect(defaultShouldRetry(null)).toBe(false);
  });
});

describe("runSettlementNudger — stub branch", () => {
  it("when BELL_MARKETS_PROGRAM_ID unset, returns stub:true with empty perMarket", async () => {
    const logs: Record<string, unknown>[] = [];
    const outcome = await runSettlementNudger({
      runAt: RUN_AT,
      config: loadConfig({}),
      log: (e) => logs.push(e),
    });
    expect(outcome.stub).toBe(true);
    expect(outcome.perMarket).toEqual([]);
    expect(logs[0]?.stub).toBe(true);
  });
});

describe("runSettlementNudger — live branch with injected deps", () => {
  it("settles each open market on first attempt", async () => {
    const clock = makeFakeClock();
    const calls: OpenMarketRef[] = [];
    const outcome = await runSettlementNudger({
      runAt: RUN_AT,
      config: FULL_CONFIG,
      anchorClientFactory: () => fakeAnchorClient(),
      listOpenMarkets: async () => OPEN_MARKETS,
      settleMarketTx: async (_client, market) => {
        calls.push(market);
        return `sig-${market.ticker}`;
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(calls).toHaveLength(2);
    expect(outcome.perMarket).toHaveLength(2);
    expect(outcome.perMarket.every((m) => m.status === "settled")).toBe(true);
    expect(outcome.perMarket.find((m) => m.ticker === "AAPL")?.txSig).toBe("sig-AAPL");
    expect(outcome.perMarket.every((m) => m.attempts === 1)).toBe(true);
  });

  it("returns ok with empty perMarket when no markets are open", async () => {
    const outcome = await runSettlementNudger({
      runAt: RUN_AT,
      config: FULL_CONFIG,
      anchorClientFactory: () => fakeAnchorClient(),
      listOpenMarkets: async () => [],
      settleMarketTx: async () => {
        throw new Error("shouldn't be called");
      },
    });
    expect(outcome.perMarket).toEqual([]);
  });

  it("retries on PythConfidenceTooWide and eventually settles", async () => {
    const clock = makeFakeClock();
    let attempt = 0;
    const outcome = await runSettlementNudger({
      runAt: RUN_AT,
      config: FULL_CONFIG,
      anchorClientFactory: () => fakeAnchorClient(),
      listOpenMarkets: async () => [OPEN_MARKETS[0]!],
      settleMarketTx: async () => {
        attempt++;
        if (attempt < 3) throw { error: { errorCode: { code: "PythConfidenceTooWide" } } };
        return "sig-after-3";
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    const aapl = outcome.perMarket[0]!;
    expect(aapl.status).toBe("settled");
    expect(aapl.txSig).toBe("sig-after-3");
    expect(aapl.attempts).toBe(3);
    expect(aapl.elapsedMs).toBe(2 * SETTLE_RETRY_INTERVAL_MS);
  });

  it("exhausts after 15min on persistent PythConfidenceTooWide", async () => {
    const clock = makeFakeClock();
    const outcome = await runSettlementNudger({
      runAt: RUN_AT,
      config: FULL_CONFIG,
      anchorClientFactory: () => fakeAnchorClient(),
      listOpenMarkets: async () => [OPEN_MARKETS[0]!],
      settleMarketTx: async () => {
        throw { error: { errorCode: { code: "PythConfidenceTooWide" } } };
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    const aapl = outcome.perMarket[0]!;
    expect(aapl.status).toBe("exhausted");
    // 15min / 30s = 30 attempts before the deadline cutoff
    expect(aapl.attempts).toBe(SETTLE_RETRY_DEADLINE_MS / SETTLE_RETRY_INTERVAL_MS);
    expect(aapl.lastError).toContain("PythConfidenceTooWide");
  });

  it("aborts immediately on non-retriable (AlreadySettled — someone else cranked)", async () => {
    const clock = makeFakeClock();
    let attempts = 0;
    const outcome = await runSettlementNudger({
      runAt: RUN_AT,
      config: FULL_CONFIG,
      anchorClientFactory: () => fakeAnchorClient(),
      listOpenMarkets: async () => [OPEN_MARKETS[0]!],
      settleMarketTx: async () => {
        attempts++;
        throw { error: { errorCode: { code: "AlreadySettled" } } };
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    const aapl = outcome.perMarket[0]!;
    expect(aapl.status).toBe("non-retriable-error");
    expect(aapl.attempts).toBe(1);
    expect(attempts).toBe(1);
    expect(aapl.lastError).toContain("AlreadySettled");
  });

  it("retries each market independently — one exhausts, the next still tries", async () => {
    const clock = makeFakeClock();
    let metaAttempt = 0;
    const outcome = await runSettlementNudger({
      runAt: RUN_AT,
      config: FULL_CONFIG,
      anchorClientFactory: () => fakeAnchorClient(),
      listOpenMarkets: async () => OPEN_MARKETS,
      settleMarketTx: async (_client, market) => {
        if (market.ticker === "AAPL") {
          throw { error: { errorCode: { code: "PythConfidenceTooWide" } } };
        }
        metaAttempt++;
        if (metaAttempt < 2) throw { error: { errorCode: { code: "PythStale" } } };
        return `sig-${market.ticker}`;
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    const aapl = outcome.perMarket.find((m) => m.ticker === "AAPL")!;
    const meta = outcome.perMarket.find((m) => m.ticker === "META")!;
    expect(aapl.status).toBe("exhausted");
    expect(meta.status).toBe("settled");
    expect(meta.txSig).toBe("sig-META");
    expect(meta.attempts).toBe(2);
  });
});
