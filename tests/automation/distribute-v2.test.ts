import { describe, it, expect, vi } from "vitest";
import {
  runMultiMetricDistribute,
  assignAmountsToRanks,
} from "../../services/automation/src/indexer/distribute-v2.js";
import {
  METRIC_ABSOLUTE_PROFIT,
  METRIC_WIN_STREAK,
  METRIC_WIN_RATE,
  METRIC_ROI,
  type MetricLeaderboardEntry,
} from "../../services/automation/src/indexer/merkle-v2.js";
import * as queries from "../../services/automation/src/db/queries.js";
import type { PeriodInfo } from "../../services/automation/src/indexer/periods.js";
import type { LeaderboardSnapshot } from "../../services/automation/src/db/types.js";

const ALICE = "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV";
const BOB = "4xMt4J2WuLFH77Jq3Yexxuv38Ge36fNnWNRmSKLCiT3c";
const CAROL = "2VWzrhmdNZN7Yxv2uknYBurJ2PDFzCqsyi5WVeVxJpCW";
const DAVE = "Eppjny6RMtVrGxZnjiKEyk41vwWYpXW4PMVKJHC4SAjh";

const WEEKLY_PERIOD: PeriodInfo = {
  kind: "weekly",
  id: 202621,
  start: new Date("2026-05-18T04:00:00.000Z"),
  end: new Date("2026-05-25T04:00:00.000Z"),
};

const WEEKLY_WINDOW = { start: WEEKLY_PERIOD.start, end: WEEKLY_PERIOD.end };

function spySnapshot(): LeaderboardSnapshot {
  return {
    id: 42,
    periodKind: "weekly",
    periodId: 202621,
    periodStart: WEEKLY_PERIOD.start,
    periodEnd: WEEKLY_PERIOD.end,
    merkleRoot: undefined,
    arweaveTxId: undefined,
    committedTxSig: undefined,
    participantsCount: 0,
    fullLeaderboardJson: [],
    createdAt: new Date(),
  };
}

describe("assignAmountsToRanks — per-rank bps × metric pool math", () => {
  it("returns same length as input", () => {
    const entries: MetricLeaderboardEntry[] = [
      { recipient: ALICE, rank: 1, amountBaseUnits: 0n },
      { recipient: BOB, rank: 2, amountBaseUnits: 0n },
    ];
    const out = assignAmountsToRanks(entries, 100_000_000n);
    expect(out).toHaveLength(2);
  });

  it("assigns 25% to rank 1, 18% to rank 2 (DEFAULT_DISTRIBUTION_BPS)", () => {
    const entries: MetricLeaderboardEntry[] = [
      { recipient: ALICE, rank: 1, amountBaseUnits: 0n },
      { recipient: BOB, rank: 2, amountBaseUnits: 0n },
    ];
    const out = assignAmountsToRanks(entries, 100_000_000n); // $100 metric pool
    expect(out[0]!.amountBaseUnits).toBe(25_000_000n); // 25%
    expect(out[1]!.amountBaseUnits).toBe(18_000_000n); // 18%
  });

  it("empty input → empty output", () => {
    expect(assignAmountsToRanks([], 100n)).toEqual([]);
  });

  it("does NOT mutate input array", () => {
    const entries: MetricLeaderboardEntry[] = [{ recipient: ALICE, rank: 1, amountBaseUnits: 999n }];
    const out = assignAmountsToRanks(entries, 100_000_000n);
    expect(entries[0]!.amountBaseUnits).toBe(999n); // input untouched
    expect(out[0]!.amountBaseUnits).not.toBe(999n); // output filled
  });
});

describe("runMultiMetricDistribute — orchestration with all-injected deps", () => {
  it("happy path: 4 metrics with winners → builds tree, calls commit + distribute per (metric, rank)", async () => {
    vi.spyOn(queries, "insertSnapshot").mockImplementation(async (input) => ({
      ...spySnapshot(),
      ...input,
    }));
    vi.spyOn(queries, "insertDistribution").mockResolvedValue(1);

    const commitCalls: unknown[] = [];
    const distCalls: unknown[] = [];

    const outcome = await runMultiMetricDistribute({
      period: WEEKLY_PERIOD,
      periodWindow: WEEKLY_WINDOW,
      readPoolBalance: async () => "100.00",
      leaderboardOverride: {
        profit: [
          { recipient: ALICE, rank: 1, amountBaseUnits: 0n },
          { recipient: BOB, rank: 2, amountBaseUnits: 0n },
        ],
        streak: [{ recipient: CAROL, rank: 1, amountBaseUnits: 0n }],
        winRate: [{ recipient: DAVE, rank: 1, amountBaseUnits: 0n }],
        roi: [], // ROI is the Pro-tier stub
      },
      commitLeaderboardRoot: async (input) => {
        commitCalls.push(input);
        return { ok: true, txSig: `commit-${input.periodId}` };
      },
      distributeRewards: async (input) => {
        distCalls.push(input);
        return { ok: true, txSig: `dist-r${input.position}` };
      },
      uploadFn: async () => ({ txId: "ar-multi-metric-1", stub: false }),
      log: () => {},
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.merkleRootHex).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.commitTxSig).toBe("commit-202621");
    expect(outcome.arweaveTxId).toBe("ar-multi-metric-1");

    // Pool split: 60% profit / 20% streak / 15% winRate / 5% ROI of $100
    expect(outcome.metricBalanceUsdc[METRIC_ABSOLUTE_PROFIT]).toBe("60.00");
    expect(outcome.metricBalanceUsdc[METRIC_WIN_STREAK]).toBe("20.00");
    expect(outcome.metricBalanceUsdc[METRIC_WIN_RATE]).toBe("15.00");
    expect(outcome.metricBalanceUsdc[METRIC_ROI]).toBe("5.00");

    // perPosition has 4 metrics × 10 ranks = 40 rows
    expect(outcome.perPosition).toHaveLength(40);
    const distributed = outcome.perPosition.filter((p) => p.status === "distributed");
    const rolled = outcome.perPosition.filter((p) => p.status === "rolled-over");
    // 2 profit + 1 streak + 1 winRate + 0 roi = 4 distributed
    expect(distributed).toHaveLength(4);
    // Remaining 36 are rolled over
    expect(rolled).toHaveLength(36);

    expect(commitCalls).toHaveLength(1);
    expect(distCalls).toHaveLength(4);

    vi.restoreAllMocks();
  });

  it("zero participants → no Merkle, no commit/distribute, only rollover persistence", async () => {
    vi.spyOn(queries, "insertSnapshot").mockImplementation(async (input) => ({
      ...spySnapshot(),
      ...input,
    }));
    vi.spyOn(queries, "insertDistribution").mockResolvedValue(1);

    const commitFn = vi.fn(async () => ({ ok: true, txSig: "x" } as const));
    const distFn = vi.fn(async () => ({ ok: true, txSig: "y" } as const));

    const outcome = await runMultiMetricDistribute({
      period: WEEKLY_PERIOD,
      periodWindow: WEEKLY_WINDOW,
      readPoolBalance: async () => "100.00",
      leaderboardOverride: { profit: [], streak: [], winRate: [], roi: [] },
      commitLeaderboardRoot: commitFn,
      distributeRewards: distFn,
      uploadFn: async () => ({ txId: "ar-empty", stub: false }),
      log: () => {},
    });

    expect(outcome.merkleRootHex).toBeUndefined();
    expect(commitFn).not.toHaveBeenCalled();
    expect(distFn).not.toHaveBeenCalled();
    // All 40 positions rolled over
    expect(outcome.perPosition.every((p) => p.status === "rolled-over")).toBe(true);
    expect(Number(outcome.rolledOverUsdc)).toBeCloseTo(100, 2);

    vi.restoreAllMocks();
  });

  it("rejects when metricPoolSplitBps doesn't sum to 10000", async () => {
    vi.spyOn(queries, "insertSnapshot").mockResolvedValue(spySnapshot());
    await expect(
      runMultiMetricDistribute({
        period: WEEKLY_PERIOD,
        periodWindow: WEEKLY_WINDOW,
        readPoolBalance: async () => "100",
        leaderboardOverride: { profit: [], streak: [], winRate: [], roi: [] },
        metricPoolSplitBps: {
          [METRIC_ABSOLUTE_PROFIT]: 5000,
          [METRIC_WIN_STREAK]: 2000,
          [METRIC_WIN_RATE]: 1500,
          [METRIC_ROI]: 500, // sum=9000, not 10000
        },
        log: () => {},
      }),
    ).rejects.toThrow(/must sum to 10000/);
    vi.restoreAllMocks();
  });

  it("DR-015 stub mode (no on-chain fns supplied) returns stubbed per-position results", async () => {
    vi.spyOn(queries, "insertSnapshot").mockImplementation(async (input) => ({
      ...spySnapshot(),
      ...input,
    }));
    vi.spyOn(queries, "insertDistribution").mockResolvedValue(1);

    const outcome = await runMultiMetricDistribute({
      period: WEEKLY_PERIOD,
      periodWindow: WEEKLY_WINDOW,
      readPoolBalance: async () => "100.00",
      leaderboardOverride: {
        profit: [{ recipient: ALICE, rank: 1, amountBaseUnits: 0n }],
        streak: [],
        winRate: [],
        roi: [],
      },
      // No commitLeaderboardRoot / distributeRewards injected — stubs fire.
      uploadFn: async () => ({ txId: "ar", stub: true }),
      log: () => {},
    });

    expect(outcome.commitTxSig).toBeUndefined();
    expect(outcome.arweaveStub).toBe(true);
    const aliceRow = outcome.perPosition.find((p) => p.userPubkey === ALICE);
    expect(aliceRow?.status).toBe("stubbed");
    expect(aliceRow?.error?.toLowerCase()).toContain("awaiting aria's deploy");

    vi.restoreAllMocks();
  });
});
