import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { enabled: false },
    globals: true,
    testTimeout: 20000,
  },
});
