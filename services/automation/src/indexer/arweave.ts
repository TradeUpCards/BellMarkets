// DR-010 — Arweave permanent leaderboard archival.
//
// Per period close: upload full leaderboard JSON to Arweave; persist
// the tx_id alongside the merkle_root in `leaderboard_snapshots`. The
// on-chain `commit_leaderboard_root` stores both — anyone can later fetch
// the full leaderboard from Arweave, reconstruct the Merkle tree, and
// verify the root matches.
//
// Cost: ~$0.01 per snapshot (Arweave's permanent storage model).
//
// Wallet: requires an Arweave JWK keyfile at ARWEAVE_WALLET_JSON_PATH.
// JWKs can be generated via `arweave wallet new`. The wallet must hold
// AR balance — fund via arweave.app or an exchange. For MVP, this is a
// one-time op done before the first distribute cron fires.
//
// STUB MODE: if ARWEAVE_WALLET_JSON_PATH is unset, uploadLeaderboardToArweave
// returns a fake tx_id with a clear "stub" prefix and a no-op effect. Lets
// the indexer pipeline run end-to-end without Arweave funding during dev
// or interview demos.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LeaderboardSnapshot } from "../db/types.js";

export type ArweaveUploadResult = {
  txId: string;
  stub: boolean;
};

export type ArweaveDeps = {
  /** Override wallet JWK loader for tests. */
  readWallet?: (path: string) => unknown;
  /** Override the upload entry-point for tests / stub fallback. */
  upload?: (jsonPayload: string, wallet: unknown) => Promise<string>;
};

/**
 * Upload the full-leaderboard JSON for a snapshot to Arweave. Returns the
 * Arweave tx_id (which becomes the snapshot's `arweave_tx_id`).
 *
 * The payload is the canonical JSON-serialization of:
 *   {
 *     periodKind, periodId, periodStart (ISO), periodEnd (ISO),
 *     merkleRoot, participantsCount, entries: LeaderboardEntry[]
 *   }
 * Order-stable: re-running with the same inputs produces byte-identical
 * payload, so Arweave de-duplicates if re-uploaded.
 */
export async function uploadLeaderboardToArweave(
  snapshot: Pick<
    LeaderboardSnapshot,
    | "periodKind"
    | "periodId"
    | "periodStart"
    | "periodEnd"
    | "merkleRoot"
    | "participantsCount"
    | "fullLeaderboardJson"
  >,
  deps: ArweaveDeps = {},
): Promise<ArweaveUploadResult> {
  const payload = JSON.stringify(
    {
      periodKind: snapshot.periodKind,
      periodId: snapshot.periodId,
      periodStart: snapshot.periodStart.toISOString(),
      periodEnd: snapshot.periodEnd.toISOString(),
      merkleRoot: snapshot.merkleRoot ?? null,
      participantsCount: snapshot.participantsCount,
      entries: snapshot.fullLeaderboardJson,
    },
    null,
    0,
  );

  // Test injection — short-circuit straight to the injected upload fn.
  if (deps.upload) {
    const txId = await deps.upload(payload, undefined);
    return { txId, stub: false };
  }

  const walletPath = process.env.ARWEAVE_WALLET_JSON_PATH;
  if (!walletPath) {
    // Stub mode — deterministic fake id so log/db rows are meaningful
    // without requiring Arweave funding for MVP.
    const fakeId = `stub-arweave-${snapshot.periodKind}-${snapshot.periodId}`;
    return { txId: fakeId, stub: true };
  }

  // Live mode — load JWK + upload via arweave SDK.
  let wallet: unknown;
  try {
    const raw = (deps.readWallet ?? defaultReadWallet)(resolve(walletPath));
    wallet = raw;
  } catch (cause) {
    throw new ArweaveError(`Failed to read Arweave wallet at ${walletPath}`, cause);
  }

  const arweave = await loadArweave();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx = await (arweave as any).createTransaction({ data: payload }, wallet);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tx as any).addTag("Content-Type", "application/json");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tx as any).addTag("App-Name", "BellMarkets-Leaderboard");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tx as any).addTag("Period-Kind", snapshot.periodKind);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tx as any).addTag("Period-Id", String(snapshot.periodId));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (arweave as any).transactions.sign(tx, wallet);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (arweave as any).transactions.post(tx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { txId: (tx as any).id as string, stub: false };
  } catch (cause) {
    throw new ArweaveError(`Arweave upload failed for ${snapshot.periodKind}#${snapshot.periodId}`, cause);
  }
}

async function loadArweave(): Promise<unknown> {
  // Deferred import — Arweave SDK is heavy and only needed in live mode.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import("arweave")) as any;
  const ArweaveCtor = mod.default ?? mod;
  return ArweaveCtor.init({ host: "arweave.net", port: 443, protocol: "https" });
}

function defaultReadWallet(path: string): unknown {
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw);
}

export class ArweaveError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "ArweaveError";
  }
}
