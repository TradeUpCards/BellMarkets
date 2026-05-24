//! One-shot: create + populate + freeze a versioned-transaction Address
//! Lookup Table (ALT) containing the BellMarkets standard accounts.
//!
//! Per `constitution/decisions.md` DR-015 §"Defensive: Address Lookup Tables"
//! and `.project/bell-markets/coordination/queued-work.md` DR-015
//! §"Defensive: Address Lookup Tables (ALT)":
//!
//! > Aria sets up a single ALT containing the standard accounts
//! > (token_program, system_program, rent, weekly_pool, monthly_pool,
//! > usdc_mint, fee_collector, leaderboard_commitments). Each `distribute_*`
//! > tx references those accounts by 1-byte index instead of 32-byte pubkey
//! > — saves ~200 bytes per tx. Not required for v1 launch (we have
//! > headroom), but kept on the shelf for when account count grows.
//!
//! ## Why a standalone Rust binary instead of TypeScript
//!
//! Same DR-004 cascade that drove `bootstrap-config` + `bootstrap-p5` — JS
//! workspace's rpc-websockets ↔ uuid CJS-ESM blocks `@solana/web3.js`
//! direct use without overrides. Rust SDK sidesteps that entirely.
//!
//! ## Workflow
//!
//! 1. Create ALT (`create_lookup_table` ix). Returns `(create_ix, alt_pubkey)`.
//!    ALT pubkey is derived deterministically from `(payer, recent_slot)` so
//!    we capture both for reproducibility / audit trail.
//! 2. Extend ALT with 8 standard addresses (`extend_lookup_table` ix).
//! 3. Freeze ALT (`freeze_lookup_table` ix) — makes it immutable forever.
//!    Frozen ALTs cannot be extended OR deactivated, so account-set stability
//!    is guaranteed against future authority compromise.
//!
//! Three txs total. All signed by `keys/devnet-upgrade-authority.json`
//! (matching the upgrade-authority role on BellMarkets program; admin
//! keypair pattern is the same security envelope).
//!
//! Run from WSL Ubuntu:
//!   cd migrations/setup-alt
//!   cargo run --release

use std::fs;
use std::str::FromStr;

use solana_client::rpc_client::RpcClient;
use solana_program::address_lookup_table::instruction::{
    create_lookup_table, extend_lookup_table, freeze_lookup_table,
};
use solana_sdk::{
    commitment_config::CommitmentConfig,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    signer::keypair::read_keypair_file,
    transaction::Transaction,
};

const RPC_URL: &str = "https://api.devnet.solana.com";
const AUTHORITY_KEYPAIR_PATH: &str = "../../keys/devnet-upgrade-authority.json";

// Standard accounts per DR-015 + queued-work.md DR-015 §"Defensive: ALT".
// Order is documentation-only; off-chain SDK callers iterate the ALT by
// index, so reordering on a future update would be a breaking change for
// any tx-builder that hardcoded indices. The ALT is frozen post-extend
// (immutable), so practically: this set is the v1 ALT contents, full stop.

const TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROGRAM_ID: &str = "11111111111111111111111111111111";
const RENT_SYSVAR_ID: &str = "SysvarRent111111111111111111111111111111111";
const USDC_DEVNET_MINT: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const FEE_COLLECTOR_WALLET: &str = "FAc2JccudUr9C5pqB2KAnaBaPXLuejYotvfjuuysUrjs";

// PDAs from the deploy_index=5 bootstrap-p5 run:
const WEEKLY_POOL: &str = "2VWzrhmdNZN7Yxv2uknYBurJ2PDFzCqsyi5WVeVxJpCW";
const MONTHLY_POOL: &str = "Eppjny6RMtVrGxZnjiKEyk41vwWYpXW4PMVKJHC4SAjh";
const LEADERBOARD_COMMITMENTS: &str = "FxohonFj6bTtbPxe4HNjwy736sqkyPfKj5GRektScF7C";

fn main() {
    println!("BellMarkets setup-alt — DR-015 standard-accounts ALT");
    println!();

    let authority_path = canonicalize_relative(AUTHORITY_KEYPAIR_PATH);
    let authority: Keypair = read_keypair_file(&authority_path)
        .unwrap_or_else(|e| panic!("failed to read authority keypair from {authority_path}: {e}"));
    println!("Authority + payer: {}", authority.pubkey());

    let rpc = RpcClient::new_with_commitment(RPC_URL.to_string(), CommitmentConfig::confirmed());

    // Step 0: gather the addresses we'll put in the ALT.
    let addresses: Vec<(&str, Pubkey)> = vec![
        ("token_program", Pubkey::from_str(TOKEN_PROGRAM_ID).unwrap()),
        ("system_program", Pubkey::from_str(SYSTEM_PROGRAM_ID).unwrap()),
        ("rent_sysvar", Pubkey::from_str(RENT_SYSVAR_ID).unwrap()),
        ("usdc_mint", Pubkey::from_str(USDC_DEVNET_MINT).unwrap()),
        ("fee_collector_wallet", Pubkey::from_str(FEE_COLLECTOR_WALLET).unwrap()),
        ("weekly_pool", Pubkey::from_str(WEEKLY_POOL).unwrap()),
        ("monthly_pool", Pubkey::from_str(MONTHLY_POOL).unwrap()),
        ("leaderboard_commitments", Pubkey::from_str(LEADERBOARD_COMMITMENTS).unwrap()),
    ];

    println!("ALT contents ({} addresses):", addresses.len());
    for (i, (name, pk)) in addresses.iter().enumerate() {
        println!("  [{i}] {name:30} {pk}");
    }
    println!();

    // Step 1: create ALT.
    // Per Solana docs: `recent_slot` must be one of the last ~150 confirmed
    // slots. We use the slot ONE BEHIND the latest to be safe against the
    // RPC reporting a slot that the cluster doesn't yet accept as "confirmed".
    let recent_slot = rpc.get_slot().expect("get slot") - 1;
    let (create_ix, alt_pubkey) = create_lookup_table(
        authority.pubkey(),  // authority
        authority.pubkey(),  // payer
        recent_slot,
    );
    println!("Step 1: create ALT at recent_slot={recent_slot}");
    println!("  ALT pubkey: {alt_pubkey}");
    let blockhash = rpc.get_latest_blockhash().expect("blockhash");
    let tx1 = Transaction::new_signed_with_payer(
        &[create_ix],
        Some(&authority.pubkey()),
        &[&authority],
        blockhash,
    );
    let sig1 = rpc.send_and_confirm_transaction(&tx1)
        .unwrap_or_else(|e| { eprintln!("create_lookup_table failed: {e:?}"); std::process::exit(1); });
    println!("  ✓ create tx: {sig1}");
    println!();

    // Step 2: extend ALT with all 8 addresses in one tx.
    // (One tx because the addresses fit comfortably in tx size limits;
    // for >30 addresses, we'd batch — not the case here.)
    println!("Step 2: extend ALT with {} addresses", addresses.len());
    let extend_ix = extend_lookup_table(
        alt_pubkey,
        authority.pubkey(),       // authority
        Some(authority.pubkey()), // payer (covers rent for added entries)
        addresses.iter().map(|(_, pk)| *pk).collect(),
    );
    let blockhash = rpc.get_latest_blockhash().expect("blockhash");
    let tx2 = Transaction::new_signed_with_payer(
        &[extend_ix],
        Some(&authority.pubkey()),
        &[&authority],
        blockhash,
    );
    let sig2 = rpc.send_and_confirm_transaction(&tx2)
        .unwrap_or_else(|e| { eprintln!("extend_lookup_table failed: {e:?}"); std::process::exit(2); });
    println!("  ✓ extend tx: {sig2}");
    println!();

    // Step 3: freeze ALT. Once frozen the ALT can never be extended OR
    // deactivated again — the account set is forever this {8 addresses}.
    // This is the security-better default: future authority compromise
    // can't insert malicious addresses or remove ours.
    println!("Step 3: freeze ALT (makes account-set permanent)");
    let freeze_ix = freeze_lookup_table(alt_pubkey, authority.pubkey());
    let blockhash = rpc.get_latest_blockhash().expect("blockhash");
    let tx3 = Transaction::new_signed_with_payer(
        &[freeze_ix],
        Some(&authority.pubkey()),
        &[&authority],
        blockhash,
    );
    let sig3 = rpc.send_and_confirm_transaction(&tx3)
        .unwrap_or_else(|e| { eprintln!("freeze_lookup_table failed: {e:?}"); std::process::exit(3); });
    println!("  ✓ freeze tx: {sig3}");
    println!();

    println!("✓ ALT setup complete.");
    println!();
    println!("  ALT pubkey:          {alt_pubkey}");
    println!("  Address count:       {}", addresses.len());
    println!("  Frozen (immutable):  yes");
    println!();
    println!("  Bram + Cleo: add this ALT to your versioned-tx construction.");
    println!("  Per-tx savings: 8 × (32 - 1) = ~248 bytes for any tx that");
    println!("  references all 8 indexed accounts; ~200 B for typical usage.");
    println!();
    println!("  Document at: .project/bell-markets/coordination/devnet-pubkeys.md");
    println!("  (Tate-owned; reference this ALT pubkey in the next pubkey-doc update.)");
}

fn canonicalize_relative(rel: &str) -> String {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let joined = std::path::Path::new(manifest_dir).join(rel);
    fs::canonicalize(&joined)
        .unwrap_or_else(|e| panic!("failed to resolve {}: {e}", joined.display()))
        .to_string_lossy()
        .into_owned()
}
