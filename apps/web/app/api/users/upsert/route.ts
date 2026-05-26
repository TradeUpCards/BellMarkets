import { NextResponse } from "next/server";

// Tight subpath `./auth/db` (per services/automation package.json `exports`
// field) — bypasses the auth barrel which re-exports discord-bot.js +
// web-push.js. Those pull in transitive deps (discord.js → @discordjs/ws
// → zlib-sync optional native dep) that don't bundle in Next.js webpack.
import {
  getUserByWalletPubkey,
  upsertUserByWallet,
} from "@bell-markets/automation/auth/db";

import {
  generateUsername,
  virtualEmail,
} from "@/lib/username-generator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // base58, Solana pubkey shape

interface UpsertRequest {
  walletPubkey: string;
  /** Optional SNS `.sol` name resolved by the caller (frontend can pass when known). */
  snsName?: string;
}

/**
 * POST /api/users/upsert — fanalytics-pattern first-connect handler.
 *
 * Called by the frontend (`useEnsureUser()`) when a wallet connects.
 * Idempotent: if a row already exists for `walletPubkey`, returns it
 * unchanged. If not, INSERTs with an auto-generated
 * `BraveEagle983`-style handle + `<wallet>@virtual.bell.markets` email so
 * the user has a working profile immediately, before they OAuth-link.
 *
 * The OAuth-link path (`bellMarketsAuthOptions.signIn` callback in
 * services/automation/src/auth/options.ts — Bram's territory) detects
 * the auto-gen handle via `isRandomUsername` and overwrites with the
 * OAuth provider's `display_name` on first link. User-chosen handles
 * (set later via /settings) are preserved across re-links.
 *
 * Auth posture: we trust the caller-supplied `walletPubkey`. Anyone who
 * knows another wallet's pubkey can trigger an upsert with that pubkey —
 * but the inserted row contains NO secret state (just a public-derivable
 * auto-gen handle + virtual email). The wallet owner sees the existing
 * row when they connect; no exposure. A future hardening pass can add
 * a signed-message check before INSERT.
 */
export async function POST(req: Request) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: "users-upsert unavailable: DATABASE_URL not configured" },
      { status: 503 },
    );
  }

  let body: UpsertRequest;
  try {
    body = (await req.json()) as UpsertRequest;
  } catch {
    return NextResponse.json(
      { error: "invalid JSON body" },
      { status: 400 },
    );
  }

  const walletPubkey = body?.walletPubkey;
  if (typeof walletPubkey !== "string" || !PUBKEY_RE.test(walletPubkey)) {
    return NextResponse.json(
      { error: "walletPubkey must be a base58 Solana pubkey" },
      { status: 400 },
    );
  }
  const snsName =
    typeof body.snsName === "string" && body.snsName.length > 0
      ? body.snsName
      : undefined;

  try {
    // Idempotent: if the row exists, return it without changing the handle
    // (we never want to overwrite a user-chosen or OAuth-set handle just
    // because they reconnected their wallet).
    const existing = await getUserByWalletPubkey(walletPubkey);
    if (existing) {
      return NextResponse.json({
        user: serialize(existing),
        created: false,
      });
    }

    // First connect — INSERT with auto-gen seed.
    const handle = generateUsername();
    const email = virtualEmail(walletPubkey);
    const created = await upsertUserByWallet(walletPubkey, {
      handle,
      email,
      avatarUrl: undefined,
      snsName,
    });

    return NextResponse.json({ user: serialize(created), created: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // unique_violation (23505) on `handle` — generator hit a collision in the
    // 100K key space. Caller can retry; we don't loop server-side to avoid
    // amplifying load on a degenerate database state.
    if (/unique/i.test(msg) && /handle/i.test(msg)) {
      return NextResponse.json(
        { error: "handle collision — caller should retry" },
        { status: 409 },
      );
    }
    console.error("[api/users/upsert] failed:", msg);
    return NextResponse.json(
      { error: "upsert failed" },
      { status: 500 },
    );
  }
}

interface UpsertableUser {
  id: string;
  walletPubkey: string;
  email?: string | null;
  handle?: string | null;
  avatarUrl?: string | null;
  snsName?: string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

function serialize(u: UpsertableUser) {
  return {
    id: u.id,
    walletPubkey: u.walletPubkey,
    email: u.email ?? null,
    handle: u.handle ?? null,
    avatarUrl: u.avatarUrl ?? null,
    snsName: u.snsName ?? null,
    createdAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : (u.createdAt ?? null),
    updatedAt: u.updatedAt instanceof Date ? u.updatedAt.toISOString() : (u.updatedAt ?? null),
  };
}
