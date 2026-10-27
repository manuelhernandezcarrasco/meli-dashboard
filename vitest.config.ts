import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } }, // tsconfig has jsx: preserve (Next); needed to render components in tests
  resolve: { alias: { "~": path.resolve(import.meta.dirname, "src") } },
  test: { environment: "node", include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.ts"] },
});
