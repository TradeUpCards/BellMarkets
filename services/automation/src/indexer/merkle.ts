// DR-010 Option B — Merkle commitment tree.
//
// Per DR-010 spec:
//   - Leaves = hash(recipient_pubkey || position || period_id)
//   - Standard binary Merkle tree (merkletreejs default)
//   - keccak256 hashing
//   - On-chain commit_leaderboard_root stores 32-byte root
//   - distribute_*_rewards accepts Merkle proof; verifies on chain
//
// Anyone with public on-chain settle events can rebuild user_streaks state
// + reconstruct the Merkle root + verify it matches our committed root.
// This makes admin distribution decisions cryptographically verifiable.
//
// Leaf encoding format (32 bytes):
//   keccak256(
//     concat(
//       sha256(user_pubkey_base58),  // pre-hash so leaf length is fixed
//       u8(position),                // 1..10 (≤10 = single byte)
//       u32_be(period_id)            // big-endian for stable on-chain decode
//     )
//   )
//
// Choosing sha256-pre-hash on the pubkey (instead of raw 32 bytes from
// base58 decode) keeps this module agnostic to Solana pubkey decoding —
// the on-chain verifier just needs to match the same hashing convention.

import { Buffer } from "node:buffer";
import keccak256 from "keccak256";
import { MerkleTree } from "merkletreejs";
import { createHash } from "node:crypto";
import type { LeaderboardEntry } from "../db/types.js";

export type LeaderboardLeaf = {
  position: number; // 1..10
  userPubkey: string;
  /** Hex-encoded 32-byte leaf hash. */
  leafHex: string;
};

export type LeaderboardMerkleTree = {
  root: string; // hex (no 0x prefix), 64 chars
  leaves: LeaderboardLeaf[];
  /** Per-position Merkle proof, hex-encoded buffer array. */
  proofFor: (position: number) => string[];
};

/**
 * Hash a single (userPubkey, position, periodId) tuple into a 32-byte leaf.
 * Pure function — same inputs always produce the same leaf.
 */
export function hashLeaf(userPubkey: string, position: number, periodId: number): Buffer {
  if (!userPubkey || userPubkey.length === 0) {
    throw new Error("hashLeaf: userPubkey must be non-empty");
  }
  if (!Number.isInteger(position) || position < 1 || position > 10) {
    throw new Error(`hashLeaf: position must be 1..10 (got ${position})`);
  }
  if (!Number.isInteger(periodId) || periodId < 0) {
    throw new Error(`hashLeaf: periodId must be non-negative integer (got ${periodId})`);
  }

  // Pre-hash the pubkey to a stable 32-byte buffer.
  const userHash = createHash("sha256").update(userPubkey, "utf8").digest();

  // 32 + 1 + 4 = 37 bytes total
  const buf = Buffer.alloc(37);
  userHash.copy(buf, 0);
  buf.writeUInt8(position, 32);
  buf.writeUInt32BE(periodId, 33);

  // keccak256(payload) — matches the on-chain verifier convention
  return keccak256(buf);
}

/**
 * Build a Merkle tree for the top-N leaderboard.
 *
 * - Top-N entries are processed in input order (caller must apply tie-break
 *   ordering BEFORE calling this). Empty slots (rollover, fewer than 10
 *   participants) are NOT included as leaves — the on-chain distribute call
 *   for empty positions is simply skipped (no recipient, no proof).
 * - Standard binary Merkle (merkletreejs default sortPairs=false).
 *
 * Returns: { root, leaves, proofFor(position) }
 */
export function buildLeaderboardMerkleTree(
  entries: ReadonlyArray<LeaderboardEntry>,
  periodId: number,
): LeaderboardMerkleTree {
  if (entries.length === 0) {
    throw new Error("buildLeaderboardMerkleTree: requires at least one entry");
  }
  if (entries.length > 10) {
    throw new Error(`buildLeaderboardMerkleTree: top-10 max (got ${entries.length})`);
  }

  const leaves: LeaderboardLeaf[] = entries.map((entry, idx) => {
    const position = idx + 1;
    const leafBuf = hashLeaf(entry.userPubkey, position, periodId);
    return {
      position,
      userPubkey: entry.userPubkey,
      leafHex: leafBuf.toString("hex"),
    };
  });

  const leafBuffers = leaves.map((l) => Buffer.from(l.leafHex, "hex"));
  const tree = new MerkleTree(leafBuffers, keccak256, { sortPairs: false });
  const rootBuf = tree.getRoot();
  const root = rootBuf.toString("hex");

  return {
    root,
    leaves,
    proofFor(position: number): string[] {
      if (!Number.isInteger(position) || position < 1 || position > leaves.length) {
        throw new Error(
          `proofFor: position must be 1..${leaves.length} (got ${position})`,
        );
      }
      const leaf = leafBuffers[position - 1];
      if (!leaf) {
        throw new Error(`proofFor: no leaf for position ${position}`);
      }
      return tree.getProof(leaf).map((p) => p.data.toString("hex"));
    },
  };
}

/**
 * Verify a Merkle proof against a committed root. Used for testing the
 * round-trip — production verification happens on chain inside Aria's
 * `distribute_*_rewards` instruction.
 */
export function verifyLeafProof(
  leafHex: string,
  proofHex: ReadonlyArray<string>,
  rootHex: string,
): boolean {
  const leaf = Buffer.from(leafHex, "hex");
  const proofBuffers = proofHex.map((p) => ({ data: Buffer.from(p, "hex"), position: "left" as const }));
  const tree = new MerkleTree([leaf], keccak256, { sortPairs: false });
  return tree.verify(proofBuffers, leaf, Buffer.from(rootHex, "hex"));
}
