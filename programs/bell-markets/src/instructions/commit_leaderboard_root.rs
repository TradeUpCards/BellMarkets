//! `commit_leaderboard_root` — admin writes a (period_id, period_type) → root
//! commitment into the ring buffer at `LeaderboardCommitments.next_slot`.
//!
//! Per DR-010 § "Locked for MVP: Option B (Merkle commitment) + Arweave":
//! anyone can re-fetch the full leaderboard from Arweave + reconstruct the
//! Merkle root + verify on-chain forever. The on-chain commitment is the
//! single source of truth; Arweave is the public archive.
//!
//! Ring buffer semantics: when `next_slot == CAPACITY - 1` after writing, the
//! next commit wraps to slot 0, overwriting the oldest entry. This bounds
//! storage at exactly 2400 bytes regardless of period count. Older periods
//! remain queryable via Arweave (off-chain); on-chain proofs for older
//! periods stop working after the rotation.
//!
//! No duplicate (period_id, period_type) check: if Bram commits the same
//! period twice in a row, the second overwrites the first. Defensive: a
//! `LeaderboardRootNotFound` error in distribute will catch a stale lookup,
//! but a stale-root commit is the admin's responsibility.

use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::BellMarketsError;

#[derive(Accounts)]
pub struct CommitLeaderboardRoot<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        constraint = config.admin == admin.key() @ BellMarketsError::NotAdmin,
        constraint = !config.paused @ BellMarketsError::Paused,
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    #[account(
        mut,
        seeds = [b"leaderboard_commits"],
        bump,
        constraint = leaderboard_commits.load()?.config == config.key()
            @ BellMarketsError::ConfigMismatch,
    )]
    pub leaderboard_commits: AccountLoader<'info, LeaderboardCommitments>,

    pub clock: Sysvar<'info, Clock>,
}

pub fn handler(
    ctx: Context<CommitLeaderboardRoot>,
    period_id: u64,
    period_type: u8,
    merkle_root: [u8; 32],
    arweave_tx_id: [u8; ARWEAVE_TX_ID_LEN],
) -> Result<()> {
    require!(
        period_type == PERIOD_TYPE_WEEKLY || period_type == PERIOD_TYPE_MONTHLY,
        BellMarketsError::InvalidFeeParam
    );

    let now = ctx.accounts.clock.unix_timestamp;
    let mut lb = ctx.accounts.leaderboard_commits.load_mut()?;
    let slot_idx = lb.next_slot as usize % LEADERBOARD_COMMITMENT_CAPACITY;
    let entry = &mut lb.entries[slot_idx];

    entry.period_id = period_id;
    entry.period_type = period_type;
    entry.merkle_root = merkle_root;
    entry.arweave_tx_id = arweave_tx_id;
    entry.committed_at_unix = now;
    entry.claimed_bitmap = 0;

    lb.next_slot = ((slot_idx + 1) % LEADERBOARD_COMMITMENT_CAPACITY) as u8;
    Ok(())
}
