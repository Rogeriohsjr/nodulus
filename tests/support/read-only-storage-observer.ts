import { LocalIntakeStorage } from "../../src/adapters/storage/local-intake-storage.js";
import type { IntakeStorage } from "../../src/core/ports/intake-storage.js";

export type StorageMutationCounts = { createRun: number; writeRunFiles: number; acquireRunLock: number; releaseRunLock: number };
export type ReadStorageObserver = { storage: IntakeStorage; mutations: StorageMutationCounts };

export function observeReadStorage(): ReadStorageObserver {
  const delegate = new LocalIntakeStorage();
  const mutations: StorageMutationCounts = { createRun: 0, writeRunFiles: 0, acquireRunLock: 0, releaseRunLock: 0 };
  const storage: IntakeStorage = {
    readUtf8: (absolutePath) => delegate.readUtf8(absolutePath),
    readRunFile: (projectRoot, runId, relativePath) => delegate.readRunFile(projectRoot, runId, relativePath),
    createRun: (projectRoot, runId, files) => {
      mutations.createRun += 1;
      return delegate.createRun(projectRoot, runId, files);
    },
    writeRunFiles: (projectRoot, runId, files) => {
      mutations.writeRunFiles += 1;
      return delegate.writeRunFiles(projectRoot, runId, files);
    },
    acquireRunLock: async (projectRoot, runId) => {
      mutations.acquireRunLock += 1;
      const lock = await delegate.acquireRunLock(projectRoot, runId);
      return {
        release: async () => {
          mutations.releaseRunLock += 1;
          await lock.release();
        },
      };
    },
  };
  return { storage, mutations };
}
