import { channel } from "node:diagnostics_channel";
import { errorMonitor } from "node:events";
import type { ChildProcess } from "node:child_process";

type ChildStage = "spawn" | "error" | "exit" | "close";

type ChildRecord = {
  identity: number;
  child: ChildProcess;
  pid: number | null;
  stages: Set<ChildStage>;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  errorName?: string;
  close: Promise<void>;
  closeProcess(): void;
};

export type OwnedNativeProcessDiagnostics = {
  identity: number;
  pid: number | null;
  stages: ChildStage[];
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  errorName?: string;
};

export type OwnedNativeProcessObserver = {
  readonly diagnostics: OwnedNativeProcessDiagnostics[];
  readonly observationFailure: boolean;
  drain(deadline: number): Promise<void>;
};

const maximumObservedChildren = 512;

/** Passively capture every ChildProcess published while this observer is active. */
export function observeOwnedNativeProcesses(): OwnedNativeProcessObserver {
  const records: ChildRecord[] = [];
  const byChild = new WeakMap<object, ChildRecord>();
  const childChannel = channel("child_process");
  let stopped = false;
  let observationFailure = false;

  const recordFor = (child: ChildProcess): ChildRecord => {
    const existing = byChild.get(child);
    if (existing) return existing;
    let closeProcess = (): void => undefined;
    const close = new Promise<void>((resolve) => { closeProcess = resolve; });
    const record: ChildRecord = {
      identity: records.length + 1,
      child,
      pid: typeof child.pid === "number" && Number.isSafeInteger(child.pid) ? child.pid : null,
      stages: new Set<ChildStage>(),
      close,
      closeProcess: () => closeProcess(),
    };
    byChild.set(child, record);
    records.push(record);
    return record;
  };

  const mark = (child: ChildProcess, stage: ChildStage, code?: number | null, signal?: NodeJS.Signals | null, error?: unknown): void => {
    try {
      const record = recordFor(child);
      record.stages.add(stage);
      if (stage === "spawn") record.pid = typeof child.pid === "number" && Number.isSafeInteger(child.pid) ? child.pid : null;
      if (stage === "exit" || stage === "close") {
        record.exitCode = code ?? null;
        record.signal = signal ?? null;
      }
      if (stage === "error") record.errorName = (error instanceof Error ? error.name : "UnknownError").slice(0, 64);
      if (stage === "close") record.closeProcess();
    } catch {
      observationFailure = true;
    }
  };

  const onChild = (message: unknown): void => {
    try {
      if (typeof message !== "object" || message === null || !("process" in message)) return;
      const candidate = (message as { process?: unknown }).process;
      if (typeof candidate !== "object" || candidate === null || !("once" in candidate) || typeof candidate.once !== "function") return;
      const child = candidate as ChildProcess;
      if (byChild.has(child)) return;
      if (records.length >= maximumObservedChildren) {
        observationFailure = true;
        return;
      }
      recordFor(child);
      child.once("spawn", () => mark(child, "spawn"));
      child.once(errorMonitor, (error: unknown) => mark(child, "error", null, null, error));
      child.once("exit", (code, signal) => mark(child, "exit", code, signal));
      child.once("close", (code, signal) => mark(child, "close", code, signal));
    } catch {
      // A diagnostics subscriber must never alter child-process behavior.
      observationFailure = true;
    }
  };

  childChannel.subscribe(onChild);

  const diagnostics = (): OwnedNativeProcessDiagnostics[] => records.map(({ identity, pid, stages, exitCode, signal, errorName }) => ({
    identity,
    pid,
    stages: [...stages],
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
    ...(errorName === undefined ? {} : { errorName }),
  }));

  return {
    get diagnostics() { return diagnostics(); },
    get observationFailure() { return observationFailure; },
    async drain(deadline: number): Promise<void> {
      try {
        while (true) {
          const observed = records.length;
          const open = records.filter((record) => !record.stages.has("close"));
          if (open.length === 0 && observed === records.length) {
            if (observationFailure) throw new Error("Owned native child observation was incomplete; process cleanup cannot be verified.");
            return;
          }
          const remaining = deadline - Date.now();
          const describeOpen = (): string => open.slice(0, 12).map(({ identity, pid, stages }) =>
            `${identity}:${pid ?? "no-pid"}:${[...stages].join(",") || "published"}`,
          ).join(";") + (open.length > 12 ? ";additional children omitted" : "");
          if (remaining <= 0) throw new Error(`Owned native children did not all close before the shared cleanup deadline (${open.length} open: ${describeOpen()}).`);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              Promise.all(open.map((record) => record.close)),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Owned native children did not all close before the shared cleanup deadline (${open.length} open: ${describeOpen()}).`)), remaining);
              }),
            ]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
          if (records.length === observed && records.every((record) => record.stages.has("close"))) {
            if (observationFailure) throw new Error("Owned native child observation was incomplete; process cleanup cannot be verified.");
            return;
          }
        }
      } finally {
        if (!stopped) {
          stopped = true;
          childChannel.unsubscribe(onChild);
        }
      }
    },
  };
}
