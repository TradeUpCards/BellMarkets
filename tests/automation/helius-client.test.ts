import { describe, it, expect } from "vitest";
import { HeliusClient } from "../../services/automation/src/clients/helius.js";

// Use a structural fake — we never actually need @solana/web3.js at
// test time. Avoids the rpc-websockets/uuid CJS-ESM cascade vitest can't
// transparently handle.
type FakeConnection = { __mock: string };

describe("HeliusClient — injectable connection factory", () => {
  it("uses the injected factory and exposes the same Connection", async () => {
    const fakeConn: FakeConnection = { __mock: "yes" };
    let seenUrl = "";
    const client = new HeliusClient({
      rpcUrl: "https://devnet.example/rpc",
      connectionFactory: (url) => {
        seenUrl = url;
        return fakeConn as unknown as import("@solana/web3.js").Connection;
      },
    });
    expect(client.rpcUrl).toBe("https://devnet.example/rpc");
    expect(client.commitment).toBe("confirmed");
    expect(seenUrl).toBe("https://devnet.example/rpc");
    expect(client.peekConnection()).toBe(fakeConn);
    expect(await client.getConnection()).toBe(fakeConn);
  });

  it("rejects construction without an rpcUrl", () => {
    expect(
      () =>
        new HeliusClient({
          rpcUrl: "",
          connectionFactory: () => ({}) as unknown as import("@solana/web3.js").Connection,
        }),
    ).toThrow();
  });

  it("honours custom commitment", () => {
    const fakeConn: FakeConnection = { __mock: "finalized" };
    const client = new HeliusClient({
      rpcUrl: "https://devnet.example/rpc",
      commitment: "finalized",
      connectionFactory: () => fakeConn as unknown as import("@solana/web3.js").Connection,
    });
    expect(client.commitment).toBe("finalized");
  });

  it("defers @solana/web3.js import until getConnection() is awaited", () => {
    // Construct without injection — the constructor must NOT import web3.js.
    // (If this test passes, the deferred-import design holds.)
    const client = new HeliusClient({ rpcUrl: "https://devnet.example/rpc" });
    expect(client.peekConnection()).toBeUndefined();
  });
});
