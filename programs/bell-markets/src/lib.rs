//! BellMarkets — binary outcome contracts on daily MAG7 stock prices.
//!
//! Read order for new contributors:
//!   1. `.project/bell-markets/kickoff/aria.md`  (workstream rules)
//!   2. `programs/bell-markets/src/state.rs`     (data model)
//!   3. `programs/bell-markets/src/oracle.rs`    (Pyth parser — vendored, no SDK)
//!   4. `programs/bell-markets/src/adapters/phoenix.rs` (Phoenix magic-prefix check)
//!   5. `programs/bell-markets/src/instructions/*` (per-instruction Accounts shape)
//!
//! Hard-rule reminders (kickoff §"Hard rules"):
//!   §4.10  Every heavy account in an Accounts struct is `Box<Account<'info,T>>`.
//!   §4.11  Stack-offset warnings are build failures.
//!   §4.12  Phoenix accounts are `UncheckedAccount` + 8-byte magic validation.
//!   §4.13  Pyth: vendored parser only. No `pyth-sdk-solana` dep.
//!   §4.2   `settle_market` requires no signer beyond the fee payer.

use anchor_lang::prelude::*;

pub mod state;
pub mod errors;
pub mod oracle;
pub mod adapters;
pub mod instructions;
pub mod merkle;
pub mod matching;

use instructions::*;
use state::{Outcome, MAX_ALLOWED_STRIKES, ARWEAVE_TX_ID_LEN};

// Program ID derived from keys/devnet-program-keypair.json (gitignored; also
// mirrored at target/deploy/bell_markets-keypair.json where Anchor reads it
// at build/deploy time). Generated 2026-05-21 Day-2 by Aria via
// solana-keygen --silent. Mainnet ID is intentionally never declared
// (Hard NO #1).
declare_id!("599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV");

#[program]
pub mod bell_markets {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        price_staleness_secs: i64,
        price_confidence_bps: u16,
        admin_override_delay_secs: i64,
    ) -> Result<()> {
        instructions::initialize_config::handler(
            ctx,
            price_staleness_secs,
            price_confidence_bps,
            admin_override_delay_secs,
        )
    }

    pub fn create_strike_market(
        ctx: Context<CreateStrikeMarket>,
        strike_price: i64,
        expiry_unix: i64,
    ) -> Result<()> {
        instructions::create_strike_market::handler(ctx, strike_price, expiry_unix)
    }

    pub fn add_strike(ctx: Context<AddStrike>) -> Result<()> {
        instructions::add_strike::handler(ctx)
    }

    pub fn mint_pair(ctx: Context<MintPair>, amount: u64) -> Result<()> {
        instructions::mint_pair::handler(ctx, amount)
    }

    pub fn settle_market(ctx: Context<SettleMarket>) -> Result<()> {
        instructions::settle_market::handler(ctx)
    }

    pub fn admin_settle(ctx: Context<AdminSettle>, forced_outcome: Outcome) -> Result<()> {
        instructions::admin_settle::handler(ctx, forced_outcome)
    }

    pub fn redeem(ctx: Context<Redeem>, amount: u64) -> Result<()> {
        instructions::redeem::handler(ctx, amount)
    }

    pub fn redeem_invalid(ctx: Context<RedeemInvalid>, amount: u64) -> Result<()> {
        instructions::redeem_invalid::handler(ctx, amount)
    }

    pub fn redeem_pair(ctx: Context<RedeemPair>, amount: u64) -> Result<()> {
        instructions::redeem_pair::handler(ctx, amount)
    }

    pub fn pause(ctx: Context<Pause>, paused: bool) -> Result<()> {
        instructions::pause::handler(ctx, paused)
    }

    pub fn update_ticker_config(
        ctx: Context<UpdateTickerConfig>,
        cap_center: i64,
        allowed_strikes: [i64; MAX_ALLOWED_STRIKES],
        strike_count: u8,
        max_user_strike_deviation_bps: u16,
        strike_tick_size: i64,
        threshold_bps: u16,
    ) -> Result<()> {
        instructions::update_ticker_config::handler(
            ctx,
            cap_center,
            allowed_strikes,
            strike_count,
            max_user_strike_deviation_bps,
            strike_tick_size,
            threshold_bps,
        )
    }

    pub fn user_create_strike_market(
        ctx: Context<UserCreateStrikeMarket>,
        strike_price: i64,
        expiry_unix: i64,
    ) -> Result<()> {
        instructions::user_create_strike_market::handler(ctx, strike_price, expiry_unix)
    }

    pub fn initialize_fee_config(
        ctx: Context<InitializeFeeConfig>,
        mint_fee_bps: u16,
        platform_retain_bps: u16,
        weekly_pool_bps: u16,
        monthly_pool_bps: u16,
        creator_rebate_bps: u16,
        force_redeem_grace_secs: i64,
        weekly_distribution_bps: [u16; 10],
        monthly_distribution_bps: [u16; 10],
    ) -> Result<()> {
        instructions::initialize_fee_config::handler(
            ctx,
            mint_fee_bps,
            platform_retain_bps,
            weekly_pool_bps,
            monthly_pool_bps,
            creator_rebate_bps,
            force_redeem_grace_secs,
            weekly_distribution_bps,
            monthly_distribution_bps,
        )
    }

    pub fn update_fee_config(
        ctx: Context<UpdateFeeConfig>,
        mint_fee_bps: u16,
        platform_retain_bps: u16,
        weekly_pool_bps: u16,
        monthly_pool_bps: u16,
        creator_rebate_bps: u16,
        force_redeem_grace_secs: i64,
        weekly_distribution_bps: [u16; 10],
        monthly_distribution_bps: [u16; 10],
    ) -> Result<()> {
        instructions::update_fee_config::handler(
            ctx,
            mint_fee_bps,
            platform_retain_bps,
            weekly_pool_bps,
            monthly_pool_bps,
            creator_rebate_bps,
            force_redeem_grace_secs,
            weekly_distribution_bps,
            monthly_distribution_bps,
        )
    }

    pub fn initialize_rewards_pools(ctx: Context<InitializeRewardsPools>) -> Result<()> {
        instructions::initialize_rewards_pools::handler(ctx)
    }

    pub fn commit_leaderboard_root(
        ctx: Context<CommitLeaderboardRoot>,
        period_id: u64,
        period_type: u8,
        merkle_root: [u8; 32],
        arweave_tx_id: [u8; ARWEAVE_TX_ID_LEN],
    ) -> Result<()> {
        instructions::commit_leaderboard_root::handler(
            ctx,
            period_id,
            period_type,
            merkle_root,
            arweave_tx_id,
        )
    }

    pub fn distribute_weekly_rewards(
        ctx: Context<DistributeWeeklyRewards>,
        period_id: u64,
        metric_id: u8,
        position: u8,
        amount: u64,
        merkle_proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        instructions::distribute_weekly_rewards::handler(
            ctx,
            period_id,
            metric_id,
            position,
            amount,
            merkle_proof,
        )
    }

    pub fn distribute_monthly_rewards(
        ctx: Context<DistributeMonthlyRewards>,
        period_id: u64,
        metric_id: u8,
        position: u8,
        amount: u64,
        merkle_proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        instructions::distribute_monthly_rewards::handler(
            ctx,
            period_id,
            metric_id,
            position,
            amount,
            merkle_proof,
        )
    }

    pub fn force_redeem(ctx: Context<ForceRedeem>, amount: u64) -> Result<()> {
        instructions::force_redeem::handler(ctx, amount)
    }

    pub fn close_settled_market(ctx: Context<CloseSettledMarket>) -> Result<()> {
        instructions::close_settled_market::handler(ctx)
    }

    // ─── DR-020 — In-program CLOB instructions ──────────────────────────

    pub fn init_order_book(ctx: Context<InitOrderBook>) -> Result<()> {
        instructions::init_order_book::handler(ctx)
    }

    pub fn grow_order_book(ctx: Context<GrowOrderBook>) -> Result<()> {
        instructions::grow_order_book::handler(ctx)
    }

    pub fn place_order<'info>(
        ctx: Context<'_, '_, '_, 'info, PlaceOrder<'info>>,
        side: u8,
        price: u64,
        size: u64,
        is_market: bool,
    ) -> Result<()> {
        instructions::place_order::handler(ctx, side, price, size, is_market)
    }

    pub fn cancel_order(ctx: Context<CancelOrder>, side: u8, seq: u64) -> Result<()> {
        instructions::cancel_order::handler(ctx, side, seq)
    }

    pub fn match_orders<'info>(
        ctx: Context<'_, '_, '_, 'info, MatchOrders<'info>>,
    ) -> Result<()> {
        instructions::match_orders::handler(ctx)
    }

    pub fn update_usdc_mint(ctx: Context<UpdateUsdcMint>, new_mint: Pubkey) -> Result<()> {
        instructions::update_usdc_mint::handler(ctx, new_mint)
    }

    pub fn reinit_rewards_pools(ctx: Context<ReinitRewardsPools>) -> Result<()> {
        instructions::reinit_rewards_pools::handler(ctx)
    }

    pub fn update_admin_override_delay_secs(
        ctx: Context<UpdateAdminOverrideDelaySecs>,
        new_secs: i64,
    ) -> Result<()> {
        instructions::update_admin_override_delay_secs::handler(ctx, new_secs)
    }
}
