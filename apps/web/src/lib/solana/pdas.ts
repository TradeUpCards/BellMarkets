import { PublicKey } from "@solana/web3.js";

import { BELL_MARKETS_PROGRAM_PUBKEY } from "./config";

const STRIKE_PREFIX = Buffer.from("strike");
const YES_PREFIX = Buffer.from("yes");
const NO_PREFIX = Buffer.from("no");
const VAULT_PREFIX = Buffer.from("vault");
const CONFIG_PREFIX = Buffer.from("config");

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
