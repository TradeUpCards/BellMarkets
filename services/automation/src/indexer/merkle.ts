// DR-010 — SHA256 sorted-pair Merkle commitment, matching Aria's on-chain
// verifier (programs/bell-markets/src/merkle.rs).
//
// Off-chain MUST match the on-chain shape exactly or proofs will fail:
//
//   Leaf:
//     sha256(
//       recipient_pubkey_bytes   (32 raw bytes — Solana pubkey base58-decoded)
//       | position               (u8)
//       | period_id              (u64 little-endian)
//       | period_type            (u8 — PERIOD_TYPE_WEEKLY=0, PERIOD_TYPE_MONTHLY=1)
//       | amount                 (u64 little-endian — USDC base units)
//     )
//     // Total input: 32 + 1 + 8 + 1 + 8 = 50 bytes
//
//   Internal nodes:
//     sha256(min(a, b) || max(a, b))   // sorted-pair, OpenZeppelin style
//
//   Odd leaf count:
//     Duplicate the orphan leaf (standard "pair with self" pattern)
//
// Proof depth bound: MERKLE_PROOF_MAX_DEPTH = 16 (on-chain CU cap).

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { LeaderboardEntry } from "../db/types.js";

// State constants — must match programs/bell-markets/src/state.rs exactly.
export const PERIOD_TYPE_WEEKLY = 0;
export const PERIOD_TYPE_MONTHLY = 1;
export const DISTRIBUTION_SLOTS = 10;
export const MERKLE_PROOF_MAX_DEPTH = 16;

export type PeriodTypeCode = typeof PERIOD_TYPE_WEEKLY | typeof PERIOD_TYPE_MONTHLY;

export type LeaderboardLeaf = {
  position: number; // 1..10
  recipient: string; // base58 pubkey
  recipientBytes: Buffer; // 32 raw bytes (base58-decoded)
  amount: bigint; // USDC base units (6 decimals)
  /** Hex-encoded 32-byte leaf hash (= sha256 of the 50-byte payload). */
  leafHex: string;
  leafBytes: Buffer;
};

export type LeaderboardMerkleTree = {
  /** Root as 64-char hex (no 0x prefix). Same shape Aria stores on-chain. */
  root: string;
  /** Root as raw 32-byte buffer (for direct on-chain comparison). */
  rootBytes: Buffer;
  /** Per-position leaves with their hashes. */
  leaves: LeaderboardLeaf[];
  /** Look up the inclusion proof for a position (1-indexed). */
  proofFor: (position: number) => string[];
  /** Same proof but as Buffer array (for direct on-chain comparison). */
  proofBytesFor: (position: number) => Buffer[];
};

// ---------------------------------------------------------------------------
// Pubkey → 32 raw bytes (without pulling in @solana/web3.js)
// ---------------------------------------------------------------------------

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz" as const;
const BASE58_LOOKUP = (() => {
  const map = new Int8Array(128).fill(-1);
  for (let i = 0; i < BASE58_ALPHABET.length; i++) {
    map[BASE58_ALPHABET.charCodeAt(i)] = i;
  }
  return map;
})();

/**
 * Decode a Solana base58 pubkey into its raw 32-byte representation. Pure
 * function; matches the encoding `Pubkey::new_from_array(...)` reverses.
 *
 * Implementation: standard base58 → bytes via repeated multiplication. We
 * roll our own to avoid pulling in @solana/web3.js (which drags in the
 * rpc-websockets/uuid CJS-ESM cascade per DR-004).
 */
export function decodePubkey(base58: string): Buffer {
  if (typeof base58 !== "string" || base58.length === 0) {
    throw new Error(`decodePubkey: invalid input (${base58})`);
  }
  // Count leading '1' chars — each maps to a leading zero byte.
  let zeroes = 0;
  while (zeroes < base58.length && base58[zeroes] === "1") {
    zeroes++;
  }
  // Convert from base58 to base256 via repeated multiplication.
  const out: number[] = [];
  for (let i = zeroes; i < base58.length; i++) {
    const c = base58.charCodeAt(i);
    const digit = c < 128 ? BASE58_LOOKUP[c] : -1;
    if (digit === undefined || digit < 0) {
      throw new Error(`decodePubkey: invalid base58 char at position ${i} (${base58[i]})`);
    }
    let carry = digit;
    for (let j = 0; j < out.length; j++) {
      carry += out[j]! * 58;
      out[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      out.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Reverse + prepend leading zeroes.
  const bytes = Buffer.alloc(zeroes + out.length);
  for (let i = 0; i < zeroes; i++) bytes[i] = 0;
  for (let i = 0; i < out.length; i++) {
    bytes[zeroes + i] = out[out.length - 1 - i]!;
  }
  if (bytes.length !== 32) {
    throw new Error(
      `decodePubkey: expected 32 bytes, got ${bytes.length} for "${base58}" — not a valid Solana pubkey`,
    );
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Leaf hashing — must match programs/bell-markets/src/merkle.rs:compute_leaf
// ---------------------------------------------------------------------------

function sha256(buf: Buffer): Buffer {
  return createHash("sha256").update(buf).digest();
}

/**
 * Compute the on-chain-compatible leaf hash for a single distribution claim.
 *
 *   sha256(recipient(32) || position(1) || period_id_le(8) || period_type(1) || amount_le(8))
 *
 * Caller supplies the pubkey as a base58 string OR as the raw 32-byte buffer.
 */
export function hashLeaf(
  recipient: string | Buffer,
  position: number,
  periodId: bigint | number,
  periodType: PeriodTypeCode,
  amount: bigint | number,
): Buffer {
  const recipientBytes: Buffer =
    typeof recipient === "string" ? decodePubkey(recipient) : recipient;
  if (recipientBytes.length !== 32) {
    throw new Error(`hashLeaf: recipient must decode to 32 bytes (got ${recipientBytes.length})`);
  }
  if (!Number.isInteger(position) || position < 1 || position > DISTRIBUTION_SLOTS) {
    throw new Error(`hashLeaf: position must be 1..${DISTRIBUTION_SLOTS} (got ${position})`);
  }
  if (periodType !== PERIOD_TYPE_WEEKLY && periodType !== PERIOD_TYPE_MONTHLY) {
    throw new Error(`hashLeaf: periodType must be 0 (weekly) or 1 (monthly) (got ${periodType})`);
  }
  const periodIdBig = BigInt(periodId);
  if (periodIdBig < 0n) {
    throw new Error(`hashLeaf: periodId must be non-negative (got ${periodId})`);
  }
  const amountBig = BigInt(amount);
  if (amountBig < 0n) {
    throw new Error(`hashLeaf: amount must be non-negative (got ${amount})`);
  }

  const buf = Buffer.alloc(50);
  recipientBytes.copy(buf, 0);
  buf.writeUInt8(position, 32);
  buf.writeBigUInt64LE(periodIdBig, 33);
  buf.writeUInt8(periodType, 41);
  buf.writeBigUInt64LE(amountBig, 42);
  return sha256(buf);
}

// ---------------------------------------------------------------------------
// Tree construction — sorted-pair (OpenZeppelin style)
// ---------------------------------------------------------------------------

/**
 * Build the standard "sorted-pair" Merkle tree per Aria's
 * `verify_merkle_proof` contract. At each level, siblings are concat'd in
 * lexicographic order before hashing.
 *
 * Returns the matrix of node hashes from leaves up to root, layer 0 = leaves.
 */
function buildSortedPairTreeLayers(leaves: ReadonlyArray<Buffer>): Buffer[][] {
  if (leaves.length === 0) {
    throw new Error("buildSortedPairTreeLayers: requires at least one leaf");
  }
  const layers: Buffer[][] = [leaves.slice()];
  while (layers[layers.length - 1]!.length > 1) {
    const current = layers[layers.length - 1]!;
    const next: Buffer[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const a = current[i]!;
      const b = current[i + 1] ?? a; // duplicate orphan leaf
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

/**
 * Generate the inclusion proof for the leaf at `leafIndex`. Sibling at each
 * level. Returns an array of 32-byte buffers.
 *
 * Verifier walks the proof: at each step, sort the current hash with the
 * sibling, concat in sorted order, sha256 to next level.
 */
function generateSortedPairProof(layers: Buffer[][], leafIndex: number): Buffer[] {
  const proof: Buffer[] = [];
  let idx = leafIndex;
  for (let level = 0; level < layers.length - 1; level++) {
    const layer = layers[level]!;
    const isRightNode = idx % 2 === 1;
    const siblingIdx = isRightNode ? idx - 1 : idx + 1;
    const sibling = layer[siblingIdx] ?? layer[idx]!; // duplicate self for orphan
    proof.push(sibling);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/**
 * Verify a proof off-chain (mirror of on-chain `verify_merkle_proof`).
 * Useful for self-checking generated proofs in tests.
 */
export function verifyLeafProof(
  leafBytes: Buffer,
  proofBytes: ReadonlyArray<Buffer>,
  rootBytes: Buffer,
): boolean {
  if (proofBytes.length > MERKLE_PROOF_MAX_DEPTH) {
    return false;
  }
  let computed = leafBytes;
  for (const sibling of proofBytes) {
    computed = hashSortedPair(computed, sibling);
  }
  return Buffer.compare(computed, rootBytes) === 0;
}

// ---------------------------------------------------------------------------
// High-level leaderboard tree builder
// ---------------------------------------------------------------------------

export type BuildTreeInput = {
  entries: ReadonlyArray<LeaderboardEntry>;
  periodId: bigint | number;
  periodType: PeriodTypeCode;
  /**
   * Per-position USDC amount (base units, 6 decimals). Must align with
   * what `distribute_*_rewards(amount=...)` will be called with on chain —
   * mismatched amounts → proof verification fails.
   *
   * `amounts[i]` is the amount for position i+1 (so length matches
   * `entries.length` ≤ 10).
   */
  amounts: ReadonlyArray<bigint>;
};

/**
 * Build the leaderboard Merkle tree for `entries` (top-N, already ordered).
 *
 * - `entries.length` must equal `amounts.length` (one amount per recipient).
 * - Empty-position rollovers (positions where `entries[i]` is missing) are
 *   NOT included in the tree. The on-chain commit's `merkle_root` covers
 *   only the actual winners; empty positions reduce `claimed_bitmap` to N-of-10.
 */
export function buildLeaderboardMerkleTree(input: BuildTreeInput): LeaderboardMerkleTree {
  const { entries, periodId, periodType, amounts } = input;
  if (entries.length === 0) {
    throw new Error("buildLeaderboardMerkleTree: requires at least one entry");
  }
  if (entries.length > DISTRIBUTION_SLOTS) {
    throw new Error(
      `buildLeaderboardMerkleTree: top-${DISTRIBUTION_SLOTS} max (got ${entries.length})`,
    );
  }
  if (amounts.length !== entries.length) {
    throw new Error(
      `buildLeaderboardMerkleTree: amounts.length (${amounts.length}) must equal entries.length (${entries.length})`,
    );
  }

  const leaves: LeaderboardLeaf[] = entries.map((entry, idx) => {
    const position = idx + 1;
    const amount = amounts[idx]!;
    const recipientBytes = decodePubkey(entry.userPubkey);
    const leafBuf = hashLeaf(recipientBytes, position, periodId, periodType, amount);
    return {
      position,
      recipient: entry.userPubkey,
      recipientBytes,
      amount,
      leafBytes: leafBuf,
      leafHex: leafBuf.toString("hex"),
    };
  });

  const leafBuffers = leaves.map((l) => l.leafBytes);
  const layers = buildSortedPairTreeLayers(leafBuffers);
  const rootBuf = layers[layers.length - 1]![0]!;

  return {
    root: rootBuf.toString("hex"),
    rootBytes: rootBuf,
    leaves,
    proofFor(position: number): string[] {
      if (!Number.isInteger(position) || position < 1 || position > leaves.length) {
        throw new Error(`proofFor: position must be 1..${leaves.length} (got ${position})`);
      }
      const proof = generateSortedPairProof(layers, position - 1);
      return proof.map((b) => b.toString("hex"));
    },
    proofBytesFor(position: number): Buffer[] {
      if (!Number.isInteger(position) || position < 1 || position > leaves.length) {
        throw new Error(`proofBytesFor: position must be 1..${leaves.length} (got ${position})`);
      }
      return generateSortedPairProof(layers, position - 1);
    },
  };
}
