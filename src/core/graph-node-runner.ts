import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import type { IntakeRequest } from "./intake-request.js";
import type { ArtifactValidator } from "./ports/artifact-validator.js";
import type { IntakeStorage, RunFiles } from "./ports/intake-storage.js";
import type { ProviderPort, ProviderInvocation } from "./ports/provider.js";
import type { CapturedInputs, DefinitionContext, Node, OutputArtifact } from "./execute-workflow.js";
import { buildPrompt, parseProviderOutcome, resolveMappedInputs, validateOutputSet, validateValidatorVerdict } from "./execute-workflow.js";
import type { GraphAcceptedRecord } from "./graph-state.js";
import { createGraphProfileTimeoutReason, graphProfileTimeoutError, graphStopError } from "./ports/graph-stop.js";
import { copyPhysicalFailureEvidence, getPhysicalFailureEvidence } from "./ports/physical-process.js";
import { NodulusError } from "./shared/nodulus-error.js";

export type GraphNodeSuccess = {
  status: "success";
  nodeId: string;
  attempt: number;
  callId: string;
  launch: boolean | null;
  accepted: GraphAcceptedRecord;
  artifacts: OutputArtifact[];
};
export type GraphNodePause = { status: "needs_input"; nodeId: string; callId: string; launch: boolean | null; request: Record<string, unknown> };
export type GraphNodeFailure = { status: "error"; nodeId: string; callId: string; code: string; message: string; launch: boolean | null; storageFailure?: true };
export type GraphNodeOutcome = GraphNodeSuccess | GraphNodePause | GraphNodeFailure;

class GraphEvidenceWriteError extends NodulusError {
  constructor(message: string) {
    super("RUN_STORAGE_FAILED", message);
  }
}

type ProfileOperationSignal = { signal: AbortSignal; deadlineError: () => NodulusError | undefined; dispose: () => void };

function profileTimeoutMs(profile: Record<string, unknown>): number {
  const value = profile.timeoutMs;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(value, 600_000)) : 600_000;
}

function createProfileOperationSignal(parent: AbortSignal, timeoutMs: number, operation: "availability" | "invoke" | "response-only repair"): ProfileOperationSignal {
  const controller = new AbortController();
  const deadlineAt = performance.now() + timeoutMs;
  const reason = createGraphProfileTimeoutReason(`Provider ${operation} exceeded its captured profile timeout of ${timeoutMs} ms.`);
  const onParentAbort = (): void => controller.abort(parent.reason);
  if (parent.aborted) onParentAbort();
  else parent.addEventListener("abort", onParentAbort, { once: true });
  const expire = (): void => { if (!controller.signal.aborted) controller.abort(reason); };
  const timer = setTimeout(expire, timeoutMs);
  return {
    signal: controller.signal,
    deadlineError: () => {
      if (!controller.signal.aborted && performance.now() >= deadlineAt) expire();
      return graphProfileTimeoutError(controller.signal);
    },
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", onParentAbort);
    },
  };
}

export function isGraphEvidenceWriteError(error: unknown): error is GraphEvidenceWriteError {
  return error instanceof GraphEvidenceWriteError;
}

export type GraphNodeRunnerContext = {
  request: IntakeRequest;
  runId: string;
  context: DefinitionContext & { validatorHashes?: Record<string, string> };
  inputs: CapturedInputs;
  node: Node;
  attempt: number;
  callId: string;
  provider: ProviderPort;
  storage: IntakeStorage;
  artifactValidator: ArtifactValidator;
  signal: AbortSignal;
  acceptedOutputs: Map<string, Map<string, OutputArtifact>>;
  ancestorIds: Set<string>;
  onRequiredWriteFailure?: (error: Error) => void;
  onCallStarted?: (attempt: number, callId: string, operation: "invoke" | "repair_response", parentCallId?: string) => Promise<void>;
  onCallCompleted?: (attempt: number, callId: string, operation: "invoke" | "repair_response", parentCallId: string | undefined, elapsedMs: number, launched: boolean | null) => Promise<void>;
};

export async function runGraphNode(args: GraphNodeRunnerContext): Promise<GraphNodeOutcome> {
  const { request, runId, context, inputs, node, attempt, callId: initialCallId, provider, storage, artifactValidator } = args;
  let currentAttempt = attempt;
  let currentCallId = initialCallId;
  let currentOperation: "invoke" | "repair_response" = "invoke";
  let parentCallId: string | undefined;
  let launch: boolean | null = null;
  let raw = "";
  let currentAttemptRoot = `nodes/${node.id}/attempt-${String(attempt).padStart(3, "0")}`;
  try {
    const ancestors = context.nodes.filter((candidate) => args.ancestorIds.has(candidate.id));
    const mapped = resolveMappedInputs(node, inputs.request, inputs.callerInputs ?? {}, ancestors, args.acceptedOutputs, context.contracts);
    if (!mapped.valid) throw Object.assign(new Error(mapped.message), { code: mapped.code });
    const mappedInputs = structuredClone(mapped.values);
    const profile = structuredClone(context.providerProfiles[node.providerProfile] ?? {});
    const operationTimeoutMs = profileTimeoutMs(profile);
    const nodeInstructions = inputs.instructions.filter((item) =>
      node.instructions.some((instruction) => path.resolve(request.projectRoot, instruction) === path.resolve(item.path)),
    );
    const prompt = buildPrompt(context, node, nodeInstructions, mappedInputs, {});
    let issue: { code: string; errors: string[]; stderr?: string } | undefined;
    let parsed: ReturnType<typeof parseProviderOutcome> | undefined;
    let validArtifacts: OutputArtifact[] | undefined;
    let validatorResults: Array<{ name: string; valid: boolean; errors: string[] }> = [];
    let repairCount = 0;
    let previousRaw = "";

    while (true) {
      currentAttemptRoot = `nodes/${node.id}/attempt-${String(currentAttempt).padStart(3, "0")}`;
      const invocation: ProviderInvocation = {
        executionMode: "graph",
        call: { callId: currentCallId, attempt: currentAttempt, operation: currentOperation, ...(parentCallId ? { parentCallId } : {}) },
        providerProfileId: node.providerProfile,
        runId,
        attempt,
        workflow: context.workflow.id,
        nodeId: node.id,
        prompt,
        inputs: structuredClone(mappedInputs),
        providerProfile: structuredClone(profile),
        signal: args.signal,
      };
      const invocationRecord = {
        callId: currentCallId,
        ...(parentCallId ? { parentCallId } : {}),
        operation: currentOperation,
        runId,
        workflow: context.workflow.id,
        nodeId: node.id,
        attempt: currentAttempt,
        invocationAttempt: attempt,
        startedAt: new Date().toISOString(),
        providerProfile: node.providerProfile,
        resolvedProviderProfile: structuredClone(profile),
        inputs: structuredClone(mappedInputs),
        inputMappings: structuredClone(node.inputs),
        expectedOutputs: structuredClone(node.expectedOutputs),
        validator: node.expectedOutputs.find((output) => output.validator)?.validator,
        ...(currentOperation === "repair_response" ? { previousAttempt: currentAttempt - 1, previousResponse: previousRaw, validationErrors: issue?.errors ?? [] } : {}),
      };
      await writeRequiredEvidence(storage, request.projectRoot, runId, {
        [`${currentAttemptRoot}/invocation.json`]: json(invocationRecord),
        [`${currentAttemptRoot}/prompt.md`]: prompt,
        [`${currentAttemptRoot}/stderr.log`]: "",
      }, args.onRequiredWriteFailure);
      if (currentOperation === "repair_response") await startCall(args, currentAttempt, currentCallId, currentOperation, parentCallId);

      const startedAt = performance.now();
      raw = "";
      launch = null;
      let callError: unknown;
      let callFailed = false;
      let providerCallEntered = false;
      let providerOperationSignal: AbortSignal | undefined;
      let providerOperationDeadlineError: (() => NodulusError | undefined) | undefined;
      try {
        if (currentOperation === "invoke") {
          const stoppedBeforeReadiness = graphStopError(args.signal);
          if (stoppedBeforeReadiness) {
            launch = false;
            throw stoppedBeforeReadiness;
          }
          if (provider.isAvailable) {
            launch = false;
            const availability = createProfileOperationSignal(args.signal, operationTimeoutMs, "availability");
            providerOperationSignal = availability.signal;
            providerOperationDeadlineError = availability.deadlineError;
            let available: boolean;
            try {
              const profileTimeout = availability.deadlineError();
              if (profileTimeout) throw profileTimeout;
              const stoppedBeforeProbe = graphStopError(availability.signal);
              if (stoppedBeforeProbe) throw stoppedBeforeProbe;
              available = await provider.isAvailable(structuredClone(profile), { signal: availability.signal, executionMode: "graph" });
              const profileTimeoutAfterProbe = availability.deadlineError();
              if (profileTimeoutAfterProbe) throw profileTimeoutAfterProbe;
              const stoppedAfterReadiness = graphStopError(availability.signal);
              if (stoppedAfterReadiness) throw stoppedAfterReadiness;
            } finally { availability.dispose(); }
            if (!available) throw Object.assign(new Error(`Provider profile '${node.providerProfile}' is unavailable.`), { code: "PROVIDER_UNAVAILABLE" });
          }
          const stoppedBeforeInvoke = graphStopError(args.signal);
          if (stoppedBeforeInvoke) {
            launch = false;
            throw stoppedBeforeInvoke;
          }
          launch = null;
          const operationSignal = createProfileOperationSignal(args.signal, operationTimeoutMs, "invoke");
          providerOperationSignal = operationSignal.signal;
          providerOperationDeadlineError = operationSignal.deadlineError;
          try {
            const profileTimeout = operationSignal.deadlineError();
            if (profileTimeout) { launch = false; throw profileTimeout; }
            const stoppedBeforeProviderCall = graphStopError(operationSignal.signal);
            if (stoppedBeforeProviderCall) { launch = false; throw stoppedBeforeProviderCall; }
            providerCallEntered = true;
            raw = await provider.invoke({ ...invocation, signal: operationSignal.signal });
            const profileTimeoutAfterCall = operationSignal.deadlineError();
            if (profileTimeoutAfterCall) throw profileTimeoutAfterCall;
            const stopped = graphStopError(operationSignal.signal);
            if (stopped) throw stopped;
          } finally { operationSignal.dispose(); }
        } else {
          if (!provider.repairResponse) throw new NodulusError("RESPONSE_REPAIR_UNAVAILABLE", "Safe response-only repair is unavailable; the full provider action will not be replayed.");
          const stoppedBeforeRepair = graphStopError(args.signal);
          if (stoppedBeforeRepair) throw stoppedBeforeRepair;
          launch = null;
          const operationSignal = createProfileOperationSignal(args.signal, operationTimeoutMs, "response-only repair");
          providerOperationSignal = operationSignal.signal;
          providerOperationDeadlineError = operationSignal.deadlineError;
          try {
            const profileTimeout = operationSignal.deadlineError();
            if (profileTimeout) { launch = false; throw profileTimeout; }
            const stoppedBeforeProviderCall = graphStopError(operationSignal.signal);
            if (stoppedBeforeProviderCall) { launch = false; throw stoppedBeforeProviderCall; }
            providerCallEntered = true;
            raw = await provider.repairResponse({ ...invocation, signal: operationSignal.signal }, previousRaw, issue?.errors ?? []);
            const profileTimeoutAfterCall = operationSignal.deadlineError();
            if (profileTimeoutAfterCall) throw profileTimeoutAfterCall;
            const stopped = graphStopError(operationSignal.signal);
            if (stopped) throw stopped;
          } finally { operationSignal.dispose(); }
        }
        const stopped = graphStopError(args.signal);
        if (stopped) throw stopped;
        if (typeof raw !== "string") throw Object.assign(new Error("Provider returned a non-string response."), { code: "PROVIDER_FAILURE" });
      } catch (error) {
        callFailed = true;
        const profileTimeout = providerOperationDeadlineError?.() ??
          (providerOperationSignal === undefined ? undefined : graphProfileTimeoutError(providerOperationSignal));
        const physicalFailure = getPhysicalFailureEvidence(error);
        const earlierPhysicalFailure = physicalFailure !== undefined && physicalFailure.terminationCause !== "cancelled";
        if (earlierPhysicalFailure) callError = error;
        else if (profileTimeout && (!isRecord(error) || error.code !== "PROVIDER_TIMEOUT")) {
          callError = copyPhysicalFailureEvidence(profileTimeout, error);
        } else callError = error;
        if (providerCallEntered) launch ??= safeLaunch(provider, currentCallId);
      }

      if (callFailed) {
        const errorMessage = messageOf(callError);
        const errorCode = isRecord(callError) && typeof callError.code === "string"
          ? callError.code
          : currentOperation === "repair_response" ? "RESPONSE_REPAIR_FAILED" : "PROVIDER_FAILURE";
        await writeRequiredEvidence(storage, request.projectRoot, runId, {
          [`${currentAttemptRoot}/response.raw.txt`]: "",
          [`${currentAttemptRoot}/stderr.log`]: errorMessage,
        }, args.onRequiredWriteFailure);
        await completeCall(args, currentAttempt, currentCallId, currentOperation, parentCallId, startedAt, launch);
        return await rejectAttempt(args, currentAttemptRoot, currentCallId, currentAttempt, launch, errorCode, errorMessage, "");
      }

      launch = safeLaunch(provider, currentCallId);
      await writeRequiredEvidence(storage, request.projectRoot, runId, { [`${currentAttemptRoot}/response.raw.txt`]: raw }, args.onRequiredWriteFailure);
      await completeCall(args, currentAttempt, currentCallId, currentOperation, parentCallId, startedAt, launch);
      const stopped = graphStopError(args.signal);
      if (stopped) return await rejectAttempt(args, currentAttemptRoot, currentCallId, currentAttempt, launch, stopped.code, stopped.message, raw);

      parsed = parseProviderOutcome(raw);
      if (!parsed.valid) {
        issue = { code: parsed.code, errors: parsed.errors };
      } else if (currentOperation === "repair_response" && parsed.outcome.status !== "success") {
        return await rejectAttempt(args, currentAttemptRoot, currentCallId, currentAttempt, launch, "INVALID_REPAIRED_OUTCOME", "A response-only correction must return a success artifact outcome.", raw);
      } else if (parsed.outcome.status === "error") {
        return await rejectAttempt(args, currentAttemptRoot, currentCallId, currentAttempt, launch, parsed.outcome.error.code, parsed.outcome.error.message, raw, { valid: true, outcome: "error", errors: [] });
      } else if (parsed.outcome.status === "needs_input") {
        const requestId = randomUUID();
        try { new Ajv2020({ strict: false }).compile(parsed.outcome.request.answerContract as AnySchema); }
        catch (error) { return await rejectAttempt(args, currentAttemptRoot, currentCallId, currentAttempt, launch, "INVALID_ANSWER_CONTRACT", messageOf(error), raw); }
        const pending = { ...parsed.outcome.request, id: requestId, nodeId: node.id, attempt: currentAttempt, callId: currentCallId };
        const validation = { valid: true, outcome: "needs_input", errors: [] };
        await writeRequiredEvidence(storage, request.projectRoot, runId, {
          [`${currentAttemptRoot}/validation.json`]: json(validation),
          [`${currentAttemptRoot}/result.json`]: json({ status: "needs_input", request: pending }),
          [`pending/${requestId}.json`]: json(pending),
        }, args.onRequiredWriteFailure);
        return { status: "needs_input", nodeId: node.id, callId: currentCallId, launch, request: pending };
      } else {
        const outputCheck = validateOutputSet(parsed.outcome.artifacts, node.expectedOutputs, context.contracts);
        if (!outputCheck.valid) issue = { code: outputCheck.code, errors: outputCheck.errors };
        else {
          validArtifacts = parsed.outcome.artifacts;
          validatorResults = [];
          issue = undefined;
          for (const artifact of validArtifacts) {
            const expected = node.expectedOutputs.find(({ name }) => name === artifact.name);
            if (!expected?.validator) continue;
            const scriptPath = path.resolve(request.projectRoot, expected.validator);
            const expectedHash = args.context.validatorHashes?.[expected.validator];
            let validatorContents: string;
            try { validatorContents = await storage.readUtf8(scriptPath); }
            catch (error) { return await rejectAttempt(args, currentAttemptRoot, currentCallId, currentAttempt, launch, "CONFIGURATION_INVALID", `Captured validator '${expected.validator}' could not be read: ${messageOf(error)}`, raw); }
            const stoppedBeforeValidator = graphStopError(args.signal);
            if (stoppedBeforeValidator) return await rejectAttempt(args, currentAttemptRoot, currentCallId, currentAttempt, launch, stoppedBeforeValidator.code, stoppedBeforeValidator.message, raw);
            if (!expectedHash || hash(validatorContents) !== expectedHash) {
              return await rejectAttempt(args, currentAttemptRoot, currentCallId, currentAttempt, launch, "CONFIGURATION_INVALID", `Captured validator '${expected.validator}' changed after intake.`, raw);
            }
            let processResult;
            try { processResult = await artifactValidator.execute(request.projectRoot, scriptPath, json(artifact.data), expected.validatorTimeoutMs ?? 5000, args.signal); }
            catch (error) { return await rejectAttempt(args, currentAttemptRoot, currentCallId, currentAttempt, launch, "VALIDATOR_EXECUTION_FAILED", messageOf(error), raw); }
            const stopped = graphStopError(args.signal);
            if (stopped) return await rejectAttempt(args, currentAttemptRoot, currentCallId, currentAttempt, launch, stopped.code, stopped.message, raw);
            if (processResult.timedOut) return await rejectAttempt(args, currentAttemptRoot, currentCallId, currentAttempt, launch, "VALIDATOR_TIMEOUT", `Validator '${expected.validator}' exceeded its timeout.`, raw, undefined, processResult.stderr);
            if (processResult.exitCode !== 0 || processResult.outputLimitExceeded) return await rejectAttempt(args, currentAttemptRoot, currentCallId, currentAttempt, launch, "VALIDATOR_EXECUTION_FAILED", `Validator '${expected.validator}' did not complete successfully.`, raw, undefined, processResult.stderr);
            let verdict: unknown;
            try { verdict = JSON.parse(processResult.stdout) as unknown; }
            catch { return await rejectAttempt(args, currentAttemptRoot, currentCallId, currentAttempt, launch, "VALIDATOR_INVALID_RESPONSE", "Validator stdout must be a JSON verdict.", raw, undefined, processResult.stderr); }
            const checked = validateValidatorVerdict(verdict);
            if (!checked.valid) return await rejectAttempt(args, currentAttemptRoot, currentCallId, currentAttempt, launch, "VALIDATOR_INVALID_RESPONSE", checked.errors.join("; "), raw, undefined, processResult.stderr);
            validatorResults.push({ name: artifact.name, valid: checked.validity === true, errors: checked.errors });
            if (!checked.validity) {
              issue = { code: "ARTIFACT_REJECTED", errors: checked.errors.length > 0 ? checked.errors : [`Validator '${expected.validator}' rejected artifact '${artifact.name}'.`], stderr: processResult.stderr };
              break;
            }
          }
        }
      }

      if (!issue) break;
      const stopBeforeRepair = graphStopError(args.signal);
      if (stopBeforeRepair) return await rejectAttempt(args, currentAttemptRoot, currentCallId, currentAttempt, launch, stopBeforeRepair.code, stopBeforeRepair.message, raw);
      const errorText = issue.errors.join("; ");
      await rejectAttempt(args, currentAttemptRoot, currentCallId, currentAttempt, launch, issue.code, errorText, raw,
        issue.code === "ARTIFACT_REJECTED" ? { valid: false, code: issue.code, errors: issue.errors } : undefined, issue.stderr);
      const capabilities = Array.isArray(profile.capabilities) ? profile.capabilities : [];
      if (!capabilities.includes("responseRepair") || !provider.repairResponse) {
        return { status: "error", nodeId: node.id, callId: currentCallId, code: "RESPONSE_REPAIR_UNAVAILABLE", message: "Safe response-only repair is unavailable; the full provider action will not be replayed.", launch };
      }
      if (repairCount >= 2) {
        return { status: "error", nodeId: node.id, callId: currentCallId, code: "REPAIR_EXHAUSTED", message: "The provider response remained invalid after two response-only repairs.", launch };
      }
      repairCount += 1;
      previousRaw = raw;
      parentCallId = currentCallId;
      currentCallId = randomUUID();
      currentAttempt += 1;
      currentOperation = "repair_response";
      validArtifacts = undefined;
      validatorResults = [];
    }

    if (!parsed?.valid || parsed.outcome.status !== "success" || !validArtifacts) {
      return { status: "error", nodeId: node.id, callId: currentCallId, code: "INVALID_REPAIRED_OUTCOME", message: "A response-only correction must return a success artifact outcome.", launch };
    }
    const acceptedAttemptRoot = `nodes/${node.id}/attempt-${String(currentAttempt).padStart(3, "0")}`;
    const validation = { valid: true, outcome: "success", validators: validatorResults, errors: [] };
    const result = { status: "success", artifacts: validArtifacts };
    const resultText = json(result);
    const validationText = json(validation);
    const responseRef = `${acceptedAttemptRoot}/response.raw.txt`;
    const resultRef = `${acceptedAttemptRoot}/result.json`;
    const validationRef = `${acceptedAttemptRoot}/validation.json`;
    const artifacts = validArtifacts.map((artifact) => {
      const ref = `nodes/${node.id}/artifacts/${artifact.name}.json`;
      return { name: artifact.name, contract: artifact.contract, ref, sha256: hash(json(artifact)) };
    });
    const files: RunFiles = { [resultRef]: resultText, [validationRef]: validationText };
    for (const artifact of validArtifacts) files[`nodes/${node.id}/artifacts/${artifact.name}.json`] = json(artifact);
    await writeRequiredEvidence(storage, request.projectRoot, runId, files, args.onRequiredWriteFailure);
    const stopped = graphStopError(args.signal);
    if (stopped) return await rejectAttempt(args, acceptedAttemptRoot, currentCallId, currentAttempt, launch, stopped.code, stopped.message, raw);
    return {
      status: "success",
      nodeId: node.id,
      attempt: currentAttempt,
      callId: currentCallId,
      launch,
      artifacts: validArtifacts.map((artifact) => structuredClone(artifact)),
      accepted: { attempt: currentAttempt, callId: currentCallId, resultRef, resultSha256: hash(resultText), validationRef, validationSha256: hash(validationText), responseRef, responseSha256: hash(raw), artifacts },
    };
  } catch (error) {
    launch ??= safeLaunch(provider, currentCallId);
    if (isGraphEvidenceWriteError(error)) {
      return { status: "error", nodeId: node.id, callId: currentCallId, code: error.code, message: error.message, launch, storageFailure: true };
    }
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "PROVIDER_FAILURE";
    return await rejectAttempt(args, currentAttemptRoot, currentCallId, currentAttempt, launch, code, messageOf(error), raw);
  }
}

async function rejectAttempt(
  args: GraphNodeRunnerContext,
  attemptRoot: string,
  callId: string,
  attempt: number,
  launch: boolean | null,
  code: string,
  message: string,
  raw: string,
  validation?: unknown,
  stderr = "",
): Promise<GraphNodeFailure> {
  const validationValue = validation ?? { valid: false, code, errors: [message] };
  await writeRequiredEvidence(args.storage, args.request.projectRoot, args.runId, {
    [`${attemptRoot}/response.raw.txt`]: raw,
    [`${attemptRoot}/stderr.log`]: stderr || message,
    [`${attemptRoot}/validation.json`]: json(validationValue),
    [`${attemptRoot}/result.json`]: json({ status: "error", error: { code, message } }),
  }, args.onRequiredWriteFailure);
  return { status: "error", nodeId: args.node.id, callId, code, message, launch };
}

async function writeRequiredEvidence(
  storage: IntakeStorage,
  projectRoot: string,
  runId: string,
  files: RunFiles,
  onFailure?: (error: Error) => void,
): Promise<void> {
  try {
    await storage.writeRunFiles(projectRoot, runId, files);
  } catch (error) {
    const writeError = new GraphEvidenceWriteError(`Could not persist required graph node evidence: ${messageOf(error)}`);
    onFailure?.(writeError);
    throw writeError;
  }
}

async function startCall(
  args: GraphNodeRunnerContext,
  attempt: number,
  callId: string,
  operation: "invoke" | "repair_response",
  parentCallId?: string,
): Promise<void> {
  try { await args.onCallStarted?.(attempt, callId, operation, parentCallId); }
  catch (error) {
    const writeError = new GraphEvidenceWriteError(`Could not persist required graph call-start event: ${messageOf(error)}`);
    args.onRequiredWriteFailure?.(writeError);
    throw writeError;
  }
}

async function completeCall(
  args: GraphNodeRunnerContext,
  attempt: number,
  callId: string,
  operation: "invoke" | "repair_response",
  parentCallId: string | undefined,
  startedAt: number,
  launched: boolean | null,
): Promise<void> {
  try {
    await args.onCallCompleted?.(attempt, callId, operation, parentCallId, Math.max(0, performance.now() - startedAt), launched);
  } catch (error) {
    const writeError = new GraphEvidenceWriteError(`Could not persist required graph call-completion event: ${messageOf(error)}`);
    args.onRequiredWriteFailure?.(writeError);
    throw writeError;
  }
}

function safeLaunch(provider: ProviderPort, callId: string): boolean | null {
  try { return provider.launchForCall?.(callId) ?? null; }
  catch { return null; }
}
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
