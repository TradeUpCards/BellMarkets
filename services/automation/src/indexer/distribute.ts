// DR-010 — period-close distribute orchestrator.
//
// Single function `runDistributeForPeriod(deps)` handles the complete
// pipeline for a weekly or monthly close:
//
//   1. Compute top-10 from user_streaks (where current_streak > 0)
//   2. Apply tiebreaker: total_markets_traded DESC, then random
//   3. Build Merkle tree over top-10 (DR-010 Option B)
//   4. Upload full leaderboard JSON to Arweave (DR-010 permanent verify)
//   5. Insert leaderboard_snapshots row with merkle_root + arweave_tx_id
//   6. Call on-chain `commit_leaderboard_root(period_id, merkle_root, arweave_tx_id)`
//      (admin-signed; falls back to stub when IDL lacks the ix)
//   7. For each top-10 position with a winner: call distribute_weekly_rewards
//      or distribute_monthly_rewards with the merkle proof. Persist
//      tx_sig + proof in distributions table.
//   8. Empty positions (<10 participants): record with user_pubkey=NULL,
//      amount_usdc=rolled_over (caller-supplied policy; default 0 → next
//      period's pool inherits naturally since this distribute didn't run).
//
// All on-chain calls degrade gracefully when Aria's program lacks the ixs
// (returns ok=false with clear "awaiting Aria" message; persistence side
// still writes the snapshot so the indexer can be replayed later).

import { topNLeaderboard, insertSnapshot, insertDistribution } from "../db/queries.js";
import type { QueryDeps } from "../db/queries.js";
import {
  buildLeaderboardMerkleTree,
  PERIOD_TYPE_WEEKLY,
  PERIOD_TYPE_MONTHLY,
  type PeriodTypeCode,
} from "./merkle.js";
import { uploadLeaderboardToArweave } from "./arweave.js";
import type { LeaderboardEntry, LeaderboardSnapshot, PeriodKind } from "../db/types.js";
import type { PeriodInfo } from "./periods.js";
import type { BellMarketsAnchorClient } from "../clients/anchor.js";
import {
  WEEKLY_REWARDS_POOL_PDA,
  MONTHLY_REWARDS_POOL_PDA,
  USDC_DEVNET_MINT,
  TOKEN_PROGRAM_ID,
} from "../devnet-pubkeys.js";

/** Map the off-chain string union to the on-chain u8 code in Aria's state.rs. */
export function periodKindToTypeCode(kind: PeriodKind): PeriodTypeCode {
  return kind === "weekly" ? PERIOD_TYPE_WEEKLY : PERIOD_TYPE_MONTHLY;
}

/** USDC base units = micro-USDC (6 decimals per Circle's mint). */
const USDC_DECIMALS = 6;
const USDC_BASE_UNIT_PER_DOLLAR = 10 ** USDC_DECIMALS; // 1_000_000

/**
 * Convert a decimal USDC string (e.g. "25.00") to base units (e.g. 25_000_000n).
 * Used to align `distribute_*_rewards(amount: u64)` with Aria's pool transfers.
 */
export function usdcDollarsToBaseUnits(usdcDecimalString: string): bigint {
  const n = Number(usdcDecimalString);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`usdcDollarsToBaseUnits: invalid USDC string "${usdcDecimalString}"`);
  }
  // Use cent-precision to avoid float rounding at $0.01 step.
  const cents = Math.round(n * 100);
  return BigInt(cents) * BigInt(USDC_BASE_UNIT_PER_DOLLAR / 100);
}

// DR-010 §"Default smooth-decay distribution" — per-position bps of pool.
export const DEFAULT_DISTRIBUTION_BPS: ReadonlyArray<number> = [
  2500, // #1
  1800, // #2
  1200, // #3
  1000, // #4
  800, //  #5
  700, //  #6
  600, //  #7
  500, //  #8
  500, //  #9
  400, //  #10
];

// Sum must be 10000 — enforced once at module load.
const _bpsSum = DEFAULT_DISTRIBUTION_BPS.reduce((a, b) => a + b, 0);
if (_bpsSum !== 10000) {
  throw new Error(`DEFAULT_DISTRIBUTION_BPS does not sum to 10000 (got ${_bpsSum})`);
}

export type CommitLeaderboardRootInput = {
  periodKind: PeriodKind;
  periodId: number;
  merkleRootHex: string;
  arweaveTxId: string;
};

export type CommitLeaderboardRootResult =
  | { ok: true; txSig: string }
  | { ok: false; error: string };

export type CommitLeaderboardRootFn = (
  input: CommitLeaderboardRootInput,
) => Promise<CommitLeaderboardRootResult>;

export type DistributeRewardsInput = {
  periodKind: PeriodKind;
  periodId: number;
  recipient: string;
  position: number;
  /** Decimal USDC string for off-chain accounting (e.g. "25.00"). */
  amountUsdc: string;
  /** Same amount in u64 base units (= micro-USDC). Passed as the on-chain `amount` arg. */
  amountBaseUnits: bigint;
  merkleProofHex: ReadonlyArray<string>;
};

export type DistributeRewardsResult =
  | { ok: true; txSig: string }
  | { ok: false; error: string };

export type DistributeRewardsFn = (input: DistributeRewardsInput) => Promise<DistributeRewardsResult>;

export type ReadPoolBalanceFn = (periodKind: PeriodKind) => Promise<string>;

export type DistributeForPeriodDeps = QueryDeps & {
  period: PeriodInfo;
  /**
   * Total pool USDC at period close, decimal string (e.g. "150.00"). The
   * indexer doesn't manage the pool balance directly — it asks via
   * `readPoolBalance`. Inject a fake in tests.
   */
  readPoolBalance: ReadPoolBalanceFn;
  /**
   * Optional Anchor client. When provided AND no `commitLeaderboardRoot` /
   * `distributeRewards` fn is injected, the orchestrator uses the live
   * default adapters (which call `program.methods.commitLeaderboardRoot()` /
   * `program.methods.distributeWeeklyRewards()` against Aria's deployed
   * program). When omitted, falls back to the "Awaiting Aria's deploy"
   * stubs — useful for replay-after-deploy testing.
   */
  anchorClient?: BellMarketsAnchorClient;
  /** On-chain commit_leaderboard_root caller. Default = live if anchorClient supplied, else stub. */
  commitLeaderboardRoot?: CommitLeaderboardRootFn;
  /** On-chain distribute_weekly_rewards / distribute_monthly_rewards. Default = live if anchorClient supplied, else stub. */
  distributeRewards?: DistributeRewardsFn;
  /** Override Arweave upload (tests use this to avoid live SDK). */
  uploadFn?: typeof uploadLeaderboardToArweave;
  /** Tiebreaker shuffler for entries with equal current_streak + total_markets_traded. Default uses Math.random; tests inject a deterministic shuffler. */
  shuffle?: <T>(arr: T[]) => T[];
  log?: (entry: Record<string, unknown>) => void;
};

export type DistributeOutcome = {
  ok: true;
  periodKind: PeriodKind;
  periodId: number;
  snapshot: LeaderboardSnapshot;
  /** Per-position outcomes. Length is always 10; positions without a winner have user_pubkey=null. */
  perPosition: Array<{
    position: number;
    userPubkey: string | undefined;
    amountUsdc: string;
    status: "distributed" | "rolled-over" | "errored";
    txSig?: string;
    error?: string;
  }>;
  poolBalanceUsdc: string;
  rolledOverUsdc: string;
  commitTxSig: string | undefined;
  arweaveTxId: string;
  arweaveStub: boolean;
};

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function runDistributeForPeriod(deps: DistributeForPeriodDeps): Promise<DistributeOutcome> {
  const log = deps.log ?? ((e: Record<string, unknown>) => console.info(JSON.stringify(e)));
  const logBase = {
    jobId: `distribute-${deps.period.kind}`,
    periodId: deps.period.id,
    periodStart: deps.period.start.toISOString(),
    periodEnd: deps.period.end.toISOString(),
  };

  // 1. Read top-10 with primary + secondary sort applied at SQL level
  const rawTop = await topNLeaderboard(10, deps);
  log({ ...logBase, stage: "top-10-read", participants: rawTop.length });

  // 2. Apply random tiebreaker for users with identical (currentStreak, totalMarketsTraded)
  const sortedTop = applyDeterministicTiebreaker(rawTop, deps.shuffle ?? defaultShuffle);

  // 3. Read pool balance (caller-injected; reads on-chain WeeklyRewardsPool or MonthlyRewardsPool)
  const poolBalanceStr = await deps.readPoolBalance(deps.period.kind);
  const poolBalanceUsdc = poolBalanceStr;
  log({ ...logBase, stage: "pool-balance", poolBalanceUsdc });

  // Compute per-position amounts: amount[i] = pool * bps[i] / 10000
  // Two parallel arrays — decimal-string for human/db, base-units for on-chain.
  const positionAmounts: string[] = DEFAULT_DISTRIBUTION_BPS.map((bps) => {
    const cents = Math.floor(Number(poolBalanceUsdc) * bps);
    return (cents / 10000).toFixed(2);
  });
  const positionAmountsBase: bigint[] = positionAmounts.map(usdcDollarsToBaseUnits);

  // 4. Snapshot — IF participants > 0, build Merkle. ELSE skip Merkle + upload zero-row snapshot.
  //
  // The Merkle leaf set covers ONLY positions with a real winner (sortedTop.length
  // entries); rollover positions are not included. Aria's distribute_*_rewards
  // verifies proof against the committed root for an (entry-position, recipient,
  // amount) triple — empty positions never produce a distribute call.
  const periodTypeCode = periodKindToTypeCode(deps.period.kind);
  let merkleRootHex: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tree: any | undefined;
  if (sortedTop.length > 0) {
    const winnerAmounts = positionAmountsBase.slice(0, sortedTop.length);
    tree = buildLeaderboardMerkleTree({
      entries: sortedTop,
      periodId: deps.period.id,
      periodType: periodTypeCode,
      amounts: winnerAmounts,
    });
    merkleRootHex = tree.root;
  }

  // 5. Upload to Arweave
  const arweave = await (deps.uploadFn ?? uploadLeaderboardToArweave)(
    {
      periodKind: deps.period.kind,
      periodId: deps.period.id,
      periodStart: deps.period.start,
      periodEnd: deps.period.end,
      merkleRoot: merkleRootHex,
      participantsCount: sortedTop.length,
      fullLeaderboardJson: sortedTop,
    },
  );
  log({ ...logBase, stage: "arweave-upload", arweaveTxId: arweave.txId, stub: arweave.stub });

  // 6. Persist snapshot
  const snapshot = await insertSnapshot(
    {
      periodKind: deps.period.kind,
      periodId: deps.period.id,
      periodStart: deps.period.start,
      periodEnd: deps.period.end,
      merkleRoot: merkleRootHex,
      arweaveTxId: arweave.txId,
      committedTxSig: undefined, // filled below
      participantsCount: sortedTop.length,
      fullLeaderboardJson: sortedTop,
    },
    deps,
  );

  // 7. Commit root on-chain
  let commitTxSig: string | undefined;
  if (merkleRootHex) {
    const commitFn =
      deps.commitLeaderboardRoot ??
      (deps.anchorClient
        ? makeCommitLeaderboardRoot(deps.anchorClient)
        : stubCommitLeaderboardRoot);
    const commitResult = await commitFn({
      periodKind: deps.period.kind,
      periodId: deps.period.id,
      merkleRootHex,
      arweaveTxId: arweave.txId,
    });
    if (commitResult.ok) {
      commitTxSig = commitResult.txSig;
      // Persist commit_tx_sig back to snapshot row.
      await insertSnapshot(
        {
          periodKind: deps.period.kind,
          periodId: deps.period.id,
          periodStart: deps.period.start,
          periodEnd: deps.period.end,
          merkleRoot: merkleRootHex,
          arweaveTxId: arweave.txId,
          committedTxSig: commitTxSig,
          participantsCount: sortedTop.length,
          fullLeaderboardJson: sortedTop,
        },
        deps,
      );
      log({ ...logBase, stage: "commit-root", commitTxSig });
    } else {
      log({ ...logBase, level: "warn", stage: "commit-root", error: commitResult.error });
    }
  }

  // 8. Per-position distribute
  const distributeFn =
    deps.distributeRewards ??
    (deps.anchorClient
      ? makeDistributeRewards(deps.anchorClient)
      : stubDistributeRewards);
  const perPosition: DistributeOutcome["perPosition"] = [];
  let rolledOverCents = 0;
  for (let i = 0; i < 10; i++) {
    const position = i + 1;
    const amountUsdc = positionAmounts[i] ?? "0.00";
    const amountBaseUnits = positionAmountsBase[i] ?? 0n;
    const entry = sortedTop[i];

    if (!entry) {
      // No winner for this position — record rollover.
      await insertDistribution(
        { snapshotId: snapshot.id, position, userPubkey: undefined, amountUsdc, txSig: undefined, merkleProof: undefined },
        deps,
      );
      rolledOverCents += Math.round(Number(amountUsdc) * 100);
      perPosition.push({ position, userPubkey: undefined, amountUsdc, status: "rolled-over" });
      continue;
    }

    const proof = tree ? tree.proofFor(position) : [];
    const result = await distributeFn({
      periodKind: deps.period.kind,
      periodId: deps.period.id,
      recipient: entry.userPubkey,
      position,
      amountUsdc,
      amountBaseUnits,
      merkleProofHex: proof,
    });

    if (result.ok) {
      await insertDistribution(
        { snapshotId: snapshot.id, position, userPubkey: entry.userPubkey, amountUsdc, txSig: result.txSig, merkleProof: [...proof] },
        deps,
      );
      perPosition.push({ position, userPubkey: entry.userPubkey, amountUsdc, status: "distributed", txSig: result.txSig });
    } else {
      await insertDistribution(
        { snapshotId: snapshot.id, position, userPubkey: entry.userPubkey, amountUsdc, txSig: undefined, merkleProof: [...proof] },
        deps,
      );
      perPosition.push({ position, userPubkey: entry.userPubkey, amountUsdc, status: "errored", error: result.error });
      log({ ...logBase, level: "warn", stage: "distribute", position, recipient: entry.userPubkey, error: result.error });
    }
  }
  const rolledOverUsdc = (rolledOverCents / 100).toFixed(2);

  return {
    ok: true,
    periodKind: deps.period.kind,
    periodId: deps.period.id,
    snapshot: { ...snapshot, committedTxSig: commitTxSig },
    perPosition,
    poolBalanceUsdc,
    rolledOverUsdc,
    commitTxSig,
    arweaveTxId: arweave.txId,
    arweaveStub: arweave.stub,
  };
}

// ---------------------------------------------------------------------------
// Tiebreaker
// ---------------------------------------------------------------------------

/**
 * Group entries by (currentStreak, totalMarketsTraded) and shuffle each
 * group in-place. Preserves the primary sort already applied at the DB
 * layer (current_streak DESC, total_markets_traded DESC).
 *
 * The shuffler is injectable so tests can be deterministic. Default uses
 * Math.random — production calls inherit the same randomness so two
 * users on identical tiebreaker outcomes get a fair coin flip.
 */
export function applyDeterministicTiebreaker(
  entries: ReadonlyArray<LeaderboardEntry>,
  shuffle: <T>(arr: T[]) => T[],
): LeaderboardEntry[] {
  if (entries.length === 0) return [];
  const out: LeaderboardEntry[] = [];
  let i = 0;
  while (i < entries.length) {
    const head = entries[i];
    if (!head) break;
    let j = i + 1;
    while (j < entries.length) {
      const peek = entries[j];
      if (!peek) break;
      if (peek.currentStreak === head.currentStreak && peek.totalMarketsTraded === head.totalMarketsTraded) {
        j++;
      } else {
        break;
      }
    }
    const group = entries.slice(i, j) as LeaderboardEntry[];
    if (group.length > 1) {
      out.push(...shuffle([...group]));
    } else {
      out.push(...group);
    }
    i = j;
  }
  return out;
}

function defaultShuffle<T>(arr: T[]): T[] {
  // Fisher-Yates with Math.random
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = tmp;
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Stubs — Aria's ixs not yet deployed
// ---------------------------------------------------------------------------

const stubCommitLeaderboardRoot: CommitLeaderboardRootFn = async () => ({
  ok: false,
  error: "IDL is missing `commitLeaderboardRoot` instruction. Awaiting Aria's deploy of the DR-010 admin ix.",
});

const stubDistributeRewards: DistributeRewardsFn = async () => ({
  ok: false,
  error: "IDL is missing `distributeWeeklyRewards` / `distributeMonthlyRewards` instructions. Awaiting Aria's deploy of the DR-010 admin ixs.",
});

// ---------------------------------------------------------------------------
// Live on-chain adapters (deploy #5)
// ---------------------------------------------------------------------------
//
// Arg shapes match programs/bell-markets/src/instructions/{commit_leaderboard_root,distribute_*_rewards}.rs:
//
//   commit_leaderboard_root(period_id u64, period_type u8,
//                           merkle_root [u8;32], arweave_tx_id [u8;48])
//   distribute_weekly_rewards(period_id u64, position u8, amount u64,
//                             merkle_proof Vec<[u8;32]>)
//   distribute_monthly_rewards(... same shape ...)

/** ARWEAVE_TX_ID_LEN per programs/bell-markets/src/state.rs — 43 base64url +
 *  5 bytes zero-pad = 48. Off-chain we pad ASCII to 48 bytes via UTF-8. */
const ARWEAVE_TX_ID_LEN = 48;

function arweaveTxIdToBytes48(arweaveTxId: string): Buffer {
  const buf = Buffer.alloc(ARWEAVE_TX_ID_LEN);
  Buffer.from(arweaveTxId, "utf-8").copy(buf, 0, 0, Math.min(arweaveTxId.length, ARWEAVE_TX_ID_LEN));
  // Remaining bytes already 0 from Buffer.alloc.
  return buf;
}

export function makeCommitLeaderboardRoot(client: BellMarketsAnchorClient): CommitLeaderboardRootFn {
  return async (input) => {
    try {
      const program = await client.getProgram();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const methods = program.methods as any;
      if (typeof methods.commitLeaderboardRoot !== "function") {
        return {
          ok: false,
          error:
            "IDL is missing `commitLeaderboardRoot` instruction. Awaiting Aria's deploy of the DR-010 admin ix.",
        };
      }
      const anchor = await import("@coral-xyz/anchor");
      const web3 = await import("@solana/web3.js");
      const programIdPk = new web3.PublicKey(client.opts.programId);
      const [configPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        programIdPk,
      );
      const [leaderboardCommitsPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("leaderboard_commits")],
        programIdPk,
      );

      const merkleRootBytes = Buffer.from(input.merkleRootHex, "hex");
      if (merkleRootBytes.length !== 32) {
        return { ok: false, error: `merkle_root must be 32 bytes (got ${merkleRootBytes.length})` };
      }
      const arweaveBytes = arweaveTxIdToBytes48(input.arweaveTxId);

      const provider = program.provider as unknown as {
        wallet: { publicKey: import("@solana/web3.js").PublicKey };
      };
      const adminPk = provider.wallet.publicKey;

      const periodType = input.periodKind === "weekly" ? PERIOD_TYPE_WEEKLY : PERIOD_TYPE_MONTHLY;

      const txSig: string = await methods
        .commitLeaderboardRoot(
          new anchor.BN(input.periodId),
          periodType,
          Array.from(merkleRootBytes), // Anchor 0.30 wants u8[32] as number array
          Array.from(arweaveBytes), // u8[48]
        )
        .accounts({
          admin: adminPk,
          config: configPda,
          leaderboardCommits: leaderboardCommitsPda,
          clock: web3.SYSVAR_CLOCK_PUBKEY,
        })
        .rpc();
      return { ok: true, txSig };
    } catch (err) {
      return { ok: false, error: serializeError(err) };
    }
  };
}

export function makeDistributeRewards(client: BellMarketsAnchorClient): DistributeRewardsFn {
  return async (input) => {
    try {
      const program = await client.getProgram();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const methods = program.methods as any;
      const methodName =
        input.periodKind === "weekly" ? "distributeWeeklyRewards" : "distributeMonthlyRewards";
      if (typeof methods[methodName] !== "function") {
        return {
          ok: false,
          error: `IDL is missing \`${methodName}\` instruction. Awaiting Aria's deploy of the DR-010 admin ixs.`,
        };
      }
      const anchor = await import("@coral-xyz/anchor");
      const web3 = await import("@solana/web3.js");
      const programIdPk = new web3.PublicKey(client.opts.programId);
      const [configPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        programIdPk,
      );
      const [leaderboardCommitsPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("leaderboard_commits")],
        programIdPk,
      );
      const poolPk = new web3.PublicKey(
        input.periodKind === "weekly" ? WEEKLY_REWARDS_POOL_PDA : MONTHLY_REWARDS_POOL_PDA,
      );
      const recipientPk = new web3.PublicKey(input.recipient);
      const usdcMintPk = new web3.PublicKey(USDC_DEVNET_MINT);
      // Recipient's USDC ATA (deterministic from recipient + USDC mint).
      const splToken = await import("@solana/spl-token");
      const recipientToken = await splToken.getAssociatedTokenAddress(
        usdcMintPk,
        recipientPk,
        true, // allowOwnerOffCurve
      );

      const provider = program.provider as unknown as {
        wallet: { publicKey: import("@solana/web3.js").PublicKey };
      };
      const adminPk = provider.wallet.publicKey;

      const proofBytes = input.merkleProofHex.map((p) => Array.from(Buffer.from(p, "hex")));

      const txSig: string = await methods[methodName](
        new anchor.BN(input.periodId),
        input.position,
        new anchor.BN(input.amountBaseUnits.toString()),
        proofBytes,
      )
        .accounts({
          admin: adminPk,
          config: configPda,
          leaderboardCommits: leaderboardCommitsPda,
          weeklyPool: input.periodKind === "weekly" ? poolPk : undefined,
          monthlyPool: input.periodKind === "monthly" ? poolPk : undefined,
          recipient: recipientPk,
          recipientToken,
          tokenProgram: new web3.PublicKey(TOKEN_PROGRAM_ID),
        })
        .rpc();
      return { ok: true, txSig };
    } catch (err) {
      return { ok: false, error: serializeError(err) };
    }
  };
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === "object" && err !== null) {
    const anchorErr = err as {
      error?: { errorCode?: { code?: string; number?: number }; errorMessage?: string };
    };
    const code = anchorErr.error?.errorCode?.code;
    if (code) {
      const num = anchorErr.error?.errorCode?.number;
      const msg = anchorErr.error?.errorMessage ? `: ${anchorErr.error.errorMessage}` : "";
      return `AnchorError(${code}${num !== undefined ? ` #${num}` : ""})${msg}`;
    }
  }
  return String(err);
}
