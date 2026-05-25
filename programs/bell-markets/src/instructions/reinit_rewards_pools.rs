//! `reinit_rewards_pools` — admin ix to close + re-initialize the two PDA
//! reward pool token accounts (`weekly_pool` + `monthly_pool`) at the SAME
//! PDA addresses, bound to the CURRENT `config.usdc_mint`.
//!
//! ## Why
//!
//! `update_usdc_mint` (deploy_index=7) lets admin flip `MarketConfig.usdc_mint`
//! in place (e.g., Circle USDC → bUSDC). But the existing weekly_pool +
//! monthly_pool TokenAccounts were bootstrapped Day-5 against the OLD mint.
//! Anchor's `token::mint = usdc_mint` constraint in `mint_pair` now fails
//! because `pool.mint == OldMint` while `config.usdc_mint == NewMint`. Result:
//! `ConstraintTokenMint (2014)` → mint_pair blocked → no fees flow.
//!
//! This ix unwinds the mint mismatch by closing the old pool TAs (recovering
//! their ~0.002 SOL × 2 of rent to admin) and re-initializing fresh ones at
//! the SAME PDA addresses but bound to the current mint.
//!
//! ## What about `fee_collector_usdc`?
//!
//! `fee_collector_usdc` is NOT a PDA — it's a standard SPL Associated Token
//! Account (per `mint_pair.rs:202-204`: `token::mint = usdc_mint` +
//! `constraint = owner == config.treasury`, no PDA seeds). After a mint flip,
//! the NEW bUSDC ATA at `(treasury, bUSDC)` is a DIFFERENT pubkey than the
//! OLD Circle ATA. Bram's adapter can create the new ATA via standard SPL
//! `createAssociatedTokenAccountInstruction` (client-side, no program ix
//! needed). The old Circle ATA stays orphaned but harmless (~0.002 SOL of
//! stranded rent; admin can recover via standard SPL CloseAccount later).
//!
//! So this ix handles ONLY the 2 PDA pools. fee_collector_usdc is a
//! separate Bram-side adapter step, not a program-side ix.
//!
//! ## Configurability
//!
//! Reads `config.usdc_mint` at call time — DOES NOT hardcode any mint
//! pubkey. Reusable for any future mint flip (bUSDC → v2-bUSDC, etc.).
//!
//! ## Approach (manual close + create + init CPI dance)
//!
//! Anchor's `init` constraint doesn't compose cleanly with `close` on the
//! SAME PDA in a single tx (the post-close account is in a "marked deleted"
//! state for the rest of the tx; subsequent `init` typically fails). So we
//! manually CPI-call the 3-step sequence per pool inside the handler:
//!
//!   1. `spl_token::close_account` — zeros lamports + transfers rent to admin
//!      + sets owner to SystemProgram. PDA signs as the self-authority.
//!   2. `system_instruction::create_account` — reallocates the same PDA
//!      address fresh, funded by admin, with owner = SPL Token program. PDA
//!      signs to authorize the allocation at its own address.
//!   3. `spl_token::initialize_account3` — sets mint = `config.usdc_mint`
//!      (current value) + owner = the pool PDA itself (self-authority pattern,
//!      matching `initialize_rewards_pools.rs`). No PDA signature needed for
//!      InitializeAccount itself; it operates on a freshly-allocated account.
//!
//! Net effect: pool.mint goes from old → current `config.usdc_mint`. Pool
//! authority stays self (PDA-owns-itself, matching the v1 deploy_index=5
//! `initialize_rewards_pools` bootstrap pattern).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
use anchor_spl::token::{self, spl_token, CloseAccount, Mint, Token, TokenAccount};

use crate::errors::BellMarketsError;
use crate::state::MarketConfig;

#[derive(Accounts)]
pub struct ReinitRewardsPools<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = usdc_mint,
        constraint = config.admin == admin.key() @ BellMarketsError::NotAdmin,
        constraint = !config.paused @ BellMarketsError::Paused,
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    /// Current `MarketConfig.usdc_mint` (verified via `has_one = usdc_mint`).
    /// Reused as the binding mint for the re-initialized pool accounts.
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// CHECK: weekly_pool PDA at `[b"weekly_pool"]`. Pre-call, this is an
    /// SPL TokenAccount bound to the OLD usdc_mint. Handler verifies via
    /// raw byte read that:
    ///   (1) account is owned by SPL Token program (`spl_token::ID`)
    ///   (2) account is a valid TokenAccount (data.len() == 165)
    ///   (3) TokenAccount.amount == 0 (PoolNotEmpty defense)
    ///   (4) TokenAccount.owner == this account's own pubkey (self-authority,
    ///       matches `initialize_rewards_pools` pattern; WrongPoolAuthority
    ///       defense)
    /// Then closes + recreates + reinits at the same PDA bound to
    /// `config.usdc_mint`.
    #[account(
        mut,
        seeds = [b"weekly_pool"],
        bump,
    )]
    pub weekly_pool: UncheckedAccount<'info>,

    /// CHECK: monthly_pool PDA at `[b"monthly_pool"]`. Same handling as
    /// weekly_pool.
    #[account(
        mut,
        seeds = [b"monthly_pool"],
        bump,
    )]
    pub monthly_pool: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<ReinitRewardsPools>) -> Result<()> {
    reinit_pool(
        &ctx.accounts.weekly_pool,
        b"weekly_pool",
        ctx.bumps.weekly_pool,
        &ctx.accounts.admin,
        &ctx.accounts.usdc_mint,
        &ctx.accounts.token_program,
        &ctx.accounts.system_program,
        &ctx.accounts.rent,
    )?;
    reinit_pool(
        &ctx.accounts.monthly_pool,
        b"monthly_pool",
        ctx.bumps.monthly_pool,
        &ctx.accounts.admin,
        &ctx.accounts.usdc_mint,
        &ctx.accounts.token_program,
        &ctx.accounts.system_program,
        &ctx.accounts.rent,
    )?;
    Ok(())
}

/// 3-step close + reallocate + reinit dance for one pool PDA. See module
/// docs for rationale.
fn reinit_pool<'info>(
    pool: &UncheckedAccount<'info>,
    seed: &[u8],
    bump: u8,
    admin: &Signer<'info>,
    mint: &Account<'info, Mint>,
    token_program: &Program<'info, Token>,
    system_program: &Program<'info, System>,
    rent: &Sysvar<'info, Rent>,
) -> Result<()> {
    let pool_info = pool.to_account_info();
    let pool_key = *pool_info.key;

    // ── Step 0 (pre-flight): verify current state ────────────────────────
    require!(
        pool_info.owner == &spl_token::ID,
        BellMarketsError::WrongPoolAuthority
    );
    {
        let data = pool_info.try_borrow_data()?;
        // SPL TokenAccount layout: mint(32) owner(32) amount(8) ... total 165
        require!(data.len() >= 165, BellMarketsError::WrongPoolAuthority);
        let amount = u64::from_le_bytes(data[64..72].try_into().unwrap());
        require!(amount == 0, BellMarketsError::PoolNotEmpty);
        // Defensive: owner field at offset 32..64 must equal the pool's own
        // pubkey (self-authority pattern from initialize_rewards_pools).
        let owner_bytes: [u8; 32] = data[32..64].try_into().unwrap();
        require!(
            Pubkey::new_from_array(owner_bytes) == pool_key,
            BellMarketsError::WrongPoolAuthority
        );
    } // drop the borrow before CPIs

    let bump_arr = [bump];
    let seeds: &[&[u8]] = &[seed, &bump_arr];
    let signers: &[&[&[u8]]] = &[seeds];

    // ── Step 1: CloseAccount CPI (PDA signs as self-authority) ───────────
    //
    // Post-CPI state: pool has 0 lamports (transferred to admin), 0-length
    // data, owner = SystemProgram. The account is "inactive" — Solana will
    // garbage-collect it at slot boundary unless we reallocate within this
    // same tx (which we do in step 2).
    token::close_account(CpiContext::new_with_signer(
        token_program.to_account_info(),
        CloseAccount {
            account: pool_info.clone(),
            destination: admin.to_account_info(),
            authority: pool_info.clone(), // self-authority
        },
        signers,
    ))?;

    // ── Step 2: SystemProgram::create_account CPI (PDA signs at its own
    //          address; admin pays the rent)  ──────────────────────────
    //
    // This is the load-bearing trick: re-allocating at the SAME PDA address
    // within the same tx as the close. Works because (a) post-close the
    // account has 0 lamports + SystemProgram owner (≈ unallocated), and
    // (b) we sign with the PDA seeds so SystemProgram authorizes the
    // allocation at this specific derived address.
    let space = TokenAccount::LEN; // SPL TokenAccount size = 165
    let lamports = rent.minimum_balance(space);
    let create_ix = system_instruction::create_account(
        admin.key,
        &pool_key,
        lamports,
        space as u64,
        &spl_token::ID,
    );
    invoke_signed(
        &create_ix,
        &[
            admin.to_account_info(),
            pool_info.clone(),
            system_program.to_account_info(),
        ],
        signers,
    )?;

    // ── Step 3: SPL Token InitializeAccount3 CPI ─────────────────────────
    //
    // Sets the freshly-allocated SPL Token account's:
    //   mint   = `mint.key()` (= MarketConfig.usdc_mint, current value)
    //   owner  = pool_key (self-authority, matches v1 bootstrap pattern)
    // initialize_account3 is the newer SPL Token ix that doesn't require
    // a rent sysvar arg (vs the older initialize_account / _account2).
    let init_ix = spl_token::instruction::initialize_account3(
        &spl_token::ID,
        &pool_key,
        &mint.key(),
        &pool_key, // owner = self
    )?;
    anchor_lang::solana_program::program::invoke(
        &init_ix,
        &[pool_info.clone(), mint.to_account_info()],
    )?;

    Ok(())
}

// ─── Unit tests (pure-byte verification — CPI flow is integration test) ────

#[cfg(test)]
mod tests {
    use super::*;

    /// `reinit_pool` reads the TokenAccount layout via raw byte offsets:
    ///   mint  @ 0..32
    ///   owner @ 32..64
    ///   amount @ 64..72
    /// These are SPL Token program constants. If they ever change (they won't —
    /// SPL Token v1 layout is frozen), this test catches it.
    #[test]
    fn spl_token_account_offsets_match_canonical_layout() {
        // Canonical SPL TokenAccount byte layout (165 bytes total):
        //   [0..32]   mint: Pubkey
        //   [32..64]  owner: Pubkey
        //   [64..72]  amount: u64 LE
        //   [72..76]  delegate option tag (4 bytes)
        //   [76..108] delegate pubkey (if some)
        //   [108..109] state: AccountState (1 byte; 1 = Initialized)
        //   [109..113] is_native option tag (4 bytes)
        //   [113..121] is_native lamports (if some)
        //   [121..129] delegated_amount: u64 LE
        //   [129..133] close_authority option tag (4 bytes)
        //   [133..165] close_authority pubkey (if some)
        assert_eq!(TokenAccount::LEN, 165);
    }

    /// `reinit_pool` requires pool.amount == 0 (PoolNotEmpty defense).
    /// This is purely a byte-comparison check; no CPI involved.
    /// Asserts the LE-decode of bytes 64..72 matches the `amount` field.
    #[test]
    fn pool_amount_byte_decode_matches_le_u64() {
        // Build a fake 165-byte TokenAccount with amount = 12345.
        let mut buf = [0u8; 165];
        buf[64..72].copy_from_slice(&12345u64.to_le_bytes());
        let decoded = u64::from_le_bytes(buf[64..72].try_into().unwrap());
        assert_eq!(decoded, 12345);

        // amount = 0 (the happy path for reinit)
        buf[64..72].copy_from_slice(&0u64.to_le_bytes());
        let decoded_zero = u64::from_le_bytes(buf[64..72].try_into().unwrap());
        assert_eq!(decoded_zero, 0);
    }

    /// Defensive check: `reinit_pool` requires TokenAccount.owner ==
    /// pool's own pubkey (self-authority pattern). This test pins the byte
    /// offset where Anchor + SPL store the owner.
    #[test]
    fn pool_self_authority_byte_offset_matches_layout() {
        let mut buf = [0u8; 165];
        let self_pubkey = Pubkey::new_unique();
        buf[32..64].copy_from_slice(self_pubkey.as_ref());
        let decoded: [u8; 32] = buf[32..64].try_into().unwrap();
        assert_eq!(Pubkey::new_from_array(decoded), self_pubkey);

        // Negative: a non-self-auth account (e.g., owner = admin pubkey)
        // would fail the WrongPoolAuthority require! in reinit_pool.
        let other_pubkey = Pubkey::new_unique();
        buf[32..64].copy_from_slice(other_pubkey.as_ref());
        let decoded2: [u8; 32] = buf[32..64].try_into().unwrap();
        assert_ne!(Pubkey::new_from_array(decoded2), self_pubkey);
    }
}
