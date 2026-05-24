//! SHA256 binary-tree merkle proof verifier (DR-010).
//!
//! Standard "sorted-pair" pattern (matches OpenZeppelin's
//! `MerkleProof.verify`): at each level, the two siblings are concatenated
//! in lexicographic order — smaller first, then the hash of the 64-byte
//! result becomes the next level's node. This avoids needing a "left/right"
//! flag per proof step (saves 1 bit × depth bytes off the wire).
//!
//! Off-chain (Bram's indexer) MUST use the identical pattern when building
//! the tree:
//!   - leaves = sha256(recipient || position || period_id || period_type || amount)
//!   - internal nodes = sha256(min(a,b) || max(a,b))
//!   - empty siblings (odd-leaf-count leveling): duplicate the orphan leaf
//!
//! Bounded depth: proof length ≤ MERKLE_PROOF_MAX_DEPTH (16). Caps CU usage.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash as sha256;
use crate::state::MERKLE_PROOF_MAX_DEPTH;
use crate::errors::BellMarketsError;

/// Compute the DR-015 multi-metric leaf hash from (user, metric_id, rank,
/// amount, period_id, period_type). All scalar fields encoded little-endian
/// per the format locked in `constitution/decisions.md` DR-015 §"Decision":
///
/// ```text
/// leaf = sha256(user || metric_id || rank || amount || period_id_u32 || period_type)
///                32  ||    1     ||  1   ||    8   ||      4        ||      1
/// ```
///
/// Notes for off-chain (Bram's indexer) compatibility:
/// - `user` is the user's wallet pubkey (NOT a token-account ATA — the
///   on-chain transfer recipient account is constrained to be owned by this
///   wallet).
/// - `rank` is the position 1..=POSITIONS_PER_METRIC. Equivalent to what
///   earlier P3 docs called "position"; DR-015 standardizes on "rank".
/// - `period_id` is narrowed from the on-chain `LeaderboardEntry.period_id:
///   u64` to a u32 in the hash. u32 supports 4e9 distinct periods (~82M
///   years at weekly cadence) — trivially safe, and the narrowing is a
///   deliberate DR-015 spec choice.
/// - `period_type` ∈ {PERIOD_TYPE_WEEKLY, PERIOD_TYPE_MONTHLY}.
/// - `metric_id` ∈ {METRIC_PROFIT, METRIC_WIN_STREAK, METRIC_WIN_RATE,
///   METRIC_ROI}. New metrics added in v2+ require off-chain leaf-builder
///   updates only IF the on-chain bitmap can still accommodate them.
pub fn compute_leaf(
    user: &Pubkey,
    metric_id: u8,
    rank: u8,
    amount: u64,
    period_id: u64,
    period_type: u8,
) -> [u8; 32] {
    let mut buf = [0u8; 32 + 1 + 1 + 8 + 4 + 1]; // = 47 bytes (DR-015 spec)
    buf[0..32].copy_from_slice(user.as_ref());
    buf[32] = metric_id;
    buf[33] = rank;
    buf[34..42].copy_from_slice(&amount.to_le_bytes());
    buf[42..46].copy_from_slice(&(period_id as u32).to_le_bytes());
    buf[46] = period_type;
    sha256(&buf).to_bytes()
}

/// Verify a merkle proof against the expected root.
///
/// Sorted-pair pattern: at each level, the pair (current_hash, sibling) is
/// concatenated with the lexicographically-smaller element first. This
/// matches OpenZeppelin's `MerkleProof.verify` exactly.
///
/// Returns `Err(MerkleProofInvalid)` if proof depth exceeds the bound. Returns
/// `Ok(true)` if the computed root matches `expected_root`, `Ok(false)`
/// otherwise. Callers `require!` on the boolean.
pub fn verify_merkle_proof(
    leaf: [u8; 32],
    proof: &[[u8; 32]],
    expected_root: [u8; 32],
) -> Result<bool> {
    require!(
        proof.len() <= MERKLE_PROOF_MAX_DEPTH,
        BellMarketsError::MerkleProofInvalid
    );

    let mut computed = leaf;
    let mut concat = [0u8; 64];

    for sibling in proof.iter() {
        if computed <= *sibling {
            concat[0..32].copy_from_slice(&computed);
            concat[32..64].copy_from_slice(sibling);
        } else {
            concat[0..32].copy_from_slice(sibling);
            concat[32..64].copy_from_slice(&computed);
        }
        computed = sha256(&concat).to_bytes();
    }

    Ok(computed == expected_root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(s: &str) -> [u8; 32] {
        sha256(s.as_bytes()).to_bytes()
    }

    fn pair(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
        let mut buf = [0u8; 64];
        if a <= b {
            buf[..32].copy_from_slice(&a);
            buf[32..].copy_from_slice(&b);
        } else {
            buf[..32].copy_from_slice(&b);
            buf[32..].copy_from_slice(&a);
        }
        sha256(&buf).to_bytes()
    }

    #[test]
    fn single_leaf_no_proof() {
        // A tree with a single leaf — root IS the leaf, proof is empty.
        let leaf = h("alice");
        assert!(verify_merkle_proof(leaf, &[], leaf).unwrap());
    }

    #[test]
    fn two_leaves_one_step_proof() {
        let a = h("alice");
        let b = h("bob");
        let root = pair(a, b);
        // proof of a is [b]
        assert!(verify_merkle_proof(a, &[b], root).unwrap());
        // proof of b is [a]
        assert!(verify_merkle_proof(b, &[a], root).unwrap());
    }

    #[test]
    fn four_leaves_two_step_proof() {
        let a = h("alice");
        let b = h("bob");
        let c = h("carol");
        let d = h("dave");
        let ab = pair(a, b);
        let cd = pair(c, d);
        let root = pair(ab, cd);

        // proof of a is [b, cd]
        assert!(verify_merkle_proof(a, &[b, cd], root).unwrap());
        // proof of c is [d, ab]
        assert!(verify_merkle_proof(c, &[d, ab], root).unwrap());
    }

    #[test]
    fn wrong_proof_rejects() {
        let a = h("alice");
        let b = h("bob");
        let c = h("carol");
        let root = pair(a, b);
        // c's "proof" using b as sibling — produces pair(c,b), which != pair(a,b).
        assert!(!verify_merkle_proof(c, &[b], root).unwrap());
    }

    #[test]
    fn tampered_root_rejects() {
        let a = h("alice");
        let b = h("bob");
        let real_root = pair(a, b);
        let tampered = h("tampered");
        assert!(!verify_merkle_proof(a, &[b], tampered).unwrap());
        // Confirm the real root would have passed.
        assert!(verify_merkle_proof(a, &[b], real_root).unwrap());
    }

    #[test]
    fn proof_too_long_errors() {
        let leaf = h("alice");
        let sibling = h("noise");
        let proof: Vec<[u8; 32]> = (0..MERKLE_PROOF_MAX_DEPTH + 1).map(|_| sibling).collect();
        // any expected root — the bound check fires before any hashing
        assert!(verify_merkle_proof(leaf, &proof, [0u8; 32]).is_err());
    }

    #[test]
    fn leaf_hash_deterministic() {
        // Property: compute_leaf is a pure function — same inputs produce same hash.
        let user = Pubkey::new_from_array([1u8; 32]);
        let h1 = compute_leaf(&user, METRIC_PROFIT, 1, 1000, 100, PERIOD_TYPE_WEEKLY);
        let h2 = compute_leaf(&user, METRIC_PROFIT, 1, 1000, 100, PERIOD_TYPE_WEEKLY);
        assert_eq!(h1, h2);
    }

    #[test]
    fn leaf_hash_changes_with_each_field() {
        let u1 = Pubkey::new_from_array([1u8; 32]);
        let u2 = Pubkey::new_from_array([2u8; 32]);
        let base = compute_leaf(&u1, METRIC_PROFIT, 1, 1000, 100, PERIOD_TYPE_WEEKLY);
        // Different user
        assert_ne!(compute_leaf(&u2, METRIC_PROFIT, 1, 1000, 100, PERIOD_TYPE_WEEKLY), base);
        // Different metric_id
        assert_ne!(compute_leaf(&u1, METRIC_WIN_STREAK, 1, 1000, 100, PERIOD_TYPE_WEEKLY), base);
        assert_ne!(compute_leaf(&u1, METRIC_WIN_RATE, 1, 1000, 100, PERIOD_TYPE_WEEKLY), base);
        assert_ne!(compute_leaf(&u1, METRIC_ROI, 1, 1000, 100, PERIOD_TYPE_WEEKLY), base);
        // Different rank
        assert_ne!(compute_leaf(&u1, METRIC_PROFIT, 2, 1000, 100, PERIOD_TYPE_WEEKLY), base);
        // Different amount
        assert_ne!(compute_leaf(&u1, METRIC_PROFIT, 1, 1001, 100, PERIOD_TYPE_WEEKLY), base);
        // Different period_id
        assert_ne!(compute_leaf(&u1, METRIC_PROFIT, 1, 1000, 101, PERIOD_TYPE_WEEKLY), base);
        // Different period_type
        assert_ne!(compute_leaf(&u1, METRIC_PROFIT, 1, 1000, 100, PERIOD_TYPE_MONTHLY), base);
    }

    #[test]
    fn leaf_hash_period_id_narrowed_to_u32() {
        // Property (DR-015 narrowing): period_id u64 values that share the
        // same low-32-bit pattern produce IDENTICAL leaf hashes. Confirms the
        // documented narrowing is in effect.
        let user = Pubkey::new_from_array([1u8; 32]);
        let h_low = compute_leaf(&user, METRIC_PROFIT, 1, 1000, 0x0000_0000_DEAD_BEEFu64, PERIOD_TYPE_WEEKLY);
        let h_high = compute_leaf(&user, METRIC_PROFIT, 1, 1000, 0xCAFE_BABE_DEAD_BEEFu64, PERIOD_TYPE_WEEKLY);
        // Low 32 bits are 0xDEADBEEF in both — hashes must match.
        assert_eq!(h_low, h_high, "u64 period_ids sharing low-32-bits should produce identical leaf hashes per DR-015 narrowing");
    }

    use crate::state::{
        PERIOD_TYPE_WEEKLY, PERIOD_TYPE_MONTHLY,
        METRIC_PROFIT, METRIC_WIN_STREAK, METRIC_WIN_RATE, METRIC_ROI,
    };
}
