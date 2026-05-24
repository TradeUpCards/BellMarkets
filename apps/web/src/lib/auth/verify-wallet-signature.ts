/**
 * Verifies an ed25519 signature produced by a Solana wallet, matching the
 * `Link <provider> account` message convention from the fffanalytics_t3
 * reference implementation.
 *
 * Throws on:
 *   - Malformed base58 signature or pubkey
 *   - Signature/message/pubkey triple that nacl rejects
 *
 * Returns the verified wallet's canonical base58 pubkey on success.
 */

import bs58 from "bs58";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";

/** Message format users sign in the client before triggering OAuth. */
export function linkMessage(provider: string): string {
  return `Link ${provider} account`;
}

export function verifyWalletSignature(
  signedBase58: string,
  pubkeyBase58: string,
  provider: string,
): string {
  const signatureBytes = bs58.decode(signedBase58);
  const message = new TextEncoder().encode(linkMessage(provider));
  const pubkey = new PublicKey(pubkeyBase58);

  const ok = nacl.sign.detached.verify(
    message,
    signatureBytes,
    pubkey.toBytes(),
  );
  if (!ok) {
    throw new Error("verifyWalletSignature: signature rejected by ed25519.");
  }
  return pubkey.toBase58();
}
