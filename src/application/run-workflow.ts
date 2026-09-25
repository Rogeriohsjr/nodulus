import { LocalIntakeStorage } from "../adapters/storage/local-intake-storage.js";
import { ProcessArtifactValidator } from "../adapters/validation/process-artifact-validator.js";
import { createIntake, type IntakeRequest } from "../core/intake-request.js";
import { executeWorkflow } from "../core/execute-workflow.js";
import type { IntakeStorage } from "../core/ports/intake-storage.js";
import type { ProviderInvocation, ProviderPort } from "../core/ports/provider.js";

export type { ProviderInvocation, ProviderPort };

export type ApplicationRunResult = {
  runId: string;
  status: "success" | "needs_input" | "error";
  result: unknown;
};

export type RunWorkflowDependencies = {
  storage?: IntakeStorage;
};

/** Compose the real intake/storage/validator path with one external provider boundary. */
export async function runWorkflow(
  request: IntakeRequest,
  provider: ProviderPort,
  dependencies: RunWorkflowDependencies = {},
): Promise<ApplicationRunResult> {
  const storage = dependencies.storage ?? new LocalIntakeStorage();
  const intake = await createIntake(request, storage);
  return executeWorkflow(request, intake, provider, storage, new ProcessArtifactValidator());
}
