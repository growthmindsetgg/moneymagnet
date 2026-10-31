import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
  // Components rendered in tests (react-dom/server) use the automatic JSX runtime, as Next does.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
