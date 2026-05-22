import { describe, it, expect } from "vitest";
import {
  loadConfig,
  requireConfig,
  MissingConfigError,
  computeExpiryUnixFor4pmETSameDay,
} from "../../services/automation/src/config.js";

describe("loadConfig", () => {
  it("maps env vars to AutomationConfig fields (Day-2 names)", () => {
    const env: NodeJS.ProcessEnv = {
      TRIGGER_PROJECT_REF: "proj_x",
      HELIUS_DEVNET_RPC_URL: "https://devnet.example/rpc",
      PYTH_HTTP_BASE_URL: "https://hermes.example/api",
      BELL_MARKETS_PROGRAM_ID: "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV",
      PLATFORM_ADMIN_KEYPAIR_PATH: "/tmp/admin.json",
      BELL_MARKETS_IDL_PATH: "src/idl/bell_markets.json",
      USDC_DEVNET_MINT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      PHOENIX_MARKET_META: "META_PHOENIX_MKT_PUBKEY",
      PHOENIX_MARKET_AAPL: "AAPL_PHOENIX_MKT_PUBKEY",
      PYTH_PRICE_ACCOUNT_META: "META_PYTH_DEVNET_PUBKEY",
      PYTH_PRICE_ACCOUNT_AAPL: "AAPL_PYTH_DEVNET_PUBKEY",
    };
    const c = loadConfig(env);
    expect(c.triggerProjectRef).toBe("proj_x");
    expect(c.heliusRpcUrl).toBe("https://devnet.example/rpc");
    expect(c.pythHttpBaseUrl).toBe("https://hermes.example/api");
    expect(c.bellMarketsProgramId).toBe("599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV");
    expect(c.platformAdminKeypairPath).toBe("/tmp/admin.json");
    expect(c.bellMarketsIdlPath).toBe("src/idl/bell_markets.json");
    expect(c.usdcDevnetMint).toBe("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
    expect(c.phoenixMarkets.META).toBe("META_PHOENIX_MKT_PUBKEY");
    expect(c.phoenixMarkets.AAPL).toBe("AAPL_PHOENIX_MKT_PUBKEY");
    expect(c.phoenixMarkets.NVDA).toBeUndefined();
    expect(c.pythPriceAccounts.META).toBe("META_PYTH_DEVNET_PUBKEY");
    expect(c.pythPriceAccounts.AAPL).toBe("AAPL_PYTH_DEVNET_PUBKEY");
    expect(c.pythPriceAccounts.NVDA).toBeUndefined();
  });

  it("treats empty string as unset (PHOENIX_MARKET_* / PYTH_PRICE_ACCOUNT_* / scalars)", () => {
    const c = loadConfig({
      BELL_MARKETS_PROGRAM_ID: "",
      PHOENIX_MARKET_META: "",
      PYTH_PRICE_ACCOUNT_META: "",
    });
    expect(c.bellMarketsProgramId).toBeUndefined();
    expect(c.phoenixMarkets.META).toBeUndefined();
    expect(c.pythPriceAccounts.META).toBeUndefined();
    expect(c.heliusRpcUrl).toBeUndefined();
  });

  it("defaults bellMarketsIdlPath to the in-package drop zone when unset", () => {
    const c = loadConfig({});
    expect(c.bellMarketsIdlPath).toBe("src/idl/bell_markets.json");
  });
});

describe("requireConfig — fast-fail on missing fields", () => {
  it("returns the config unchanged when required fields are present", () => {
    const c = loadConfig({
      HELIUS_DEVNET_RPC_URL: "x",
      BELL_MARKETS_PROGRAM_ID: "y",
    });
    expect(() => requireConfig(c, ["heliusRpcUrl", "bellMarketsProgramId"])).not.toThrow();
  });

  it("throws MissingConfigError naming every absent field", () => {
    const c = loadConfig({});
    try {
      requireConfig(c, ["heliusRpcUrl", "bellMarketsProgramId", "platformAdminKeypairPath"]);
      throw new Error("expected requireConfig to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MissingConfigError);
      const err = e as MissingConfigError;
      expect(err.fields).toEqual(["heliusRpcUrl", "bellMarketsProgramId", "platformAdminKeypairPath"]);
      expect(err.message).toContain("heliusRpcUrl");
      expect(err.message).toContain("bellMarketsProgramId");
      expect(err.message).toContain("platformAdminKeypairPath");
    }
  });

  it("when only some fields are missing, error names only the absent ones", () => {
    const c = loadConfig({ HELIUS_DEVNET_RPC_URL: "x" });
    try {
      requireConfig(c, ["heliusRpcUrl", "bellMarketsProgramId", "platformAdminKeypairPath"]);
      throw new Error("expected requireConfig to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MissingConfigError);
      const err = e as MissingConfigError;
      expect(err.fields).toEqual(["bellMarketsProgramId", "platformAdminKeypairPath"]);
      expect(err.message).not.toContain("heliusRpcUrl");
    }
  });

  it("treats an empty phoenixMarkets map as missing", () => {
    const c = loadConfig({}); // no PHOENIX_MARKET_* set → phoenixMarkets is {}
    expect(() => requireConfig(c, ["phoenixMarkets"])).toThrow(MissingConfigError);
  });
});

describe("computeExpiryUnixFor4pmETSameDay", () => {
  it("returns 20:00 UTC same day for an EDT morning run", () => {
    // 2026-05-22 08:00 ET (EDT, UTC-4) = 12:00 UTC. Expected expiry:
    // 2026-05-22 16:00 ET = 20:00 UTC = Date.UTC(2026, 4, 22, 20, 0, 0) / 1000.
    const runAt = new Date(Date.UTC(2026, 4, 22, 12, 0, 0));
    const expiry = computeExpiryUnixFor4pmETSameDay(runAt);
    expect(expiry).toBe(Math.floor(Date.UTC(2026, 4, 22, 20, 0, 0) / 1000));
  });

  it("uses the run-at's UTC date even when run-at is well past midnight UTC", () => {
    // A 23:30 UTC run (e.g., late-evening operator-replay) should still use
    // that day's 20:00 UTC for expiry — pure function, no rollover magic.
    const runAt = new Date(Date.UTC(2026, 5, 1, 23, 30, 0));
    const expiry = computeExpiryUnixFor4pmETSameDay(runAt);
    expect(expiry).toBe(Math.floor(Date.UTC(2026, 5, 1, 20, 0, 0) / 1000));
  });
});
