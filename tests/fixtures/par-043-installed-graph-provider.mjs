import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const project = process.cwd();
const controlPath = path.join(project, ".nodulus", "fixtures", "par-043-control.json");
const control = JSON.parse(readFileSync(controlPath, "utf8"));
const allowedCalls = control.mode === "parallel-review"
  ? new Set(["prepare/1", "security/1", "quality/1", "join/1", "audit/1"])
  : control.mode === "questions"
    ? new Set(["alpha/1", "beta/1", "alpha/2", "beta/2", "join/1"])
    : new Set();

function append(relativePath, value) {
  const target = path.resolve(project, relativePath);
  const existingBytes = existsSync(target) ? statSync(target).size : 0;
  const line = `${JSON.stringify(value)}\n`;
  const lineBytes = Buffer.byteLength(line, "utf8");
  if (existingBytes + lineBytes > 64 * 1024) throw new Error("PAR-043 fixture event output exceeded its byte bound.");
  appendFileSync(target, line, "utf8");
}

function uniqueRecord(directory, name, value) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("PAR-043 fixture record name was unsafe.");
  const target = path.join(path.resolve(project, directory), `${name}.json`);
  writeFileSync(target, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
}

async function readStdin() {
  let input = "";
  let inputBytes = 0;
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    if (inputBytes + chunkBytes > 128 * 1024) throw new Error("PAR-043 fixture input exceeded its bound.");
    inputBytes += chunkBytes;
    input += chunk;
  }
  return input;
}

function requestFor(callId) {
  const runsRoot = path.join(project, ".nodulus", "runs");
  for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const requestPath = path.join(runsRoot, entry.name, "calls", callId, "request.json");
    try {
      const request = JSON.parse(readFileSync(requestPath, "utf8"));
      if (request.callId === callId) return request;
    } catch {
      // Continue across other saved runs and incomplete call directories.
    }
  }
  throw new Error("PAR-043 fixture could not find the captured provider request.");
}

function sectionObject(prompt, heading) {
  const header = `${heading}\n\n`;
  const offset = prompt.indexOf(header);
  if (offset < 0) return {};
  const body = prompt.slice(offset + header.length);
  const end = body.search(/\n\n## /);
  const value = JSON.parse(end < 0 ? body : body.slice(0, end));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`PAR-043 ${heading} must be an object.`);
  return value;
}

function requireRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`PAR-043 ${label} must be an object.`);
  return value;
}

function requireText(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`PAR-043 ${label} must be nonempty text.`);
  return value;
}

function question(nodeId) {
  const answerKey = `${nodeId}Approval`;
  return {
    status: "needs_input",
    request: {
      id: `provider-untrusted-${nodeId}`,
      questions: [{ id: answerKey, message: `Approve the ${nodeId} report.` }],
      answerContract: {
        type: "object",
        required: [answerKey],
        properties: { [answerKey]: { type: "boolean", const: true } },
        additionalProperties: false,
      },
    },
  };
}

function success(text) {
  return { status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text } }] };
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort(compareStrings);
  const orderedExpected = [...expected].sort(compareStrings);
  if (JSON.stringify(actual) !== JSON.stringify(orderedExpected)) throw new Error(`PAR-043 ${label} had unexpected keys.`);
}

function exampleOutcome(request, mapped) {
  const nodeId = request.nodeId;
  if (nodeId === "prepare" && request.attempt === 1) {
    exactKeys(mapped, ["brief"], "prepare mapped inputs");
    const brief = requireText(mapped.brief, "prepare brief");
    if (brief !== "Review the release brief") throw new Error("PAR-043 prepare did not receive the actual request mapping.");
    return success(`prepared:${brief}`);
  }
  if (nodeId === "security" && request.attempt === 1) {
    exactKeys(mapped, ["brief"], "security mapped inputs");
    const brief = requireText(requireRecord(mapped.brief, "security brief").text, "security brief text");
    return success(`security:${brief}`);
  }
  if (nodeId === "quality" && request.attempt === 1) {
    exactKeys(mapped, ["brief"], "quality mapped inputs");
    const brief = requireText(requireRecord(mapped.brief, "quality brief").text, "quality brief text");
    return success(`quality:${brief}`);
  }
  if (nodeId === "join" && request.attempt === 1) {
    exactKeys(mapped, ["quality", "security"], "join mapped inputs");
    const security = requireText(requireRecord(mapped.security, "join security mapping").text, "join security text");
    const quality = requireText(requireRecord(mapped.quality, "join quality mapping").text, "join quality text");
    return success(`review=${security}|${quality}`);
  }
  if (nodeId === "audit" && request.attempt === 1) {
    exactKeys(mapped, ["brief"], "audit mapped inputs");
    const brief = requireText(requireRecord(mapped.brief, "audit brief").text, "audit brief text");
    return success(`audit=${brief}`);
  }
  throw new Error(`PAR-043 example fixture received unexpected identity ${nodeId}/${request.attempt}.`);
}

function questionOutcome(request, mapped, answers) {
  const nodeId = request.nodeId;
  if (nodeId === "alpha" || nodeId === "beta") {
    exactKeys(mapped, ["request"], `${nodeId} mapped inputs`);
    if (requireText(mapped.request, `${nodeId} request mapping`) !== "Answer both review questions") {
      throw new Error(`PAR-043 ${nodeId} did not receive the actual workflow request mapping.`);
    }
    if (request.attempt === 1) {
      exactKeys(answers, [], `${nodeId}/1 prompt answers`);
      return question(nodeId);
    }
    if (request.attempt === 2) {
      const answerKey = `${nodeId}Approval`;
      exactKeys(answers, [answerKey], `${nodeId}/2 prompt answers`);
      if (answers[answerKey] !== true) throw new Error(`PAR-043 ${nodeId} did not receive its own committed answer.`);
      return success(`${nodeId}:approved`);
    }
  }
  if (nodeId === "join" && request.attempt === 1) {
    exactKeys(mapped, ["alpha", "beta"], "question join mapped inputs");
    exactKeys(answers, [], "question join prompt answers");
    const alpha = requireText(requireRecord(mapped.alpha, "join alpha mapping").text, "join alpha text");
    const beta = requireText(requireRecord(mapped.beta, "join beta mapping").text, "join beta text");
    return success(`join=${alpha}|${beta}`);
  }
  throw new Error(`PAR-043 question fixture received unexpected identity ${nodeId}/${request.attempt}.`);
}

async function main() {
  if (args[0] === "--version") {
    append(control.eventsPath, { stage: "version", pid: process.pid });
    process.stdout.write("codex-cli 0.156.1\n");
    return;
  }
  if (args[0] === "login" && args[1] === "status") {
    append(control.eventsPath, { stage: "readiness", pid: process.pid });
    process.stdout.write("Logged in\n");
    return;
  }
  if (args[0] !== "exec") throw new Error("PAR-043 fixture received an unsupported Codex operation.");
  if (!allowedCalls.size || readdirSync(path.resolve(project, control.attemptsDirectory)).length >= 5) {
    throw new Error("PAR-043 fixture exceeded its configured node-attempt bound.");
  }
  const outputIndex = args.indexOf("--output-last-message");
  if (outputIndex < 0 || typeof args[outputIndex + 1] !== "string") throw new Error("PAR-043 fixture has no output-last-message path.");
  const outputPath = path.resolve(project, args[outputIndex + 1]);
  const callId = path.basename(path.dirname(outputPath));
  if (!/^[0-9a-f-]{36}$/i.test(callId)) throw new Error("PAR-043 fixture found an invalid call id.");
  const request = requestFor(callId);
  if (typeof request.nodeId !== "string" || request.callId !== callId || !Number.isSafeInteger(request.attempt) || request.attempt < 1 || typeof request.runId !== "string") {
    throw new Error("PAR-043 fixture found an invalid captured invocation identity.");
  }
  const identityKey = `${request.nodeId}/${request.attempt}`;
  if (!allowedCalls.has(identityKey)) throw new Error(`PAR-043 fixture received unexpected call ${identityKey}.`);
  const prompt = await readStdin();
  const mappedInputs = sectionObject(prompt, "## Mapped Inputs");
  const answers = sectionObject(prompt, "## Answers to clarification questions");
  const identity = {
    mode: control.mode,
    nodeId: request.nodeId,
    runId: request.runId,
    callId,
    attempt: request.attempt,
    parentCallId: request.parentCallId ?? null,
    pid: process.pid,
    mappedInputs,
    promptAnswers: answers,
  };
  uniqueRecord(control.attemptsDirectory, identityKey.replace("/", "-"), identity);
  uniqueRecord(control.callsDirectory, callId, identity);
  append(control.eventsPath, { stage: "inference-started", ...identity });

  const outcome = control.mode === "parallel-review"
    ? exampleOutcome(request, mappedInputs)
    : questionOutcome(request, mappedInputs, answers);
  writeFileSync(outputPath, JSON.stringify({ response: JSON.stringify(outcome) }), "utf8");
  append(control.callsPath, { ...identity, completed: true });
  append(control.eventsPath, { stage: "inference-completed", ...identity });
  process.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message.slice(0, 300) : "PAR-043 fixture failed with a non-Error value.";
  try { append(control.eventsPath, { stage: "fixture-error", pid: process.pid, message }); }
  catch { /* Preserve the original local fixture failure. */ }
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
