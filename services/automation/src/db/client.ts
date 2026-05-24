// Postgres client for the DR-010 win-streak indexer.
//
// Uses @neondatabase/serverless because Trigger.dev jobs are short-lived
// (per-invocation lambdas) — pooled HTTP-based connections fit that
// lifecycle far better than a long-lived TCP pool. `neon()` wraps each query
// in a single HTTP POST to Neon's pooler endpoint; no connection state to
// manage between invocations.
//
// All queries are parameterized — never string-interpolate user input.
//
// DATABASE_URL shape: postgresql://user:password@host:port/db?sslmode=require
// Stored in services/automation/.env (gitignored). NEVER commit the value;
// only the placeholder lives in .env.example.

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

export type SqlClient = NeonQueryFunction<false, false>;

let cached: SqlClient | undefined;

/**
 * Lazy-construct the Neon SQL client. Cached for the lifetime of the
 * process. Tests inject their own via `setSqlClientForTesting`.
 */
export function getSqlClient(): SqlClient {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new IndexerDbError(
      "DATABASE_URL is unset. Add the Neon connection string to services/automation/.env (see .env.example).",
    );
  }
  cached = neon(url);
  return cached;
}

/** Test injection point — set the client to a stub. */
export function setSqlClientForTesting(client: SqlClient | undefined): void {
  cached = client;
}

export class IndexerDbError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "IndexerDbError";
  }
}
