// DR-014 — Discord bot DM helper. Stubbed for MVP: the client is configured
// + the DM helper is implemented, but the actual bot is NOT auto-logged in
// at module import. Production cron explicitly calls `ensureDiscordBotReady`
// before its first DM batch.
//
// Pattern adapted from /c/Dev/fffanalytics_t3/src/utils/discordService.ts:
//   - Single discord.js Client singleton per process
//   - login() via DISCORD_BOT_TOKEN env (omitted at MVP → stub mode)
//   - DM is via `users.fetch(discordId).then(u => u.send(message))` — works
//     ONLY if the user shares a server with the bot. Per discord.js docs.
//     Production setup: invite the BellMarkets Discord bot to the public
//     "BellMarkets community" server; require new users to join to receive DMs.
//
// STUB MODE: when DISCORD_BOT_TOKEN is unset, `sendDiscordDM` returns
// { ok: false, stub: true, reason: "DISCORD_BOT_TOKEN unset" }. Same shape
// as the Aria-ix stubs in distribute.ts — fail-fast with a clear message.

import type { Client } from "discord.js";
import { logNotificationSent } from "./db.js";
import type { NotificationKind } from "./types.js";

export class DiscordBotError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "DiscordBotError";
  }
}

// ---------------------------------------------------------------------------
// Singleton client
// ---------------------------------------------------------------------------

let client: Client | undefined;
let loginPromise: Promise<Client> | undefined;

/** Reset state for tests. Not used at runtime. */
export function _resetDiscordBotForTesting(): void {
  client = undefined;
  loginPromise = undefined;
}

/**
 * Lazily initialize the Discord bot client + login. Returns the connected
 * Client. Idempotent — subsequent calls return the cached client.
 *
 * Returns `undefined` when DISCORD_BOT_TOKEN is unset → callers fall back to
 * stub behavior. We don't throw because the bot is optional infra; downstream
 * crons should keep running even without it.
 */
export async function ensureDiscordBotReady(): Promise<Client | undefined> {
  if (client?.isReady()) return client;
  if (!process.env.DISCORD_BOT_TOKEN) return undefined;
  if (loginPromise) return loginPromise;

  loginPromise = (async () => {
    const { Client: ClientCtor, GatewayIntentBits } = await import("discord.js");
    const c = new ClientCtor({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
      ],
    });
    c.on("error", (err) => {
      console.error("[discord] client error:", err);
    });
    await c.login(process.env.DISCORD_BOT_TOKEN);
    // Wait for ready event
    if (!c.isReady()) {
      await new Promise<void>((resolve) => c.once("ready", () => resolve()));
    }
    client = c;
    return c;
  })();
  try {
    return await loginPromise;
  } catch (err) {
    loginPromise = undefined;
    throw new DiscordBotError(`Failed to log in Discord bot: ${(err as Error).message}`, err);
  }
}

// ---------------------------------------------------------------------------
// DM helper
// ---------------------------------------------------------------------------

export type DiscordDMResult =
  | { ok: true; messageId: string; stub?: undefined }
  | { ok: false; reason: string; stub?: boolean };

/**
 * Send a Direct Message to a Discord user via the BellMarkets bot.
 *
 * @param discordUserId — the user's Discord snowflake (from `oauth_accounts.provider_user_id`)
 * @param message — UTF-8 plaintext. Discord limits to 2000 chars; we truncate.
 *
 * Returns `{ ok: true, messageId }` on success. On bot-not-configured,
 * returns `{ ok: false, stub: true, reason: "..." }` — caller can log + skip.
 *
 * Logs every attempt (success or failure) to `notifications_sent` under the
 * "discord" channel.
 */
export async function sendDiscordDM(
  userId: string,
  discordUserId: string,
  kind: NotificationKind,
  message: string,
): Promise<DiscordDMResult> {
  if (!discordUserId) {
    return { ok: false, reason: "discordUserId required" };
  }
  const truncated = message.length > 2000 ? message.slice(0, 1997) + "..." : message;

  const bot = await ensureDiscordBotReady();
  if (!bot) {
    await logNotificationSent({
      userId,
      channel: "discord",
      kind,
      payload: { discordUserId, messageLen: truncated.length },
      status: "failed",
      lastError: "DISCORD_BOT_TOKEN unset (stub mode)",
    });
    return { ok: false, stub: true, reason: "DISCORD_BOT_TOKEN unset (stub mode)" };
  }

  try {
    const user = await bot.users.fetch(discordUserId);
    const sent = await user.send(truncated);
    await logNotificationSent({
      userId,
      channel: "discord",
      kind,
      payload: { discordUserId, messageLen: truncated.length, messageId: sent.id },
      status: "sent",
    });
    return { ok: true, messageId: sent.id };
  } catch (err) {
    const reason = `discord DM failed: ${(err as Error).message ?? String(err)}`;
    await logNotificationSent({
      userId,
      channel: "discord",
      kind,
      payload: { discordUserId, messageLen: truncated.length },
      status: "failed",
      lastError: reason,
    });
    return { ok: false, reason };
  }
}

/**
 * Convenience: format a Unix timestamp as a Discord-renderable timestamp.
 * `<t:1748030400:f>` → renders as the user's locale-formatted datetime in
 * Discord clients.
 */
export function formatDiscordTimestamp(unixSeconds: number, style: "f" | "F" | "d" | "D" | "t" | "T" | "R" = "f"): string {
  return `<t:${Math.floor(unixSeconds)}:${style}>`;
}
