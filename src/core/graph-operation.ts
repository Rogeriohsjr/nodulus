/** Runtime-owned persistence permitted while a provider operation is active. */
export type RuntimeEvidencePublication = {
  run<T>(write: () => Promise<T>): Promise<T>;
  isSealed(): boolean;
};

/** Core keeps the seal capability private to the graph runtime. */
export type RuntimeEvidencePublicationOwner = {
  publication: RuntimeEvidencePublication;
  sealAndDrain(): Promise<void>;
};

/**
 * Creates a publication fence for concrete runtime-owned evidence writes.
 * Provider/process waits and caller-owned IO must not be registered here.
 */
export function createRuntimeEvidencePublication(): RuntimeEvidencePublicationOwner {
  let sealed = false;
  const pending = new Set<Promise<void>>();
  const requiredWriteFailures: unknown[] = [];

  const publication: RuntimeEvidencePublication = {
    run<T>(write: () => Promise<T>): Promise<T> {
      if (sealed) return Promise.reject(Object.assign(new Error("Runtime evidence publication is sealed."), { code: "GRAPH_EVIDENCE_SEALED" }));
      let release!: () => void;
      const completed = new Promise<void>((resolve) => { release = resolve; });
      pending.add(completed);
      return (async () => {
        try {
          return await write();
        } catch (error) {
          requiredWriteFailures.push(error);
          throw error;
        } finally {
          pending.delete(completed);
          release();
        }
      })();
    },
    isSealed(): boolean { return sealed; },
  };

  return {
    publication,
    async sealAndDrain(): Promise<void> {
      sealed = true;
      const active = [...pending];
      await Promise.all(active);
      if (requiredWriteFailures.length > 0) throw requiredWriteFailures[0];
    },
  };
}
