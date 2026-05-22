//! One-shot bootstrap: call `initialize_config` on the deployed BellMarkets
//! program on devnet, signed by the platform admin keypair.
//!
//! Why a standalone Rust binary instead of TypeScript: the workspace's JS
//! environment has a known `rpc-websockets@9.3.9` ↔ `uuid@14.0.0` CJS-ESM
//! cascade (DR-004) that blocks any `@coral-xyz/anchor` or full
//! `@solana/web3.js` import. Routing this through a Rust binary sidesteps the
//! cascade entirely.
//!
//! Run from WSL Ubuntu (PATH must include solana-cli):
//!   cd migrations/bootstrap-config
//!   cargo run --release
//!
//! Idempotent: the program's `#[account(init, ...)]` constraint causes a
//! second run to fail at allocation. That's the desired behavior — re-running
//! by accident does NOT silently re-initialize.

use std::fs;
use std::str::FromStr;

use borsh::BorshSerialize;
use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    signer::keypair::read_keypair_file,
    system_program,
    sysvar,
    transaction::Transaction,
};

// ─── Constants (the canonical Day-2/Day-3 pubkeys) ─────────────────────────
const PROGRAM_ID: &str = "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV";
const USDC_DEVNET_MINT: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // Circle's official devnet USDC
const FEE_COLLECTOR: &str = "FAc2JccudUr9C5pqB2KAnaBaPXLuejYotvfjuuysUrjs"; // keys/devnet-fee-collector.json
const ADMIN_KEYPAIR_PATH: &str = "../../keys/devnet-platform-admin.json";
const RPC_URL: &str = "https://api.devnet.solana.com";

// Anchor instruction discriminator for `initialize_config`, copied from the
// committed IDL at programs/bell-markets/idl/bell_markets.json.
const INITIALIZE_CONFIG_DISCRIMINATOR: [u8; 8] = [208, 127, 21, 1, 194, 190, 196, 70];

// Kickoff defaults (see state.rs DEFAULT_* constants).
const PRICE_STALENESS_SECS: i64 = 300; // 5 minutes
const PRICE_CONFIDENCE_BPS: u16 = 50; // 0.5%
const ADMIN_OVERRIDE_DELAY_SECS: i64 = 3600; // 1 hour

#[derive(BorshSerialize)]
struct InitializeConfigArgs {
    price_staleness_secs: i64,
    price_confidence_bps: u16,
    admin_override_delay_secs: i64,
}

fn main() {
    println!("BellMarkets bootstrap-config — calling initialize_config on devnet");
    println!();

    let program_id = Pubkey::from_str(PROGRAM_ID).expect("valid program ID");
    let usdc_mint = Pubkey::from_str(USDC_DEVNET_MINT).expect("valid USDC mint");
    let treasury = Pubkey::from_str(FEE_COLLECTOR).expect("valid fee collector");

    // Load admin keypair from file. Anchor's `init` constraint will permanently
    // record this pubkey as `MarketConfig.admin` for the deployed program until
    // the program is upgraded (and a new MarketConfig is initialized).
    let admin_path = canonicalize_relative(ADMIN_KEYPAIR_PATH);
    let admin: Keypair = read_keypair_file(&admin_path)
        .unwrap_or_else(|e| panic!("failed to read admin keypair from {admin_path}: {e}"));
    println!("Admin pubkey:     {}", admin.pubkey());
    println!("USDC mint:        {usdc_mint}");
    println!("Treasury:         {treasury}");
    println!("Program ID:       {program_id}");

    // Derive the MarketConfig PDA: seeds = [b"config"]
    let (config_pda, bump) = Pubkey::find_program_address(&[b"config"], &program_id);
    println!("Config PDA:       {config_pda} (bump {bump})");
    println!();

    let rpc = RpcClient::new_with_commitment(RPC_URL.to_string(), CommitmentConfig::confirmed());

    // Pre-flight: check the PDA doesn't already exist (idempotency guard).
    match rpc.get_account(&config_pda) {
        Ok(_) => {
            eprintln!("ERROR: MarketConfig PDA {config_pda} already exists on devnet.");
            eprintln!("       initialize_config has already been called against this program.");
            eprintln!("       Inspect on-chain with: solana account {config_pda} --url devnet");
            std::process::exit(1);
        }
        Err(e) if format!("{e:?}").contains("AccountNotFound") => {
            println!("Pre-flight: MarketConfig PDA does not exist yet — proceeding.");
        }
        Err(e) => {
            eprintln!("ERROR: unexpected RPC error during pre-flight: {e:?}");
            std::process::exit(2);
        }
    }

    // Build instruction data: 8-byte Anchor discriminator + borsh-encoded args.
    let args = InitializeConfigArgs {
        price_staleness_secs: PRICE_STALENESS_SECS,
        price_confidence_bps: PRICE_CONFIDENCE_BPS,
        admin_override_delay_secs: ADMIN_OVERRIDE_DELAY_SECS,
    };
    let mut data = Vec::with_capacity(8 + 18);
    data.extend_from_slice(&INITIALIZE_CONFIG_DISCRIMINATOR);
    args.serialize(&mut data).expect("borsh serialize");

    // Account order MUST match programs/bell-markets/src/instructions/initialize_config.rs.
    let accounts = vec![
        AccountMeta::new(admin.pubkey(), true),      // admin (signer, writable — pays for PDA init)
        AccountMeta::new(config_pda, false),         // config PDA (writable, NOT signer — program signs via PDA bump)
        AccountMeta::new_readonly(usdc_mint, false), // usdc_mint
        AccountMeta::new_readonly(treasury, false),  // treasury (UncheckedAccount, just stored)
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(spl_token_id(), false),
        AccountMeta::new_readonly(sysvar::rent::ID, false),
    ];

    let ix = Instruction { program_id, accounts, data };

    // Construct + sign + send.
    let recent_blockhash = rpc
        .get_latest_blockhash()
        .expect("get latest blockhash");
    println!("Recent blockhash: {recent_blockhash}");
    println!("Staleness:        {PRICE_STALENESS_SECS} secs");
    println!("Confidence:       {PRICE_CONFIDENCE_BPS} bps");
    println!("Override delay:   {ADMIN_OVERRIDE_DELAY_SECS} secs");
    println!();
    println!("Sending transaction...");

    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&admin.pubkey()),
        &[&admin],
        recent_blockhash,
    );

    let sig = rpc
        .send_and_confirm_transaction(&tx)
        .unwrap_or_else(|e| {
            eprintln!("ERROR: send_and_confirm_transaction failed: {e:?}");
            std::process::exit(3);
        });
    println!("Success! tx signature: {sig}");

    // Post-flight verification.
    println!();
    println!("Verifying on chain...");
    let account = rpc
        .get_account(&config_pda)
        .expect("config PDA should now exist");
    println!("MarketConfig PDA size: {} bytes (Anchor 8 discriminator + ~250 data)", account.data.len());
    println!("Owner:                 {}", account.owner);
    assert_eq!(account.owner, program_id, "PDA should be owned by program");

    println!();
    println!("✓ initialize_config complete.");
    println!("  Program:  {program_id}");
    println!("  Config:   {config_pda}");
    println!("  Admin:    {} (bound by Anchor init constraint)", admin.pubkey());
    println!("  Tx:       https://explorer.solana.com/tx/{sig}?cluster=devnet");
}

/// SPL Token program ID (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).
/// Vendored as a const so we don't pull in the full `spl-token` crate just
/// to spell out 32 bytes.
fn spl_token_id() -> Pubkey {
    Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap()
}

/// Resolve a relative path against this crate's manifest dir so the script
/// can be run from any working directory.
fn canonicalize_relative(rel: &str) -> String {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let joined = std::path::Path::new(manifest_dir).join(rel);
    fs::canonicalize(&joined)
        .unwrap_or_else(|e| panic!("failed to resolve {}: {e}", joined.display()))
        .to_string_lossy()
        .into_owned()
}
