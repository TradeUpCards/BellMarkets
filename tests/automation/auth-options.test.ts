import { describe, it, expect, vi } from "vitest";
import {
  handleSignIn,
  normalizeOAuthProfile,
  type BellMarketsAuthUser,
} from "../../services/automation/src/auth/options.js";
import type { User } from "../../services/automation/src/auth/types.js";

const ALICE_PK = "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV";

function fakeUser(seed: Partial<BellMarketsAuthUser> = {}): BellMarketsAuthUser {
  return {
    id: "twitter-12345",
    name: "Alice",
    email: "alice@example.com",
    image: "https://example.com/alice.png",
    ...seed,
  };
}

function fakeAccount(provider: string): {
  provider: string;
  type: "oauth";
  providerAccountId: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
} {
  return {
    provider,
    type: "oauth",
    providerAccountId: "ext-id-123",
    access_token: "fake-access",
    refresh_token: "fake-refresh",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };
}

describe("normalizeOAuthProfile", () => {
  it("picks Twitter v2 fields (profile_image_url falls back to user.image, username, email)", () => {
    const out = normalizeOAuthProfile(
      "twitter",
      // user.image undefined → normalize falls back to profile.profile_image_url
      { id: "tw1", username: "alice_x", email: "alice@example.com" } as BellMarketsAuthUser,
      { profile_image_url: "https://x.com/alice.png", email: "alice@example.com", username: "alice_x" } as never,
    );
    expect(out).toEqual({
      provider: "twitter",
      providerUserId: "tw1",
      email: "alice@example.com",
      username: "alice_x",
      avatarUrl: "https://x.com/alice.png",
    });
  });

  it("prefers user.image over profile-level avatar fields (NextAuth-normalized wins)", () => {
    const out = normalizeOAuthProfile(
      "twitter",
      fakeUser({ id: "tw1", image: "https://nextauth-resolved.com/alice.png" }),
      { profile_image_url: "https://x.com/alice.png" } as never,
    );
    expect(out.avatarUrl).toBe("https://nextauth-resolved.com/alice.png");
  });

  it("picks Discord fields (global_name, image_url)", () => {
    const out = normalizeOAuthProfile(
      "discord",
      fakeUser({ id: "disc1", image: "https://cdn.discord.com/alice.png" }),
      { global_name: "alice_discord", image_url: "https://cdn.discord.com/alice.png" } as never,
    );
    expect(out.provider).toBe("discord");
    expect(out.providerUserId).toBe("disc1");
    expect(out.username).toBe("alice_discord");
  });

  it("picks Google fields (picture, name)", () => {
    const out = normalizeOAuthProfile(
      "google",
      fakeUser({ id: "g1", name: "Alice G" }),
      { picture: "https://lh3.googleusercontent.com/alice", email: "alice@example.com" } as never,
    );
    expect(out.provider).toBe("google");
    expect(out.providerUserId).toBe("g1");
    expect(out.username).toBe("Alice G");
    expect(out.avatarUrl).toBe("https://example.com/alice.png"); // user.image wins per priority
  });

  it("tolerates missing fields", () => {
    const out = normalizeOAuthProfile("twitter", { id: "x" } as BellMarketsAuthUser, undefined);
    expect(out.providerUserId).toBe("x");
    expect(out.email).toBeUndefined();
    expect(out.username).toBeUndefined();
    expect(out.avatarUrl).toBeUndefined();
  });
});

describe("handleSignIn", () => {
  function fakeUserRow(overrides: Partial<User> = {}): User {
    return {
      id: "user-uuid-1",
      walletPubkey: ALICE_PK,
      email: undefined,
      handle: undefined,
      avatarUrl: undefined,
      snsName: undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  it("rejects when account is missing", async () => {
    const result = await handleSignIn(
      { user: fakeUser(), account: null },
      { cookieReader: async () => ({ signedData: "s", publicKey: ALICE_PK }) },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no account");
  });

  it("rejects unsupported providers", async () => {
    const result = await handleSignIn(
      { user: fakeUser(), account: { ...fakeAccount("github"), provider: "github" } as never },
      {
        cookieReader: async () => ({ signedData: "s", publicKey: ALICE_PK }),
        verifySignature: async () => ALICE_PK,
        upsertUser: vi.fn(),
        linkAccount: vi.fn(),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("unsupported provider");
  });

  it("rejects when wallet-signature cookies missing", async () => {
    const result = await handleSignIn(
      { user: fakeUser(), account: fakeAccount("twitter") as never },
      {
        cookieReader: async () => ({ signedData: undefined, publicKey: undefined }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("missing signedData");
  });

  it("rejects on invalid signature", async () => {
    const result = await handleSignIn(
      { user: fakeUser(), account: fakeAccount("twitter") as never },
      {
        cookieReader: async () => ({ signedData: "bad", publicKey: ALICE_PK }),
        verifySignature: async () => {
          throw new Error("invalid signature");
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("signature verification failed");
  });

  it("happy path: upserts user + links oauth_accounts + sets user.id/walletPubkey", async () => {
    const upsertUser = vi.fn().mockResolvedValue(fakeUserRow({ email: "alice@example.com" }));
    const linkAccount = vi.fn().mockResolvedValue({
      id: "oauth-uuid",
      userId: "user-uuid-1",
      provider: "twitter",
      providerUserId: "tw1",
      email: "alice@example.com",
      username: "alice_x",
      avatarUrl: undefined,
      refreshToken: undefined,
      accessTokenExpiresAt: undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const user = fakeUser({ id: "tw1", username: "alice_x" });
    const result = await handleSignIn(
      { user, account: fakeAccount("twitter") as never, profile: { username: "alice_x", email: "alice@example.com" } as never },
      {
        cookieReader: async () => ({ signedData: "sig", publicKey: ALICE_PK }),
        verifySignature: async (sig, pk) => {
          expect(sig).toBe("sig");
          expect(pk).toBe(ALICE_PK);
          return ALICE_PK;
        },
        upsertUser,
        linkAccount,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.walletPubkey).toBe(ALICE_PK);
    expect(result.userId).toBe("user-uuid-1");
    expect(upsertUser).toHaveBeenCalledOnce();
    expect(upsertUser).toHaveBeenCalledWith(ALICE_PK, expect.objectContaining({ email: "alice@example.com" }));
    expect(linkAccount).toHaveBeenCalledOnce();
    expect(linkAccount).toHaveBeenCalledWith(
      "user-uuid-1",
      expect.objectContaining({ provider: "twitter", providerUserId: "tw1" }),
      "fake-refresh",
      expect.any(Date),
    );
    // user.id should now be the DB UUID (was twitter snowflake "tw1")
    expect(user.id).toBe("user-uuid-1");
    expect(user.walletPubkey).toBe(ALICE_PK);
    expect(user.username).toBe("alice_x");
  });

  it("captures db-write failure with clear reason", async () => {
    const result = await handleSignIn(
      { user: fakeUser({ id: "x" }), account: fakeAccount("twitter") as never },
      {
        cookieReader: async () => ({ signedData: "sig", publicKey: ALICE_PK }),
        verifySignature: async () => ALICE_PK,
        upsertUser: async () => {
          throw new Error("connection refused");
        },
        linkAccount: vi.fn(),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("db write failed");
    expect(result.reason).toContain("connection refused");
  });

  it("rejects when provider returned no user id", async () => {
    const result = await handleSignIn(
      { user: { ...fakeUser(), id: "" } as never, account: fakeAccount("twitter") as never },
      {
        cookieReader: async () => ({ signedData: "sig", publicKey: ALICE_PK }),
        verifySignature: async () => ALICE_PK,
        upsertUser: vi.fn(),
        linkAccount: vi.fn(),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no user id");
  });
});
