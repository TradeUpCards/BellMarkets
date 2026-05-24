import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_DISTRIBUTION_BPS,
  applyDeterministicTiebreaker,
  runDistributeForPeriod,
} from "../../services/automation/src/indexer/distribute.js";
import type { LeaderboardEntry } from "../../services/automation/src/db/types.js";
import * as queries from "../../services/automation/src/db/queries.js";

// Real-shape base58 pubkeys (32 raw bytes). Tests that exercise the Merkle
// leaf path use these (since `decodePubkey()` rejects non-32-byte strings).
// Tests that only exercise the tiebreaker sort use the plain `entry()`
// helper with single-letter aliases.
const REAL_PUBKEYS = [
  "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV",
  "4xMt4J2WuLFH77Jq3Yexxuv38Ge36fNnWNRmSKLCiT3c",
  "2VWzrhmdNZN7Yxv2uknYBurJ2PDFzCqsyi5WVeVxJpCW",
  "Eppjny6RMtVrGxZnjiKEyk41vwWYpXW4PMVKJHC4SAjh",
  "FxohonFj6bTtbPxe4HNjwy736sqkyPfKj5GRektScF7C",
  "6CYzWhTMzsndRrnRcHgWCUfVDvrRh3Cfoze6GSVev9gQ",
  "7b17F2woUy9hgHcRjuLckBVAtNnKAJBRD769URvLprp5",
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  "CS2H8nbAVVEUHWPF5extCSymqheQdkd4d7thik6eet9N",
  "J83w4HKfFqVghYYjAYTQTzAQ9QQbpDgN1qmcQxk8q1QH",
];

function entry(
  userPubkey: string,
  currentStreak: number,
  totalMarketsTraded = 10,
): LeaderboardEntry {
  return {
    userPubkey,
    currentStreak,
    longestStreak: currentStreak,
    totalMarketsTraded,
    totalMarketsWon: currentStreak,
  };
}

function realEntry(
  index: number,
  currentStreak: number,
  totalMarketsTraded = 10,
): LeaderboardEntry {
  return entry(REAL_PUBKEYS[index % REAL_PUBKEYS.length]!, currentStreak, totalMarketsTraded);
}

describe("DEFAULT_DISTRIBUTION_BPS", () => {
  it("sums to 10000 (per DR-010 spec)", () => {
    const sum = DEFAULT_DISTRIBUTION_BPS.reduce((a, b) => a + b, 0);
    expect(sum).toBe(10000);
  });

  it("has 10 positions with monotonically non-increasing values", () => {
    expect(DEFAULT_DISTRIBUTION_BPS).toHaveLength(10);
    for (let i = 1; i < DEFAULT_DISTRIBUTION_BPS.length; i++) {
      expect(DEFAULT_DISTRIBUTION_BPS[i]!).toBeLessThanOrEqual(DEFAULT_DISTRIBUTION_BPS[i - 1]!);
    }
  });

  it("position 1 is 2500 (25%)", () => {
    expect(DEFAULT_DISTRIBUTION_BPS[0]).toBe(2500);
  });

  it("position 10 is 400 (4%)", () => {
    expect(DEFAULT_DISTRIBUTION_BPS[9]).toBe(400);
  });
});

describe("applyDeterministicTiebreaker", () => {
  it("preserves order when no ties exist", () => {
    const entries = [entry("a", 5), entry("b", 4), entry("c", 3)];
    const shuffled = applyDeterministicTiebreaker(entries, (x) => x.reverse());
    expect(shuffled.map((e) => e.userPubkey)).toEqual(["a", "b", "c"]);
  });

  it("shuffles only entries with identical (currentStreak, totalMarketsTraded)", () => {
    const entries = [
      entry("a", 5, 10),
      entry("b", 5, 10), // tie with a
      entry("c", 5, 10), // tie with a, b
      entry("d", 4, 10),
    ];
    // Inject a deterministic shuffler that reverses the array.
    const result = applyDeterministicTiebreaker(entries, (x) => x.reverse());
    // a/b/c reversed; d unchanged at position 4
    expect(result.map((e) => e.userPubkey)).toEqual(["c", "b", "a", "d"]);
  });

  it("does NOT shuffle when totalMarketsTraded differs (already broken at SQL layer)", () => {
    const entries = [entry("a", 5, 20), entry("b", 5, 10)];
    // SQL ORDER BY current_streak DESC, total_markets_traded DESC already
    // ordered these. Our function sees they have different totalMarketsTraded
    // so they're not tied.
    const result = applyDeterministicTiebreaker(entries, (x) => x.reverse());
    expect(result.map((e) => e.userPubkey)).toEqual(["a", "b"]);
  });

  it("empty input → empty output", () => {
    expect(applyDeterministicTiebreaker([], (x) => x)).toEqual([]);
  });
});

describe("runDistributeForPeriod — orchestration with all-injected deps", () => {
  it("happy path: 10 winners → 10 distributions; commit + arweave + per-position invoked", async () => {
    const winners: LeaderboardEntry[] = Array.from({ length: 10 }, (_, i) => realEntry(i, 10 - i, 10));

    // Mock all DB queries to no-op + return synthetic ids.
    const spyTop = vi.spyOn(queries, "topNLeaderboard").mockResolvedValue(winners);
    const spyInsertSnapshot = vi
      .spyOn(queries, "insertSnapshot")
      .mockImplementation(async (input) => ({
        id: 1,
        ...input,
        createdAt: new Date(),
      }));
    const spyInsertDist = vi.spyOn(queries, "insertDistribution").mockResolvedValue(99);

    const commitCalls: unknown[] = [];
    const distCalls: unknown[] = [];

    const outcome = await runDistributeForPeriod({
      period: {
        kind: "weekly",
        id: 202621,
        start: new Date("2026-05-18T04:00:00Z"),
        end: new Date("2026-05-25T04:00:00Z"),
      },
      readPoolBalance: async () => "100.00",
      commitLeaderboardRoot: async (input) => {
        commitCalls.push(input);
        return { ok: true, txSig: `commit-${input.periodId}` };
      },
      distributeRewards: async (input) => {
        distCalls.push(input);
        return { ok: true, txSig: `dist-${input.position}` };
      },
      uploadFn: async (snap) => ({ txId: `ar-${snap.periodId}`, stub: false }),
      shuffle: (x) => x, // identity (no shuffle needed — no ties here)
      log: () => {},
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.commitTxSig).toBe("commit-202621");
    expect(outcome.arweaveTxId).toBe("ar-202621");
    expect(outcome.arweaveStub).toBe(false);
    expect(outcome.perPosition).toHaveLength(10);
    for (const pos of outcome.perPosition) {
      expect(pos.status).toBe("distributed");
    }
    expect(commitCalls).toHaveLength(1);
    expect(distCalls).toHaveLength(10);

    // Deploy-6 reconciliation: every v1 distribute call carries
    // metricId = 0 (METRIC_ABSOLUTE_PROFIT) — the DR-010 single-metric
    // path implicitly ranked by profit. Without this field, Aria's
    // deploy-6 IDL would reject the call (period_id, position, ...)
    // for a deploy-5-era 4-arg shape.
    for (const call of distCalls) {
      expect((call as { metricId: number }).metricId).toBe(0);
    }

    // Sum of position amounts ≈ pool (modulo cent rounding)
    const sumCents = outcome.perPosition.reduce(
      (acc, p) => acc + Math.round(Number(p.amountUsdc) * 100),
      0,
    );
    expect(sumCents).toBeLessThanOrEqual(10000); // = $100.00
    expect(sumCents).toBeGreaterThan(9990); // tolerance for cent rounding

    spyTop.mockRestore();
    spyInsertSnapshot.mockRestore();
    spyInsertDist.mockRestore();
  });

  it("fewer than 10 winners → empty positions recorded as rolled-over", async () => {
    const winners: LeaderboardEntry[] = [realEntry(0, 5), realEntry(1, 4), realEntry(2, 3)];

    vi.spyOn(queries, "topNLeaderboard").mockResolvedValue(winners);
    vi.spyOn(queries, "insertSnapshot").mockImplementation(async (input) => ({ id: 2, ...input, createdAt: new Date() }));
    vi.spyOn(queries, "insertDistribution").mockResolvedValue(1);

    const outcome = await runDistributeForPeriod({
      period: { kind: "weekly", id: 202621, start: new Date(), end: new Date() },
      readPoolBalance: async () => "100.00",
      commitLeaderboardRoot: async () => ({ ok: true, txSig: "commit" }),
      distributeRewards: async (input) => ({ ok: true, txSig: `d-${input.position}` }),
      uploadFn: async () => ({ txId: "ar-id", stub: false }),
      shuffle: (x) => x,
      log: () => {},
    });

    expect(outcome.perPosition).toHaveLength(10);
    const distributed = outcome.perPosition.filter((p) => p.status === "distributed");
    const rolled = outcome.perPosition.filter((p) => p.status === "rolled-over");
    expect(distributed).toHaveLength(3);
    expect(rolled).toHaveLength(7);
    expect(rolled.every((r) => r.userPubkey === undefined)).toBe(true);
    expect(Number(outcome.rolledOverUsdc)).toBeGreaterThan(0); // some pool rolled over

    vi.restoreAllMocks();
  });

  it("zero participants → snapshot persisted with no Merkle, no on-chain calls beyond commit-skip", async () => {
    vi.spyOn(queries, "topNLeaderboard").mockResolvedValue([]);
    vi.spyOn(queries, "insertSnapshot").mockImplementation(async (input) => ({ id: 3, ...input, createdAt: new Date() }));
    vi.spyOn(queries, "insertDistribution").mockResolvedValue(1);

    const commitFn = vi.fn(async () => ({ ok: true, txSig: "x" } as const));
    const distFn = vi.fn(async () => ({ ok: true, txSig: "y" } as const));

    const outcome = await runDistributeForPeriod({
      period: { kind: "weekly", id: 202621, start: new Date(), end: new Date() },
      readPoolBalance: async () => "100.00",
      commitLeaderboardRoot: commitFn,
      distributeRewards: distFn,
      uploadFn: async () => ({ txId: "ar-empty", stub: false }),
      shuffle: (x) => x,
      log: () => {},
    });

    expect(outcome.perPosition).toHaveLength(10);
    expect(outcome.perPosition.every((p) => p.status === "rolled-over")).toBe(true);
    // Commit not called when there's no merkle root
    expect(commitFn).not.toHaveBeenCalled();
    // Distribute never called for rolled-over positions
    expect(distFn).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("stub on-chain calls (Aria's ixs missing) → persistence happens; per-position marked errored", async () => {
    const winners: LeaderboardEntry[] = [realEntry(0, 5)];
    vi.spyOn(queries, "topNLeaderboard").mockResolvedValue(winners);
    vi.spyOn(queries, "insertSnapshot").mockImplementation(async (input) => ({ id: 4, ...input, createdAt: new Date() }));
    vi.spyOn(queries, "insertDistribution").mockResolvedValue(1);

    const outcome = await runDistributeForPeriod({
      period: { kind: "weekly", id: 202621, start: new Date(), end: new Date() },
      readPoolBalance: async () => "50.00",
      // Don't inject commitLeaderboardRoot or distributeRewards — defaults
      // are stubs that return ok=false.
      uploadFn: async () => ({ txId: "ar", stub: true }),
      shuffle: (x) => x,
      log: () => {},
    });

    expect(outcome.arweaveStub).toBe(true);
    expect(outcome.commitTxSig).toBeUndefined();
    // First position errors out (stub distribute returned ok=false)
    expect(outcome.perPosition[0]!.status).toBe("errored");
    expect(outcome.perPosition[0]!.error).toContain("Awaiting Aria");

    vi.restoreAllMocks();
  });
});
