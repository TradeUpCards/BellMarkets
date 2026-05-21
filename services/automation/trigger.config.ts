import { defineConfig } from "@trigger.dev/sdk/v3";

// Trigger.dev v4 project config for the BellMarkets automation service.
// Two scheduled jobs live under ./src/jobs (morning create-markets ~8am ET,
// settlement nudger ~4:05pm ET). Both are permissionless convenience callers
// over Aria's Anchor program — never authorities (DR-002).
//
// `TRIGGER_PROJECT_REF` is the Trigger.dev project reference for this
// workspace; populate it locally in .env (.env.example shows the shape).
// We deliberately don't hard-code a project ref here so the same source
// can attach to different Trigger.dev projects per environment.

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_bellmarkets_dev",
  runtime: "node",
  logLevel: "info",
  dirs: ["./src/jobs"],
  maxDuration: 300,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 5,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 60_000,
      factor: 2,
      randomize: true,
    },
  },
});
