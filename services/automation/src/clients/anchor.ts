// Anchor program client wrapper for the BellMarkets devnet program.
//
// Design notes (mirror clients/helius.ts):
//   - All `@coral-xyz/anchor` + `@solana/web3.js` runtime imports are
//     DEFERRED until `getProgram()` / `loadKeypair()` actually need them.
//     Same rationale as HeliusClient: workspace `rpc-websockets@9.3.9`
//     pulls `uuid@14` via `require()` which blows up under vitest. The
//     deferred imports also mean unit tests can inject every dependency
//     and never touch the real chain or load web3.js.
//   - The IDL is loaded from disk at `BELL_MARKETS_IDL_PATH`. The
//     committed file is `{}` until Aria's `anchor build` artifact lands;
//     `loadIdl()` rejects placeholder shapes with a descriptive
//     `AnchorClientError` so a half-wired deploy can never silently no-op.
//   - The platform-admin keypair is loaded from a JSON file (the standard
//     Solana keypair format: a JSON array of 64 bytes). Path comes from
//     `PLATFORM_ADMIN_KEYPAIR_PATH` (per Aria's wallet architecture —
//     keys/devnet-platform-admin.json, gitignored).
//
// DR-002 reminder: the keypair this wrapper signs with is the
// program-required admin (constraint = config.admin == admin.key()). This
// service is a permissionless convenience caller — any wallet whose pubkey
// matches MarketConfig.admin can sign the same instruction; we have no
// privilege the constraint doesn't grant.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Idl, Program } from "@coral-xyz/anchor";
import type { Commitment, Connection, Keypair } from "@solana/web3.js";

export class AnchorClientError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AnchorClientError";
  }
}

export type AnchorClientOptions = {
  /** Solana RPC URL — devnet for the core submission. */
  rpcUrl: string;
  /** Aria's deployed program ID (base58). */
  programId: string;
  /** Path to the platform-admin keypair JSON file. */
  keypairPath: string;
  /** Path to the Anchor IDL JSON file. */
  idlPath: string;
  /** Default commitment. Defaults to "confirmed". */
  commitment?: Commitment;

  // ── Test injection (all optional; defaults wire to real runtime) ────────
  /** Override the IDL content directly (bypass disk read). */
  idlOverride?: Idl;
  /** Override the loaded keypair directly (bypass disk read). */
  keypairOverride?: Keypair;
  /** Factory for the Program object — accepts injected idl/programId/provider. */
  programFactory?: (idl: Idl, programId: string, provider: unknown) => Program<Idl>;
  /** Factory for the underlying Connection. Defaults to web3.js Connection. */
  connectionFactory?: (rpcUrl: string, commitment: Commitment) => Connection;
  /** Inject a fs-read implementation for tests. */
  readFileImpl?: (path: string) => string;
};

/**
 * Lazy-construct an Anchor `Program<Idl>` against Aria's deployed program.
 *
 * Usage:
 *   const client = new BellMarketsAnchorClient({ rpcUrl, programId, keypairPath, idlPath });
 *   const program = await client.getProgram();
 *   await program.methods.createStrikeMarket(...).accounts({...}).signers([...]).rpc();
 */
export class BellMarketsAnchorClient {
  private cachedProgram: Program<Idl> | undefined;
  private readonly readFileImpl: (path: string) => string;
  readonly opts: AnchorClientOptions;

  constructor(opts: AnchorClientOptions) {
    if (!opts.rpcUrl) throw new AnchorClientError("BellMarketsAnchorClient requires rpcUrl");
    if (!opts.programId) throw new AnchorClientError("BellMarketsAnchorClient requires programId");
    if (!opts.keypairPath && !opts.keypairOverride) {
      throw new AnchorClientError("BellMarketsAnchorClient requires keypairPath (or keypairOverride for tests)");
    }
    if (!opts.idlPath && !opts.idlOverride) {
      throw new AnchorClientError("BellMarketsAnchorClient requires idlPath (or idlOverride for tests)");
    }
    this.opts = opts;
    this.readFileImpl = opts.readFileImpl ?? ((p) => readFileSync(p, "utf-8"));
  }

  /**
   * Resolve the underlying `Program<Idl>`. Caches on first successful call.
   *
   * Throws `AnchorClientError` (not a deep web3.js stack) when the IDL is
   * absent, malformed, or still the placeholder `{}` from the drop zone.
   */
  async getProgram(): Promise<Program<Idl>> {
    if (this.cachedProgram) return this.cachedProgram;

    const idl = this.opts.idlOverride ?? this.loadIdlFromPath(this.opts.idlPath);
    const keypair = this.opts.keypairOverride ?? (await this.loadKeypairFromPath(this.opts.keypairPath));

    if (this.opts.programFactory) {
      this.cachedProgram = this.opts.programFactory(idl, this.opts.programId, { keypair });
      return this.cachedProgram;
    }

    // Real runtime path — deferred imports keep test runs off web3.js.
    const anchor = await import("@coral-xyz/anchor");
    const web3 = await import("@solana/web3.js");

    const commitment: Commitment = this.opts.commitment ?? "confirmed";
    const connection: Connection = this.opts.connectionFactory
      ? this.opts.connectionFactory(this.opts.rpcUrl, commitment)
      : new web3.Connection(this.opts.rpcUrl, commitment);

    const wallet = new anchor.Wallet(keypair);
    const provider = new anchor.AnchorProvider(connection, wallet, { commitment });

    // Anchor 0.30 `Program` constructor reads programId from `idl.address`
    // (the old `(idl, programId, provider)` signature was dropped in 0.30).
    // Stamp our configured programId on the IDL before construction so
    // both placeholder + real IDLs route to Aria's deployed address.
    const idlWithAddress = { ...(idl as Record<string, unknown>), address: this.opts.programId } as Idl;
    const program = new anchor.Program(idlWithAddress, provider) as unknown as Program<Idl>;

    this.cachedProgram = program;
    return program;
  }

  /** Visible for tests — parses + validates IDL shape from a string. */
  loadIdlFromPath(idlPath: string): Idl {
    const absolute = resolve(idlPath);
    let raw: string;
    try {
      raw = this.readFileImpl(absolute);
    } catch (cause) {
      throw new AnchorClientError(
        `IDL not found at ${absolute}. Aria must commit the real IDL to services/automation/src/idl/bell_markets.json (copy from target/idl/bell_markets.json after \`anchor build\`).`,
        cause,
      );
    }
    return parseIdlJson(raw, absolute);
  }

  /** Visible for tests — parses keypair bytes from a file path. */
  async loadKeypairFromPath(keypairPath: string): Promise<Keypair> {
    const absolute = resolve(keypairPath);
    let raw: string;
    try {
      raw = this.readFileImpl(absolute);
    } catch (cause) {
      throw new AnchorClientError(
        `Platform admin keypair not found at ${absolute}. Set PLATFORM_ADMIN_KEYPAIR_PATH to the path of keys/devnet-platform-admin.json.`,
        cause,
      );
    }
    let bytes: unknown;
    try {
      bytes = JSON.parse(raw);
    } catch (cause) {
      throw new AnchorClientError(`Keypair at ${absolute} is not valid JSON`, cause);
    }
    if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((b) => typeof b === "number")) {
      throw new AnchorClientError(
        `Keypair at ${absolute} must be a JSON array of 64 numbers (got ${Array.isArray(bytes) ? `${bytes.length}-len array` : typeof bytes})`,
      );
    }
    const web3 = await import("@solana/web3.js");
    return web3.Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
  }
}

/**
 * Parse + validate an IDL JSON string. Exported so unit tests can exercise
 * the validation without constructing the full client.
 */
export function parseIdlJson(raw: string, absolutePath: string): Idl {
  let idl: unknown;
  try {
    idl = JSON.parse(raw);
  } catch (cause) {
    throw new AnchorClientError(`IDL at ${absolutePath} is not valid JSON`, cause);
  }
  if (!idl || typeof idl !== "object") {
    throw new AnchorClientError(`IDL at ${absolutePath} is not a JSON object`);
  }
  const obj = idl as Record<string, unknown>;
  if (!Array.isArray(obj.instructions) || obj.instructions.length === 0) {
    throw new AnchorClientError(
      `IDL at ${absolutePath} is missing required "instructions" array — likely still the placeholder \`{}\`. Replace with the real IDL from \`target/idl/bell_markets.json\` after Aria's \`anchor build\`.`,
    );
  }
  return idl as Idl;
}
