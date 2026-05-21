import { describe, it, expect } from "vitest";
import {
  loadConfig,
  requireConfig,
  MissingConfigError,
} from "../../services/automation/src/config.js";

describe("loadConfig", () => {
  it("maps env vars to AutomationConfig fields", () => {
    const env: NodeJS.ProcessEnv = {
      TRIGGER_PROJECT_REF: "proj_x",
      HELIUS_DEVNET_RPC_URL: "https://devnet.example/rpc",
      PYTH_HTTP_BASE_URL: "https://hermes.example/api",
      PROGRAM_ID: "Bell11111111111111111111111111111111111111",
      ADMIN_KEYPAIR_PATH: "/tmp/keypair.json",
    };
    const c = loadConfig(env);
    expect(c.triggerProjectRef).toBe("proj_x");
    expect(c.heliusRpcUrl).toBe("https://devnet.example/rpc");
    expect(c.pythHttpBaseUrl).toBe("https://hermes.example/api");
    expect(c.programId).toBe("Bell11111111111111111111111111111111111111");
    expect(c.adminKeypairPath).toBe("/tmp/keypair.json");
  });

  it("returns undefined for unset fields (empty string also treated as unset)", () => {
    const c = loadConfig({ PROGRAM_ID: "" });
    expect(c.programId).toBeUndefined();
    expect(c.heliusRpcUrl).toBeUndefined();
  });
});

describe("requireConfig — fast-fail on missing fields", () => {
  it("returns the config unchanged when required fields are present", () => {
    const c = loadConfig({
      HELIUS_DEVNET_RPC_URL: "x",
      PROGRAM_ID: "y",
    });
    expect(() => requireConfig(c, ["heliusRpcUrl", "programId"])).not.toThrow();
  });

  it("throws MissingConfigError naming every absent field", () => {
    const c = loadConfig({});
    try {
      requireConfig(c, ["heliusRpcUrl", "programId", "adminKeypairPath"]);
      throw new Error("expected requireConfig to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MissingConfigError);
      const err = e as MissingConfigError;
      expect(err.fields).toEqual(["heliusRpcUrl", "programId", "adminKeypairPath"]);
      expect(err.message).toContain("heliusRpcUrl");
      expect(err.message).toContain("programId");
      expect(err.message).toContain("adminKeypairPath");
    }
  });

  it("when only some fields are missing, error names only the absent ones", () => {
    const c = loadConfig({
      HELIUS_DEVNET_RPC_URL: "x",
      // programId + adminKeypairPath intentionally absent
    });
    try {
      requireConfig(c, ["heliusRpcUrl", "programId", "adminKeypairPath"]);
      throw new Error("expected requireConfig to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MissingConfigError);
      const err = e as MissingConfigError;
      expect(err.fields).toEqual(["programId", "adminKeypairPath"]);
      expect(err.message).not.toContain("heliusRpcUrl");
    }
  });
});
