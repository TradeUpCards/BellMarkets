import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  hashLeaf,
  buildLeaderboardMerkleTree,
  verifyLeafProof,
  decodePubkey,
  PERIOD_TYPE_WEEKLY,
  PERIOD_TYPE_MONTHLY,
  MERKLE_PROOF_MAX_DEPTH,
} from "../../services/automation/src/indexer/merkle.js";
import type { LeaderboardEntry } from "../../services/automation/src/db/types.js";

function entry(userPubkey: string, currentStreak: number): LeaderboardEntry {
  return {
    userPubkey,
    currentStreak,
    longestStreak: currentStreak,
    totalMarketsTraded: 10,
    totalMarketsWon: currentStreak,
  };
}

// Real Solana pubkeys (base58, 32-byte decode) for test vectors.
// "11111111111111111111111111111111" is System Program → 32 zero bytes.
const PUBKEY_ZEROES = "11111111111111111111111111111111";
// We need a known-good 32-byte-base58 — these are real devnet pubkeys.
const ALICE_PK = "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV"; // Aria's program ID
const BOB_PK = "4xMt4J2WuLFH77Jq3Yexxuv38Ge36fNnWNRmSKLCiT3c"; // FeeConfig PDA
const CAROL_PK = "2VWzrhmdNZN7Yxv2uknYBurJ2PDFzCqsyi5WVeVxJpCW"; // WeeklyPool PDA
const DAVE_PK = "Eppjny6RMtVrGxZnjiKEyk41vwWYpXW4PMVKJHC4SAjh"; // MonthlyPool PDA

describe("decodePubkey", () => {
  it("System Program (all-1s base58) decodes to 32 zero bytes", () => {
    const bytes = decodePubkey(PUBKEY_ZEROES);
    expect(bytes.length).toBe(32);
    for (let i = 0; i < 32; i++) expect(bytes[i]).toBe(0);
  });

  it("Aria's program ID decodes to a 32-byte non-zero buffer", () => {
    const bytes = decodePubkey(ALICE_PK);
    expect(bytes.length).toBe(32);
    // Not all zeroes
    expect(bytes.some((b) => b !== 0)).toBe(true);
  });

  it("rejects empty or non-string input", () => {
    expect(() => decodePubkey("")).toThrow();
    expect(() => decodePubkey(undefined as unknown as string)).toThrow();
  });

  it("rejects invalid base58 chars", () => {
    expect(() => decodePubkey("not-base58-because-of-dash")).toThrow();
    expect(() => decodePubkey("OOOOIIIIllll0000")).toThrow(); // 'O' and 'l' and '0' are not base58
  });

  it("rejects strings that decode to wrong length", () => {
    // Solana pubkeys are 32 bytes. A short base58 won't satisfy.
    expect(() => decodePubkey("abc")).toThrow(/32 bytes/);
  });
});

describe("hashLeaf — matches Aria's compute_leaf semantics", () => {
  it("matches Aria's Rust test vector: recipient=[1u8;32], pos=1, period=100, type=WEEKLY(0), amount=1000", () => {
    // From programs/bell-markets/src/merkle.rs `leaf_hash_deterministic`:
    //   recipient = Pubkey::new_from_array([1u8; 32])
    //   position = 1, period_id = 100, period_type = PERIOD_TYPE_WEEKLY(0), amount = 1000
    // Expected: sha256(repeat(0x01)(32) || 0x01 || 100_le_u64 || 0x00 || 1000_le_u64)
    const recipient = Buffer.alloc(32, 1);
    const leaf = hashLeaf(recipient, 1, 100n, PERIOD_TYPE_WEEKLY, 1000n);

    // Build the same input in TS and compare against an independent sha256.
    const input = Buffer.alloc(50);
    recipient.copy(input, 0);
    input.writeUInt8(1, 32);
    input.writeBigUInt64LE(100n, 33);
    input.writeUInt8(0, 41);
    input.writeBigUInt64LE(1000n, 42);
    const expected = createHash("sha256").update(input).digest();

    expect(leaf.equals(expected)).toBe(true);
  });

  it("changes when any of the 5 fields changes (matches Aria's leaf_hash_changes_with_each_field)", () => {
    const r1 = Buffer.alloc(32, 1);
    const r2 = Buffer.alloc(32, 2);
    const base = hashLeaf(r1, 1, 100n, PERIOD_TYPE_WEEKLY, 1000n);
    expect(hashLeaf(r2, 1, 100n, PERIOD_TYPE_WEEKLY, 1000n).equals(base)).toBe(false);
    expect(hashLeaf(r1, 2, 100n, PERIOD_TYPE_WEEKLY, 1000n).equals(base)).toBe(false);
    expect(hashLeaf(r1, 1, 101n, PERIOD_TYPE_WEEKLY, 1000n).equals(base)).toBe(false);
    expect(hashLeaf(r1, 1, 100n, PERIOD_TYPE_MONTHLY, 1000n).equals(base)).toBe(false);
    expect(hashLeaf(r1, 1, 100n, PERIOD_TYPE_WEEKLY, 1001n).equals(base)).toBe(false);
  });

  it("accepts pubkey as base58 string or raw bytes (equivalent result)", () => {
    const fromB58 = hashLeaf(ALICE_PK, 3, 202621n, PERIOD_TYPE_WEEKLY, 25_000_000n);
    const bytes = decodePubkey(ALICE_PK);
    const fromBytes = hashLeaf(bytes, 3, 202621n, PERIOD_TYPE_WEEKLY, 25_000_000n);
    expect(fromB58.equals(fromBytes)).toBe(true);
  });

  it("accepts periodId / amount as number or bigint", () => {
    const a = hashLeaf(ALICE_PK, 1, 100, PERIOD_TYPE_WEEKLY, 1000);
    const b = hashLeaf(ALICE_PK, 1, 100n, PERIOD_TYPE_WEEKLY, 1000n);
    expect(a.equals(b)).toBe(true);
  });

  it("rejects invalid position", () => {
    expect(() => hashLeaf(ALICE_PK, 0, 1, PERIOD_TYPE_WEEKLY, 1)).toThrow();
    expect(() => hashLeaf(ALICE_PK, 11, 1, PERIOD_TYPE_WEEKLY, 1)).toThrow();
  });

  it("rejects invalid periodType", () => {
    expect(() => hashLeaf(ALICE_PK, 1, 1, 2 as 0 | 1, 1)).toThrow();
  });

  it("rejects negative periodId / amount", () => {
    expect(() => hashLeaf(ALICE_PK, 1, -1, PERIOD_TYPE_WEEKLY, 1)).toThrow();
    expect(() => hashLeaf(ALICE_PK, 1, 1, PERIOD_TYPE_WEEKLY, -1)).toThrow();
  });
});

describe("buildLeaderboardMerkleTree — sorted-pair, SHA256", () => {
  it("single-leaf tree: root == leaf hash", () => {
    const tree = buildLeaderboardMerkleTree({
      entries: [entry(ALICE_PK, 5)],
      periodId: 202621n,
      periodType: PERIOD_TYPE_WEEKLY,
      amounts: [25_000_000n],
    });
    expect(tree.root).toBe(tree.leaves[0]!.leafHex);
  });

  it("returns root + proofs that verify off-chain", () => {
    const entries = [entry(ALICE_PK, 5), entry(BOB_PK, 4), entry(CAROL_PK, 3)];
    const amounts = [25_000_000n, 18_000_000n, 12_000_000n];
    const tree = buildLeaderboardMerkleTree({
      entries,
      periodId: 202621n,
      periodType: PERIOD_TYPE_WEEKLY,
      amounts,
    });
    for (let position = 1; position <= entries.length; position++) {
      const proof = tree.proofBytesFor(position);
      const leaf = tree.leaves[position - 1]!.leafBytes;
      expect(verifyLeafProof(leaf, proof, tree.rootBytes)).toBe(true);
    }
  });

  it("is deterministic — same input → identical root", () => {
    const entries = [entry(ALICE_PK, 5), entry(BOB_PK, 4)];
    const t1 = buildLeaderboardMerkleTree({
      entries,
      periodId: 202621n,
      periodType: PERIOD_TYPE_WEEKLY,
      amounts: [25_000_000n, 18_000_000n],
    });
    const t2 = buildLeaderboardMerkleTree({
      entries,
      periodId: 202621n,
      periodType: PERIOD_TYPE_WEEKLY,
      amounts: [25_000_000n, 18_000_000n],
    });
    expect(t1.root).toBe(t2.root);
  });

  it("root changes when periodId changes", () => {
    const entries = [entry(ALICE_PK, 5)];
    const amounts = [25_000_000n];
    const t1 = buildLeaderboardMerkleTree({
      entries,
      periodId: 202621n,
      periodType: PERIOD_TYPE_WEEKLY,
      amounts,
    });
    const t2 = buildLeaderboardMerkleTree({
      entries,
      periodId: 202622n,
      periodType: PERIOD_TYPE_WEEKLY,
      amounts,
    });
    expect(t1.root).not.toBe(t2.root);
  });

  it("root changes when periodType changes (weekly vs monthly)", () => {
    const entries = [entry(ALICE_PK, 5)];
    const amounts = [25_000_000n];
    const weekly = buildLeaderboardMerkleTree({
      entries,
      periodId: 202621n,
      periodType: PERIOD_TYPE_WEEKLY,
      amounts,
    });
    const monthly = buildLeaderboardMerkleTree({
      entries,
      periodId: 202621n,
      periodType: PERIOD_TYPE_MONTHLY,
      amounts,
    });
    expect(weekly.root).not.toBe(monthly.root);
  });

  it("root changes when amount changes (different distribute amounts → different leaf)", () => {
    const entries = [entry(ALICE_PK, 5)];
    const a = buildLeaderboardMerkleTree({
      entries,
      periodId: 1n,
      periodType: PERIOD_TYPE_WEEKLY,
      amounts: [1_000_000n],
    });
    const b = buildLeaderboardMerkleTree({
      entries,
      periodId: 1n,
      periodType: PERIOD_TYPE_WEEKLY,
      amounts: [2_000_000n],
    });
    expect(a.root).not.toBe(b.root);
  });

  it("rejects empty entries", () => {
    expect(() =>
      buildLeaderboardMerkleTree({
        entries: [],
        periodId: 1n,
        periodType: PERIOD_TYPE_WEEKLY,
        amounts: [],
      }),
    ).toThrow(/at least one/);
  });

  it("rejects >10 entries", () => {
    const entries = Array.from({ length: 11 }, (_, i) => entry(ALICE_PK, 5 - (i % 4)));
    const amounts = Array.from({ length: 11 }, () => 1_000_000n);
    expect(() =>
      buildLeaderboardMerkleTree({
        entries,
        periodId: 1n,
        periodType: PERIOD_TYPE_WEEKLY,
        amounts,
      }),
    ).toThrow(/top-10 max/);
  });

  it("rejects mismatched amounts.length vs entries.length", () => {
    expect(() =>
      buildLeaderboardMerkleTree({
        entries: [entry(ALICE_PK, 5)],
        periodId: 1n,
        periodType: PERIOD_TYPE_WEEKLY,
        amounts: [1_000_000n, 2_000_000n],
      }),
    ).toThrow(/length/);
  });

  it("proofFor rejects out-of-range position", () => {
    const tree = buildLeaderboardMerkleTree({
      entries: [entry(ALICE_PK, 5), entry(BOB_PK, 4)],
      periodId: 1n,
      periodType: PERIOD_TYPE_WEEKLY,
      amounts: [1n, 2n],
    });
    expect(() => tree.proofFor(0)).toThrow();
    expect(() => tree.proofFor(3)).toThrow();
  });
});

describe("sorted-pair pairing — matches Aria's Rust unit-test vectors", () => {
  // Aria's test in programs/bell-markets/src/merkle.rs:
  //   let a = h("alice");  // = sha256("alice")
  //   let b = h("bob");
  //   let root = pair(a, b);  // pair = sha256(min(a,b) || max(a,b))
  //   verify_merkle_proof(a, &[b], root) → true
  //   verify_merkle_proof(b, &[a], root) → true
  it("two-leaf tree built from sha256('alice') + sha256('bob') verifies in both directions", () => {
    const a = createHash("sha256").update("alice").digest();
    const b = createHash("sha256").update("bob").digest();
    const concat = Buffer.alloc(64);
    if (Buffer.compare(a, b) <= 0) {
      a.copy(concat, 0);
      b.copy(concat, 32);
    } else {
      b.copy(concat, 0);
      a.copy(concat, 32);
    }
    const root = createHash("sha256").update(concat).digest();

    // verify a → [b] → root
    expect(verifyLeafProof(a, [b], root)).toBe(true);
    // verify b → [a] → root
    expect(verifyLeafProof(b, [a], root)).toBe(true);
  });

  it("four-leaf tree matches Aria's four_leaves_two_step_proof exactly", () => {
    const a = createHash("sha256").update("alice").digest();
    const b = createHash("sha256").update("bob").digest();
    const c = createHash("sha256").update("carol").digest();
    const d = createHash("sha256").update("dave").digest();

    const pair = (x: Buffer, y: Buffer): Buffer => {
      const concat = Buffer.alloc(64);
      if (Buffer.compare(x, y) <= 0) {
        x.copy(concat, 0);
        y.copy(concat, 32);
      } else {
        y.copy(concat, 0);
        x.copy(concat, 32);
      }
      return createHash("sha256").update(concat).digest();
    };

    const ab = pair(a, b);
    const cd = pair(c, d);
    const root = pair(ab, cd);

    expect(verifyLeafProof(a, [b, cd], root)).toBe(true);
    expect(verifyLeafProof(c, [d, ab], root)).toBe(true);
    // Wrong sibling rejects
    expect(verifyLeafProof(a, [c, cd], root)).toBe(false);
  });

  it("verifyLeafProof rejects when depth > MERKLE_PROOF_MAX_DEPTH (16)", () => {
    const leaf = Buffer.alloc(32, 1);
    const sibling = Buffer.alloc(32, 2);
    const proof = Array.from({ length: MERKLE_PROOF_MAX_DEPTH + 1 }, () => sibling);
    expect(verifyLeafProof(leaf, proof, Buffer.alloc(32))).toBe(false);
  });
});

describe("PERIOD_TYPE constants match state.rs", () => {
  it("WEEKLY = 0, MONTHLY = 1", () => {
    expect(PERIOD_TYPE_WEEKLY).toBe(0);
    expect(PERIOD_TYPE_MONTHLY).toBe(1);
  });
});
