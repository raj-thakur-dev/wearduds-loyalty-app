import { defineConfig } from "vitest/config";

// Separate from vite.config.js so the React Router plugin doesn't load in tests.
// Integration tests need a Postgres database: set TEST_DATABASE_URL.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 30000,
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL || "postgresql://postgres@localhost:5432/wearduds_test?host=/tmp",
      NODE_ENV: "test",
    },
  },
});
