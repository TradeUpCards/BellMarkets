// Admin script: export the first N test wallet private keys for Phantom import.
//
// Usage:
//   pnpm --filter @bell-markets/automation export-phantom [count] [--file path/to/export.txt]
//   e.g. pnpm --filter @bell-markets/automation export-phantom 10
//        pnpm --filter @bell-markets/automation export-phantom 10 --file phantom-imports.txt
//
// Behavior:
//   1. Reads keys/test-wallets.json (must run gen-test-wallets first)
//   2. Outputs the first `count` wallets (default 10) in Phantom-importable format
//   3. Each wallet output: index, pubkey, base58 secret key (paste into Phantom)
//   4. If --file is provided, also writes to a text file (gitignored — be careful)
//   5. Prints WARNING about handling secrets
//
// Phantom import steps:
//   - Open Phantom → Account dropdown (top) → "Add / Connect Wallet"
//   - "Import Private Key"
//   - Paste the secretKeyBase58 string
//   - Optionally name the wallet (e.g., "Test Wallet 1")
//
// SECURITY:
//   - keys/test-wallets.json is gitignored
//   - Output file (--file) goes to gitignored keys/ by default
//   - Never paste these keys publicly, share them externally, or use on mainnet
//   - These are DEVNET test wallets — they hold no real value, only bUSDC + devnet SOL

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const WALLETS_PATH = "keys/test-wallets.json";
const DEFAULT_COUNT = 10;
const DEFAULT_OUTPUT_DIR = "keys";

interface Wallet {
  index: number;
  pubkey: string;
  secretKeyBase58: string;
  secretKeyBytes: number[];
}

function parseArgs() {
  const args = process.argv.slice(2);
  const fileArg = args.indexOf("--file");
  const file = fileArg >= 0 ? args[fileArg + 1] : null;
  const countArg = args.find((a) => !a.startsWith("--") && a !== file);
  const count = countArg ? Number(countArg) : DEFAULT_COUNT;
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error(`count must be a positive number, got "${countArg}"`);
  }
  return { count, file };
}

function loadWallets(): Wallet[] {
  const raw = readFileSync(resolve(WALLETS_PATH), "utf-8");
  return JSON.parse(raw);
}

function formatForPhantom(w: Wallet): string {
  return [
    `=== Test Wallet #${w.index} ===`,
    `Pubkey:    ${w.pubkey}`,
    `Secret:    ${w.secretKeyBase58}`,
    `(paste the Secret line into Phantom → "Import Private Key")`,
    ``,
  ].join("\n");
}

async function main() {
  const { count, file } = parseArgs();
  const wallets = loadWallets();

  if (count > wallets.length) {
    throw new Error(
      `requested ${count} but only ${wallets.length} wallets exist in ${WALLETS_PATH}`,
    );
  }

  const toExport = wallets.slice(0, count);

  console.error(
    JSON.stringify({
      event: "operator.export-phantom.start",
      count,
      totalAvailable: wallets.length,
      outputFile: file,
    }),
  );

  const formatted = toExport.map(formatForPhantom).join("\n");

  const header = [
    "═══════════════════════════════════════════════════════════════════",
    "  PHANTOM IMPORT KEYS — DEVNET TEST WALLETS",
    "  DO NOT SHARE THESE. DO NOT COMMIT THIS OUTPUT.",
    "  These wallets only hold devnet bUSDC + devnet SOL.",
    `  Generated from: ${WALLETS_PATH}`,
    `  Exported: ${new Date().toISOString()}`,
    "═══════════════════════════════════════════════════════════════════",
    "",
    "How to import into Phantom:",
    "  1. Open Phantom → click the account dropdown at the top",
    `  2. "Add / Connect Wallet" → "Import Private Key"`,
    `  3. Copy the "Secret:" line below and paste into Phantom`,
    `  4. Name the wallet (e.g., "Test Wallet 1")`,
    "  5. Verify the public key matches the Pubkey line",
    "",
    "═══════════════════════════════════════════════════════════════════",
    "",
  ].join("\n");

  const output = header + formatted;

  // Print to stdout (so it can be piped / clipboard'd)
  process.stdout.write(output);

  // Optionally write to file
  if (file) {
    const filePath = file.includes("/") || file.includes("\\")
      ? resolve(file)
      : resolve(DEFAULT_OUTPUT_DIR, file);
    if (!existsSync(dirname(filePath))) {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    writeFileSync(filePath, output, { mode: 0o600 });
    console.error(
      JSON.stringify({
        event: "operator.export-phantom.file-written",
        path: filePath,
        warning: "this file contains private keys; gitignored by keys/ rule",
      }),
    );
  }

  console.error(
    JSON.stringify({
      event: "operator.export-phantom.success",
      exported: count,
      file: file ?? null,
    }),
  );
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      event: "operator.export-phantom.fatal",
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
  process.exit(1);
});
