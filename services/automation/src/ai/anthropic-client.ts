// Anthropic SDK wrapper for AI v2 phase 0+. Lazy import + caching.
//
// Why a wrapper instead of using the SDK directly:
//   - Audit-log every call into `ai_outputs` automatically (token counts +
//     model + prompt hash + cost estimate). One source of truth for the
//     cost dashboard (per ai-v2-plan §3 "Cost projection").
//   - Lazy import of `@anthropic-ai/sdk` so unit tests + cron init paths
//     don't pull a 5MB SDK + crypto deps if they never call.
//   - Optional batch + cache hints — DR-agnostic for now, threaded
//     through when callers light them up.
//
// Usage:
//   import { callAnthropic } from "./anthropic-client.js";
//   const result = await callAnthropic({
//     kind: "classify-news",
//     model: "claude-haiku-4-5-20251001",
//     system: "You are a financial news classifier...",
//     messages: [{ role: "user", content: "Classify this headline..." }],
//     maxTokens: 512,
//     relatedTicker: "META",
//   });
//
// STUB mode: when ANTHROPIC_API_KEY is unset, returns a deterministic stub
// response — useful for dev/CI without real API access.

import { createHash } from "node:crypto";
import { logAiOutput } from "./db.js";
import type {
  AiOutputKind,
  AnthropicModelId,
} from "./types.js";

// Anthropic SDK's published per-million-token rates (USD). May 2026 snapshot
// from ai-v2-plan §3 — update when rates change.
//
// rates[model] = { input, output, cacheRead, cacheCreate } per 1M tokens
// All in cents (× 100 USD).
const RATE_TABLE_CENTS_PER_MTOK: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number }> = {
  "claude-haiku-4-5-20251001": { input: 100, output: 500, cacheRead: 10, cacheCreate: 125 },
  "claude-haiku-4-5": { input: 100, output: 500, cacheRead: 10, cacheCreate: 125 },
  "claude-sonnet-4-6": { input: 300, output: 1500, cacheRead: 30, cacheCreate: 375 },
  "claude-opus-4-7": { input: 500, output: 2500, cacheRead: 50, cacheCreate: 625 },
};

export class AnthropicWrapperError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "AnthropicWrapperError";
  }
}

export type AnthropicCallInput = {
  kind: AiOutputKind;
  model: AnthropicModelId;
  system?: string;
  /** Anthropic Messages API format. */
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
  relatedTicker?: string;
  userId?: string;
  /** Skip logging this call to ai_outputs. Default false. */
  skipAudit?: boolean;
};

export type AnthropicCallResult = {
  ok: true;
  outputText: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costCents: number;
  requestId: string;
  stub: boolean;
};

export type AnthropicCallError = {
  ok: false;
  error: string;
  stub?: boolean;
};

let cachedClient: unknown;

async function getClient(): Promise<unknown> {
  if (cachedClient) return cachedClient;
  const mod = await import("@anthropic-ai/sdk");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ctor = (mod as any).default ?? (mod as any).Anthropic ?? mod;
  cachedClient = new Ctor({ apiKey: process.env.ANTHROPIC_API_KEY });
  return cachedClient;
}

/** Compute SHA-256 of the canonical "prompt string" — concat of system +
 *  all messages. Used for cache-hit-rate analysis in ai_outputs. */
function hashPrompt(input: AnthropicCallInput): string {
  const h = createHash("sha256");
  h.update(input.kind);
  h.update("|");
  h.update(input.model);
  h.update("|");
  if (input.system) h.update(input.system);
  h.update("|");
  for (const m of input.messages) {
    h.update(m.role);
    h.update(":");
    h.update(m.content);
    h.update("\n");
  }
  return h.digest("hex");
}

function estimateCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): number {
  const rates = RATE_TABLE_CENTS_PER_MTOK[model];
  if (!rates) return 0;
  const nonCachedInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens);
  const total =
    (nonCachedInputTokens * rates.input) / 1_000_000 +
    (outputTokens * rates.output) / 1_000_000 +
    (cacheReadTokens * rates.cacheRead) / 1_000_000 +
    (cacheCreationTokens * rates.cacheCreate) / 1_000_000;
  return Math.round(total * 100) / 100; // cents, 2-decimal precision
}

/**
 * Call Anthropic Messages API. Audit-logs every response into ai_outputs
 * (unless skipAudit=true). Returns the response text + token counts +
 * cost estimate.
 *
 * Stub mode (ANTHROPIC_API_KEY unset): returns a deterministic stub with
 * outputText='STUB: <prompt-hash-prefix>' and zero costs. Persists to
 * ai_outputs with model='stub' so dashboards can filter stub from real
 * calls.
 */
export async function callAnthropic(
  input: AnthropicCallInput,
): Promise<AnthropicCallResult | AnthropicCallError> {
  const promptHash = hashPrompt(input);

  if (!process.env.ANTHROPIC_API_KEY) {
    const stubText = `STUB[${promptHash.slice(0, 8)}]: ${input.kind} via ${input.model} — Anthropic API key unset; this is a deterministic stub response. Set ANTHROPIC_API_KEY for live calls.`;
    if (!input.skipAudit) {
      await logAiOutput({
        kind: input.kind,
        model: "stub",
        promptHash,
        inputTokens: 0,
        outputTokens: 0,
        outputText: stubText,
        userId: input.userId,
        relatedTicker: input.relatedTicker,
      }).catch(() => undefined);
    }
    return {
      ok: true,
      outputText: stubText,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costCents: 0,
      requestId: `stub-${promptHash.slice(0, 16)}`,
      stub: true,
    };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (await getClient()) as any;
    const response = await client.messages.create({
      model: input.model,
      max_tokens: input.maxTokens ?? 1024,
      temperature: input.temperature,
      system: input.system,
      messages: input.messages,
    });

    // Extract text block(s) — Anthropic responses are an array of content blocks
    const text = Array.isArray(response.content)
      ? response.content
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((b: any) => b.type === "text")
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((b: any) => b.text)
          .join("")
      : String(response.content ?? "");

    const usage = response.usage ?? {};
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
    const costCents = estimateCostCents(
      input.model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    );

    if (!input.skipAudit) {
      await logAiOutput({
        kind: input.kind,
        model: input.model,
        promptHash,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        costCents,
        outputText: text,
        userId: input.userId,
        relatedTicker: input.relatedTicker,
        requestId: response.id ?? undefined,
      }).catch(() => undefined);
    }

    return {
      ok: true,
      outputText: text,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      costCents,
      requestId: response.id ?? `req-${promptHash.slice(0, 16)}`,
      stub: false,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? String(err) };
  }
}
