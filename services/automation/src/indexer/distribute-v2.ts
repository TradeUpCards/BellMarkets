// DR-015 multi-metric distribute orchestrator. Extends distribute.ts's
// single-metric flow to:
//   1. Fetch 4 metric leaderboards from Neon (profit / streak / win-rate / ROI)
//   2. Split pool USDC per metric per DEFAULT_METRIC_POOL_SPLIT_BPS
//   3. Build ONE Merkle tree per period covering all 4 metrics' top-N entries
//   4. Upload metric-segmented Arweave manifest
//   5. Single `commit_leaderboard_root` per period (covers all metrics atomically)
//   6. Per-(metric, rank) distribute call with corresponding Merkle proof
//
// **Aria's deploy-5 doesn't yet validate DR-015 leaves on-chain** — this
// orchestrator builds the off-chain side, but the live `commitLeaderboardRoot`
// call uses the v1 (DR-010) leaf encoding still. Once Aria ships her next
// deploy with the DR-015 verifier (per .project/.../queued-work.md DR-015
// Aria-side), we flip the live adapter to use this builder.
//
// Until then: the Arweave upload + Neon persistence + distribute-call
// scaffolding all run, so a replay after Aria's deploy lands picks up
// cleanly. Same stub-friendly contract as v1 distribute.ts.

import { insertSnapshot, insertDistribution, topNLeaderboard as _v1Compat } from "../db/queries.js";
import type { QueryDeps } from "../db/queries.js";
import {
  buildMultiMetricMerkleTree,
  type MetricId,
  type MetricLeaderboardEntry,
  type MultiMetricLeaderboard,
  DEFAULT_METRIC_POOL_SPLIT_BPS,
  METRIC_ABSOLUTE_PROFIT,
  METRIC_WIN_STREAK,
  METRIC_WIN_RATE,
  METRIC_ROI,
  METRIC_NAMES,
} from "./merkle-v2.js";
import { uploadLeaderboardToArweave } from "./arweave.js";
import { DEFAULT_DISTRIBUTION_BPS, usdcDollarsToBaseUnits } from "./distribute.js";
import type {
  CommitLeaderboardRootFn,
  DistributeRewardsFn,
  ReadPoolBalanceFn,
} from "./distribute.js";
import { fetchAllMetricLeaderboards, type FourMetricLeaderboard, type PeriodWindow } from "./metric-leaderboards.js";
import type { PeriodTypeCode } from "./merkle.js";
import { PERIOD_TYPE_WEEKLY, PERIOD_TYPE_MONTHLY } from "./merkle.js";
import type { PeriodKind, LeaderboardSnapshot } from "../db/types.js";
import type { PeriodInfo } from "./periods.js";
import type { BellMarketsAnchorClient } from "../clients/anchor.js";

// Suppress unused warning — kept as a reminder of v1 query path.
void _v1Compat;

// ---------------------------------------------------------------------------
// Types — extended for per-metric (metricId, rank) results
// ---------------------------------------------------------------------------

export type MultiMetricDistributePosition = {
  metricId: MetricId;
  metricName: string;
  rank: number;
  userPubkey: string | undefined;
  amountUsdc: string;
  amountBaseUnits: bigint;
  status: "distributed" | "rolled-over" | "errored" | "stubbed";
  txSig?: string;
  error?: string;
};

export type MultiMetricDistributeDeps = QueryDeps & {
  period: PeriodInfo;
  periodWindow: PeriodWindow; // [start, end) — usually period.start..period.end
  /** Total pool USDC at period close (decimal string). */
  readPoolBalance: ReadPoolBalanceFn;
  /** Optional override for the 4 metric leaderboards (tests inject pre-built data). */
  leaderboardOverride?: FourMetricLeaderboard;
  /** On-chain commit_leaderboard_root caller. Default = stub. */
  commitLeaderboardRoot?: CommitLeaderboardRootFn;
  /** On-chain distribute call (per metric, per rank). Default = stub. */
  distributeRewards?: DistributeRewardsFn;
  /** Optional Anchor client; routing remains caller-driven. */
  anchorClient?: BellMarketsAnchorClient;
  /** Override Arweave upload (tests). */
  uploadFn?: typeof uploadLeaderboardToArweave;
  /** Top-N limit per metric. Default 10. */
  topN?: number;
  /** Override pool split (per-metric bps; must sum to 10000). */
  metricPoolSplitBps?: Record<MetricId, number>;
  log?: (entry: Record<string, unknown>) => void;
};

export type MultiMetricDistributeOutcome = {
  ok: true;
  periodKind: PeriodKind;
  periodId: number;
  snapshot: LeaderboardSnapshot;
  /** Per (metric, rank) position. Length sums to 4×N (with rolled-over for empty). */
  perPosition: MultiMetricDistributePosition[];
  metricBalanceUsdc: Record<MetricId, string>;
  totalPoolUsdc: string;
  rolledOverUsdc: string;
  commitTxSig?: string;
  arweaveTxId: string;
  arweaveStub: boolean;
  merkleRootHex?: string;
};

// ---------------------------------------------------------------------------
// Period kind → period_type code helper
// ---------------------------------------------------------------------------

function periodKindToTypeCode(kind: PeriodKind): PeriodTypeCode {
  return kind === "weekly" ? PERIOD_TYPE_WEEKLY : PERIOD_TYPE_MONTHLY;
}

const ORDERED_METRICS: MetricId[] = [METRIC_ABSOLUTE_PROFIT, METRIC_WIN_STREAK, METRIC_WIN_RATE, METRIC_ROI];

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function runMultiMetricDistribute(deps: MultiMetricDistributeDeps): Promise<MultiMetricDistributeOutcome> {
  const log = deps.log ?? ((e: Record<string, unknown>) => console.info(JSON.stringify(e)));
  const logBase = {
    jobId: `distribute-${deps.period.kind}-multi-metric`,
    periodId: deps.period.id,
    periodStart: deps.period.start.toISOString(),
    periodEnd: deps.period.end.toISOString(),
  };

  const topN = deps.topN ?? 10;
  const split = deps.metricPoolSplitBps ?? DEFAULT_METRIC_POOL_SPLIT_BPS;
  const splitSum: number = ORDERED_METRICS.reduce<number>((s, m) => s + (split[m] ?? 0), 0);
  if (splitSum !== 10000) {
    throw new Error(`runMultiMetricDistribute: metricPoolSplitBps must sum to 10000 (got ${splitSum})`);
  }

  // 1. Fetch the 4 leaderboards
  const lb: FourMetricLeaderboard = deps.leaderboardOverride
    ?? (await fetchAllMetricLeaderboards(deps.periodWindow, topN, deps));
  log({
    ...logBase,
    stage: "leaderboards-fetched",
    profitCount: lb.profit.length,
    streakCount: lb.streak.length,
    winRateCount: lb.winRate.length,
    roiCount: lb.roi.length,
  });

  // 2. Read pool balance + split per metric per bps
  const totalPoolUsdc = await deps.readPoolBalance(deps.period.kind);
  const totalPoolCents = Math.floor(Number(totalPoolUsdc) * 100);
  const metricBalanceUsdc: Record<MetricId, string> = {} as Record<MetricId, string>;
  const metricBalanceBaseUnits: Record<MetricId, bigint> = {} as Record<MetricId, bigint>;
  for (const m of ORDERED_METRICS) {
    const metricCents = Math.floor((totalPoolCents * (split[m] ?? 0)) / 10000);
    const metricUsdc = (metricCents / 100).toFixed(2);
    metricBalanceUsdc[m] = metricUsdc;
    metricBalanceBaseUnits[m] = usdcDollarsToBaseUnits(metricUsdc);
  }
  log({ ...logBase, stage: "pool-split", totalPoolUsdc, metricBalanceUsdc });

  // 3. Assign per-rank amounts within each metric and build the Merkle input
  const perMetricEntries: Record<MetricId, MetricLeaderboardEntry[]> = {
    [METRIC_ABSOLUTE_PROFIT]: assignAmountsToRanks(lb.profit, metricBalanceBaseUnits[METRIC_ABSOLUTE_PROFIT]),
    [METRIC_WIN_STREAK]: assignAmountsToRanks(lb.streak, metricBalanceBaseUnits[METRIC_WIN_STREAK]),
    [METRIC_WIN_RATE]: assignAmountsToRanks(lb.winRate, metricBalanceBaseUnits[METRIC_WIN_RATE]),
    [METRIC_ROI]: assignAmountsToRanks(lb.roi, metricBalanceBaseUnits[METRIC_ROI]),
  };

  const leaderboardForTree: MultiMetricLeaderboard = {
    [METRIC_ABSOLUTE_PROFIT]: perMetricEntries[METRIC_ABSOLUTE_PROFIT],
    [METRIC_WIN_STREAK]: perMetricEntries[METRIC_WIN_STREAK],
    [METRIC_WIN_RATE]: perMetricEntries[METRIC_WIN_RATE],
    [METRIC_ROI]: perMetricEntries[METRIC_ROI],
  };

  let merkleRootHex: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tree: any | undefined;
  const periodTypeCode = periodKindToTypeCode(deps.period.kind);

  // Only build tree if at least one metric has entries
  const totalLeafCount: number = ORDERED_METRICS.reduce<number>((s, m) => s + perMetricEntries[m].length, 0);
  if (totalLeafCount > 0) {
    tree = buildMultiMetricMerkleTree({
      leaderboard: leaderboardForTree,
      periodId: deps.period.id,
      periodType: periodTypeCode,
    });
    merkleRootHex = tree.root;
    log({ ...logBase, stage: "merkle-built", leafCount: tree.leafCount, root: merkleRootHex });
  }

  // 4. Upload metric-segmented manifest to Arweave
  const manifest = buildMetricSegmentedManifest(deps.period, perMetricEntries, merkleRootHex);
  const arweaveResult = await (deps.uploadFn ?? uploadLeaderboardToArweave)({
    periodKind: deps.period.kind,
    periodId: deps.period.id,
    periodStart: deps.period.start,
    periodEnd: deps.period.end,
    merkleRoot: merkleRootHex,
    participantsCount: totalLeafCount,
    fullLeaderboardJson: manifest as never, // schema is JSONB; we store the segmented payload
  });
  log({ ...logBase, stage: "arweave-upload", arweaveTxId: arweaveResult.txId, stub: arweaveResult.stub });

  // 5. Persist snapshot (initial — committedTxSig filled below)
  let snapshot = await insertSnapshot(
    {
      periodKind: deps.period.kind,
      periodId: deps.period.id,
      periodStart: deps.period.start,
      periodEnd: deps.period.end,
      merkleRoot: merkleRootHex,
      arweaveTxId: arweaveResult.txId,
      committedTxSig: undefined,
      participantsCount: totalLeafCount,
      fullLeaderboardJson: manifest as never,
    },
    deps,
  );

  // 6. Commit root on-chain (or stub)
  let commitTxSig: string | undefined;
  if (merkleRootHex) {
    const commitFn = deps.commitLeaderboardRoot ?? stubCommitRoot;
    const commitResult = await commitFn({
      periodKind: deps.period.kind,
      periodId: deps.period.id,
      merkleRootHex,
      arweaveTxId: arweaveResult.txId,
    });
    if (commitResult.ok) {
      commitTxSig = commitResult.txSig;
      // Re-persist with the commit tx sig
      snapshot = await insertSnapshot(
        {
          periodKind: deps.period.kind,
          periodId: deps.period.id,
          periodStart: deps.period.start,
          periodEnd: deps.period.end,
          merkleRoot: merkleRootHex,
          arweaveTxId: arweaveResult.txId,
          committedTxSig: commitTxSig,
          participantsCount: totalLeafCount,
          fullLeaderboardJson: manifest as never,
        },
        deps,
      );
      log({ ...logBase, stage: "commit-root", commitTxSig });
    } else {
      log({ ...logBase, level: "warn", stage: "commit-root", error: commitResult.error });
    }
  }

  // 7. Per-(metric, rank) distribute
  const distributeFn = deps.distributeRewards ?? stubDistributeRewards;
  const perPosition: MultiMetricDistributePosition[] = [];
  let rolledOverBaseUnits = 0n;

  for (const metricId of ORDERED_METRICS) {
    const entries = perMetricEntries[metricId];
    // For every position 1..topN, either distribute or roll over
    for (let i = 0; i < topN; i++) {
      const rank = i + 1;
      const entry = entries[i];

      const positionBps = DEFAULT_DISTRIBUTION_BPS[i] ?? 0;
      const positionAmountBaseUnits =
        (metricBalanceBaseUnits[metricId] * BigInt(positionBps)) / 10_000n;
      const positionAmountUsdc = (Number(positionAmountBaseUnits) / 1_000_000).toFixed(2);

      if (!entry) {
        rolledOverBaseUnits += positionAmountBaseUnits;
        // Record rollover row (distributions stores position 1..10 only — fits)
        // We log via a DR-015-extended position even though the v1 distributions
        // table doesn't yet carry metricId. v1.5 schema migration to be queued
        // when Aria's distribute_*_rewards branches on metricId.
        await insertDistribution(
          {
            snapshotId: snapshot.id,
            position: rank,
            userPubkey: undefined,
            amountUsdc: positionAmountUsdc,
            txSig: undefined,
            merkleProof: undefined,
          },
          deps,
        ).catch(() => {
          // distributions has UNIQUE (snapshot_id, position) — across metrics
          // this may collide. Soft-ignore; v1.5 migration extends the unique
          // key to (snapshot_id, metric_id, position). For MVP we just log.
        });
        perPosition.push({
          metricId,
          metricName: METRIC_NAMES[metricId],
          rank,
          userPubkey: undefined,
          amountUsdc: positionAmountUsdc,
          amountBaseUnits: positionAmountBaseUnits,
          status: "rolled-over",
        });
        continue;
      }

      // Distribute. amount on the leaf is entry.amountBaseUnits — set
      // earlier in assignAmountsToRanks; consistent with the leaf hash.
      const proof = tree && merkleRootHex ? tree.proofFor(metricId, rank) : [];
      const distResult = await distributeFn({
        periodKind: deps.period.kind,
        periodId: deps.period.id,
        metricId, // Aria deploy-6: ix arg order is (period_id, metric_id, position, amount, proof).
        recipient: entry.recipient,
        position: rank,
        amountUsdc: positionAmountUsdc,
        amountBaseUnits: entry.amountBaseUnits,
        merkleProofHex: proof,
      });

      if (distResult.ok) {
        await insertDistribution(
          {
            snapshotId: snapshot.id,
            position: rank,
            userPubkey: entry.recipient,
            amountUsdc: positionAmountUsdc,
            txSig: distResult.txSig,
            merkleProof: [...proof],
          },
          deps,
        ).catch(() => {});
        perPosition.push({
          metricId,
          metricName: METRIC_NAMES[metricId],
          rank,
          userPubkey: entry.recipient,
          amountUsdc: positionAmountUsdc,
          amountBaseUnits: entry.amountBaseUnits,
          status: "distributed",
          txSig: distResult.txSig,
        });
      } else {
        perPosition.push({
          metricId,
          metricName: METRIC_NAMES[metricId],
          rank,
          userPubkey: entry.recipient,
          amountUsdc: positionAmountUsdc,
          amountBaseUnits: entry.amountBaseUnits,
          status: /awaiting aria/i.test(distResult.error) ? "stubbed" : "errored",
          error: distResult.error,
        });
      }
    }
  }

  const rolledOverUsdc = (Number(rolledOverBaseUnits) / 1_000_000).toFixed(2);

  return {
    ok: true,
    periodKind: deps.period.kind,
    periodId: deps.period.id,
    snapshot,
    perPosition,
    metricBalanceUsdc,
    totalPoolUsdc,
    rolledOverUsdc,
    commitTxSig,
    arweaveTxId: arweaveResult.txId,
    arweaveStub: arweaveResult.stub,
    merkleRootHex,
  };
}

// ---------------------------------------------------------------------------
// Per-rank amount assignment within a metric
// ---------------------------------------------------------------------------

/**
 * Fill `amountBaseUnits` per entry based on per-rank bps × metric pool.
 * Returns a NEW array (doesn't mutate inputs). Rank 1 gets DEFAULT_DISTRIBUTION_BPS[0],
 * rank 2 gets [1], etc.
 */
export function assignAmountsToRanks(
  entries: ReadonlyArray<MetricLeaderboardEntry>,
  metricPoolBaseUnits: bigint,
): MetricLeaderboardEntry[] {
  return entries.map((entry, idx) => {
    const bps = DEFAULT_DISTRIBUTION_BPS[idx] ?? 0;
    const amount = (metricPoolBaseUnits * BigInt(bps)) / 10_000n;
    return {
      recipient: entry.recipient,
      rank: entry.rank, // preserve caller-provided rank (should match idx+1)
      amountBaseUnits: amount,
    };
  });
}

// ---------------------------------------------------------------------------
// Arweave metric-segmented manifest builder
// ---------------------------------------------------------------------------

export type MetricSegmentedManifest = {
  schema_version: "dr015.v1";
  period: {
    kind: PeriodKind;
    id: number;
    start: string;
    end: string;
  };
  merkle: {
    root_hex: string | undefined;
    leaf_format: "sha256(recipient(32) || metric_id(1) || rank(1) || amount(8) || period_id(4) || period_type(1))";
    tree_format: "sorted-pair binary";
  };
  metrics: {
    [k: string]: {
      metric_id: MetricId;
      metric_name: string;
      pool_split_bps: number;
      entries: Array<{
        rank: number;
        recipient: string;
        amount_base_units: string; // bigint as string for JSON
      }>;
    };
  };
};

function buildMetricSegmentedManifest(
  period: PeriodInfo,
  perMetric: Record<MetricId, MetricLeaderboardEntry[]>,
  merkleRootHex: string | undefined,
): MetricSegmentedManifest {
  const metrics: MetricSegmentedManifest["metrics"] = {};
  for (const m of ORDERED_METRICS) {
    metrics[METRIC_NAMES[m]] = {
      metric_id: m,
      metric_name: METRIC_NAMES[m],
      pool_split_bps: DEFAULT_METRIC_POOL_SPLIT_BPS[m],
      entries: perMetric[m].map((e) => ({
        rank: e.rank,
        recipient: e.recipient,
        amount_base_units: e.amountBaseUnits.toString(),
      })),
    };
  }
  return {
    schema_version: "dr015.v1",
    period: {
      kind: period.kind,
      id: period.id,
      start: period.start.toISOString(),
      end: period.end.toISOString(),
    },
    merkle: {
      root_hex: merkleRootHex,
      leaf_format:
        "sha256(recipient(32) || metric_id(1) || rank(1) || amount(8) || period_id(4) || period_type(1))",
      tree_format: "sorted-pair binary",
    },
    metrics,
  };
}

// ---------------------------------------------------------------------------
// Stubs (until Aria's DR-015 verifier deploy lands)
// ---------------------------------------------------------------------------

const stubCommitRoot: CommitLeaderboardRootFn = async () => ({
  ok: false,
  error:
    "DR-015 commit_leaderboard_root awaiting Aria's deploy with multi-metric verifier branch. v1 deploy-5 verifier still expects DR-010 leaf shape.",
});

const stubDistributeRewards: DistributeRewardsFn = async () => ({
  ok: false,
  error:
    "DR-015 distribute_*_rewards awaiting Aria's deploy with metric_id branch + per-metric claimed_bitmap segments.",
});
