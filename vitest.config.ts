import { defineConfig } from "vitest/config";

// The default test command deliberately excludes the contract tests: they spawn a
// real `codex exec`, cost tokens, and need working Codex credentials. Run them
// with `pnpm test:contract` — that is how a Codex version bump gets validated.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/contract/**", "node_modules/**"],
  },
});
