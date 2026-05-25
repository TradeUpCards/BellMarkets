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
  deriveOrderBookPda,
  deriveUsdcEscrowPda,
  deriveYesEscrowPda,
  deriveYesMintPda,
} from "@/lib/solana/pdas";
import {
  SIDE_ASK,
  SIDE_BID,
  type PlannedFill,
} from "@/lib/solana/order-book";

export type OrderSide = typeof SIDE_BID | typeof SIDE_ASK;

export interface BuildPlaceOrderParams {
  program: Program<Idl>;
  trader: PublicKey;
  /** BellMarkets `StrikeMarket` PDA. */
  marketPda: PublicKey;
  /** USDC mint pubkey from MarketConfig. */
  usdcMint: PublicKey;
  /** SIDE_BID (0) or SIDE_ASK (1). */
  side: OrderSide;
  /**
   * Limit price in USDC base units per YES (range `[1, PRICE_SCALE]`). For
   * market orders this is ignored on chain but should still be a valid u64
   * (recommend 0). The args struct is `(side, price, size, is_market)`.
   */
  price: bigint;
  /**
   * YES tokens in base units (10^6 = one "macro" YES). For a market BID the
   * program escrows up to `size` USDC base units (worst case = $1/YES).
   */
  size: bigint;
  /** When true, drains as many crossing makers as exist; refunds unused escrow. */
  isMarket: boolean;
  /**
   * Maker payout ATAs in fill order (best-price/time first). The `place_order`
   * handler iterates `remaining_accounts.iter().take(planned.len())` — order
   * MUST match the off-chain `plan_fills` result that produced the list.
   *
   * - Incoming BID → ask makers paid in USDC (their USDC ATA).
   * - Incoming ASK → bid makers paid in YES (their YES ATA).
   */
  plannedFills: PlannedFill[];
}

export interface BuildPlaceOrderResult {
  tx: Transaction;
  prelude: TransactionInstruction[];
  ix: TransactionInstruction;
  pdas: {
    config: PublicKey;
    orderBook: PublicKey;
    yesMint: PublicKey;
    usdcEscrow: PublicKey;
    yesEscrow: PublicKey;
  };
}

/**
 * Build (don't send) a `place_order` transaction against the DR-020 in-program
 * CLOB. Composes the maker-payout `remaining_accounts` array from the supplied
 * `plannedFills` (off-chain mirror of `matching::plan_fills`).
 *
 * **IOC partial-fill posture (DR-019 + `.project/stories/ioc-partial-fill-stranding.md`):**
 * the on-chain `place_order` does NOT take a minimum-fill arg — market
 * remainders refund silently. Callers that need fill-or-revert semantics (the
 * atomic Buy NO / Sell NO bundles) MUST verify off-chain that
 * `plannedFills.totalFilled >= size` BEFORE submitting; the wrapping
 * `buildBuyNoTx` / `buildSellNoTx` builders enforce this.
 *
 * **DR-019 limit-NO posture:** the UI gates the Limit toggle off for NO-side
 * trades. This builder doesn't know about NO directly — it operates on YES
 * book primitives — so the rule lives at the UI layer (`trade-view.tsx`).
 */
export async function buildPlaceOrderTx(
  params: BuildPlaceOrderParams,
): Promise<BuildPlaceOrderResult> {
  const {
    program,
    trader,
    marketPda,
    usdcMint,
    side,
    price,
    size,
    isMarket,
    plannedFills,
  } = params;

  if (size <= 0n) {
    throw new Error("buildPlaceOrderTx: size must be > 0");
  }

  const [config] = deriveMarketConfigPda();
  const [orderBook] = deriveOrderBookPda(marketPda);
  const [yesMint] = deriveYesMintPda(marketPda);
  const [usdcEscrow] = deriveUsdcEscrowPda(marketPda);
  const [yesEscrow] = deriveYesEscrowPda(marketPda);

  const userUsdc = getAssociatedTokenAddressSync(usdcMint, trader, true);
  const userYes = getAssociatedTokenAddressSync(yesMint, trader, true);

  const prelude: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(
      trader,
      userUsdc,
      trader,
      usdcMint,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      trader,
      userYes,
      trader,
      yesMint,
    ),
  ];

  // Maker payout ATAs in fill order. Incoming BID → makers paid in USDC at
  // their respective resting-ask owners; incoming ASK → makers paid in YES.
  const makerPayoutMint = side === SIDE_BID ? usdcMint : yesMint;
  const remainingAccounts: AccountMeta[] = plannedFills.map((fill) => ({
    pubkey: getAssociatedTokenAddressSync(makerPayoutMint, fill.makerOwner, true),
    isSigner: false,
    isWritable: true,
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builders = (program.methods as any).placeOrder;
  if (!builders) {
    throw new Error("buildPlaceOrderTx: 'placeOrder' missing from IDL.");
  }

  const ix: TransactionInstruction = await builders(
    side,
    new BN(price.toString()),
    new BN(size.toString()),
    isMarket,
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
  tx.add(ix);

  return {
    tx,
    prelude,
    ix,
    pdas: { config, orderBook, yesMint, usdcEscrow, yesEscrow },
  };
}
