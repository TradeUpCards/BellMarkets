//! One-shot bootstrap for deploy_index=5: call `initialize_fee_config` and
//! `initialize_rewards_pools` on the deployed BellMarkets program. Both are
//! one-shot admin ixs — second call against the same PDA fails at allocation.
//!
//! Defaults match the DR-008 + DR-010 spec verbatim (see state.rs default
//! constants):
//!   - mint_fee_bps = 0           (mechanism present but disabled — demo
//!                                  runs at 0 fees by default per DR-008)
//!   - platform_retain_bps = 5000 (50%)
//!   - weekly_pool_bps = 2500     (25%)
//!   - monthly_pool_bps = 2500    (25%)
//!   - creator_rebate_bps = 10000 (100% rebate — creator pays 0% on all
//!                                  mints into their strike until settle)
//!   - force_redeem_grace_secs = 2_592_000 (30 days)
//!   - distribution arrays = [25, 18, 12, 10, 8, 7, 6, 5, 5, 4] %
//!
//! Why a standalone Rust binary instead of TypeScript: same DR-004 cascade
//! that drove `bootstrap-config` — JS workspace's rpc-websockets ↔ uuid CJS-ESM
//! issue blocks `@coral-xyz/anchor` imports until pnpm overrides land.
//!
//! Run from WSL Ubuntu (PATH must include solana-cli):
//!   cd migrations/bootstrap-p5
//!   cargo run --release

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

const PROGRAM_ID: &str = "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV";
const USDC_DEVNET_MINT: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const ADMIN_KEYPAIR_PATH: &str = "../../keys/devnet-platform-admin.json";
const RPC_URL: &str = "https://api.devnet.solana.com";

// Discriminators from programs/bell-markets/idl/bell_markets.json (P5 deploy).
const INIT_FEE_CONFIG_DISCRIMINATOR: [u8; 8] = [62, 162, 20, 133, 121, 65, 145, 27];
const INIT_REWARDS_POOLS_DISCRIMINATOR: [u8; 8] = [237, 181, 71, 163, 194, 7, 62, 174];

// DR-008 + DR-010 default values.
const DEFAULT_MINT_FEE_BPS: u16 = 0;
const DEFAULT_PLATFORM_RETAIN_BPS: u16 = 5_000;
const DEFAULT_WEEKLY_POOL_BPS: u16 = 2_500;
const DEFAULT_MONTHLY_POOL_BPS: u16 = 2_500;
const DEFAULT_CREATOR_REBATE_BPS: u16 = 10_000;
const DEFAULT_FORCE_REDEEM_GRACE_SECS: i64 = 30 * 24 * 60 * 60;
const DEFAULT_DISTRIBUTION_BPS: [u16; 10] = [2500, 1800, 1200, 1000, 800, 700, 600, 500, 500, 400];

#[derive(BorshSerialize)]
struct InitializeFeeConfigArgs {
    mint_fee_bps: u16,
    platform_retain_bps: u16,
    weekly_pool_bps: u16,
    monthly_pool_bps: u16,
    creator_rebate_bps: u16,
    force_redeem_grace_secs: i64,
    weekly_distribution_bps: [u16; 10],
    monthly_distribution_bps: [u16; 10],
}

fn main() {
    println!("BellMarkets bootstrap-p5 — initialize_fee_config + initialize_rewards_pools");
    println!();

    let program_id = Pubkey::from_str(PROGRAM_ID).expect("valid program ID");
    let usdc_mint = Pubkey::from_str(USDC_DEVNET_MINT).expect("valid USDC mint");

    let admin_path = canonicalize_relative(ADMIN_KEYPAIR_PATH);
    let admin: Keypair = read_keypair_file(&admin_path)
        .unwrap_or_else(|e| panic!("failed to read admin keypair from {admin_path}: {e}"));
    println!("Admin pubkey:     {}", admin.pubkey());
    println!("Program ID:       {program_id}");
    println!("USDC mint:        {usdc_mint}");

    let (config_pda, _) = Pubkey::find_program_address(&[b"config"], &program_id);
    let (fee_config_pda, _) = Pubkey::find_program_address(&[b"fee_config"], &program_id);
    let (weekly_pool_pda, _) = Pubkey::find_program_address(&[b"weekly_pool"], &program_id);
    let (monthly_pool_pda, _) = Pubkey::find_program_address(&[b"monthly_pool"], &program_id);
    let (leaderboard_pda, _) = Pubkey::find_program_address(&[b"leaderboard_commits"], &program_id);
    println!("Config PDA:       {config_pda}");
    println!("FeeConfig PDA:    {fee_config_pda}");
    println!("WeeklyPool PDA:   {weekly_pool_pda}");
    println!("MonthlyPool PDA:  {monthly_pool_pda}");
    println!("Leaderboard PDA:  {leaderboard_pda}");
    println!();

    let rpc = RpcClient::new_with_commitment(RPC_URL.to_string(), CommitmentConfig::confirmed());

    // ── Phase 1: initialize_fee_config ─────────────────────────────────────
    if account_exists(&rpc, &fee_config_pda) {
        println!("Phase 1: FeeConfig PDA already exists — skipping initialize_fee_config.");
    } else {
        println!("Phase 1: initializing FeeConfig...");
        let args = InitializeFeeConfigArgs {
            mint_fee_bps: DEFAULT_MINT_FEE_BPS,
            platform_retain_bps: DEFAULT_PLATFORM_RETAIN_BPS,
            weekly_pool_bps: DEFAULT_WEEKLY_POOL_BPS,
            monthly_pool_bps: DEFAULT_MONTHLY_POOL_BPS,
            creator_rebate_bps: DEFAULT_CREATOR_REBATE_BPS,
            force_redeem_grace_secs: DEFAULT_FORCE_REDEEM_GRACE_SECS,
            weekly_distribution_bps: DEFAULT_DISTRIBUTION_BPS,
            monthly_distribution_bps: DEFAULT_DISTRIBUTION_BPS,
        };
        let mut data = Vec::with_capacity(8 + 2 * 5 + 8 + 2 * 10 + 2 * 10);
        data.extend_from_slice(&INIT_FEE_CONFIG_DISCRIMINATOR);
        args.serialize(&mut data).expect("borsh serialize");

        // Account order MUST match programs/bell-markets/src/instructions/initialize_fee_config.rs
        let accounts = vec![
            AccountMeta::new(admin.pubkey(), true),
            AccountMeta::new_readonly(config_pda, false),
            AccountMeta::new(fee_config_pda, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ];

        let ix = Instruction { program_id, accounts, data };
        let blockhash = rpc.get_latest_blockhash().expect("blockhash");
        let tx = Transaction::new_signed_with_payer(
            &[ix], Some(&admin.pubkey()), &[&admin], blockhash,
        );
        let sig = rpc.send_and_confirm_transaction(&tx)
            .unwrap_or_else(|e| { eprintln!("initialize_fee_config failed: {e:?}"); std::process::exit(3); });
        println!("  ✓ initialize_fee_config tx: {sig}");
    }

    // ── Phase 2: initialize_rewards_pools ──────────────────────────────────
    if account_exists(&rpc, &weekly_pool_pda) && account_exists(&rpc, &monthly_pool_pda) && account_exists(&rpc, &leaderboard_pda) {
        println!("Phase 2: rewards pools + leaderboard PDAs already exist — skipping initialize_rewards_pools.");
    } else {
        println!("Phase 2: initializing rewards pools + leaderboard...");
        let mut data = Vec::with_capacity(8);
        data.extend_from_slice(&INIT_REWARDS_POOLS_DISCRIMINATOR);
        // No args.

        // Account order MUST match programs/bell-markets/src/instructions/initialize_rewards_pools.rs
        let accounts = vec![
            AccountMeta::new(admin.pubkey(), true),
            AccountMeta::new_readonly(config_pda, false),
            AccountMeta::new_readonly(fee_config_pda, false),
            AccountMeta::new(weekly_pool_pda, false),
            AccountMeta::new(monthly_pool_pda, false),
            AccountMeta::new(leaderboard_pda, false),
            AccountMeta::new_readonly(usdc_mint, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(spl_token_id(), false),
            AccountMeta::new_readonly(sysvar::rent::ID, false),
        ];

        let ix = Instruction { program_id, accounts, data };
        let blockhash = rpc.get_latest_blockhash().expect("blockhash");
        let tx = Transaction::new_signed_with_payer(
            &[ix], Some(&admin.pubkey()), &[&admin], blockhash,
        );
        let sig = rpc.send_and_confirm_transaction(&tx)
            .unwrap_or_else(|e| { eprintln!("initialize_rewards_pools failed: {e:?}"); std::process::exit(4); });
        println!("  ✓ initialize_rewards_pools tx: {sig}");
    }

    println!();
    println!("✓ P5 bootstrap complete.");
    println!("  FeeConfig:   {fee_config_pda}");
    println!("  WeeklyPool:  {weekly_pool_pda}");
    println!("  MonthlyPool: {monthly_pool_pda}");
    println!("  Leaderboard: {leaderboard_pda}");
}

fn account_exists(rpc: &RpcClient, pubkey: &Pubkey) -> bool {
    match rpc.get_account(pubkey) {
        Ok(_) => true,
        Err(e) if format!("{e:?}").contains("AccountNotFound") => false,
        Err(e) => {
            eprintln!("WARN: unexpected RPC error checking {pubkey}: {e:?}");
            false
        }
    }
}

fn spl_token_id() -> Pubkey {
    Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap()
}

fn canonicalize_relative(rel: &str) -> String {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let joined = std::path::Path::new(manifest_dir).join(rel);
    fs::canonicalize(&joined)
        .unwrap_or_else(|e| panic!("failed to resolve {}: {e}", joined.display()))
        .to_string_lossy()
        .into_owned()
}
