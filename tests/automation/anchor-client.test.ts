import { describe, it, expect } from "vitest";
import {
  BellMarketsAnchorClient,
  AnchorClientError,
  parseIdlJson,
} from "../../services/automation/src/clients/anchor.js";

// All tests use injection — never load @solana/web3.js or @coral-xyz/anchor
// at runtime. The deferred-import design (helius.ts precedent) lets vitest
// stay clear of the rpc-websockets/uuid CJS-ESM cascade.

describe("parseIdlJson — placeholder rejection", () => {
  it("rejects the empty-object placeholder with a descriptive error", () => {
    expect(() => parseIdlJson("{}", "/some/path/bell_markets.json")).toThrow(
      AnchorClientError,
    );
    try {
      parseIdlJson("{}", "/p/bell_markets.json");
    } catch (e) {
      const err = e as Error;
      expect(err.message).toContain("instructions");
      expect(err.message).toContain("/p/bell_markets.json");
      expect(err.message).toContain("anchor build");
    }
  });

  it("rejects invalid JSON", () => {
    expect(() => parseIdlJson("{not-json", "/p")).toThrow(AnchorClientError);
  });

  it("rejects an IDL with empty instructions array", () => {
    expect(() => parseIdlJson(JSON.stringify({ instructions: [] }), "/p")).toThrow(
      AnchorClientError,
    );
  });

  it("accepts a minimal IDL that has at least one instruction", () => {
    const idl = parseIdlJson(
      JSON.stringify({ instructions: [{ name: "noop", accounts: [], args: [] }] }),
      "/p",
    );
    expect(idl).toBeTruthy();
  });
});

describe("BellMarketsAnchorClient — constructor validation", () => {
  it("rejects empty rpcUrl", () => {
    expect(
      () =>
        new BellMarketsAnchorClient({
          rpcUrl: "",
          programId: "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV",
          keypairPath: "/k.json",
          idlPath: "/idl.json",
        }),
    ).toThrow(AnchorClientError);
  });

  it("rejects empty programId", () => {
    expect(
      () =>
        new BellMarketsAnchorClient({
          rpcUrl: "https://api.devnet.solana.com",
          programId: "",
          keypairPath: "/k.json",
          idlPath: "/idl.json",
        }),
    ).toThrow(AnchorClientError);
  });

  it("rejects when neither keypairPath nor keypairOverride is supplied", () => {
    expect(
      () =>
        new BellMarketsAnchorClient({
          rpcUrl: "https://api.devnet.solana.com",
          programId: "P",
          keypairPath: "",
          idlPath: "/idl.json",
        }),
    ).toThrow(AnchorClientError);
  });

  it("rejects when neither idlPath nor idlOverride is supplied", () => {
    expect(
      () =>
        new BellMarketsAnchorClient({
          rpcUrl: "https://api.devnet.solana.com",
          programId: "P",
          keypairPath: "/k.json",
          idlPath: "",
        }),
    ).toThrow(AnchorClientError);
  });
});

describe("BellMarketsAnchorClient.getProgram — fault paths via injection", () => {
  it("fail-fasts when the IDL file is the placeholder `{}`", async () => {
    const client = new BellMarketsAnchorClient({
      rpcUrl: "https://api.devnet.solana.com",
      programId: "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV",
      keypairPath: "/k.json",
      idlPath: "/idl.json",
      readFileImpl: (path) => {
        if (path.endsWith("idl.json")) return "{}";
        // Fake 64-byte keypair so we don't blow up on the keypair load
        // before the IDL check has a chance to fail.
        return JSON.stringify(new Array(64).fill(0));
      },
    });
    await expect(client.getProgram()).rejects.toThrow(AnchorClientError);
  });

  it("fail-fasts when the IDL file is missing on disk", async () => {
    const client = new BellMarketsAnchorClient({
      rpcUrl: "https://api.devnet.solana.com",
      programId: "P",
      keypairPath: "/k.json",
      idlPath: "/no-such-file.json",
      readFileImpl: (path) => {
        if (path.endsWith("no-such-file.json")) {
          throw new Error("ENOENT: no such file");
        }
        return JSON.stringify(new Array(64).fill(0));
      },
    });
    await expect(client.getProgram()).rejects.toThrow(/IDL not found/);
  });

  it("fail-fasts when the keypair file is not a 64-byte array", async () => {
    const client = new BellMarketsAnchorClient({
      rpcUrl: "https://api.devnet.solana.com",
      programId: "P",
      keypairPath: "/k.json",
      idlPath: "/idl.json",
      readFileImpl: (path) => {
        if (path.endsWith("idl.json")) {
          return JSON.stringify({ instructions: [{ name: "noop", accounts: [], args: [] }] });
        }
        return JSON.stringify([1, 2, 3]); // wrong length
      },
    });
    await expect(client.getProgram()).rejects.toThrow(/64 numbers/);
  });

  it("uses the injected programFactory + idlOverride + keypairOverride end-to-end", async () => {
    let factorySeenIdl: unknown = null;
    let factorySeenProgramId = "";
    const fakeKeypair = { __mock: "keypair" } as unknown as import("@solana/web3.js").Keypair;
    const fakeProgram = { __mock: "program" } as unknown as import("@coral-xyz/anchor").Program<import("@coral-xyz/anchor").Idl>;
    const client = new BellMarketsAnchorClient({
      rpcUrl: "https://api.devnet.solana.com",
      programId: "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV",
      keypairPath: "ignored",
      idlPath: "ignored",
      idlOverride: { instructions: [{ name: "noop", accounts: [], args: [] }] } as unknown as import("@coral-xyz/anchor").Idl,
      keypairOverride: fakeKeypair,
      programFactory: (idl, programId) => {
        factorySeenIdl = idl;
        factorySeenProgramId = programId;
        return fakeProgram;
      },
    });
    const program = await client.getProgram();
    expect(program).toBe(fakeProgram);
    expect(factorySeenProgramId).toBe("599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV");
    expect(factorySeenIdl).toMatchObject({ instructions: [{ name: "noop" }] });

    // Caches on second call
    const program2 = await client.getProgram();
    expect(program2).toBe(fakeProgram);
  });
});
