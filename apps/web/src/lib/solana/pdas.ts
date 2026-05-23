import { PublicKey } from "@solana/web3.js";

import { BELL_MARKETS_PROGRAM_PUBKEY } from "./config";

const STRIKE_PREFIX = Buffer.from("strike");
const YES_PREFIX = Buffer.from("yes");
const NO_PREFIX = Buffer.from("no");
const VAULT_PREFIX = Buffer.from("vault");
const CONFIG_PREFIX = Buffer.from("config");
// PROVISIONAL SEEDS — confirmed seeds will land with Aria's IDL refresh.
// Per DR-005 / DR-008 / DR-010 these are the structurally-correct labels;
// adjust to match Aria's final account-derive_account_keys at IDL pickup.
const TICKER_PREFIX = Buffer.from("ticker");
const USER_CONFIG_PREFIX = Buffer.from("user_config");
const WEEKLY_REWARDS_PREFIX = Buffer.from("weekly_rewards");
const MONTHLY_REWARDS_PREFIX = Buffer.from("monthly_rewards");
const LEADERBOARD_PREFIX = Buffer.from("leaderboard");

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
 * `UserConfig` PDA per wallet (DR-008). Holds `mint_volume_30d`,
 * `mint_volume_lifetime`, last-decay timestamps. `init_if_needed` from
 * `mint_pair`; ~$0.16 user-paid rent on first mint.
 */
export function deriveUserConfigPda(user: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [USER_CONFIG_PREFIX, user.toBuffer()],
    BELL_MARKETS_PROGRAM_PUBKEY,
  );
}

/** `WeeklyRewardsPool` (USDC token account, owned by program PDA) per DR-010. */
export function deriveWeeklyRewardsPoolPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [WEEKLY_REWARDS_PREFIX],
    BELL_MARKETS_PROGRAM_PUBKEY,
  );
}

/** `MonthlyRewardsPool` per DR-010. */
export function deriveMonthlyRewardsPoolPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [MONTHLY_REWARDS_PREFIX],
    BELL_MARKETS_PROGRAM_PUBKEY,
  );
}

/** `LeaderboardCommitments` PDA per DR-010 §"Option B (Merkle commitment)". */
export function deriveLeaderboardCommitmentsPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [LEADERBOARD_PREFIX],
    BELL_MARKETS_PROGRAM_PUBKEY,
  );
}
