const maxTimerDelay = 2_147_483_647;

export type FeedbackDeadline = {
  signal: AbortSignal;
  expired(): boolean;
  remainingMs(): number;
  dispose(): void;
};

/** Create one abort signal for an absolute deadline, rearming long timers safely. */
export function createFeedbackDeadline(deadlineAtMs: number): FeedbackDeadline {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const remainingMs = () => Math.max(0, deadlineAtMs - Date.now());
  const arm = () => {
    if (disposed || controller.signal.aborted) return;
    const remaining = remainingMs();
    if (remaining <= 0) {
      controller.abort();
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, maxTimerDelay));
  };
  arm();
  return {
    signal: controller.signal,
    expired: () => controller.signal.aborted || remainingMs() <= 0,
    remainingMs,
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

export function feedbackDeadlineError(): Error & { code: string } {
  const error = new Error("Feedback routing elapsed-time limit was reached.") as Error & { code: string };
  error.code = "FEEDBACK_LIMIT_EXCEEDED";
  return error;
}
