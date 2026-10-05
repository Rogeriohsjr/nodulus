import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import path from "node:path";
import { LocalIntakeStorage } from "../adapters/storage/local-intake-storage.js";
import type { IntakeStorage } from "../core/ports/intake-storage.js";
import { requestContractSchema } from "../core/intake-request.js";
import { ENGINE_VERSION } from "./resume-workflow.js";

type RecordValue = Record<string, unknown>;
type Attempt = { nodeId: string; attempt: number };

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (!isRecord(value)) return JSON.stringify(value);
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

async function readJson(storage: IntakeStorage, root: string, runId: string, ref: string, diagnostics: string[]): Promise<unknown> {
  try {
    return JSON.parse(await storage.readRunFile(root, runId, ref)) as unknown;
  } catch {
    diagnostics.push("Saved replay input '" + ref + "' is missing, unreadable, or malformed.");
    return null;
  }
}

function readAttempts(value: unknown, diagnostics: string[]): Attempt[] {
  if (typeof value !== "string") {
    diagnostics.push("Saved run events are unavailable; no attempts can be replayed.");
    return [];
  }
  const attempts = new Map<string, Attempt>();
  for (const [index, line] of value.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line) as unknown; }
    catch {
      diagnostics.push("Saved run event line " + (index + 1) + " is malformed.");
      continue;
    }
    if (!isRecord(event) || (event.event !== "node.started" && event.event !== "node.repair.started")) continue;
    if (typeof event.nodeId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(event.nodeId) || !Number.isSafeInteger(event.attempt) || (event.attempt as number) < 1) {
      diagnostics.push("Saved run event line " + (index + 1) + " has an invalid node attempt reference.");
      continue;
    }
    const attempt = { nodeId: event.nodeId, attempt: event.attempt as number };
    attempts.set(attempt.nodeId + "\0" + attempt.attempt, attempt);
  }
  if (attempts.size === 0) diagnostics.push("Saved run has no recorded node attempts to replay.");
  return [...attempts.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId) || left.attempt - right.attempt);
}

/** Revalidate persisted provider candidates using only the run's captured JSON Schemas. */
export async function replaySavedRun(
  projectRoot: string,
  runId: string,
  storage: IntakeStorage = new LocalIntakeStorage(),
): Promise<RecordValue> {
  const diagnostics: string[] = [];
  const drift: RecordValue[] = [];
  const run = await readJson(storage, projectRoot, runId, "run.json", diagnostics);
  const definitions = await readJson(storage, projectRoot, runId, "context/definitions.json", diagnostics);
  const eventsText = await storage.readRunFile(projectRoot, runId, "events.jsonl").catch(() => null);
  const attempts = readAttempts(eventsText, diagnostics);
  const contracts = isRecord(definitions) && isRecord(definitions.contracts) ? definitions.contracts : {};
  const nodes = new Map<string, RecordValue>();
  if (isRecord(definitions) && Array.isArray(definitions.nodes)) {
    for (const node of definitions.nodes) if (isRecord(node) && typeof node.id === "string") nodes.set(node.id, node);
  } else {
    diagnostics.push("Captured node definitions are unavailable or malformed.");
  }

  if (isRecord(definitions) && typeof definitions.engineVersion === "string" && definitions.engineVersion !== ENGINE_VERSION) {
    drift.push({ kind: "engine-version", captured: definitions.engineVersion, current: ENGINE_VERSION });
  }
  if (isRecord(run) && isRecord(definitions) && typeof run.engineVersion === "string" && typeof definitions.engineVersion === "string" && run.engineVersion !== definitions.engineVersion) {
    drift.push({ kind: "run-definition-engine-version", captured: definitions.engineVersion, run: run.engineVersion });
  }

  const candidates: RecordValue[] = [];
  const skippedValidators = new Set<string>();
  for (const node of nodes.values()) {
    if (Array.isArray(node.expectedOutputs)) {
      for (const output of node.expectedOutputs) {
        if (isRecord(output) && typeof output.validator === "string") skippedValidators.add(output.validator);
      }
    }
  }

  for (const attempt of attempts) {
    const node = nodes.get(attempt.nodeId);
    if (!node) {
      diagnostics.push("Attempt for unknown captured node '" + attempt.nodeId + "' was skipped.");
      continue;
    }
    const attemptRoot = "nodes/" + attempt.nodeId + "/attempt-" + String(attempt.attempt).padStart(3, "0");
    const response = await readJson(storage, projectRoot, runId, attemptRoot + "/response.raw.txt", diagnostics);
    if (!isRecord(response) || response.status !== "success" || !Array.isArray(response.artifacts)) {
      diagnostics.push("Attempt '" + attemptRoot + "' does not contain a successful artifact response.");
      continue;
    }
    const declared = new Map<string, string>();
    if (Array.isArray(node.expectedOutputs)) {
      for (const output of node.expectedOutputs) {
        if (isRecord(output) && typeof output.name === "string" && typeof output.contract === "string") declared.set(output.name, output.contract);
      }
    }
    for (const artifact of response.artifacts) {
      if (!isRecord(artifact) || typeof artifact.name !== "string" || typeof artifact.contract !== "string") {
        diagnostics.push("Attempt '" + attemptRoot + "' contains a malformed artifact candidate.");
        continue;
      }
      const declaredContract = declared.get(artifact.name);
      const capturedSchema = contracts[artifact.contract];
      let valid: boolean | null = null;
      let errors: string[] = [];
      if (!declaredContract || declaredContract !== artifact.contract) {
        diagnostics.push("Candidate '" + attempt.nodeId + "." + artifact.name + "' does not match a captured expected output contract.");
        errors = ["Candidate is not declared with this contract in the captured node definition."];
      } else if (capturedSchema === undefined) {
        diagnostics.push("Captured schema '" + artifact.contract + "' is unavailable.");
        errors = ["Captured JSON Schema is unavailable."];
      } else {
        try {
          const validator = new Ajv2020({ strict: false }).compile(capturedSchema as AnySchema);
          valid = (await validator(artifact.data)) === true;
          if (!valid) errors = (validator.errors ?? []).map((error) => (error.instancePath || "/") + " " + (error.message ?? "is invalid"));
        } catch (error) {
          diagnostics.push("Captured schema '" + artifact.contract + "' cannot be compiled: " + (error instanceof Error ? error.message : String(error)));
          errors = ["Captured JSON Schema could not be compiled."];
        }
      }
      candidates.push({ nodeId: attempt.nodeId, attempt: attempt.attempt, name: artifact.name, contract: artifact.contract, valid, errors });
    }
  }

  for (const [contractId, capturedSchema] of Object.entries(contracts)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(contractId)) {
      diagnostics.push("Captured contract ID '" + contractId + "' is invalid; current-schema drift could not be checked.");
      continue;
    }
    if (contractId === "request.v1") {
      const capturedHash = hash(capturedSchema);
      const currentHash = hash(requestContractSchema);
      if (capturedHash !== currentHash) drift.push({ kind: "contract-schema", contract: contractId, capturedHash, currentHash });
      continue;
    }
    const contractPath = path.resolve(projectRoot, ".nodulus", "contracts", contractId + ".schema.json");
    try {
      const currentSchema: unknown = JSON.parse(await storage.readUtf8(contractPath)) as unknown;
      const capturedHash = hash(capturedSchema);
      const currentHash = hash(currentSchema);
      if (capturedHash !== currentHash) drift.push({ kind: "contract-schema", contract: contractId, capturedHash, currentHash });
    } catch {
      drift.push({ kind: "contract-schema", contract: contractId, capturedHash: hash(capturedSchema), currentHash: null });
    }
  }

  return {
    schemaVersion: 1,
    runId,
    mode: "schema-only",
    candidates,
    drift,
    skipped: { providerCalls: true, executableValidators: [...skippedValidators].sort() },
    diagnostics,
  };
}
