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

/// Compute the standard DR-010 leaf hash from (recipient, position,
/// period_id, period_type, amount). All scalar fields encoded little-endian.
///
/// Recipient is the user's wallet pubkey (NOT their USDC ATA — the off-chain
/// indexer ranks by wallet identity, and the on-chain transfer recipient
/// account is constrained to be owned by this wallet).
pub fn compute_leaf(
    recipient: &Pubkey,
    position: u8,
    period_id: u64,
    period_type: u8,
    amount: u64,
) -> [u8; 32] {
    let mut buf = [0u8; 32 + 1 + 8 + 1 + 8];
    buf[0..32].copy_from_slice(recipient.as_ref());
    buf[32] = position;
    buf[33..41].copy_from_slice(&period_id.to_le_bytes());
    buf[41] = period_type;
    buf[42..50].copy_from_slice(&amount.to_le_bytes());
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
        let recipient = Pubkey::new_from_array([1u8; 32]);
        let h1 = compute_leaf(&recipient, 1, 100, PERIOD_TYPE_WEEKLY, 1000);
        let h2 = compute_leaf(&recipient, 1, 100, PERIOD_TYPE_WEEKLY, 1000);
        assert_eq!(h1, h2);
    }

    #[test]
    fn leaf_hash_changes_with_each_field() {
        let r1 = Pubkey::new_from_array([1u8; 32]);
        let r2 = Pubkey::new_from_array([2u8; 32]);
        let base = compute_leaf(&r1, 1, 100, PERIOD_TYPE_WEEKLY, 1000);
        // Different recipient
        assert_ne!(compute_leaf(&r2, 1, 100, PERIOD_TYPE_WEEKLY, 1000), base);
        // Different position
        assert_ne!(compute_leaf(&r1, 2, 100, PERIOD_TYPE_WEEKLY, 1000), base);
        // Different period_id
        assert_ne!(compute_leaf(&r1, 1, 101, PERIOD_TYPE_WEEKLY, 1000), base);
        // Different period_type
        assert_ne!(compute_leaf(&r1, 1, 100, PERIOD_TYPE_MONTHLY, 1000), base);
        // Different amount
        assert_ne!(compute_leaf(&r1, 1, 100, PERIOD_TYPE_WEEKLY, 1001), base);
    }

    use crate::state::{PERIOD_TYPE_WEEKLY, PERIOD_TYPE_MONTHLY};
}
