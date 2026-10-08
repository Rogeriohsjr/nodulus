import path from "node:path";
import { LocalIntakeStorage } from "../adapters/storage/local-intake-storage.js";
import { inspectWorkflowDefinition } from "../core/inspect-workflow.js";

/** Read and resolve a workflow definition without creating a run or executing actions. */
export async function inspectWorkflow(projectRoot: string, workflowId: string): Promise<Record<string, unknown>> {
  return inspectWorkflowDefinition(path.resolve(projectRoot), workflowId, new LocalIntakeStorage());
}
