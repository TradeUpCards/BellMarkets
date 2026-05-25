import { PublicKey } from "@solana/web3.js";

import { BELL_MARKETS_PROGRAM_PUBKEY } from "./config";

const STRIKE_PREFIX = Buffer.from("strike");
const YES_PREFIX = Buffer.from("yes");
const NO_PREFIX = Buffer.from("no");
const VAULT_PREFIX = Buffer.from("vault");
const CONFIG_PREFIX = Buffer.from("config");
// Seeds reconciled against the live 20-ix IDL (`apps/web/src/idl/bell_markets.json`).
// Each label sourced from `instructions[].accounts[].pda.seeds` — see the IDL
// JSON for byte-level evidence.
const TICKER_PREFIX = Buffer.from("ticker");
const USER_CONFIG_PREFIX = Buffer.from("user"); // not "user_config" — short seed per IDL
const WEEKLY_POOL_PREFIX = Buffer.from("weekly_pool");
const MONTHLY_POOL_PREFIX = Buffer.from("monthly_pool");
const LEADERBOARD_PREFIX = Buffer.from("leaderboard_commits");
const FEE_CONFIG_PREFIX = Buffer.from("fee_config");

// DR-020 in-program CLOB seeds (deploy_index=7).
const ORDER_BOOK_PREFIX = Buffer.from("order_book");
const USDC_ESCROW_PREFIX = Buffer.from("usdc_escrow");
const YES_ESCROW_PREFIX = Buffer.from("yes_escrow");

function bnLe(value: bigint, byteLength: number): Buffer {
  const buf = Buffer.alloc(byteLength);
  let v = value;
  for (let i = 0; i < byteLength; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

export function deriveConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [CONFIG_PREFIX],
    BELL_MARKETS_PROGRAM_PUBKEY,
  );
}

export function deriveStrikeMarketPda(
  underlyingPythFeed: PublicKey,
  expiryUnix: bigint,
  strikePrice: bigint,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      STRIKE_PREFIX,
      underlyingPythFeed.toBuffer(),
      bnLe(expiryUnix, 8),
      bnLe(strikePrice, 8),
    ],
    BELL_MARKETS_PROGRAM_PUBKEY,
  );
}

export function deriveYesMintPda(strikeMarket: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [YES_PREFIX, strikeMarket.toBuffer()],
    BELL_MARKETS_PROGRAM_PUBKEY,
  );
}

export function deriveNoMintPda(strikeMarket: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [NO_PREFIX, strikeMarket.toBuffer()],
    BELL_MARKETS_PROGRAM_PUBKEY,
  );
}

export function deriveUsdcVaultPda(
  strikeMarket: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_PREFIX, strikeMarket.toBuffer()],
    BELL_MARKETS_PROGRAM_PUBKEY,
  );
}

/**
 * `TickerConfig` PDA per Pyth feed (DR-005 + DR-006). Holds `cap_center`,
 * `allowed_strikes`, `max_user_strike_deviation_bps`, `strike_tick_size`,
 * `threshold_bps`, etc.
 */
export function deriveTickerConfigPda(
  underlyingPythFeed: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [TICKER_PREFIX, underlyingPythFeed.toBuffer()],
    BELL_MARKETS_PROGRAM_PUBKEY,
  );
}

/**
 * `UserConfig` PDA per (config, user). Seeds `[b"user", config, user]` per
 * IDL — the config PDA IS part of the seed (binds the user-config to the
 * specific MarketConfig). Holds `mint_volume_30d`, `mint_volume_lifetime`,
 * `last_decay_unix`. `init_if_needed` from `mint_pair`; ~$0.16 user-paid
 * rent on first mint.
 */
export function deriveUserConfigPda(
  config: PublicKey,
  user: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [USER_CONFIG_PREFIX, config.toBuffer(), user.toBuffer()],
    BELL_MARKETS_PROGRAM_PUBKEY,
  );
}

/**
 * `WeeklyPool` PDA per DR-010. Seed `[b"weekly_pool"]`. The PDA IS a USDC
 * token account owned by the program — `weekly_pool_bps` of every `mint_pair`
 * fee flows here; drained by `distribute_weekly_rewards`.
 */
export function deriveWeeklyPoolPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [WEEKLY_POOL_PREFIX],
    BELL_MARKETS_PROGRAM_PUBKEY,
  );
}

/** `MonthlyPool` PDA per DR-010. Seed `[b"monthly_pool"]`. */
export function deriveMonthlyPoolPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [MONTHLY_POOL_PREFIX],
    BELL_MARKETS_PROGRAM_PUBKEY,
  );
}

/**
 * `LeaderboardCommitments` PDA per DR-010 §"Option B Merkle commitment".
 * Seed `[b"leaderboard_commits"]` — note the trailing 's' / underscore vs
 * the more obvious `"leaderboard"`. Sourced from IDL `account_keys`.
 */
export function deriveLeaderboardCommitmentsPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [LEADERBOARD_PREFIX],
    BELL_MARKETS_PROGRAM_PUBKEY,
  );
}

/** `FeeConfig` global singleton per DR-008. Seed `[b"fee_config"]`. */
export function deriveFeeConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [FEE_CONFIG_PREFIX],
    BELL_MARKETS_PROGRAM_PUBKEY,
  );
}

/**
 * `OrderBook` PDA per strike (DR-020 in-program CLOB, deploy_index=7).
 * Seeds `[b"order_book", strike_market]`. Zero-copy account (16,448 bytes
 * post `grow_order_book`). The address is also written to
 * `strike_market.order_book` as the trading gate.
 */
export function deriveOrderBookPda(
  strikeMarket: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ORDER_BOOK_PREFIX, strikeMarket.toBuffer()],
    BELL_MARKETS_PROGRAM_PUBKEY,
  );
}

/**
 * Per-strike USDC escrow PDA — holds escrowed USDC for resting bid orders.
 * Authority = strike_market PDA (reused per DR-020). Seeds
 * `[b"usdc_escrow", strike_market]`.
 */
export function deriveUsdcEscrowPda(
  strikeMarket: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [USDC_ESCROW_PREFIX, strikeMarket.toBuffer()],
    BELL_MARKETS_PROGRAM_PUBKEY,
  );
}

/**
 * Per-strike YES escrow PDA — holds escrowed YES tokens for resting ask
 * orders. Authority = strike_market PDA. Seeds
 * `[b"yes_escrow", strike_market]`.
 */
export function deriveYesEscrowPda(
  strikeMarket: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [YES_ESCROW_PREFIX, strikeMarket.toBuffer()],
    BELL_MARKETS_PROGRAM_PUBKEY,
  );
}
