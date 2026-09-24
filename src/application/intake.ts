import { LocalIntakeStorage } from "../adapters/storage/local-intake-storage.js";
import { createIntake, type IntakeRequest, type IntakeResult, type RequestSource } from "../core/intake-request.js";
import type { IntakeStorage } from "../core/ports/intake-storage.js";

export type { IntakeRequest, IntakeResult, RequestSource };

/** Internal intake milestone used by run orchestration; this does not execute a workflow. */
export function intakeRequest(request: IntakeRequest, storage: IntakeStorage = new LocalIntakeStorage()): Promise<IntakeResult> {
  return createIntake(request, storage);
}
