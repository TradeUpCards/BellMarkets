import { BN, type Program, type Idl } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  Transaction,
  type AccountMeta,
  type TransactionInstruction,
} from "@solana/web3.js";

import { deriveMarketConfigPda } from "@/lib/solana/anchor";
import {
  deriveNoMintPda,
  deriveOrderBookPda,
  deriveUsdcEscrowPda,
  deriveUsdcVaultPda,
  deriveYesEscrowPda,
  deriveYesMintPda,
} from "@/lib/solana/pdas";
import {
  SIDE_BID,
  type OrderBookAccount,
  planFills,
} from "@/lib/solana/order-book";

import { callAnchorMethod } from "./anchor-helper";

export interface BuildSellNoParams {
  program: Program<Idl>;
  trader: PublicKey;
  marketPda: PublicKey;
  usdcMint: PublicKey;
  /** Live OrderBook snapshot — REQUIRED for pre-flight fill coverage check. */
  book: OrderBookAccount | null;
  /**
   * NO base units to sell (= YES base units to buy + redeem_pair burn count).
   * 10^6 = one macro NO. The atomic place_order(SIDE_BID, market) leg buys
   * exactly `amount` YES; the redeem_pair leg burns `amount` YES + `amount`
   * NO and refunds `amount` USDC base units.
   */
  amount: bigint;
}

export interface BuildSellNoResult {
  tx: Transaction;
  prelude: TransactionInstruction[];
  placeOrderIx: TransactionInstruction;
  redeemPairIx: TransactionInstruction;
  plannedFilled: bigint;
}

/**
 * Build the **atomic** Sell-NO transaction per DR-020 §"Trade-path mapping":
 *
 *   tx = [
 *     <ATA creates>,
 *     place_order(side=BID, size=amount, is_market=true),  // buy YES at market
 *     redeem_pair(amount),                                 // burn YES+NO, refund $amount USDC
 *   ]
 *
 * Net effect: user's NO balance drops by `amount`, USDC up by approximately
 * `amount × (1 − best_ask)`. The user never sees an intermediate YES balance
 * — POV-3 atomicity enforced IF the buy-YES leg fully fills.
 *
 * ## DR-019 + IOC partial-fill defense
 *
 * `redeem_pair(amount)` requires the user to hold EXACTLY `amount` YES (in
 * addition to their existing `amount` NO). If `place_order` returns less
 * than `amount` YES (thin ask book), redeem_pair fails and Solana atomicity
 * unwinds the whole tx — so unlike the Buy NO case, partial-fill here is
 * SAFE: it just reverts cleanly with no stranded state.
 *
 * Even so, we pre-flight the fill plan and throw `SellNoIocError` BEFORE
 * broadcasting — the UX of "your tx will revert, here's why" is better than
 * "your tx reverted, parse the simulation log."
 */
export async function buildSellNoTx(
  params: BuildSellNoParams,
): Promise<BuildSellNoResult> {
  const { program, trader, marketPda, usdcMint, book, amount } = params;

  if (amount <= 0n) {
    throw new Error("buildSellNoTx: amount must be > 0");
  }

  const plan = book
    ? planFills(book, SIDE_BID, 0n, amount, true /* isMarket */)
    : { fills: [], totalFilled: 0n, remaining: amount };
  if (plan.totalFilled < amount) {
    throw new SellNoIocError(
      `Atomic Sell NO needs ${amount} YES of ask liquidity; only ${plan.totalFilled} available. Aborting before submission (on-chain redeem_pair would also revert).`,
      amount,
      plan.totalFilled,
    );
  }

  // ── PDAs + ATAs ─────────────────────────────────────────────────────────
  const [config] = deriveMarketConfigPda();
  const [yesMint] = deriveYesMintPda(marketPda);
  const [noMint] = deriveNoMintPda(marketPda);
  const [usdcVault] = deriveUsdcVaultPda(marketPda);
  const [orderBook] = deriveOrderBookPda(marketPda);
  const [usdcEscrow] = deriveUsdcEscrowPda(marketPda);
  const [yesEscrow] = deriveYesEscrowPda(marketPda);

  const userUsdc = getAssociatedTokenAddressSync(usdcMint, trader, true);
  const userYes = getAssociatedTokenAddressSync(yesMint, trader, true);
  const userNo = getAssociatedTokenAddressSync(noMint, trader, true);

  const prelude: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(trader, userUsdc, trader, usdcMint),
    createAssociatedTokenAccountIdempotentInstruction(trader, userYes, trader, yesMint),
    createAssociatedTokenAccountIdempotentInstruction(trader, userNo, trader, noMint),
  ];

  // ── place_order(BID, market) leg — maker payouts in USDC ────────────────
  const remainingAccounts: AccountMeta[] = plan.fills.map((fill) => ({
    pubkey: getAssociatedTokenAddressSync(usdcMint, fill.makerOwner, true),
    isSigner: false,
    isWritable: true,
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const placeOrderBuilders = (program.methods as any).placeOrder;
  if (!placeOrderBuilders) {
    throw new Error("buildSellNoTx: 'placeOrder' missing from IDL.");
  }
  const placeOrderIx: TransactionInstruction = await placeOrderBuilders(
    SIDE_BID,
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

  // ── redeem_pair leg ─────────────────────────────────────────────────────
  const redeemPairIx = await callAnchorMethod(
    program,
    "redeemPair",
    new BN(amount.toString()),
    {
      user: trader,
      config,
      strikeMarket: marketPda,
      yesMint,
      noMint,
      userYes,
      userNo,
      usdcVault,
      userUsdc,
      usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
    },
  );

  const tx = new Transaction();
  for (const p of prelude) tx.add(p);
  tx.add(placeOrderIx);
  tx.add(redeemPairIx);

  return {
    tx,
    prelude,
    placeOrderIx,
    redeemPairIx,
    plannedFilled: plan.totalFilled,
  };
}

/**
 * Thrown by `buildSellNoTx` when the ask book can't fully absorb the
 * `amount` YES the bid leg would need. Caller catches to present a clear
 * "thin/empty ask book" UX state.
 */
export class SellNoIocError extends Error {
  constructor(
    message: string,
    public readonly required: bigint,
    public readonly available: bigint,
  ) {
    super(message);
    this.name = "SellNoIocError";
  }
}
