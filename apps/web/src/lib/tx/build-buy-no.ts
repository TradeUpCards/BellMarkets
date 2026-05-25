import { BN, type Program, type Idl } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
  type AccountMeta,
  type TransactionInstruction,
} from "@solana/web3.js";

import { deriveMarketConfigPda } from "@/lib/solana/anchor";
import {
  deriveFeeConfigPda,
  deriveMonthlyPoolPda,
  deriveNoMintPda,
  deriveOrderBookPda,
  deriveUsdcEscrowPda,
  deriveUsdcVaultPda,
  deriveUserConfigPda,
  deriveWeeklyPoolPda,
  deriveYesEscrowPda,
  deriveYesMintPda,
} from "@/lib/solana/pdas";
import {
  SIDE_ASK,
  type OrderBookAccount,
  planFills,
} from "@/lib/solana/order-book";

import { callAnchorMethod } from "./anchor-helper";

export interface BuildBuyNoParams {
  program: Program<Idl>;
  trader: PublicKey;
  marketPda: PublicKey;
  usdcMint: PublicKey;
  /** `MarketConfig.treasury` — drives fee_collector_usdc ATA. */
  treasury: PublicKey;
  /** Live OrderBook snapshot — REQUIRED so we can pre-flight fill coverage. */
  book: OrderBookAccount | null;
  /**
   * Pair count to mint (= YES base units to sell into the book). 10^6 = one
   * macro pair. The atomic mint_pair leg mints `amount` YES + `amount` NO;
   * the place_order(SIDE_ASK, market) leg sells exactly `amount` YES.
   */
  amount: bigint;
}

export interface BuildBuyNoResult {
  tx: Transaction;
  prelude: TransactionInstruction[];
  mintPairIx: TransactionInstruction;
  placeOrderIx: TransactionInstruction;
  plannedFilled: bigint;
}

/**
 * Build the **atomic** Buy-NO transaction per DR-020 §"Trade-path mapping":
 *
 *   tx = [
 *     <ATA creates>,
 *     mint_pair(amount),                                  // YES:+amount, NO:+amount, USDC:-(amount + fee)
 *     place_order(side=ASK, size=amount, is_market=true), // sell YES into the bid book
 *   ]
 *
 * Net effect: user ends up holding `+amount` NO, paid roughly
 * `amount × (1 − best_bid)` USDC plus protocol fee. The user never sees an
 * intermediate stranded YES balance under Solana atomicity — IF the entire
 * `amount` is fillable.
 *
 * ## DR-019 + IOC partial-fill defense
 *
 * The on-chain `place_order` ix does NOT take a minimum-fill arg — a market
 * order that can only fill half the size silently refunds the remainder.
 * That breaks POV-3 atomicity: the user would land with `mint_pair`
 * succeeded, `amount/2` YES sold, `amount/2` YES + `amount` NO sitting in
 * their wallet, and the mint fee paid. Stranded.
 *
 * Defense (`.project/stories/ioc-partial-fill-stranding.md`): the builder
 * **throws** before submission unless `book.plannedFilled === amount`. The
 * caller checks the result, presents a clear "Empty / thin YES bid book"
 * error to the user, and the tx never broadcasts.
 *
 * **This is enforced HERE in the builder**, not at the caller — adding new
 * call sites can never reintroduce the bug.
 */
export async function buildBuyNoTx(
  params: BuildBuyNoParams,
): Promise<BuildBuyNoResult> {
  const { program, trader, marketPda, usdcMint, treasury, book, amount } =
    params;

  if (amount <= 0n) {
    throw new Error("buildBuyNoTx: amount must be > 0");
  }

  // DR-019 / IOC partial-fill defense — plan the Phoenix-leg sell + REJECT if
  // the bid book can't fully absorb. Builder enforces, caller can't bypass.
  const plan = book
    ? planFills(book, SIDE_ASK, 0n, amount, true /* isMarket */)
    : { fills: [], totalFilled: 0n, remaining: amount };
  if (plan.totalFilled < amount) {
    throw new BuyNoIocError(
      `Atomic Buy NO needs ${amount} YES of bid liquidity; only ${plan.totalFilled} available. Aborting before submission to prevent stranded YES + NO + paid mint fee.`,
      amount,
      plan.totalFilled,
    );
  }

  // ── Derive all PDAs / ATAs ──────────────────────────────────────────────
  const [config] = deriveMarketConfigPda();
  const [feeConfig] = deriveFeeConfigPda();
  const [userConfig] = deriveUserConfigPda(config, trader);
  const [weeklyPool] = deriveWeeklyPoolPda();
  const [monthlyPool] = deriveMonthlyPoolPda();
  const [yesMint] = deriveYesMintPda(marketPda);
  const [noMint] = deriveNoMintPda(marketPda);
  const [usdcVault] = deriveUsdcVaultPda(marketPda);
  const [orderBook] = deriveOrderBookPda(marketPda);
  const [usdcEscrow] = deriveUsdcEscrowPda(marketPda);
  const [yesEscrow] = deriveYesEscrowPda(marketPda);

  const userUsdc = getAssociatedTokenAddressSync(usdcMint, trader, true);
  const userYes = getAssociatedTokenAddressSync(yesMint, trader, true);
  const userNo = getAssociatedTokenAddressSync(noMint, trader, true);
  const feeCollectorUsdc = getAssociatedTokenAddressSync(usdcMint, treasury, true);

  const prelude: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(trader, userUsdc, trader, usdcMint),
    createAssociatedTokenAccountIdempotentInstruction(trader, userYes, trader, yesMint),
    createAssociatedTokenAccountIdempotentInstruction(trader, userNo, trader, noMint),
    createAssociatedTokenAccountIdempotentInstruction(
      trader,
      feeCollectorUsdc,
      treasury,
      usdcMint,
    ),
  ];

  // ── mint_pair leg ───────────────────────────────────────────────────────
  const mintPairIx = await callAnchorMethod(
    program,
    "mintPair",
    new BN(amount.toString()),
    {
      user: trader,
      config,
      feeConfig,
      userConfig,
      strikeMarket: marketPda,
      userUsdc,
      usdcVault,
      yesMint,
      noMint,
      userYes,
      userNo,
      feeCollectorUsdc,
      weeklyPool,
      monthlyPool,
      usdcMint,
      clock: SYSVAR_CLOCK_PUBKEY,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    },
  );

  // ── place_order(side=ASK, market) leg ───────────────────────────────────
  // Maker payouts go to bid makers' YES ATAs.
  const remainingAccounts: AccountMeta[] = plan.fills.map((fill) => ({
    pubkey: getAssociatedTokenAddressSync(yesMint, fill.makerOwner, true),
    isSigner: false,
    isWritable: true,
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const placeOrderBuilders = (program.methods as any).placeOrder;
  if (!placeOrderBuilders) {
    throw new Error("buildBuyNoTx: 'placeOrder' missing from IDL.");
  }
  const placeOrderIx: TransactionInstruction = await placeOrderBuilders(
    SIDE_ASK,
    new BN(0),
    new BN(amount.toString()),
    true /* is_market */,
  )
    .accounts({
      user: trader,
      config,
      strikeMarket: marketPda,
      orderBook,
      yesMint,
      usdcMint,
      userYes,
      userUsdc,
      usdcEscrow,
      yesEscrow,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(remainingAccounts)
    .instruction();

  const tx = new Transaction();
  for (const p of prelude) tx.add(p);
  tx.add(mintPairIx);
  tx.add(placeOrderIx);

  return {
    tx,
    prelude,
    mintPairIx,
    placeOrderIx,
    plannedFilled: plan.totalFilled,
  };
}

/**
 * Thrown by `buildBuyNoTx` when the bid book can't fully absorb the
 * `amount` YES the atomic mint_pair leg would produce. Caller catches this
 * to present a clear "thin/empty bid book" UX state. NEVER suppress —
 * suppressing reintroduces the IOC partial-fill stranding bug.
 */
export class BuyNoIocError extends Error {
  constructor(
    message: string,
    public readonly required: bigint,
    public readonly available: bigint,
  ) {
    super(message);
    this.name = "BuyNoIocError";
  }
}
