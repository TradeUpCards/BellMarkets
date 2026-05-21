// Solana RPC wrapper around @solana/web3.js Connection. The automation
// service uses Helius RPC on devnet (per specs/architecture.md §2.2),
// but accepts any Solana-compatible RPC URL — we don't depend on
// Helius-specific endpoints in the automation service itself (the
// frontend's WebSocket subscriptions are Helius-flavored; ours are not).
//
// Design notes:
//   - URL injected from env (HELIUS_DEVNET_RPC_URL).
//   - Connection factory accepts a custom `connectionFactory` for tests
//     so we never hit a live RPC in unit tests
//     (constitution/hard-rules.md §2.2 generalises this discipline:
//     no live external state in tests).
//   - This wrapper is intentionally thin. Job code calls
//     `client.getConnection()` and uses standard web3.js + Anchor
//     patterns from there. We add real retry/backoff at the *job*
//     layer (Trigger.dev policy), not inside the connection wrapper.

import type { Commitment, Connection } from "@solana/web3.js";

export type HeliusClientOptions = {
  /** Solana RPC URL — devnet for the core submission. */
  rpcUrl: string;
  /** Default commitment for reads/writes. Defaults to "confirmed". */
  commitment?: Commitment;
  /** Inject a Connection-like factory for tests. Defaults to web3.js Connection. */
  connectionFactory?: (rpcUrl: string, commitment: Commitment) => Connection;
};

// Default factory deferred behind a function so unit tests that inject a
// fake `connectionFactory` never trigger the `@solana/web3.js` runtime
// import chain (which currently has a CJS/ESM interop issue with
// `rpc-websockets` and `uuid@14` under vitest). Job code that actually
// needs a Connection picks up the real one at runtime.
async function defaultConnectionFactory(url: string, commitment: Commitment): Promise<Connection> {
  const web3 = await import("@solana/web3.js");
  return new web3.Connection(url, commitment);
}

export class HeliusClient {
  private connection: Connection | undefined;
  private readonly factory: (rpcUrl: string, commitment: Commitment) => Connection;
  readonly rpcUrl: string;
  readonly commitment: Commitment;

  constructor(opts: HeliusClientOptions) {
    if (!opts.rpcUrl) throw new Error("HeliusClient requires rpcUrl");
    this.rpcUrl = opts.rpcUrl;
    this.commitment = opts.commitment ?? "confirmed";
    if (opts.connectionFactory) {
      this.factory = opts.connectionFactory;
      this.connection = this.factory(this.rpcUrl, this.commitment);
    } else {
      // Sentinel factory — never invoked synchronously. Callers go through
      // `getConnection()` which lazily resolves via defaultConnectionFactory.
      this.factory = () => {
        throw new Error("HeliusClient: synchronous default factory invoked; use getConnection() instead");
      };
    }
  }

  /**
   * Resolve the underlying Connection. If a factory was injected, returns
   * synchronously; otherwise lazily imports @solana/web3.js.
   */
  async getConnection(): Promise<Connection> {
    if (this.connection) return this.connection;
    this.connection = await defaultConnectionFactory(this.rpcUrl, this.commitment);
    return this.connection;
  }

  /** Test/dev helper — returns the eagerly-constructed Connection if any. */
  peekConnection(): Connection | undefined {
    return this.connection;
  }
}
