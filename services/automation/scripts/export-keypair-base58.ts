// Print the base58-encoded private key for a Solana keypair JSON file —
// the form Phantom / Solflare / Backpack accept in their "Import private
// key" flows.
//
// Usage:
//   pnpm --filter @bell-markets/automation export-keypair <path-from-repo-root>
//
//   pnpm --filter @bell-markets/automation export-keypair keys/devnet-platform-admin.json
//
// Output goes to stdout — pipe to clip / xclip / pbcopy as needed:
//   pnpm --filter @bell-markets/automation export-keypair keys/devnet-platform-admin.json | clip
//
// Safety:
//   - The pubkey is logged to stderr so you can sanity-check WHICH wallet
//     you're about to expose before pasting the base58 secret into a
//     browser extension.
//   - The base58 secret is the ONLY thing written to stdout — so a single
//     `| clip` pipe puts the right thing on the clipboard.
//   - Clear your terminal scrollback afterward (`cls` on Windows / `clear`
//     on bash) if you ran without the pipe.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import bs58 from "bs58";

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    process.stderr.write(
      "usage: pnpm --filter @bell-markets/automation export-keypair <path-from-repo-root>\n" +
        "example: pnpm --filter @bell-markets/automation export-keypair keys/devnet-platform-admin.json\n",
    );
    process.exit(1);
  }

  // Path is given relative to the repo root; this script's cwd is
  // services/automation when run via the pnpm script, so step up two.
  const repoRoot = resolve(process.cwd(), "..", "..");
  const absolute = resolve(repoRoot, arg);
  const raw = readFileSync(absolute, "utf-8");
  const bytes = JSON.parse(raw) as number[];
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    process.stderr.write(
      `Keypair at ${absolute} must be a JSON array of 64 numbers (got length=${
        Array.isArray(bytes) ? bytes.length : "non-array"
      }).\n`,
    );
    process.exit(1);
  }
  const secret = Uint8Array.from(bytes);

  // Both lines to stdout — labeled clearly. Some terminals + pnpm wrappers
  // hide stderr behind the pnpm preamble, which made the prior version
  // appear to print only the pubkey.
  const web3 = await import("@solana/web3.js");
  const kp = web3.Keypair.fromSecretKey(secret);
  const pubkey = kp.publicKey.toBase58();
  const secretB58 = bs58.encode(secret);

  process.stdout.write("\n");
  process.stdout.write(`PUBKEY      : ${pubkey}\n`);
  process.stdout.write(`PRIVATE KEY : ${secretB58}\n`);
  process.stdout.write("\n");
}

main().catch((err) => {
  process.stderr.write(
    `fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
