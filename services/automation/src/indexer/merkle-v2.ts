// DR-015 multi-metric Merkle commitment. Extends DR-010's single-metric tree
// (programs/bell-markets/src/merkle.rs) to encode 4 ranking metrics in a
// SINGLE Merkle tree per `(period_id, period_type)`.
//
// **Important:** Aria's deploy-5 verifier still validates DR-010's leaf
// shape (50 bytes, no metric_id). DR-015 leaves cannot be verified on-chain
// until Aria's next deploy updates `merkle.rs` + `distribute_*_rewards`
// to accept the new shape + branch on `metric_id`. This module ships the
// off-chain side so the indexer + Arweave manifest are ready when Aria's
// deploy lands.
//
// DR-015 leaf format (47 bytes, per constitution/decisions.md DR-015):
//
//   sha256(
//     user_pubkey  (32 raw bytes — base58-decoded Solana pubkey),
//     metric_id    (u8 — 0x00 profit / 0x01 streak / 0x02 winRate / 0x03 ROI),
//     rank         (u8 — 1..N within this metric, 1 = top),
//     amount       (u64 LE — USDC base units distributed for this rank),
//     period_id    (u32 LE — ISO week or month_id; 4 bytes plenty for 4B periods),
//     period_type  (u8 — 0 weekly / 1 monthly)
//   )
//   // 32 + 1 + 1 + 8 + 4 + 1 = 47 bytes
//
// Same sorted-pair SHA256 internal-node hashing as DR-010 (OpenZeppelin
// style; `sha256(min(a,b) || max(a,b))`). The verifier can be a single
// shared implementation in Aria's `merkle.rs` once the leaf encoding is
// updated.
//
// Compatibility note: the v1 (DR-010) tree builder in merkle.ts is kept
// alongside this module — call sites distinguish via the input shape
// (BuildTreeInput vs BuildMultiMetricTreeInput).

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { decodePubkey, PERIOD_TYPE_WEEKLY, PERIOD_TYPE_MONTHLY, type PeriodTypeCode } from "./merkle.js";

// ---------------------------------------------------------------------------
// Metric IDs — keep in lockstep with constitution/decisions.md DR-015 table
// ---------------------------------------------------------------------------

export const METRIC_ABSOLUTE_PROFIT = 0x00;
export const METRIC_WIN_STREAK = 0x01;
export const METRIC_WIN_RATE = 0x02;
export const METRIC_ROI = 0x03;

export type MetricId =
  | typeof METRIC_ABSOLUTE_PROFIT
  | typeof METRIC_WIN_STREAK
  | typeof METRIC_WIN_RATE
  | typeof METRIC_ROI;

export const METRIC_NAMES: Record<MetricId, string> = {
  [METRIC_ABSOLUTE_PROFIT]: "absolute_profit",
  [METRIC_WIN_STREAK]: "win_streak",
  [METRIC_WIN_RATE]: "win_rate",
  [METRIC_ROI]: "roi",
};

/** DR-015 default per-metric pool split — sums to 10000 bps. */
export const DEFAULT_METRIC_POOL_SPLIT_BPS: Record<MetricId, number> = {
  [METRIC_ABSOLUTE_PROFIT]: 6000, // 60%
  [METRIC_WIN_STREAK]: 2000, //     20%
  [METRIC_WIN_RATE]: 1500, //       15%
  [METRIC_ROI]: 500, //               5% (Bell Pro tier per DR-014)
};

// Sanity check at module load.
const _splitSum = Object.values(DEFAULT_METRIC_POOL_SPLIT_BPS).reduce((a, b) => a + b, 0);
if (_splitSum !== 10000) {
  throw new Error(`DEFAULT_METRIC_POOL_SPLIT_BPS sums to ${_splitSum}, expected 10000`);
}

// ---------------------------------------------------------------------------
// Leaf hashing — DR-015 multi-metric shape
// ---------------------------------------------------------------------------

function sha256(buf: Buffer): Buffer {
  return createHash("sha256").update(buf).digest();
}

/**
 * Compute the DR-015 multi-metric leaf hash. All scalars little-endian.
 * `recipient` accepts base58 or pre-decoded 32-byte buffer.
 */
export function hashLeafV2(
  recipient: string | Buffer,
  metricId: MetricId,
  rank: number,
  amountBaseUnits: bigint | number,
  periodId: number,
  periodType: PeriodTypeCode,
): Buffer {
  const recipientBytes: Buffer = typeof recipient === "string" ? decodePubkey(recipient) : recipient;
  if (recipientBytes.length !== 32) {
    throw new Error(`hashLeafV2: recipient must decode to 32 bytes (got ${recipientBytes.length})`);
  }
  if (!isValidMetricId(metricId)) {
    throw new Error(`hashLeafV2: metricId must be 0..3 (got ${metricId})`);
  }
  if (!Number.isInteger(rank) || rank < 1 || rank > 255) {
    throw new Error(`hashLeafV2: rank must be 1..255 (got ${rank})`);
  }
  const amountBig = BigInt(amountBaseUnits);
  if (amountBig < 0n) {
    throw new Error(`hashLeafV2: amount must be non-negative (got ${amountBaseUnits})`);
  }
  if (amountBig > 0xffffffffffffffffn) {
    throw new Error(`hashLeafV2: amount exceeds u64 max (got ${amountBig})`);
  }
  if (!Number.isInteger(periodId) || periodId < 0 || periodId > 0xffffffff) {
    throw new Error(`hashLeafV2: periodId must fit in u32 (got ${periodId})`);
  }
  if (periodType !== PERIOD_TYPE_WEEKLY && periodType !== PERIOD_TYPE_MONTHLY) {
    throw new Error(`hashLeafV2: periodType must be 0 (weekly) or 1 (monthly) (got ${periodType})`);
  }

  // 32 + 1 + 1 + 8 + 4 + 1 = 47 bytes
  const buf = Buffer.alloc(47);
  recipientBytes.copy(buf, 0);
  buf.writeUInt8(metricId, 32);
  buf.writeUInt8(rank, 33);
  buf.writeBigUInt64LE(amountBig, 34);
  buf.writeUInt32LE(periodId, 42);
  buf.writeUInt8(periodType, 46);
  return sha256(buf);
}

function isValidMetricId(m: number): m is MetricId {
  return m === METRIC_ABSOLUTE_PROFIT || m === METRIC_WIN_STREAK || m === METRIC_WIN_RATE || m === METRIC_ROI;
}

// ---------------------------------------------------------------------------
// Multi-metric tree builder
// ---------------------------------------------------------------------------

export type MetricLeaderboardEntry = {
  recipient: string; // base58 pubkey
  rank: number; // 1..N
  amountBaseUnits: bigint;
};

/** Per-metric ranked list. Each list independently ranked 1..N where N <= 32
 *  (matches Aria's per-metric `claimed_bitmap` segment size from DR-015 §
 *  "Pool split"). Empty list = no winners for that metric this period. */
export type MultiMetricLeaderboard = {
  [METRIC_ABSOLUTE_PROFIT]?: MetricLeaderboardEntry[];
  [METRIC_WIN_STREAK]?: MetricLeaderboardEntry[];
  [METRIC_WIN_RATE]?: MetricLeaderboardEntry[];
  [METRIC_ROI]?: MetricLeaderboardEntry[];
};

export type BuildMultiMetricTreeInput = {
  leaderboard: MultiMetricLeaderboard;
  periodId: number;
  periodType: PeriodTypeCode;
};

export type MultiMetricLeaf = {
  metricId: MetricId;
  rank: number;
  recipient: string;
  amountBaseUnits: bigint;
  leafBytes: Buffer;
  leafHex: string;
};

export type MultiMetricMerkleTree = {
  /** 32-byte root, hex-encoded. */
  root: string;
  rootBytes: Buffer;
  /** All leaves across all metrics, in the canonical (metric, rank) order. */
  leaves: MultiMetricLeaf[];
  /** Look up the inclusion proof for a (metric, rank). */
  proofFor(metric: MetricId, rank: number): string[];
  proofBytesFor(metric: MetricId, rank: number): Buffer[];
  /** Total leaf count (sum across all metrics). */
  leafCount: number;
};

/**
 * Build the DR-015 single Merkle tree per period over multi-metric leaves.
 * Leaves are appended in canonical order: metric_id ASC, rank ASC. This
 * makes proof generation index-stable.
 *
 * Empty metrics (no winners) contribute zero leaves — no on-chain commit
 * for that metric is needed; the verifier branches on metric_id at
 * distribute time.
 *
 * Throws if every metric has zero entries (no point committing an empty
 * tree).
 */
export function buildMultiMetricMerkleTree(input: BuildMultiMetricTreeInput): MultiMetricMerkleTree {
  const { leaderboard, periodId, periodType } = input;

  const orderedMetrics: MetricId[] = [METRIC_ABSOLUTE_PROFIT, METRIC_WIN_STREAK, METRIC_WIN_RATE, METRIC_ROI];

  const leaves: MultiMetricLeaf[] = [];
  for (const metric of orderedMetrics) {
    const entries = leaderboard[metric];
    if (!entries) continue;
    if (entries.length > 32) {
      throw new Error(
        `buildMultiMetricMerkleTree: metric ${METRIC_NAMES[metric]} has ${entries.length} entries; max 32 per DR-015 bitmap segment`,
      );
    }
    for (const entry of entries) {
      if (!Number.isInteger(entry.rank) || entry.rank < 1 || entry.rank > 32) {
        throw new Error(
          `buildMultiMetricMerkleTree: rank must be 1..32 (got ${entry.rank} for ${METRIC_NAMES[metric]})`,
        );
      }
      const leafBytes = hashLeafV2(entry.recipient, metric, entry.rank, entry.amountBaseUnits, periodId, periodType);
      leaves.push({
        metricId: metric,
        rank: entry.rank,
        recipient: entry.recipient,
        amountBaseUnits: entry.amountBaseUnits,
        leafBytes,
        leafHex: leafBytes.toString("hex"),
      });
    }
  }

  if (leaves.length === 0) {
    throw new Error("buildMultiMetricMerkleTree: at least one metric must have entries");
  }

  const layers = buildSortedPairTreeLayers(leaves.map((l) => l.leafBytes));
  const rootBytes = layers[layers.length - 1]![0]!;

  // Build (metric, rank) → leaf index map for proof lookups
  const indexMap = new Map<string, number>();
  leaves.forEach((leaf, idx) => {
    indexMap.set(`${leaf.metricId}-${leaf.rank}`, idx);
  });

  return {
    root: rootBytes.toString("hex"),
    rootBytes,
    leaves,
    leafCount: leaves.length,
    proofFor(metric: MetricId, rank: number): string[] {
      const idx = indexMap.get(`${metric}-${rank}`);
      if (idx === undefined) {
        throw new Error(`proofFor: no leaf for metric=${METRIC_NAMES[metric]} rank=${rank}`);
      }
      return generateSortedPairProof(layers, idx).map((b) => b.toString("hex"));
    },
    proofBytesFor(metric: MetricId, rank: number): Buffer[] {
      const idx = indexMap.get(`${metric}-${rank}`);
      if (idx === undefined) {
        throw new Error(`proofBytesFor: no leaf for metric=${METRIC_NAMES[metric]} rank=${rank}`);
      }
      return generateSortedPairProof(layers, idx);
    },
  };
}

// ---------------------------------------------------------------------------
// Sorted-pair tree internals — identical to DR-010 merkle.ts
// ---------------------------------------------------------------------------

function buildSortedPairTreeLayers(leaves: ReadonlyArray<Buffer>): Buffer[][] {
  const layers: Buffer[][] = [leaves.slice()];
  while (layers[layers.length - 1]!.length > 1) {
    const current = layers[layers.length - 1]!;
    const next: Buffer[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const a = current[i]!;
      const b = current[i + 1] ?? a;
      next.push(hashSortedPair(a, b));
    }
    layers.push(next);
  }
  return layers;
}

function hashSortedPair(a: Buffer, b: Buffer): Buffer {
  const buf = Buffer.alloc(64);
  if (Buffer.compare(a, b) <= 0) {
    a.copy(buf, 0);
    b.copy(buf, 32);
  } else {
    b.copy(buf, 0);
    a.copy(buf, 32);
  }
  return sha256(buf);
}

function generateSortedPairProof(layers: Buffer[][], leafIndex: number): Buffer[] {
  const proof: Buffer[] = [];
  let idx = leafIndex;
  for (let level = 0; level < layers.length - 1; level++) {
    const layer = layers[level]!;
    const isRightNode = idx % 2 === 1;
    const siblingIdx = isRightNode ? idx - 1 : idx + 1;
    const sibling = layer[siblingIdx] ?? layer[idx]!;
    proof.push(sibling);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/** Verify a DR-015 proof off-chain. Mirrors what Aria's next-deploy verifier
 *  will do on-chain. */
export function verifyMultiMetricLeafProof(
  leafBytes: Buffer,
  proofBytes: ReadonlyArray<Buffer>,
  rootBytes: Buffer,
): boolean {
  if (proofBytes.length > 16) return false; // matches DR-010 MERKLE_PROOF_MAX_DEPTH
  let computed = leafBytes;
  for (const sibling of proofBytes) {
    computed = hashSortedPair(computed, sibling);
  }
  return Buffer.compare(computed, rootBytes) === 0;
}
