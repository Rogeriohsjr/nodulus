import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { IntakeRequest, IntakeResult } from "./intake-request.js";
import type { ArtifactValidator } from "./ports/artifact-validator.js";
import type { IntakeStorage } from "./ports/intake-storage.js";
import type { ProviderCallMetric, ProviderPort, ProviderUsage } from "./ports/provider.js";
import type { ProviderTelemetry } from "./ports/provider-telemetry.js";
import type { CapturedInputs, DefinitionContext, OutputArtifact } from "./execute-workflow.js";
import { resolveOutputReference } from "./workflow-mapping.js";
import type { GraphDefinition } from "./workflow-graph.js";
import { GraphStateWriter, type GraphRunCheckpoint, type GraphRunErrorDetails } from "./graph-state.js";
import { isGraphEvidenceWriteError, runGraphNode, type GraphNodeOutcome } from "./graph-node-runner.js";
import { createGraphStopReason } from "./ports/graph-stop.js";
import { NodulusError } from "./shared/nodulus-error.js";

type GraphContext = DefinitionContext & {
  schemaVersion: 2;
  engineVersion: "1.0.0";
  workflow: GraphDefinition;
  validatorHashes: Record<string, string>;
};
type GraphRunResponse = { runId: string; status: "success" | "needs_input" | "error"; result: unknown };
type ActiveNode = { nodeId: string; attempt: number; callId: string; startedAtMs: number; resources: string[]; controller: AbortController; promise: Promise<{ nodeId: string; outcome: GraphNodeOutcome }> };
type GraphFailure = { code: string; message: string; nodeId?: string; callId?: string; launch?: boolean | null; cause?: GraphRunErrorDetails["cause"] };

/** Execute a captured schema-2 graph through an isolated scheduler and node runner. */
export async function executeGraphWorkflow(
  request: IntakeRequest,
  intake: IntakeResult,
  provider: ProviderPort,
  storage: IntakeStorage,
  artifactValidator: ArtifactValidator,
): Promise<GraphRunResponse> {
  const runId = intake.runId;
  const contextText = await storage.readRunFile(request.projectRoot, runId, "context/definitions.json");
  const inputText = await storage.readRunFile(request.projectRoot, runId, "inputs.json");
  const referencesText = await storage.readRunFile(request.projectRoot, runId, "references.json");
  const context = JSON.parse(contextText) as GraphContext;
  const inputs = JSON.parse(inputText) as CapturedInputs;
  const checkpoint = JSON.parse(await storage.readRunFile(request.projectRoot, runId, "run.json")) as GraphRunCheckpoint;
  const events = await storage.readRunFile(request.projectRoot, runId, "events.jsonl");
  const writer = new GraphStateWriter(request.projectRoot, runId, storage, checkpoint, events);
  try {
    if (context.schemaVersion !== 2 || checkpoint.schemaVersion !== 2 || context.workflow.schemaVersion !== 2) {
      throw new NodulusError("RUN_STATE_INVALID", "The captured graph execution version is invalid.");
    }
    await verifyCapturedFiles(request.projectRoot, storage, context, contextText, inputText, referencesText, checkpoint);
  } catch (error) {
    return finishError(writer, runId, errorCode(error, "RUN_STATE_INVALID"), messageOf(error));
  }

  const acceptedOutputs = new Map<string, Map<string, OutputArtifact>>();
  const accepted = new Set<string>();
  const failed: GraphFailure[] = [];
  const pending = new Map<string, Record<string, unknown>>();
  const active = new Map<string, ActiveNode>();
  const resourcesHeld = new Set<string>();
  const uncertainNodes = new Set<string>();
  const cleanupUnverifiedNodes = new Set<string>();
  let admissionClosed = false;
  let initiatingFailure: GraphFailure | undefined;
  let provisionalFailure: GraphFailure | undefined;

  const nodes = context.nodes;
  const workflow = context.workflow;
  const declaredOutputs = nodes.map((node) => ({
    nodeId: node.id,
    outputs: node.expectedOutputs.map(({ name, contract }) => ({ name, contract })),
  }));
  const ancestors = dependencyAncestors(workflow);

  const abortActivePeers = (failedNodeId: string, code: string, message: string, callId?: string, launch?: boolean | null): void => {
    admissionClosed = true;
    initiatingFailure ??= provisionalFailure ?? { code, message, nodeId: failedNodeId, ...(callId ? { callId } : {}), ...(launch !== undefined ? { launch } : {}) };
    const reason = createGraphStopReason(`Graph node '${failedNodeId}' failed with ${code}: ${message}`);
    for (const node of active.values()) {
      if (node.nodeId !== failedNodeId && !node.controller.signal.aborted) node.controller.abort(reason);
    }
  };

  const orderedIds = (ids: Set<string>): string[] => workflow.nodes.filter((nodeId) => ids.has(nodeId));
  const recordUnresolved = async (outcome: Extract<GraphNodeOutcome, { status: "unresolved" }>): Promise<void> => {
    admissionClosed = true;
    uncertainNodes.add(outcome.nodeId);
    if (outcome.cause.code === "PROVIDER_TIMEOUT") {
      if (!initiatingFailure || provisionalFailure) {
        initiatingFailure = { code: outcome.cause.code, message: outcome.cause.message, nodeId: outcome.nodeId, callId: outcome.callId, launch: outcome.launch };
      }
      provisionalFailure = undefined;
      abortActivePeers(outcome.nodeId, outcome.cause.code, outcome.cause.message, outcome.callId, outcome.launch);
      failed.push({ code: outcome.cause.code, message: outcome.cause.message, nodeId: outcome.nodeId, callId: outcome.callId, launch: outcome.launch });
    } else if (!initiatingFailure) {
      initiatingFailure = provisionalFailure ?? {
        code: outcome.cause.code,
        message: outcome.cause.message,
        nodeId: outcome.nodeId,
        callId: outcome.callId,
        launch: outcome.launch,
      };
      provisionalFailure = undefined;
      failed.push({ ...initiatingFailure });
    }
    if (outcome.publicationFailure) {
      const storageFailure: GraphFailure = {
        code: "RUN_STORAGE_FAILED",
        message: outcome.publicationFailure.message,
        nodeId: outcome.nodeId,
        callId: outcome.callId,
        launch: outcome.launch,
        ...(initiatingFailure ? selectedFailureCause(initiatingFailure) : { cause: { code: outcome.cause.code, message: outcome.cause.message, nodeId: outcome.nodeId, callId: outcome.callId, launch: outcome.launch } }),
      };
      failed.push(storageFailure);
      abortActivePeers(outcome.nodeId, "RUN_STORAGE_FAILED", storageFailure.message, outcome.callId, outcome.launch);
      return;
    }
    const message = "The provider operation remained active after the bounded cleanup grace.";
    try {
      await writer.recordUnresolved(
        outcome.nodeId,
        outcome.attempt,
        outcome.callId,
        outcome.launch,
        outcome.operation,
        { code: "GRAPH_OPERATION_UNRESOLVED", message, cause: outcome.cause },
        orderedIds(uncertainNodes),
      );
    } catch (error) {
      const storageMessage = messageOf(error);
      writer.poison(error);
      failed.push({ code: "RUN_STORAGE_FAILED", message: storageMessage, nodeId: outcome.nodeId, callId: outcome.callId, launch: outcome.launch, ...(initiatingFailure ? selectedFailureCause(initiatingFailure) : { cause: { code: outcome.cause.code, message: outcome.cause.message, nodeId: outcome.nodeId, callId: outcome.callId, launch: outcome.launch } }) });
      abortActivePeers(outcome.nodeId, "RUN_STORAGE_FAILED", storageMessage, outcome.callId, outcome.launch);
    }
  };

  while (accepted.size < nodes.length && (active.size > 0 || !admissionClosed)) {
    let admitted = false;
    if (!admissionClosed) {
      for (const node of nodes) {
        if (accepted.has(node.id) || active.has(node.id)) continue;
        const dependencies = workflow.execution.dependsOn[node.id] ?? [];
        if (!dependencies.every((dependency) => accepted.has(dependency))) continue;
        if (active.size >= workflow.execution.maxConcurrency) break;
        const resourceKeys = resourceKeysFor(workflow, node.id);
        if (resourceConflicts(resourcesHeld, resourceKeys)) continue;

        const attempt = Number(checkpoint.graph.nodes[node.id]?.attempt ?? 0) + 1;
        const callId = randomUUID();
        const attemptRoot = `nodes/${node.id}/attempt-${String(attempt).padStart(3, "0")}`;
        try {
          await writer.admit(node.id, attempt, callId, attemptRoot);
          if (admissionClosed) {
            const reason = initiatingFailure;
            await writer.fail(node.id, reason?.code ?? "GRAPH_CANCELLED", reason?.message ?? "Graph admission closed before this reserved node launched.");
            break;
          }
          await writer.callStarted(node.id, attempt, callId);
          if (admissionClosed) {
            const reason = initiatingFailure;
            await writer.fail(node.id, reason?.code ?? "GRAPH_CANCELLED", reason?.message ?? "Graph admission closed before this reserved node launched.");
            break;
          }
        } catch (error) {
          const message = messageOf(error);
          failed.push({ code: "RUN_STORAGE_FAILED", message, nodeId: node.id });
          abortActivePeers(node.id, "RUN_STORAGE_FAILED", message);
          break;
        }
        for (const key of resourceKeys) resourcesHeld.add(key);
        const controller = new AbortController();
        const promise = runGraphNode({
          request,
          runId,
          context,
          inputs,
          node,
          attempt,
          callId,
          provider,
          storage,
          artifactValidator,
          signal: controller.signal,
          acceptedOutputs,
          ancestorIds: ancestors.get(node.id) ?? new Set<string>(),
          onRequiredWriteFailure: (error) => writer.poison(error),
          onStopIntent: (stopNodeId, stopCode, message) => {
            admissionClosed = true;
            if (stopCode === "PROVIDER_TIMEOUT" && !initiatingFailure) {
              provisionalFailure ??= { code: stopCode, message, nodeId: stopNodeId };
            }
            const reason = createGraphStopReason(`Graph node '${stopNodeId}' received a stop intent: ${message}`);
            for (const activeNode of active.values()) {
              if (activeNode.nodeId !== stopNodeId && !activeNode.controller.signal.aborted) activeNode.controller.abort(reason);
            }
          },
          onCallStarted: (callAttempt, nextCallId, operation, parentCallId) => writer.callStarted(node.id, callAttempt, nextCallId, operation, parentCallId),
          onCallCompleted: (callAttempt, completedCallId, operation, parentCallId, elapsedMs, launched) => {
            const measurement = providerMetric(provider, node.id, callAttempt, completedCallId, operation, elapsedMs, launched);
            return writer.recordCallCompletion(node.id, callAttempt, completedCallId, operation, launched,
              measurement.metric, parentCallId, measurement.diagnostic);
          },
        }).then((outcome) => ({ nodeId: node.id, outcome }), (error: unknown) => ({
          nodeId: node.id,
          outcome: {
            status: "error",
            nodeId: node.id,
            code: errorCode(error, "NODE_EXECUTION_FAILED"),
            message: messageOf(error),
            launch: safeLaunch(provider, callId),
            ...(isGraphEvidenceWriteError(error) ? { storageFailure: true as const } : {}),
          } as GraphNodeOutcome,
        }));
        active.set(node.id, { nodeId: node.id, attempt, callId, startedAtMs: performance.now(), resources: resourceKeys, controller, promise });
        admitted = true;
      }
    }

    if (active.size === 0) {
      if (admissionClosed) break;
      if (accepted.size !== nodes.length) {
        failed.push({ code: "GRAPH_SCHEDULER_STALLED", message: "No pending graph node is ready to run." });
        admissionClosed = true;
      }
      continue;
    }
    if (admitted && active.size < workflow.execution.maxConcurrency && !admissionClosed) continue;

    const completion = await Promise.race([...active.values()].map(({ promise }) => promise));
    const completed = active.get(completion.nodeId);
    if (completed) {
      active.delete(completion.nodeId);
      for (const resource of completed.resources) resourcesHeld.delete(resource);
    }
    if (completion.outcome.status === "error" && completion.outcome.storageFailure === true) {
      writer.poison(new NodulusError("RUN_STORAGE_FAILED", completion.outcome.message));
      failed.push({
        code: "RUN_STORAGE_FAILED",
        message: completion.outcome.message,
        nodeId: completion.nodeId,
        callId: completion.outcome.callId,
        launch: completion.outcome.launch,
      });
      abortActivePeers(completion.nodeId, "RUN_STORAGE_FAILED", completion.outcome.message);
      continue;
    }
    if (completion.outcome.status === "unresolved") {
      await recordUnresolved(completion.outcome);
      continue;
    }
    if (completion.outcome.status === "success") {
      try {
        await writer.accept(completion.nodeId, completion.outcome.accepted, workflow.nodes);
        accepted.add(completion.nodeId);
        acceptedOutputs.set(completion.nodeId, new Map(completion.outcome.artifacts.map((artifact) => [artifact.name, structuredClone(artifact)])));
      } catch (error) {
        const message = messageOf(error);
        failed.push({ code: "RUN_STORAGE_FAILED", message, nodeId: completion.nodeId, callId: completion.outcome.callId });
        abortActivePeers(completion.nodeId, "RUN_STORAGE_FAILED", message);
      }
    } else if (completion.outcome.status === "needs_input") {
      pending.set(completion.nodeId, completion.outcome.request);
      admissionClosed = true;
      try { await writer.closeAdmission(); }
      catch (error) {
        const message = messageOf(error);
        failed.push({ code: "RUN_STORAGE_FAILED", message, nodeId: completion.nodeId });
        abortActivePeers(completion.nodeId, "RUN_STORAGE_FAILED", message);
      }
    } else {
      if (provisionalFailure && (completion.outcome.preemptedByPhysicalFailure || completion.nodeId === provisionalFailure.nodeId)) {
        initiatingFailure = {
          code: completion.outcome.code,
          message: completion.outcome.message,
          nodeId: completion.nodeId,
          callId: completion.outcome.callId,
          launch: completion.outcome.launch,
        };
        provisionalFailure = undefined;
      }
      failed.push({
        code: completion.outcome.code,
        message: completion.outcome.message,
        nodeId: completion.nodeId,
        callId: completion.outcome.callId,
        launch: completion.outcome.launch,
      });
      abortActivePeers(completion.nodeId, completion.outcome.code, completion.outcome.message, completion.outcome.callId, completion.outcome.launch);
      try {
        if (completion.outcome.cleanupUnverified) {
          cleanupUnverifiedNodes.add(completion.nodeId);
          await writer.recordCleanupUnverified(
            completion.nodeId,
            completion.outcome.callId,
            completion.outcome.launch,
            completion.outcome.code,
            completion.outcome.message,
            completion.outcome.cleanupUnverified,
            orderedIds(cleanupUnverifiedNodes),
          );
        } else await writer.fail(completion.nodeId, completion.outcome.code, completion.outcome.message);
      }
      catch (error) {
        const message = messageOf(error);
        failed.push({ code: "RUN_STORAGE_FAILED", message, nodeId: completion.nodeId });
        abortActivePeers(completion.nodeId, "RUN_STORAGE_FAILED", message);
      }
    }
  }

  // Stop admission on the first terminal outcome, but retain accepted sibling work while it drains.
  while (active.size > 0) {
    const completion = await Promise.race([...active.values()].map(({ promise }) => promise));
    const completed = active.get(completion.nodeId);
    if (completed) {
      active.delete(completion.nodeId);
      for (const resource of completed.resources) resourcesHeld.delete(resource);
    }
    if (completion.outcome.status === "error" && completion.outcome.storageFailure === true) {
      writer.poison(new NodulusError("RUN_STORAGE_FAILED", completion.outcome.message));
      failed.push({
        code: "RUN_STORAGE_FAILED",
        message: completion.outcome.message,
        nodeId: completion.nodeId,
        callId: completion.outcome.callId,
        launch: completion.outcome.launch,
      });
      abortActivePeers(completion.nodeId, "RUN_STORAGE_FAILED", completion.outcome.message);
      continue;
    }
    if (completion.outcome.status === "unresolved") {
      await recordUnresolved(completion.outcome);
      continue;
    }
    try {
      if (completion.outcome.status === "success") {
        await writer.accept(completion.nodeId, completion.outcome.accepted, workflow.nodes);
        accepted.add(completion.nodeId);
        acceptedOutputs.set(completion.nodeId, new Map(completion.outcome.artifacts.map((artifact) => [artifact.name, structuredClone(artifact)])));
      } else if (completion.outcome.status === "needs_input") {
        pending.set(completion.nodeId, completion.outcome.request);
      } else {
        if (provisionalFailure && (completion.outcome.preemptedByPhysicalFailure || completion.nodeId === provisionalFailure.nodeId)) {
          initiatingFailure = {
            code: completion.outcome.code,
            message: completion.outcome.message,
            nodeId: completion.nodeId,
            callId: completion.outcome.callId,
            launch: completion.outcome.launch,
          };
          provisionalFailure = undefined;
        }
        failed.push({
          code: completion.outcome.code,
          message: completion.outcome.message,
          nodeId: completion.nodeId,
          callId: completion.outcome.callId,
          launch: completion.outcome.launch,
        });
        abortActivePeers(completion.nodeId, completion.outcome.code, completion.outcome.message, completion.outcome.callId, completion.outcome.launch);
        if (completion.outcome.cleanupUnverified) {
          cleanupUnverifiedNodes.add(completion.nodeId);
          await writer.recordCleanupUnverified(
            completion.nodeId,
            completion.outcome.callId,
            completion.outcome.launch,
            completion.outcome.code,
            completion.outcome.message,
            completion.outcome.cleanupUnverified,
            orderedIds(cleanupUnverifiedNodes),
          );
        } else await writer.fail(completion.nodeId, completion.outcome.code, completion.outcome.message);
      }
    } catch (error) {
      writer.poison(error);
      const message = messageOf(error);
      failed.push({ code: "RUN_STORAGE_FAILED", message, nodeId: completion.nodeId });
      abortActivePeers(completion.nodeId, "RUN_STORAGE_FAILED", message);
    }
  }

  if (failed.length > 0) {
    const storageFailure = failed.find((failure) => failure.code === "RUN_STORAGE_FAILED");
    const terminal = storageFailure ?? initiatingFailure ?? failed[0];
    return finishError(writer, runId, terminal?.code ?? "GRAPH_EXECUTION_FAILED", terminal?.message ?? "Graph execution failed.", {
      ...(terminal?.nodeId ? { nodeId: terminal.nodeId } : {}),
      ...(terminal?.callId ? { callId: terminal.callId } : {}),
      ...(terminal?.launch !== undefined ? { launch: terminal.launch } : {}),
      ...(uncertainNodes.size > 0 || cleanupUnverifiedNodes.size > 0 ? { recoveryRequired: true as const } : {}),
      ...(uncertainNodes.size > 0 ? { uncertainNodeIds: orderedIds(uncertainNodes) } : {}),
      ...(cleanupUnverifiedNodes.size > 0 ? { cleanupUnverifiedNodeIds: orderedIds(cleanupUnverifiedNodes) } : {}),
      ...(terminal?.cause ? { cause: terminal.cause } : storageFailure && initiatingFailure ? selectedFailureCause(initiatingFailure) : {}),
    });
  }
  if (pending.size > 0) {
    const requests = workflow.nodes.flatMap((nodeId) => pending.has(nodeId) ? [pending.get(nodeId)!] : []);
    try { await writer.pause(requests); }
    catch (error) { return finishError(writer, runId, "RUN_STORAGE_FAILED", messageOf(error)); }
    const first = requests[0];
    return { runId, status: "needs_input", result: { request: first, requests } };
  }
  if (accepted.size !== nodes.length) return finishError(writer, runId, "GRAPH_INCOMPLETE", "Graph completed without accepting every declared node.");

  const artifacts = workflow.outputs.map((alias) => {
    const resolution = resolveOutputReference(alias.from, declaredOutputs);
    if (resolution.status !== "resolved") throw new NodulusError("RUN_STATE_INVALID", `Captured workflow output '${alias.name}' no longer resolves.`);
    const artifact = acceptedOutputs.get(resolution.nodeId)?.get(resolution.outputName);
    if (!artifact || artifact.contract !== alias.contract) throw new NodulusError("RUN_STATE_INVALID", `Accepted output '${alias.from}' is unavailable.`);
    return { name: alias.name, contract: alias.contract, data: structuredClone(artifact.data) };
  });
  const result = { artifacts };
  try {
    await writer.finishSuccess(result, { "outputs.json": json(artifacts) });
  } catch (error) {
    return finishError(writer, runId, "RUN_STORAGE_FAILED", messageOf(error));
  }
  return { runId, status: "success", result };
}

async function verifyCapturedFiles(
  projectRoot: string,
  storage: IntakeStorage,
  context: GraphContext,
  definitionsText: string,
  inputsText: string,
  referencesText: string,
  checkpoint: GraphRunCheckpoint,
): Promise<void> {
  const captured = checkpoint.graph.captured;
  if (captured.definitionsSha256 !== hash(definitionsText) ||
      captured.inputsSha256 !== hash(inputsText) || captured.referencesSha256 !== hash(referencesText)) {
    throw new NodulusError("RUN_STATE_INVALID", "Captured graph intake files do not match their saved hashes.");
  }
  const pricingHash = captured.pricingSha256;
  if (typeof pricingHash === "string" && pricingHash !== hash(await storage.readRunFile(projectRoot, checkpoint.runId, "pricing.json"))) {
    throw new NodulusError("RUN_STATE_INVALID", "Captured graph pricing data does not match its saved hash.");
  }
  for (const [relative, expectedHash] of Object.entries(context.validatorHashes)) {
    const absolute = path.resolve(projectRoot, relative);
    const contents = await storage.readUtf8(absolute);
    if (hash(contents) !== expectedHash) throw new NodulusError("CONFIGURATION_INVALID", `Captured validator '${relative}' has changed since intake.`);
  }
}

function dependencyAncestors(workflow: GraphDefinition): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const visit = (nodeId: string): Set<string> => {
    const existing = result.get(nodeId);
    if (existing) return existing;
    const ancestors = new Set<string>();
    for (const predecessor of workflow.execution.dependsOn[nodeId] ?? []) {
      ancestors.add(predecessor);
      for (const ancestor of visit(predecessor)) ancestors.add(ancestor);
    }
    result.set(nodeId, ancestors);
    return ancestors;
  };
  for (const nodeId of workflow.nodes) visit(nodeId);
  return result;
}

function resourceKeysFor(workflow: GraphDefinition, nodeId: string): string[] {
  const resources = workflow.execution.resources;
  if (!resources || !Object.hasOwn(resources, nodeId)) return ["workspace"];
  return resources[nodeId] ?? ["workspace"];
}

function resourceConflicts(held: Set<string>, candidate: string[]): boolean {
  if (candidate.includes("workspace") && held.size > 0) return true;
  if (held.has("workspace") && candidate.length > 0) return true;
  return candidate.some((key) => held.has(key));
}

type ProviderMetricCapture = { metric: ProviderCallMetric; diagnostic?: string };

function providerMetric(provider: ProviderPort, nodeId: string, attempt: number, callId: string, operation: "invoke" | "repair_response", elapsedMs: number, launched: boolean | null): ProviderMetricCapture {
  const safeMetric: ProviderCallMetric = { nodeId, attempt, usage: null, elapsedMs, callId, operation, launched };
  try {
    const rawTelemetry = provider.telemetryForCall?.(callId) ?? null;
    if (rawTelemetry === null) return { metric: safeMetric };
    const serializedTelemetry = JSON.stringify(rawTelemetry);
    if (typeof serializedTelemetry !== "string") throw new Error("Call-keyed telemetry did not produce a JSON value.");
    const telemetry = JSON.parse(serializedTelemetry) as ProviderTelemetry;
    const normalizedUsage: ProviderUsage = {
      inputTokens: finiteOrNull(telemetry.normalized.inputTokens),
      outputTokens: finiteOrNull(telemetry.normalized.outputTokens),
      cacheReadTokens: telemetry.coverage === "complete" ? finiteOrNull(telemetry.reported.cacheReadTokens) : null,
      costUsd: telemetry.coverage === "complete" ? finiteOrNull(telemetry.reported.costUsd) : null,
    };
    const usage = Object.values(normalizedUsage).every((value) => value === null) ? null : normalizedUsage;
    return { metric: { ...safeMetric, usage, telemetry } };
  } catch (error) {
    return {
      metric: safeMetric,
      diagnostic: `Optional graph measurement failed for call '${callId}': ${safeMeasurementError(error)}`,
    };
  }
}
function finiteOrNull(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function safeMeasurementError(error: unknown): string {
  try { return (error instanceof Error ? error.message : String(error)).slice(0, 500); }
  catch { return "Measurement error could not be described safely."; }
}

async function finishError(writer: GraphStateWriter, runId: string, code: string, message: string, details?: GraphRunErrorDetails): Promise<GraphRunResponse> {
  let resultCode = code;
  let resultMessage = message;
  let resultDetails = details;
  try { await writer.finishError(code, message, details); }
  catch (error) {
    resultCode = "RUN_STORAGE_FAILED";
    resultMessage = `Could not persist the terminal graph result: ${messageOf(error)}`;
    const cause = details?.cause ?? (code === "RUN_STORAGE_FAILED" ? undefined : {
      code,
      message,
      ...(details?.nodeId ? { nodeId: details.nodeId } : {}),
      ...(details?.callId ? { callId: details.callId } : {}),
      ...(details?.launch !== undefined ? { launch: details.launch } : {}),
    });
    resultDetails = { ...details, ...(cause ? { cause } : {}) };
  }
  return {
    runId,
    status: "error",
    result: { error: {
      code: resultCode,
      message: resultMessage,
      ...(resultDetails?.nodeId ? { nodeId: resultDetails.nodeId } : {}),
      ...(resultDetails?.callId ? { callId: resultDetails.callId } : {}),
      ...(resultDetails?.launch !== undefined ? { launch: resultDetails.launch } : {}),
      ...(resultDetails?.recoveryRequired ? { recoveryRequired: true } : {}),
      ...(resultDetails?.uncertainNodeIds && resultDetails.uncertainNodeIds.length > 0 ? { uncertainNodeIds: [...resultDetails.uncertainNodeIds] } : {}),
      ...(resultDetails?.cleanupUnverifiedNodeIds && resultDetails.cleanupUnverifiedNodeIds.length > 0 ? { cleanupUnverifiedNodeIds: [...resultDetails.cleanupUnverifiedNodeIds] } : {}),
      ...(resultDetails?.cause ? { cause: { ...resultDetails.cause } } : {}),
    } },
  };
}
function safeLaunch(provider: ProviderPort, callId: string): boolean | null {
  try { return provider.launchForCall?.(callId) ?? null; }
  catch { return null; }
}
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function errorCode(error: unknown, fallback: string): string {
  return error instanceof NodulusError ? error.code : fallback;
}
function failureCause(failure: GraphFailure): NonNullable<GraphRunErrorDetails["cause"]> {
  return {
    code: failure.code,
    message: failure.message,
    ...(failure.nodeId ? { nodeId: failure.nodeId } : {}),
    ...(failure.callId ? { callId: failure.callId } : {}),
    ...(failure.launch !== undefined ? { launch: failure.launch } : {}),
  };
}
function selectedFailureCause(failure: GraphFailure): { cause?: GraphRunErrorDetails["cause"] } {
  if (failure.code === "RUN_STORAGE_FAILED") return failure.cause ? { cause: failure.cause } : {};
  return { cause: failureCause(failure) };
}
