import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("opencode 1.18.32\n");
  process.exit(0);
}
if (args[0] === "models") {
  process.stdout.write("ollama/qwen3.5:9b\n");
  process.exit(0);
}
if (args[0] !== "run") {
  process.stderr.write(`Unexpected OpenCode fixture arguments: ${JSON.stringify(args)}`);
  process.exit(64);
}

let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;

const stateDirectory = path.join(process.cwd(), ".nodulus", "fixtures", "graph-opencode-state");
const config = JSON.parse(readFileSync(path.join(stateDirectory, "config.json"), "utf8"));
const agent = readFlag("--agent");
const sessionArgument = readFlag("--session");
let nodeId;
let operation;
let operationIndex;
let sessionID;
let rawResponse;

if (agent === "build") {
  nodeId = /^Node: ([^\r\n]+)/m.exec(stdin)?.[1];
  if (!nodeId || !config.nodes[nodeId]) {
    process.stderr.write("Build prompt did not identify a configured graph node.");
    process.exit(65);
  }
  operation = "build";
  operationIndex = 1;
  sessionID = config.nodes[nodeId].sessionId;
  rawResponse = config.nodes[nodeId].buildRaw;
  const actionPath = path.join(stateDirectory, `action-${nodeId}.json`);
  writeFileSync(actionPath, JSON.stringify({ nodeId, pid: process.pid, at: Date.now() }), { encoding: "utf8", flag: "wx" });
} else if (agent === "nodulus-response") {
  const matches = Object.entries(config.nodes).flatMap(([candidateNodeId, node]) => [node.buildRaw, ...node.repairRaw]
    .filter((priorRaw) => stdin.includes(priorRaw))
    .map((priorRaw) => ({ candidateNodeId, node, priorRaw })));
  if (matches.length !== 1) {
    process.stderr.write(`Response-only prompt matched ${matches.length} configured prior responses; expected exactly one.`);
    process.exit(66);
  }
  const [matched] = matches;
  nodeId = matched.candidateNodeId;
  if (matched.node.sessionId !== sessionArgument) {
    process.stderr.write(`Response-only session '${String(sessionArgument)}' does not belong to the node identified by the prior response.`);
    process.exit(66);
  }
  operation = "repair";
  sessionID = sessionArgument;
  const priorOperations = readdirSync(stateDirectory).filter((name) => name.startsWith(`operation-${nodeId}-repair-`) && name.endsWith(".json")).length;
  operationIndex = priorOperations + 1;
  const expectedPreviousRaw = operationIndex === 1 ? config.nodes[nodeId].buildRaw : config.nodes[nodeId].repairRaw[operationIndex - 2];
  if (matched.priorRaw !== expectedPreviousRaw) {
    process.stderr.write(`Response-only prior response does not match ${nodeId} repair ${operationIndex}.`);
    process.exit(67);
  }
  rawResponse = config.nodes[nodeId].repairRaw[operationIndex - 1];
  if (typeof rawResponse !== "string") {
    process.stderr.write(`No response-only fixture result configured for ${nodeId} repair ${operationIndex}.`);
    process.exit(67);
  }
} else {
  process.stderr.write(`Unexpected OpenCode agent '${String(agent)}'.`);
  process.exit(68);
}

const operationKey = `${nodeId}-${operation}-${operationIndex}`;
const startedPath = path.join(stateDirectory, `started-${operationKey}.json`);
const releasePath = path.join(stateDirectory, `release-${operationKey}`);
const finishedPath = path.join(stateDirectory, `finished-${operationKey}.json`);
const operationPath = path.join(stateDirectory, `operation-${operationKey}.json`);
const usageIndex = Object.keys(config.nodes).indexOf(nodeId) * 10 + (operation === "build" ? 0 : operationIndex);
const usage = {
  input: 101 + usageIndex,
  output: 31 + usageIndex,
  reasoning: 2,
  cache: { read: 3, write: 1 },
  cost: Number((0.001 + usageIndex / 1000).toFixed(3)),
};
const operationData = { nodeId, operation, operationIndex, sessionID, pid: process.pid, argv: args, stdin, usage };
writeFileSync(operationPath, JSON.stringify(operationData), { encoding: "utf8", flag: "wx" });
writeFileSync(startedPath, JSON.stringify({ ...operationData, at: Date.now() }), { encoding: "utf8", flag: "wx" });

const deadline = Date.now() + 10_000;
while (!existsSync(releasePath)) {
  if (Date.now() >= deadline) {
    process.stderr.write(`OpenCode graph fixture watchdog expired for ${operationKey}.`);
    process.exit(72);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}

writeFileSync(finishedPath, JSON.stringify({ nodeId, operation, operationIndex, sessionID, pid: process.pid }), "utf8");
const messageID = `message-${operationKey}`;
const step = `step-${operationKey}`;
const events = [
  { type: "step_start", part: { id: step, messageID, sessionID } },
  { type: "text", part: { messageID, text: rawResponse } },
  { type: "step_finish", part: { id: step, messageID, sessionID, reason: "stop", tokens: usage, cost: usage.cost } },
];
process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

function readFlag(flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}
