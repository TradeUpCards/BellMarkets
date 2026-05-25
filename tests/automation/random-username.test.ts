import { describe, it, expect } from "vitest";
import {
  isRandomUsername,
  RANDOM_USERNAME_ADJECTIVES,
  RANDOM_USERNAME_NOUNS,
  RANDOM_USERNAME_REGEX,
} from "../../services/automation/src/auth/random-username.js";

describe("isRandomUsername — dictionary roundtrip", () => {
  it("matches every (adjective, noun, 0-999) combination produced by the generator pattern", () => {
    // Sample every adj × noun cross + a few number variations (0, 5, 42, 999)
    // to lock byte-for-byte parity with Cleo's apps/web username-generator.
    for (const adj of RANDOM_USERNAME_ADJECTIVES) {
      for (const noun of RANDOM_USERNAME_NOUNS) {
        for (const num of [0, 5, 42, 999]) {
          expect(isRandomUsername(`${adj}${noun}${num}`)).toBe(true);
        }
      }
    }
  });

  it("locks the regex shape (canary against accidental dictionary drift)", () => {
    expect(RANDOM_USERNAME_REGEX.source).toMatch(/^\^/);
    expect(RANDOM_USERNAME_REGEX.source).toMatch(/\$$/);
    // Drift canary — bumping these numbers also requires bumping Cleo's
    // apps/web/src/lib/username-generator.ts.
    expect(RANDOM_USERNAME_ADJECTIVES).toHaveLength(10);
    expect(RANDOM_USERNAME_NOUNS).toHaveLength(10);
  });
});

describe("isRandomUsername — rejections (user-customized handles)", () => {
  it.each([
    ["my_real_name", "snake_case custom"],
    ["alice", "single word lowercase"],
    ["BraveFox", "missing number"],
    ["BraveFox_42", "number separated"],
    ["bravefox42", "lowercase"],
    ["BRAVEFOX42", "uppercase"],
    ["BraveFox007", "leading zero — generator produces no padding"],
    ["BraveFox1000", "4-digit number > 999"],
    ["BraveDragon42", "noun outside dictionary"],
    ["AmazingFox42", "adj outside dictionary"],
    ["BraveFox42_extra", "trailing customization"],
    ["prefix_BraveFox42", "leading customization"],
    ["", "empty string"],
  ])("rejects %s (%s)", (handle) => {
    expect(isRandomUsername(handle)).toBe(false);
  });

  it("returns false for null/undefined (no auto-gen handle exists)", () => {
    expect(isRandomUsername(null)).toBe(false);
    expect(isRandomUsername(undefined)).toBe(false);
  });
});

describe("isRandomUsername — boundary numbers", () => {
  it("matches the boundary values 0 and 999", () => {
    expect(isRandomUsername("BraveFox0")).toBe(true);
    expect(isRandomUsername("LivelyDolphin999")).toBe(true);
  });

  it("rejects negative-looking numbers", () => {
    expect(isRandomUsername("BraveFox-1")).toBe(false);
  });
});
