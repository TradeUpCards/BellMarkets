// Admin script: generate N test wallets + store keypairs to keys/test-wallets.json.
//
// Usage:
//   pnpm --filter @bell-markets/automation gen-test-wallets [count] [--force]
//   e.g. pnpm --filter @bell-markets/automation gen-test-wallets 100
//        pnpm --filter @bell-markets/automation gen-test-wallets 100 --force
//
// Behavior:
//   1. Generates `count` fresh Solana keypairs (default: 100)
//   2. Writes to keys/test-wallets.json (gitignored — never committed)
//   3. Each wallet entry: { index, pubkey, secretKeyBase58, secretKeyBytes }
//   4. Refuses to overwrite existing file unless --force flag
//   5. Prints first 3 pubkeys for sanity-check
//
// Output format compatible with:
//   - solana CLI (secretKeyBytes is the 64-element array `[n,n,...]` format)
//   - Phantom import (secretKeyBase58 is what Phantom's "Import private key" accepts)
//   - downstream fund-test-wallets.ts (iterates the array)
//
// Hard rule: keys/test-wallets.json is gitignored. NEVER commit it.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_COUNT = 100;
const OUTPUT_PATH = resolve("keys/test-wallets.json");

function parseArgs(): { count: number; force: boolean } {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const countArg = args.find((a) => !a.startsWith("--"));
  const count = countArg ? Number(countArg) : DEFAULT_COUNT;
  if (!Number.isFinite(count) || count <= 0 || count > 1000) {
    throw new Error(`count must be 1-1000, got "${countArg}"`);
  }
  return { count, force };
}

async function main() {
  const { count, force } = parseArgs();

  if (existsSync(OUTPUT_PATH) && !force) {
    console.error(
      JSON.stringify({
        event: "operator.gen-test-wallets.abort",
        reason: "file_exists",
        path: OUTPUT_PATH,
        hint: "rerun with --force to overwrite",
      }),
    );
    process.exit(1);
  }

  console.error(
    JSON.stringify({
      event: "operator.gen-test-wallets.start",
      count,
      outputPath: OUTPUT_PATH,
    }),
  );

  const web3 = await import("@solana/web3.js");
  const bs58 = (await import("bs58")).default;

  const wallets = [];
  for (let i = 0; i < count; i++) {
    const kp = web3.Keypair.generate();
    wallets.push({
      index: i,
      pubkey: kp.publicKey.toBase58(),
      secretKeyBase58: bs58.encode(kp.secretKey),
      secretKeyBytes: Array.from(kp.secretKey),
    });
  }

  // Ensure parent dir exists
  if (!existsSync(dirname(OUTPUT_PATH))) {
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  }

  writeFileSync(OUTPUT_PATH, JSON.stringify(wallets, null, 2), { mode: 0o600 });

  console.error(
    JSON.stringify({
      event: "operator.gen-test-wallets.success",
      count: wallets.length,
      outputPath: OUTPUT_PATH,
      firstThreePubkeys: wallets.slice(0, 3).map((w) => w.pubkey),
    }),
  );

  console.log(
    JSON.stringify({
      ok: true,
      count: wallets.length,
      path: OUTPUT_PATH,
      firstPubkey: wallets[0].pubkey,
      lastPubkey: wallets[wallets.length - 1].pubkey,
      note: "keys/test-wallets.json is gitignored. Do NOT commit.",
    }),
  );
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      event: "operator.gen-test-wallets.fatal",
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
  process.exit(1);
});
