import { defineConfig } from "vitest/config";
import { availableParallelism } from "node:os";

const maxWorkers = Math.max(1, Math.min(4, availableParallelism() - 1));

export default defineConfig({
  test: {
    maxWorkers,
  },
});
