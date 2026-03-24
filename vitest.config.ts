import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [
      ".claude/**",
      ".worktrees/**",
      "node_modules/**",
      // Tests that depend on Bun runtime APIs (Bun.spawnSync, Bun.sleepSync,
      // require(".ts")). These run under `bun test` locally but fail under
      // `bunx vitest run` (CI) where vitest uses Node.
      "test/setup.test.ts",
      "test/init.test.ts",
      "test/start.test.ts",
      "test/lock.test.ts",
      "test/config.test.ts",
      "test/gh.test.ts",
    ],
  },
});
