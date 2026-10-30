import { fileURLToPath, pathToFileURL } from "node:url";

const publicApiPath = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const providerPath = fileURLToPath(new URL("../../dist/adapters/providers/default-provider-port.js", import.meta.url));
const { resumeWorkflow, runWorkflow } = await import(pathToFileURL(publicApiPath).href);
const { createDefaultProviderPort } = await import(pathToFileURL(providerPath).href);
const [operation, nonce, projectRoot, runId, requestId, answersPath] = process.argv.slice(2);
const protocol = "par-033-fresh-resume-driver-v1";
const maxEnvelopeBytes = 256_000;
const maxObservations = 64;
const observations = {
  availability: [],
  invocations: [],
  repairs: [],
  telemetry: [],
  launches: [],
  legacyUsage: 0,
  observationLimitExceeded: false,
};
const delegatedSettlements = [];

function record(target, value) {
  if (target.length >= maxObservations) {
    observations.observationLimitExceeded = true;
    return;
  }
  target.push(value);
}

function track(operationValue) {
  if (operationValue !== null && (typeof operationValue === "object" || typeof operationValue === "function")
    && "then" in operationValue && typeof operationValue.then === "function") {
    delegatedSettlements.push(Promise.resolve(operationValue).then(() => undefined, () => undefined));
  }
  return operationValue;
}

function describeError(error) {
  let message = "Non-Error rejection value.";
  let name = "Error";
  let code;
  if (error instanceof Error) {
    message = error.message;
    name = error.name;
    if (typeof error.code === "string") code = error.code.slice(0, 100);
  } else if (typeof error === "string") message = error;
  return { name: name.slice(0, 100), ...(code === undefined ? {} : { code }), message: message.slice(0, 1200) };
}

function capture(promise) {
  return Promise.resolve(promise).then(
    (result) => ({ kind: "result", result }),
    (error) => ({ kind: "error", error: describeError(error) }),
  );
}

function createObservedProvider() {
  const delegate = createDefaultProviderPort(projectRoot);
  return {
    invoke(invocation) {
      record(observations.invocations, {
        nodeId: invocation.nodeId,
        callId: typeof invocation.call?.callId === "string" ? invocation.call.callId : null,
        attempt: Number.isSafeInteger(invocation.call?.attempt) ? invocation.call.attempt : invocation.attempt,
        parentCallId: typeof invocation.call?.parentCallId === "string" ? invocation.call.parentCallId : null,
        answers: invocation.answers === undefined ? null : structuredClone(invocation.answers),
      });
      return track(delegate.invoke(invocation));
    },
    ...(delegate.isAvailable ? { isAvailable(profile, options) {
      record(observations.availability, typeof profile.model === "string" ? profile.model.slice(0, 200) : "unknown");
      return track(delegate.isAvailable(profile, options));
    } } : {}),
    ...(delegate.repairResponse ? { repairResponse(invocation, previousRawResponse, validationErrors) {
      record(observations.repairs, {
        nodeId: invocation.nodeId,
        callId: typeof invocation.call?.callId === "string" ? invocation.call.callId : null,
        attempt: Number.isSafeInteger(invocation.call?.attempt) ? invocation.call.attempt : invocation.attempt,
        parentCallId: typeof invocation.call?.parentCallId === "string" ? invocation.call.parentCallId : null,
      });
      return track(delegate.repairResponse(invocation, previousRawResponse, validationErrors));
    } } : {}),
    ...(delegate.telemetryForCall ? { telemetryForCall(callId) {
      record(observations.telemetry, typeof callId === "string" ? callId.slice(0, 200) : "unknown");
      return delegate.telemetryForCall(callId);
    } } : {}),
    ...(delegate.launchForCall ? { launchForCall(callId) {
      record(observations.launches, typeof callId === "string" ? callId.slice(0, 200) : "unknown");
      return delegate.launchForCall(callId);
    } } : {}),
    ...(delegate.usageForLastCall ? { usageForLastCall() {
      observations.legacyUsage += 1;
      return delegate.usageForLastCall();
    } } : {}),
  };
}

function validIdentity() {
  return typeof nonce === "string" && nonce.length >= 16 && typeof projectRoot === "string"
    && (operation === "initial" || (operation === "partial" || operation === "final")
      && typeof runId === "string" && typeof requestId === "string" && typeof answersPath === "string");
}

function emit(envelope, exitCode = 0) {
  let serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized, "utf8") > maxEnvelopeBytes) {
    serialized = JSON.stringify({ protocol, operation, nonce, ok: false, driverError: "The bounded result envelope exceeded its size limit." });
    process.exitCode = 1;
  } else if (exitCode !== 0) process.exitCode = exitCode;
  process.stdout.write(`${serialized}\n`);
}

async function main() {
  if (!validIdentity()) throw new Error("Invalid PAR-033 driver operation or identity arguments.");
  const provider = createObservedProvider();
  const publicPromise = operation === "initial"
    ? runWorkflow({
      projectRoot,
      cwd: projectRoot,
      workflow: "example",
      sources: [{ kind: "inline", text: "Resume the saved parallel graph without replaying its accepted seed." }],
    }, provider)
    : resumeWorkflow({
      projectRoot,
      runId,
      requestId,
      answers: JSON.parse(await (await import("node:fs/promises")).readFile(answersPath, "utf8")),
    }, provider);
  const outcome = await capture(publicPromise);
  const publicSettled = true;
  await Promise.all(delegatedSettlements);
  const delegatedSettled = true;
  emit({ protocol, operation, nonce, outcome, observations, settled: { public: publicSettled, delegated: delegatedSettled } });
}

try {
  await main();
} catch (error) {
  emit({ protocol, operation, nonce, ok: false, driverError: describeError(error) }, 1);
}
