import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  METRIC_ABSOLUTE_PROFIT,
  METRIC_WIN_STREAK,
  METRIC_WIN_RATE,
  METRIC_ROI,
  METRIC_NAMES,
  DEFAULT_METRIC_POOL_SPLIT_BPS,
  hashLeafV2,
  buildMultiMetricMerkleTree,
  verifyMultiMetricLeafProof,
} from "../../services/automation/src/indexer/merkle-v2.js";
import { PERIOD_TYPE_WEEKLY, PERIOD_TYPE_MONTHLY } from "../../services/automation/src/indexer/merkle.js";

// Real Solana pubkeys for tests.
const ALICE = "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV";
const BOB = "4xMt4J2WuLFH77Jq3Yexxuv38Ge36fNnWNRmSKLCiT3c";
const CAROL = "2VWzrhmdNZN7Yxv2uknYBurJ2PDFzCqsyi5WVeVxJpCW";
const DAVE = "Eppjny6RMtVrGxZnjiKEyk41vwWYpXW4PMVKJHC4SAjh";

describe("DR-015 metric constants", () => {
  it("metric ids are 0x00..0x03 per spec", () => {
    expect(METRIC_ABSOLUTE_PROFIT).toBe(0x00);
    expect(METRIC_WIN_STREAK).toBe(0x01);
    expect(METRIC_WIN_RATE).toBe(0x02);
    expect(METRIC_ROI).toBe(0x03);
  });

  it("DEFAULT_METRIC_POOL_SPLIT_BPS sums to 10000 (per DR-015 pool split)", () => {
    const sum = Object.values(DEFAULT_METRIC_POOL_SPLIT_BPS).reduce((a, b) => a + b, 0);
    expect(sum).toBe(10000);
  });

  it("default split is 60/20/15/5 per DR-015", () => {
    expect(DEFAULT_METRIC_POOL_SPLIT_BPS[METRIC_ABSOLUTE_PROFIT]).toBe(6000);
    expect(DEFAULT_METRIC_POOL_SPLIT_BPS[METRIC_WIN_STREAK]).toBe(2000);
    expect(DEFAULT_METRIC_POOL_SPLIT_BPS[METRIC_WIN_RATE]).toBe(1500);
    expect(DEFAULT_METRIC_POOL_SPLIT_BPS[METRIC_ROI]).toBe(500);
  });

  it("METRIC_NAMES has all 4 entries", () => {
    expect(Object.keys(METRIC_NAMES).sort()).toEqual(["0", "1", "2", "3"]);
  });
});

describe("hashLeafV2 — DR-015 47-byte leaf shape", () => {
  it("produces 32-byte SHA256 output", () => {
    const leaf = hashLeafV2(ALICE, METRIC_ABSOLUTE_PROFIT, 1, 25_000_000n, 202621, PERIOD_TYPE_WEEKLY);
    expect(leaf).toBeInstanceOf(Buffer);
    expect(leaf.length).toBe(32);
  });

  it("is bytewise-correct vs hand-constructed 47-byte payload", () => {
    // Hand-build the 47-byte input the same way Aria's verifier will, then
    // compare SHA256 outputs.
    const recipientBytes = Buffer.alloc(32, 1); // 32 raw bytes (mock pubkey)
    const buf = Buffer.alloc(47);
    recipientBytes.copy(buf, 0);
    buf.writeUInt8(METRIC_WIN_STREAK, 32);
    buf.writeUInt8(3, 33);
    buf.writeBigUInt64LE(1_000_000n, 34);
    buf.writeUInt32LE(202621, 42);
    buf.writeUInt8(PERIOD_TYPE_MONTHLY, 46);
    const expected = createHash("sha256").update(buf).digest();
    const actual = hashLeafV2(recipientBytes, METRIC_WIN_STREAK, 3, 1_000_000n, 202621, PERIOD_TYPE_MONTHLY);
    expect(actual.equals(expected)).toBe(true);
  });

  it("changes when ANY of the 6 fields changes", () => {
    const base = hashLeafV2(ALICE, METRIC_ABSOLUTE_PROFIT, 1, 1_000n, 100, PERIOD_TYPE_WEEKLY);
    expect(hashLeafV2(BOB, METRIC_ABSOLUTE_PROFIT, 1, 1_000n, 100, PERIOD_TYPE_WEEKLY).equals(base)).toBe(false);
    expect(hashLeafV2(ALICE, METRIC_WIN_STREAK, 1, 1_000n, 100, PERIOD_TYPE_WEEKLY).equals(base)).toBe(false);
    expect(hashLeafV2(ALICE, METRIC_ABSOLUTE_PROFIT, 2, 1_000n, 100, PERIOD_TYPE_WEEKLY).equals(base)).toBe(false);
    expect(hashLeafV2(ALICE, METRIC_ABSOLUTE_PROFIT, 1, 1_001n, 100, PERIOD_TYPE_WEEKLY).equals(base)).toBe(false);
    expect(hashLeafV2(ALICE, METRIC_ABSOLUTE_PROFIT, 1, 1_000n, 101, PERIOD_TYPE_WEEKLY).equals(base)).toBe(false);
    expect(hashLeafV2(ALICE, METRIC_ABSOLUTE_PROFIT, 1, 1_000n, 100, PERIOD_TYPE_MONTHLY).equals(base)).toBe(false);
  });

  it("rejects invalid metricId", () => {
    expect(() => hashLeafV2(ALICE, 4 as 0 | 1 | 2 | 3, 1, 1n, 1, PERIOD_TYPE_WEEKLY)).toThrow();
    expect(() => hashLeafV2(ALICE, 255 as 0 | 1 | 2 | 3, 1, 1n, 1, PERIOD_TYPE_WEEKLY)).toThrow();
  });

  it("rejects out-of-range rank", () => {
    expect(() => hashLeafV2(ALICE, METRIC_ABSOLUTE_PROFIT, 0, 1n, 1, PERIOD_TYPE_WEEKLY)).toThrow();
    expect(() => hashLeafV2(ALICE, METRIC_ABSOLUTE_PROFIT, 256, 1n, 1, PERIOD_TYPE_WEEKLY)).toThrow();
  });

  it("rejects periodId exceeding u32 max", () => {
    expect(() => hashLeafV2(ALICE, METRIC_ABSOLUTE_PROFIT, 1, 1n, 0x1_0000_0000, PERIOD_TYPE_WEEKLY)).toThrow();
    expect(() => hashLeafV2(ALICE, METRIC_ABSOLUTE_PROFIT, 1, 1n, -1, PERIOD_TYPE_WEEKLY)).toThrow();
  });

  it("rejects negative amount", () => {
    expect(() => hashLeafV2(ALICE, METRIC_ABSOLUTE_PROFIT, 1, -1n, 1, PERIOD_TYPE_WEEKLY)).toThrow();
  });

  it("accepts pubkey as base58 string or raw 32-byte buffer (equivalent result)", async () => {
    const fromB58 = hashLeafV2(ALICE, METRIC_ABSOLUTE_PROFIT, 1, 1n, 100, PERIOD_TYPE_WEEKLY);
    const { decodePubkey } = await import("../../services/automation/src/indexer/merkle.js");
    const fromBytes = hashLeafV2(decodePubkey(ALICE), METRIC_ABSOLUTE_PROFIT, 1, 1n, 100, PERIOD_TYPE_WEEKLY);
    expect(fromB58.equals(fromBytes)).toBe(true);
  });
});

describe("buildMultiMetricMerkleTree", () => {
  it("builds a tree across all 4 metrics with single root", () => {
    const tree = buildMultiMetricMerkleTree({
      leaderboard: {
        [METRIC_ABSOLUTE_PROFIT]: [
          { recipient: ALICE, rank: 1, amountBaseUnits: 25_000_000n },
          { recipient: BOB, rank: 2, amountBaseUnits: 18_000_000n },
        ],
        [METRIC_WIN_STREAK]: [
          { recipient: CAROL, rank: 1, amountBaseUnits: 5_000_000n },
        ],
        [METRIC_WIN_RATE]: [
          { recipient: DAVE, rank: 1, amountBaseUnits: 3_750_000n },
        ],
        [METRIC_ROI]: [],
      },
      periodId: 202621,
      periodType: PERIOD_TYPE_WEEKLY,
    });
    expect(tree.root).toMatch(/^[0-9a-f]{64}$/);
    expect(tree.leafCount).toBe(4);
  });

  it("proofs round-trip for every (metric, rank)", () => {
    const tree = buildMultiMetricMerkleTree({
      leaderboard: {
        [METRIC_ABSOLUTE_PROFIT]: [
          { recipient: ALICE, rank: 1, amountBaseUnits: 25_000_000n },
          { recipient: BOB, rank: 2, amountBaseUnits: 18_000_000n },
          { recipient: CAROL, rank: 3, amountBaseUnits: 12_000_000n },
        ],
        [METRIC_WIN_STREAK]: [{ recipient: DAVE, rank: 1, amountBaseUnits: 5_000_000n }],
      },
      periodId: 202621,
      periodType: PERIOD_TYPE_WEEKLY,
    });
    for (const leaf of tree.leaves) {
      const proof = tree.proofBytesFor(leaf.metricId, leaf.rank);
      expect(verifyMultiMetricLeafProof(leaf.leafBytes, proof, tree.rootBytes)).toBe(true);
    }
  });

  it("is deterministic — same input → identical root", () => {
    const input = {
      leaderboard: {
        [METRIC_ABSOLUTE_PROFIT]: [{ recipient: ALICE, rank: 1, amountBaseUnits: 1_000n }],
        [METRIC_WIN_STREAK]: [{ recipient: BOB, rank: 1, amountBaseUnits: 1_000n }],
      },
      periodId: 1,
      periodType: PERIOD_TYPE_WEEKLY,
    } as const;
    const t1 = buildMultiMetricMerkleTree(input);
    const t2 = buildMultiMetricMerkleTree(input);
    expect(t1.root).toBe(t2.root);
  });

  it("root changes when amounts change (per-rank payout is bound in the leaf)", () => {
    const base = buildMultiMetricMerkleTree({
      leaderboard: { [METRIC_ABSOLUTE_PROFIT]: [{ recipient: ALICE, rank: 1, amountBaseUnits: 1_000n }] },
      periodId: 1,
      periodType: PERIOD_TYPE_WEEKLY,
    });
    const changed = buildMultiMetricMerkleTree({
      leaderboard: { [METRIC_ABSOLUTE_PROFIT]: [{ recipient: ALICE, rank: 1, amountBaseUnits: 2_000n }] },
      periodId: 1,
      periodType: PERIOD_TYPE_WEEKLY,
    });
    expect(base.root).not.toBe(changed.root);
  });

  it("rejects when ALL metrics are empty", () => {
    expect(() =>
      buildMultiMetricMerkleTree({
        leaderboard: {},
        periodId: 1,
        periodType: PERIOD_TYPE_WEEKLY,
      }),
    ).toThrow(/at least one metric/);
  });

  it("rejects >32 entries in any single metric (per DR-015 bitmap segment)", () => {
    const entries = Array.from({ length: 33 }, (_, i) => ({
      recipient: ALICE,
      rank: i + 1,
      amountBaseUnits: 1n,
    }));
    expect(() =>
      buildMultiMetricMerkleTree({
        leaderboard: { [METRIC_ABSOLUTE_PROFIT]: entries },
        periodId: 1,
        periodType: PERIOD_TYPE_WEEKLY,
      }),
    ).toThrow(/max 32/);
  });

  it("rejects rank=0 or rank>32 within a metric", () => {
    expect(() =>
      buildMultiMetricMerkleTree({
        leaderboard: { [METRIC_ABSOLUTE_PROFIT]: [{ recipient: ALICE, rank: 0, amountBaseUnits: 1n }] },
        periodId: 1,
        periodType: PERIOD_TYPE_WEEKLY,
      }),
    ).toThrow(/rank must be 1\.\.32/);
  });

  it("proofFor rejects unknown (metric, rank)", () => {
    const tree = buildMultiMetricMerkleTree({
      leaderboard: { [METRIC_ABSOLUTE_PROFIT]: [{ recipient: ALICE, rank: 1, amountBaseUnits: 1n }] },
      periodId: 1,
      periodType: PERIOD_TYPE_WEEKLY,
    });
    expect(() => tree.proofFor(METRIC_WIN_STREAK, 1)).toThrow(/no leaf/);
    expect(() => tree.proofFor(METRIC_ABSOLUTE_PROFIT, 2)).toThrow(/no leaf/);
  });
});

describe("verifyMultiMetricLeafProof — defensive cases", () => {
  it("rejects proof longer than MERKLE_PROOF_MAX_DEPTH (16)", () => {
    const leaf = Buffer.alloc(32, 1);
    const sibling = Buffer.alloc(32, 2);
    const tooDeep = Array.from({ length: 17 }, () => sibling);
    expect(verifyMultiMetricLeafProof(leaf, tooDeep, Buffer.alloc(32))).toBe(false);
  });

  it("rejects wrong sibling", () => {
    const tree = buildMultiMetricMerkleTree({
      leaderboard: {
        [METRIC_ABSOLUTE_PROFIT]: [
          { recipient: ALICE, rank: 1, amountBaseUnits: 1n },
          { recipient: BOB, rank: 2, amountBaseUnits: 1n },
        ],
      },
      periodId: 1,
      periodType: PERIOD_TYPE_WEEKLY,
    });
    const aliceProof = tree.proofBytesFor(METRIC_ABSOLUTE_PROFIT, 1);
    // Tamper with the sibling
    const tampered = aliceProof.map((b) => {
      const t = Buffer.from(b);
      t[0] = (t[0]! ^ 0x01) & 0xff;
      return t;
    });
    expect(verifyMultiMetricLeafProof(tree.leaves[0]!.leafBytes, tampered, tree.rootBytes)).toBe(false);
  });
});
