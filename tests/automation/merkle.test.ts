import { describe, it, expect } from "vitest";
import {
  hashLeaf,
  buildLeaderboardMerkleTree,
} from "../../services/automation/src/indexer/merkle.js";
import type { LeaderboardEntry } from "../../services/automation/src/db/types.js";

function entry(userPubkey: string, currentStreak: number): LeaderboardEntry {
  return {
    userPubkey,
    currentStreak,
    longestStreak: currentStreak,
    totalMarketsTraded: 10,
    totalMarketsWon: currentStreak,
  };
}

describe("hashLeaf", () => {
  it("returns a 32-byte buffer", () => {
    const leaf = hashLeaf("user-A", 1, 202621);
    expect(leaf).toBeInstanceOf(Buffer);
    expect(leaf.length).toBe(32);
  });

  it("is deterministic — same inputs produce same hash", () => {
    const a = hashLeaf("user-A", 1, 202621);
    const b = hashLeaf("user-A", 1, 202621);
    expect(a.equals(b)).toBe(true);
  });

  it("changes with position", () => {
    const a = hashLeaf("user-A", 1, 202621);
    const b = hashLeaf("user-A", 2, 202621);
    expect(a.equals(b)).toBe(false);
  });

  it("changes with period", () => {
    const a = hashLeaf("user-A", 1, 202621);
    const b = hashLeaf("user-A", 1, 202622);
    expect(a.equals(b)).toBe(false);
  });

  it("changes with user", () => {
    const a = hashLeaf("user-A", 1, 202621);
    const b = hashLeaf("user-B", 1, 202621);
    expect(a.equals(b)).toBe(false);
  });

  it("rejects invalid position", () => {
    expect(() => hashLeaf("u", 0, 1)).toThrow();
    expect(() => hashLeaf("u", 11, 1)).toThrow();
    expect(() => hashLeaf("u", -1, 1)).toThrow();
  });

  it("rejects negative period", () => {
    expect(() => hashLeaf("u", 1, -1)).toThrow();
  });

  it("rejects empty user", () => {
    expect(() => hashLeaf("", 1, 1)).toThrow();
  });
});

describe("buildLeaderboardMerkleTree", () => {
  it("returns a root hex of 64 chars for a non-empty tree", () => {
    const tree = buildLeaderboardMerkleTree([entry("user-A", 5), entry("user-B", 3)], 202621);
    expect(tree.root).toMatch(/^[0-9a-f]{64}$/);
  });

  it("populates one leaf per entry, position-stamped 1..N", () => {
    const entries = [entry("a", 5), entry("b", 4), entry("c", 3)];
    const tree = buildLeaderboardMerkleTree(entries, 202621);
    expect(tree.leaves).toHaveLength(3);
    expect(tree.leaves.map((l) => l.position)).toEqual([1, 2, 3]);
    expect(tree.leaves.map((l) => l.userPubkey)).toEqual(["a", "b", "c"]);
    for (const leaf of tree.leaves) {
      expect(leaf.leafHex).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("is deterministic — same entries + period → same root", () => {
    const entries = [entry("a", 5), entry("b", 4)];
    const t1 = buildLeaderboardMerkleTree(entries, 202621);
    const t2 = buildLeaderboardMerkleTree(entries, 202621);
    expect(t1.root).toBe(t2.root);
  });

  it("root changes when entry order changes (position matters)", () => {
    const t1 = buildLeaderboardMerkleTree([entry("a", 5), entry("b", 5)], 202621);
    const t2 = buildLeaderboardMerkleTree([entry("b", 5), entry("a", 5)], 202621);
    expect(t1.root).not.toBe(t2.root);
  });

  it("root changes when period changes", () => {
    const entries = [entry("a", 5)];
    const t1 = buildLeaderboardMerkleTree(entries, 202621);
    const t2 = buildLeaderboardMerkleTree(entries, 202622);
    expect(t1.root).not.toBe(t2.root);
  });

  it("rejects empty entries", () => {
    expect(() => buildLeaderboardMerkleTree([], 1)).toThrow(/at least one/);
  });

  it("rejects >10 entries", () => {
    const entries = Array.from({ length: 11 }, (_, i) => entry(`u${i}`, 5));
    expect(() => buildLeaderboardMerkleTree(entries, 1)).toThrow(/top-10 max/);
  });

  it("proofFor returns a proof array (length depends on tree size)", () => {
    const tree = buildLeaderboardMerkleTree([entry("a", 5), entry("b", 4), entry("c", 3)], 202621);
    const proof1 = tree.proofFor(1);
    const proof2 = tree.proofFor(2);
    const proof3 = tree.proofFor(3);
    expect(Array.isArray(proof1)).toBe(true);
    expect(Array.isArray(proof2)).toBe(true);
    expect(Array.isArray(proof3)).toBe(true);
    // Each proof entry is hex
    for (const p of [...proof1, ...proof2, ...proof3]) {
      expect(p).toMatch(/^[0-9a-f]+$/);
    }
  });

  it("proofFor rejects out-of-range position", () => {
    const tree = buildLeaderboardMerkleTree([entry("a", 5), entry("b", 4)], 202621);
    expect(() => tree.proofFor(0)).toThrow();
    expect(() => tree.proofFor(3)).toThrow();
  });

  it("single-entry tree: root == leaf hash", () => {
    const tree = buildLeaderboardMerkleTree([entry("a", 5)], 202621);
    expect(tree.root).toBe(tree.leaves[0]!.leafHex);
  });
});
