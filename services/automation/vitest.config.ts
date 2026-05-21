import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["../../tests/automation/**/*.test.ts"],
    environment: "node",
    globals: false,
    reporters: ["default"],
    testTimeout: 10_000,
  },
});
