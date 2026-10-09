import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { expect, test } from "vitest";
import { createDefaultProviderPort } from "../../src/adapters/providers/default-provider-port.js";
import { LocalIntakeStorage } from "../../src/adapters/storage/local-intake-storage.js";
import { runCli } from "../../src/cli.js";
import * as nodulusApi from "../../src/index.js";
import { acceptedResponses, createFeedbackProject, type FeedbackFixtureResponse } from "../support/feedback-project.js";
import { readProjectJson, writeJson } from "../support/workflow-sequence.js";

type InspectApi = (projectRoot: string, runId: string, storage?: LocalIntakeStorage) => Promise<Record<string, unknown>>;
type ExportApi = (projectRoot: string, runId: string) => Promise<Record<string, unknown>>;
type ReplayApi = (projectRoot: string, runId: string) => Promise<Record<string, unknown>>;
type RunApi = (request: { projectRoot: string; cwd: string; workflow: string; sources: Array<{ kind: "inline"; text: string }> }, provider: ReturnType<typeof createDefaultProviderPort>) => Promise<{ runId: string; status: string; result: unknown }>;

const inspectRun = (nodulusApi as unknown as { inspectRun: InspectApi }).inspectRun;
const exportRunDiagnostic = (nodulusApi as unknown as { exportRunDiagnostic: ExportApi }).exportRunDiagnostic;
const replaySavedRun = (nodulusApi as unknown as { replaySavedRun: ReplayApi }).replaySavedRun;
const runWorkflow = (nodulusApi as unknown as { runWorkflow: RunApi }).runWorkflow;
const defaultCliFixture = fileURLToPath(new URL("../fixtures/fb-040-default-provider-cli.mjs", import.meta.url));
const testRegionId = "content.review-v1";
const privateMarkers = [
  "FB050_PRIVATE_REQUEST_TEXT", "FB050_PRIVATE_PREPARE_ARTIFACT", "FB050_PRIVATE_DOCS_ARTIFACT",
  "FB050_PRIVATE_BUILD_ARTIFACT", "FB050_PRIVATE_REASON_ONE", "FB050_PRIVATE_REASON_TWO",
  "FB050_PRIVATE_REASON_ACCEPT", "FB050_PRIVATE_FINDING_ONE", "FB050_PRIVATE_FINDING_TWO", "FB050_PRIVATE_SCHEMA_DESCRIPTION",
  "FB050_PRIVATE_PROVIDER_PROFILE", "FB050_PRIVATE_PROVIDER_MODEL",
  "FB050_PRIVATE_LIMITS_VALUE",
];

type PausePoint = "docs" | "continue";
type PausedScenario = {
  fixture: ReturnType<typeof createFeedbackProject>;
  runId: string;
  storage: LocalIntakeStorage;
  runRoot: string;
  validatorTrace: string;
  validatorBytes: string;
};

function treeDigest(root: string): string {
  const rows: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (statSync(absolute).isDirectory()) visit(absolute);
      else rows.push(relative + ":" + createHash("sha256").update(readFileSync(absolute)).digest("hex"));
    }
  };
  visit(root);
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + stableJson(record[key])).join(",") + "}";
}

async function assertAcceptedGeneration(
  scenario: PausedScenario,
  nodeId: string,
  outputName: string,
  attemptPath: string,
): Promise<{ generationId: string; sha256: string; iteration: number; attemptPath: string }> {
  const checkpoint = JSON.parse(await scenario.storage.readRunFile(scenario.fixture.project, scenario.runId, "run.json")) as {
    feedbackRouting: { regions: Record<string, { generationHistory: Array<Record<string, unknown>> }> };
  };
  const generation = checkpoint.feedbackRouting.regions[testRegionId].generationHistory.find((row) => row.nodeId === nodeId && row.status === "accepted" && row.attemptPath === attemptPath);
  expect(generation).toBeDefined();
  expect(generation).toMatchObject({ attemptPath, iteration: 3, sha256: expect.any(String) });
  const manifestPath = "feedback/" + testRegionId + "/generations/" + String(generation!.generationId) + ".json";
  const manifest = JSON.parse(await scenario.storage.readRunFile(scenario.fixture.project, scenario.runId, manifestPath)) as Record<string, unknown>;
  expect(manifest).toMatchObject({ generationId: generation!.generationId, nodeId, outputName, iteration: 3, attemptPath, sha256: generation!.sha256 });
  const attempt = JSON.parse(await scenario.storage.readRunFile(scenario.fixture.project, scenario.runId, attemptPath)) as { artifacts: Array<{ name: string; data: unknown }> };
  const attemptArtifact = attempt.artifacts.find((artifact) => artifact.name === outputName);
  const currentArtifact = JSON.parse(await scenario.storage.readRunFile(scenario.fixture.project, scenario.runId, "nodes/" + nodeId + "/artifacts/" + outputName + ".json")) as { data: unknown };
  expect(attemptArtifact).toBeDefined();
  expect(currentArtifact.data).toEqual(attemptArtifact!.data);
  expect(createHash("sha256").update(stableJson(currentArtifact.data)).digest("hex")).toBe(generation!.sha256);
  return generation as { generationId: string; sha256: string; iteration: number; attemptPath: string };
}

async function makePausedScenario(label: string, pausePoint: PausePoint = "docs", orderedPreparedPayload = false): Promise<PausedScenario> {
  const fixture = createFeedbackProject("fb-050-" + label);
  const workflow = readProjectJson(fixture.project, ".nodulus/workflows/example.json");
  (workflow.feedbackRouting as Record<string, unknown>).regionId = testRegionId;
  writeJson(fixture.project, ".nodulus/workflows/example.json", workflow);
  const requestText = "FB050_PRIVATE_REQUEST_TEXT";
  const validatorTrace = path.join(fixture.project, ".nodulus", "fb050-validator-trace.txt");
  const validatorRelative = ".nodulus/validators/fb050-validator.mjs";
  mkdirSync(path.dirname(path.join(fixture.project, validatorRelative)), { recursive: true });
  writeFileSync(path.join(fixture.project, validatorRelative),
    "import { appendFileSync } from 'node:fs';\n" +
    "import path from 'node:path';\n" +
    "appendFileSync(path.join(process.cwd(), '.nodulus', 'fb050-validator-trace.txt'), 'called\\n');\n" +
    "process.stdout.write(JSON.stringify({ valid: true, errors: [] }));\n", "utf8");
  const prepareNode = readProjectJson(fixture.project, ".nodulus/nodes/prepare.json");
  prepareNode.expectedOutputs[0].validator = validatorRelative;
  writeJson(fixture.project, ".nodulus/nodes/prepare.json", prepareNode);
  const settings = readProjectJson(fixture.project, ".nodulus/settings.json");
  const privateProfile = settings.providerProfiles.fixture as Record<string, unknown>;
  privateProfile.model = "FB050_PRIVATE_PROVIDER_MODEL";
  delete settings.providerProfiles.fixture;
  settings.providerProfiles.FB050_PRIVATE_PROVIDER_PROFILE = privateProfile;
  writeJson(fixture.project, ".nodulus/settings.json", settings);
  for (const nodeId of ["prepare", "docs", "build", "review", "continue"]) {
    const node = readProjectJson(fixture.project, ".nodulus/nodes/" + nodeId + ".json");
    node.providerProfile = "FB050_PRIVATE_PROVIDER_PROFILE";
    writeJson(fixture.project, ".nodulus/nodes/" + nodeId + ".json", node);
  }
  const docsSchema = readProjectJson(fixture.project, ".nodulus/contracts/readme.v1.schema.json");
  docsSchema.description = "FB050_PRIVATE_SCHEMA_DESCRIPTION";
  writeJson(fixture.project, ".nodulus/contracts/readme.v1.schema.json", docsSchema);
  if (orderedPreparedPayload) writeJson(fixture.project, ".nodulus/contracts/prepared.v1.schema.json", {
    type: "object", required: ["text", "zulu", "alpha"], additionalProperties: false,
    properties: { text: { type: "string" }, zulu: { type: "object", required: ["omega", "alpha"], properties: { omega: { type: "integer" }, alpha: { type: "integer" } }, additionalProperties: false }, alpha: { type: "integer" } },
  });

  const responses: FeedbackFixtureResponse[] = [
    orderedPreparedPayload
      ? { nodeId: "prepare", name: "prepared", contract: "prepared.v1", data: { text: "FB050_PRIVATE_PREPARE_ARTIFACT", zulu: { omega: 1, alpha: 2 }, alpha: 3 } }
      : { nodeId: "prepare", name: "prepared", contract: "prepared.v1", text: "FB050_PRIVATE_PREPARE_ARTIFACT" },
    { nodeId: "docs", name: "readme", contract: "readme.v1", text: "FB050_PRIVATE_DOCS_ARTIFACT generation 1" },
    { nodeId: "build", name: "build", contract: "build.v1", text: "FB050_PRIVATE_BUILD_ARTIFACT generation 1" },
    { nodeId: "review", kind: "decision", decisionCode: "FIX_BUILD", reason: "FB050_PRIVATE_REASON_ONE", findings: [{ marker: "FB050_PRIVATE_FINDING_ONE" }] },
    { nodeId: "build", name: "build", contract: "build.v1", text: "FB050_PRIVATE_BUILD_ARTIFACT generation 2" },
    { nodeId: "review", kind: "decision", decisionCode: "FIX_DOCS", reason: "FB050_PRIVATE_REASON_TWO", findings: [{ marker: "FB050_PRIVATE_FINDING_TWO" }] },
  ];
  if (pausePoint === "docs") {
    responses.push({ nodeId: "docs", rawOutcome: JSON.stringify(pauseOutcome("fb050-pending-docs")) });
  } else {
    responses.push(
      { nodeId: "docs", name: "readme", contract: "readme.v1", text: "FB050_PRIVATE_DOCS_ARTIFACT generation 2" },
      { nodeId: "build", name: "build", contract: "build.v1", text: "FB050_PRIVATE_BUILD_ARTIFACT generation 3" },
      { nodeId: "review", kind: "decision", decisionCode: "ACCEPT", reason: "FB050_PRIVATE_REASON_ACCEPT", findings: [] },
      { nodeId: "continue", rawOutcome: JSON.stringify(pauseOutcome("fb050-pending-continuation")) },
    );
  }
  fixture.writeResponses(responses);
  const result = await runWorkflow({ projectRoot: fixture.project, cwd: fixture.project, workflow: "example", sources: [{ kind: "inline", text: requestText }] }, fixture.provider);
  if (result.status !== "needs_input") {
    fixture.cleanup();
    throw new Error("FB-050 setup did not reach its intended pause: " + result.status);
  }
  return {
    fixture,
    runId: result.runId,
    storage: new LocalIntakeStorage(),
    runRoot: path.join(fixture.project, ".nodulus", "runs", result.runId),
    validatorTrace,
    validatorBytes: readFileSync(validatorTrace, "utf8"),
  };
}

function pauseOutcome(id: string): Record<string, unknown> {
  return {
    status: "needs_input",
    request: {
      id,
      questions: [{ id: "detail", message: "Provide review details." }],
      answerContract: { type: "object", required: ["detail"], properties: { detail: { type: "string" } }, additionalProperties: false },
    },
  };
}

async function cliResult(command: string, fixture: ReturnType<typeof createFeedbackProject>, runId: string): Promise<unknown> {
  let stdout = "";
  const exit = await runCli(["node", "nodulus", "inspect", command, runId, "--project", fixture.project, "--json"], {
    writeOut(message) { stdout += message; },
    writeErr(message) { throw new Error(message); },
  });
  expect(exit).toBe(0);
  return (JSON.parse(stdout) as { result: unknown }).result;
}

async function withPausedScenario<T>(
  label: string,
  pausePoint: PausePoint,
  action: (scenario: PausedScenario) => Promise<T>,
): Promise<T> {
  const scenario = await makePausedScenario(label, pausePoint);
  try { return await action(scenario); }
  finally { scenario.fixture.cleanup(); }
}

function installSlowDefaultCodexFixture(project: string, slowInvocation: boolean, options: { timeoutMs?: number; invocationDelayMs?: number } = {}): { started: string; completed: string } {
  const settings = readProjectJson(project, ".nodulus/settings.json");
  const profile = settings.providerProfiles.fixture as Record<string, unknown>;
  Object.assign(profile, { kind: "codex", timeoutMs: options.timeoutMs ?? 5000, model: "fixture", sandbox: "read-only" });
  const providerDirectory = path.join(project, ".nodulus", "fixtures");
  mkdirSync(providerDirectory, { recursive: true });
  const cliFixture = path.join(providerDirectory, "fb-040-default-provider-cli.mjs");
  copyFileSync(defaultCliFixture, cliFixture);
  const wrapperPath = path.join(providerDirectory, process.platform === "win32" ? "codex-fixture.cmd" : "codex-fixture.sh");
  if (process.platform === "win32") {
    writeFileSync(wrapperPath, "@echo off\r\n\"" + process.execPath + "\" \".nodulus\\fixtures\\fb-040-default-provider-cli.mjs\" %*\r\nexit /b %ERRORLEVEL%\r\n", "utf8");
  } else {
    writeFileSync(wrapperPath, "#!/bin/sh\nexec '" + process.execPath + "' '.nodulus/fixtures/fb-040-default-provider-cli.mjs' \"$@\"\n", "utf8");
    chmodSync(wrapperPath, 0o755);
  }
  profile.executable = wrapperPath;
  writeJson(project, ".nodulus/settings.json", settings);
  const started = path.join(project, ".nodulus", "readiness-probe-started");
  const completed = path.join(project, ".nodulus", "readiness-probe-completed");
  if (slowInvocation) {
    writeFileSync(started, "already checked\n", "utf8");
    writeFileSync(completed, "already checked\n", "utf8");
    writeFileSync(path.join(project, ".nodulus", "slow-provider-invocation"), "slow\n", "utf8");
    if (options.invocationDelayMs !== undefined) writeFileSync(path.join(project, ".nodulus", "slow-provider-invocation-delay-ms"), String(options.invocationDelayMs), "utf8");
  }
  return { started, completed };
}

test("FB-050 inspection excludes stale suffix files immediately after a reroute", async () => {
  await withPausedScenario("inspect-after-reroute", "docs", async (scenario) => {
    const before = treeDigest(scenario.runRoot);
    const providerCalls = scenario.fixture.readTrace().length;
    const inspected = await inspectRun(scenario.fixture.project, scenario.runId, scenario.storage);
    expect(inspected.status).toBe("needs_input");
    expect((inspected.artifacts as Array<{ nodeId: string; name: string }>).map((item) => item.nodeId + "." + item.name)).toEqual(["prepare.prepared"]);
    expect(existsSync(path.join(scenario.runRoot, "nodes", "docs", "artifacts", "readme.json"))).toBe(true);
    expect(existsSync(path.join(scenario.runRoot, "nodes", "build", "artifacts", "build.json"))).toBe(true);
    const routing = inspected.feedbackRouting as { artifactGenerations: Array<Record<string, unknown>> };
    expect(routing).toEqual(expect.objectContaining({
      policy: expect.objectContaining({ regionId: testRegionId, startNode: "prepare", decisionNode: "review" }),
      regions: expect.objectContaining({ [testRegionId]: expect.any(Object) }),
    }));
    expect(routing.artifactGenerations).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "docs", status: "invalidated", attemptPath: "nodes/docs/attempt-001/result.json", sha256: expect.any(String), materialized: true }),
      expect.objectContaining({ nodeId: "build", status: "invalidated", attemptPath: "nodes/build/attempt-001/result.json", sha256: expect.any(String), materialized: false }),
      expect.objectContaining({ nodeId: "build", status: "invalidated", attemptPath: "nodes/build/attempt-002/result.json", sha256: expect.any(String), materialized: true }),
    ]));
    expect(await cliResult("run", scenario.fixture, scenario.runId)).toEqual(inspected);
    expect(scenario.fixture.readTrace()).toHaveLength(providerCalls);
    expect(readFileSync(scenario.validatorTrace, "utf8")).toBe(scenario.validatorBytes);
    expect(treeDigest(scenario.runRoot)).toBe(before);
  });
}, 20_000);

test("FB-050 inspection returns unique current outputs after an accepted reroute", async () => {
  await withPausedScenario("inspect-current-generations", "continue", async (scenario) => {
    const before = treeDigest(scenario.runRoot);
    const providerCalls = scenario.fixture.readTrace().length;
    const inspected = await inspectRun(scenario.fixture.project, scenario.runId, scenario.storage);
    const artifacts = inspected.artifacts as Array<{ nodeId: string; name: string; reference: string; accepted: boolean }>;
    expect(artifacts).toHaveLength(4);
    expect(artifacts.map((item) => [item.nodeId, item.name, item.reference, item.accepted]).sort((left, right) => String(left[0]).localeCompare(String(right[0])))).toEqual([
      ["build", "build", "nodes/build/artifacts/build.json", true],
      ["docs", "readme", "nodes/docs/artifacts/readme.json", true],
      ["prepare", "prepared", "nodes/prepare/artifacts/prepared.json", true],
      ["review", "decision", "nodes/review/artifacts/decision.json", true],
    ]);
    const routed = inspected.feedbackRouting as { artifactGenerations: Array<Record<string, unknown>> };
    const docsGeneration = await assertAcceptedGeneration(scenario, "docs", "readme", "nodes/docs/attempt-002/result.json");
    const buildGeneration = await assertAcceptedGeneration(scenario, "build", "build", "nodes/build/attempt-003/result.json");
    expect(routed.artifactGenerations).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "docs", outputName: "readme", ...docsGeneration, status: "accepted", materialized: true }),
      expect.objectContaining({ nodeId: "build", outputName: "build", ...buildGeneration, status: "accepted", materialized: true }),
    ]));
    const prepare = JSON.parse(await scenario.storage.readRunFile(scenario.fixture.project, scenario.runId, "nodes/prepare/artifacts/prepared.json")) as { data: unknown };
    const docs = JSON.parse(await scenario.storage.readRunFile(scenario.fixture.project, scenario.runId, "nodes/docs/artifacts/readme.json")) as { data: unknown };
    const build = JSON.parse(await scenario.storage.readRunFile(scenario.fixture.project, scenario.runId, "nodes/build/artifacts/build.json")) as { data: unknown };
    const decision = JSON.parse(await scenario.storage.readRunFile(scenario.fixture.project, scenario.runId, "nodes/review/artifacts/decision.json")) as { data: { decisionCode: string } };
    const reviewAttempt = JSON.parse(await scenario.storage.readRunFile(scenario.fixture.project, scenario.runId, "nodes/review/attempt-003/result.json")) as { artifacts: Array<{ name: string; data: unknown }> };
    const attemptDecision = reviewAttempt.artifacts.find((artifact) => artifact.name === "decision");
    expect(prepare.data).toEqual({ text: "FB050_PRIVATE_PREPARE_ARTIFACT" });
    expect(docs.data).toEqual({ text: "FB050_PRIVATE_DOCS_ARTIFACT generation 2" });
    expect(build.data).toEqual({ text: "FB050_PRIVATE_BUILD_ARTIFACT generation 3" });
    expect(decision.data).toEqual(attemptDecision?.data);
    expect(decision.data.decisionCode).toBe("ACCEPT");
    expect(await cliResult("run", scenario.fixture, scenario.runId)).toEqual(inspected);
    expect(scenario.fixture.readTrace()).toHaveLength(providerCalls);
    expect(readFileSync(scenario.validatorTrace, "utf8")).toBe(scenario.validatorBytes);
    expect(treeDigest(scenario.runRoot)).toBe(before);
  });
}, 20_000);

test("FB-050 export is deterministic, redacted, routed, and API/CLI equivalent", async () => {
  await withPausedScenario("export-redaction", "continue", async (scenario) => {
    const before = treeDigest(scenario.runRoot);
    const providerCalls = scenario.fixture.readTrace().length;
    const first = await exportRunDiagnostic(scenario.fixture.project, scenario.runId);
    expect(await exportRunDiagnostic(scenario.fixture.project, scenario.runId)).toEqual(first);
    const serialized = JSON.stringify(first);
    for (const marker of [...privateMarkers, scenario.fixture.project]) expect(serialized).not.toContain(marker);
    const routing = (first as Record<string, unknown>).feedbackRouting as Record<string, unknown>;
    expect(routing).toEqual(expect.objectContaining({
      policy: expect.objectContaining({ regionId: testRegionId, startNode: "prepare", decisionNode: "review" }),
      regions: expect.objectContaining({ [testRegionId]: expect.any(Object) }),
      artifactGenerations: expect.any(Array),
    }));
    expect(await cliResult("export", scenario.fixture, scenario.runId)).toEqual(first);
    expect(scenario.fixture.readTrace()).toHaveLength(providerCalls);
    expect(readFileSync(scenario.validatorTrace, "utf8")).toBe(scenario.validatorBytes);
    expect(treeDigest(scenario.runRoot)).toBe(before);
  });
}, 20_000);

test.each([
  ["docs", "FIX_DOCS", "docs"],
  ["continue", "ACCEPT", "continue"],
] as const)("FB-050 export summarizes the last route and region budgets at %s", async (pausePoint, decisionCode, target) => {
  await withPausedScenario("route-summary-" + pausePoint, pausePoint, async (scenario) => {
    const exported = await exportRunDiagnostic(scenario.fixture.project, scenario.runId, scenario.storage);
    const routing = exported.feedbackRouting as { regions: Record<string, Record<string, unknown>> };
    const region = routing.regions[testRegionId];
    expect(region.lastRoute).toEqual({ decisionCode, target, iteration: 3 });
    expect(region.budget).toEqual(expect.objectContaining({
      iteration: expect.objectContaining({ used: 3, limit: 3, reached: true }),
      providerCalls: expect.objectContaining({ used: expect.any(Number), limit: 20, reached: false }),
      elapsedMs: expect.objectContaining({ limit: 3_600_000, reached: false }),
    }));
  });
}, 20_000);

test("FB-050 replay reports historical generation state without claiming runtime eligibility", async () => {
  await withPausedScenario("replay-generations", "continue", async (scenario) => {
    const before = treeDigest(scenario.runRoot);
    const providerCalls = scenario.fixture.readTrace().length;
    const replay = await replaySavedRun(scenario.fixture.project, scenario.runId);
    expect(await replaySavedRun(scenario.fixture.project, scenario.runId)).toEqual(replay);
    expect(replay).toEqual(expect.objectContaining({ mode: "schema-only", feedbackRouting: expect.objectContaining({ artifactGenerations: expect.any(Array) }) }));
    const candidates = replay.candidates as Array<Record<string, unknown>>;
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "docs", attempt: 1, generationStatus: "invalidated" }),
      expect.objectContaining({ nodeId: "docs", attempt: 2, generationStatus: "accepted" }),
      expect.objectContaining({ nodeId: "build", attempt: 2, generationStatus: "invalidated" }),
      expect.objectContaining({ nodeId: "build", attempt: 3, generationStatus: "accepted" }),
    ]));
    const routing = (replay as Record<string, unknown>).feedbackRouting as { artifactGenerations: Array<Record<string, unknown>> };
    expect(routing.artifactGenerations).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "docs", iteration: 1, status: "invalidated", materialized: false }),
      expect.objectContaining({ nodeId: "docs", iteration: 3, status: "accepted", materialized: true }),
      expect.objectContaining({ nodeId: "build", iteration: 2, status: "invalidated", materialized: false }),
      expect.objectContaining({ nodeId: "build", iteration: 3, status: "accepted", materialized: true }),
    ]));
    expect(JSON.stringify(replay)).not.toContain("eligibleForCurrentRouting");
    expect(await cliResult("replay", scenario.fixture, scenario.runId)).toEqual(replay);
    expect(scenario.fixture.readTrace()).toHaveLength(providerCalls);
    expect(readFileSync(scenario.validatorTrace, "utf8")).toBe(scenario.validatorBytes);
    expect(treeDigest(scenario.runRoot)).toBe(before);
  });
}, 20_000);

test("FB-050 routed summaries stay absent on a real non-routed run", async () => {
  const fixture = createFeedbackProject("fb-050-legacy-shape");
  try {
    const workflow = readProjectJson(fixture.project, ".nodulus/workflows/example.json");
    delete workflow.feedbackRouting;
    writeJson(fixture.project, ".nodulus/workflows/example.json", workflow);
    fixture.writeResponses(acceptedResponses());
    const result = await runWorkflow({ projectRoot: fixture.project, cwd: fixture.project, workflow: "example", sources: [{ kind: "inline", text: "FB050 legacy route absence" }] }, fixture.provider);
    expect(result.status).toBe("success");
    const storage = new LocalIntakeStorage();
    expect(Object.hasOwn(await inspectRun(fixture.project, result.runId, storage), "feedbackRouting")).toBe(false);
    expect(Object.hasOwn(await exportRunDiagnostic(fixture.project, result.runId, storage), "feedbackRouting")).toBe(false);
    expect(Object.hasOwn(await replaySavedRun(fixture.project, result.runId, storage), "feedbackRouting")).toBe(false);
  } finally { fixture.cleanup(); }
}, 20_000);

test.each(["missing", "malformed"] as const)("FB-050 damaged captured definitions cannot fall back to stale artifacts (%s)", async (damage) => {
  await withPausedScenario("damaged-definitions-" + damage, "docs", async (scenario) => {
    const reference = "context/definitions.json";
    const original = await scenario.storage.readRunFile(scenario.fixture.project, scenario.runId, reference);
    const absolute = path.join(scenario.runRoot, reference);
    if (damage === "missing") rmSync(absolute);
    else writeFileSync(absolute, "{ invalid json", "utf8");
    try {
      const before = treeDigest(scenario.runRoot);
      const providerCalls = scenario.fixture.readTrace().length;
      const validatorBytes = readFileSync(scenario.validatorTrace, "utf8");
      const inspected = await inspectRun(scenario.fixture.project, scenario.runId, scenario.storage);
      expect(JSON.stringify(inspected.diagnostics)).toMatch(/definition|feedback|routing/i);
      expect((inspected.artifacts as Array<{ nodeId: string }>).some((artifact) => artifact.nodeId === "docs" || artifact.nodeId === "build")).toBe(false);
      expect(scenario.fixture.readTrace()).toHaveLength(providerCalls);
      expect(readFileSync(scenario.validatorTrace, "utf8")).toBe(validatorBytes);
      expect(treeDigest(scenario.runRoot)).toBe(before);
    } finally {
      writeFileSync(absolute, original, "utf8");
    }
  });
}, 20_000);

test.each(["nodes-object", "nodes-null-entry"] as const)("FB-050 malformed captured node definitions are diagnosed (%s)", async (damage) => {
  await withPausedScenario("malformed-node-definitions-" + damage, "docs", async (scenario) => {
    const reference = "context/definitions.json";
    const original = await scenario.storage.readRunFile(scenario.fixture.project, scenario.runId, reference);
    const definitions = JSON.parse(original) as { nodes: unknown };
    definitions.nodes = damage === "nodes-object" ? {} : [null];
    await scenario.storage.writeRunFiles(scenario.fixture.project, scenario.runId, { [reference]: JSON.stringify(definitions) });
    try {
      const before = treeDigest(scenario.runRoot);
      const providerCalls = scenario.fixture.readTrace().length;
      const validatorBytes = readFileSync(scenario.validatorTrace, "utf8");
      const inspected = await inspectRun(scenario.fixture.project, scenario.runId, scenario.storage);
      expect(JSON.stringify(inspected.diagnostics)).toMatch(/definition|feedback|routing|node/i);
      expect((inspected.artifacts as Array<{ nodeId: string }>).some((artifact) => artifact.nodeId === "docs" || artifact.nodeId === "build")).toBe(false);
      expect(scenario.fixture.readTrace()).toHaveLength(providerCalls);
      expect(readFileSync(scenario.validatorTrace, "utf8")).toBe(validatorBytes);
      expect(treeDigest(scenario.runRoot)).toBe(before);
    } finally {
      await scenario.storage.writeRunFiles(scenario.fixture.project, scenario.runId, { [reference]: original });
    }
  });
}, 20_000);

test("FB-050 generation evidence cannot point at a different successful attempt", async () => {
  await withPausedScenario("mispointed-generation-attempt", "continue", async (scenario) => {
    const eventsPath = "events.jsonl";
    const originalEvents = await scenario.storage.readRunFile(scenario.fixture.project, scenario.runId, eventsPath);
    const checkpoint = JSON.parse(await scenario.storage.readRunFile(scenario.fixture.project, scenario.runId, "run.json")) as { feedbackRouting: { regions: Record<string, { generationHistory: Array<Record<string, unknown>> }> } };
    const generation = checkpoint.feedbackRouting.regions[testRegionId].generationHistory.find((row) => row.nodeId === "docs" && row.status === "accepted" && row.attemptPath === "nodes/docs/attempt-002/result.json");
    expect(generation).toBeDefined();
    const eventRows = originalEvents.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const created = eventRows.find((row) => row.event === "feedback.generation.created" && row.generationId === generation!.generationId);
    expect(created).toBeDefined();
    const manifestPath = `feedback/${testRegionId}/generations/${String(generation!.generationId)}.json`;
    const originalManifest = await scenario.storage.readRunFile(scenario.fixture.project, scenario.runId, manifestPath);
    const manifest = JSON.parse(originalManifest) as Record<string, unknown>;
    const wrongAttemptPath = "nodes/docs/attempt-001/result.json";
    const wrongAttempt = JSON.parse(await scenario.storage.readRunFile(scenario.fixture.project, scenario.runId, wrongAttemptPath)) as { artifacts: Array<{ name: string; data: unknown }> };
    const wrongArtifact = wrongAttempt.artifacts.find((artifact) => artifact.name === "readme");
    expect(wrongArtifact).toBeDefined();
    created!.attemptPath = wrongAttemptPath;
    manifest.attemptPath = wrongAttemptPath;
    manifest.sha256 = createHash("sha256").update(JSON.stringify(wrongArtifact!.data), "utf8").digest("hex");
    await scenario.storage.writeRunFiles(scenario.fixture.project, scenario.runId, {
      [eventsPath]: eventRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      [manifestPath]: JSON.stringify(manifest),
    });
    try {
      const before = treeDigest(scenario.runRoot);
      const providerCalls = scenario.fixture.readTrace().length;
      const validatorBytes = readFileSync(scenario.validatorTrace, "utf8");
      const inspected = await inspectRun(scenario.fixture.project, scenario.runId, scenario.storage);
      expect(JSON.stringify(inspected.diagnostics)).toMatch(/attempt|generation|evidence/i);
      expect((inspected.artifacts as Array<{ nodeId: string }>).some((artifact) => artifact.nodeId === "docs")).toBe(false);
      expect((inspected.feedbackRouting as { artifactGenerations: Array<{ generationId: string; status: string }> }).artifactGenerations)
        .not.toContainEqual(expect.objectContaining({ generationId: generation!.generationId, status: "accepted" }));
      expect(scenario.fixture.readTrace()).toHaveLength(providerCalls);
      expect(readFileSync(scenario.validatorTrace, "utf8")).toBe(validatorBytes);
      expect(treeDigest(scenario.runRoot)).toBe(before);
    } finally {
      await scenario.storage.writeRunFiles(scenario.fixture.project, scenario.runId, { [eventsPath]: originalEvents, [manifestPath]: originalManifest });
    }
  });
}, 20000);

test("FB-050 malformed nested feedback limits are not exported", async () => {
  await withPausedScenario("malformed-private-feedback-limits", "continue", async (scenario) => {
    const reference = "context/definitions.json";
    const original = await scenario.storage.readRunFile(scenario.fixture.project, scenario.runId, reference);
    const definitions = JSON.parse(original) as { workflow: { feedbackRouting: Record<string, unknown> } };
    definitions.workflow.feedbackRouting.limits = { maxIterations: "FB050_PRIVATE_LIMITS_VALUE", maxProviderCalls: { private: "FB050_PRIVATE_LIMITS_VALUE" }, maxElapsedMs: -1 };
    await scenario.storage.writeRunFiles(scenario.fixture.project, scenario.runId, { [reference]: JSON.stringify(definitions) });
    try {
      const before = treeDigest(scenario.runRoot);
      const providerCalls = scenario.fixture.readTrace().length;
      const validatorBytes = readFileSync(scenario.validatorTrace, "utf8");
      const exported = await exportRunDiagnostic(scenario.fixture.project, scenario.runId, scenario.storage);
      expect(JSON.stringify(exported)).not.toContain("FB050_PRIVATE_LIMITS_VALUE");
      const limits = ((exported.feedbackRouting as { policy: { limits?: unknown } }).policy).limits;
      expect(limits).toEqual({});
      expect(scenario.fixture.readTrace()).toHaveLength(providerCalls);
      expect(readFileSync(scenario.validatorTrace, "utf8")).toBe(validatorBytes);
      expect(treeDigest(scenario.runRoot)).toBe(before);
    } finally {
      await scenario.storage.writeRunFiles(scenario.fixture.project, scenario.runId, { [reference]: original });
    }
  });
}, 20_000);

test("FB-050 damaged manifests are diagnostic and cannot produce accepted current artifacts", async () => {
  await withPausedScenario("damaged-manifest", "continue", async (scenario) => {
    const checkpoint = JSON.parse(await scenario.storage.readRunFile(scenario.fixture.project, scenario.runId, "run.json")) as { feedbackRouting: { regions: Record<string, { generationHistory: Array<{ generationId: string; nodeId: string; status: string }> }> } };
    const generation = checkpoint.feedbackRouting.regions[testRegionId].generationHistory.find((item) => item.nodeId === "docs" && item.status === "accepted");
    expect(generation).toBeDefined();
    const reference = "feedback/" + testRegionId + "/generations/" + generation!.generationId + ".json";
    const original = await scenario.storage.readRunFile(scenario.fixture.project, scenario.runId, reference);
    const manifest = JSON.parse(original) as Record<string, unknown>;
    manifest.sha256 = "0".repeat(64);
    await scenario.storage.writeRunFiles(scenario.fixture.project, scenario.runId, { [reference]: JSON.stringify(manifest) });
    try {
      const damagedTree = treeDigest(scenario.runRoot);
      const inspected = await inspectRun(scenario.fixture.project, scenario.runId, scenario.storage);
      expect(JSON.stringify(inspected.diagnostics)).toMatch(/generation|manifest|digest/i);
      expect((inspected.artifacts as Array<{ nodeId: string }>).some((artifact) => artifact.nodeId === "docs")).toBe(false);
      const routing = inspected.feedbackRouting as { artifactGenerations: Array<{ generationId: string; status: string }> };
      expect(routing.artifactGenerations).not.toContainEqual(expect.objectContaining({ generationId: generation!.generationId, status: "accepted" }));
      expect(treeDigest(scenario.runRoot)).toBe(damagedTree);
    } finally {
      await scenario.storage.writeRunFiles(scenario.fixture.project, scenario.runId, { [reference]: original });
    }
  });
}, 20_000);

test("FB-050 accepts routed payload hashes using the executor's JSON serialization order", async () => {
  const scenario = await makePausedScenario("ordered-payload-digest", "docs", true);
  try {
    const checkpoint = JSON.parse(await scenario.storage.readRunFile(scenario.fixture.project, scenario.runId, "run.json")) as { feedbackRouting: { regions: Record<string, { generationHistory: Array<Record<string, unknown>> }> } };
    const generation = checkpoint.feedbackRouting.regions[testRegionId].generationHistory.find((item) => item.nodeId === "prepare" && item.outputName === "prepared");
    expect(generation).toBeDefined();
    const result = JSON.parse(await scenario.storage.readRunFile(scenario.fixture.project, scenario.runId, String(generation!.attemptPath))) as { artifacts: Array<Record<string, unknown>> };
    const artifact = result.artifacts.find((item) => item.name === "prepared");
    const digest = createHash("sha256").update(JSON.stringify(artifact!.data), "utf8").digest("hex");
    const manifest = JSON.parse(await scenario.storage.readRunFile(scenario.fixture.project, scenario.runId, `feedback/${testRegionId}/generations/${String(generation!.generationId)}.json`)) as Record<string, unknown>;
    expect(manifest.sha256).toBe(digest);
    expect(generation!.sha256).toBe(digest);
    expect(artifact!.data).toEqual({ text: "FB050_PRIVATE_PREPARE_ARTIFACT", zulu: { omega: 1, alpha: 2 }, alpha: 3 });
    const inspected = await inspectRun(scenario.fixture.project, scenario.runId, scenario.storage);
    expect((inspected.artifacts as Array<{ nodeId: string; name: string }>)).toContainEqual(expect.objectContaining({ nodeId: "prepare", name: "prepared" }));
    expect(JSON.stringify(inspected.diagnostics)).not.toMatch(/generation|manifest|digest/i);
} finally { scenario.fixture.cleanup(); }
}, 20_000);

test("FB-050 inconsistent reroute invalidations cannot promote stale artifacts", async () => {
  await withPausedScenario("forged-transition-invalidation", "docs", async (scenario) => {
    const eventsPath = "events.jsonl";
    const original = await scenario.storage.readRunFile(scenario.fixture.project, scenario.runId, eventsPath);
    const events = original.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const transition = events.find((event) => event.event === "feedback.route.transition" && event.regionId === testRegionId);
    expect(transition).toBeDefined();
    expect(transition!.invalidatedGenerationIds).not.toEqual([]);
    transition!.invalidatedGenerationIds = [];
    await scenario.storage.writeRunFiles(scenario.fixture.project, scenario.runId, { [eventsPath]: events.map((event) => JSON.stringify(event)).join("\n") + "\n" });
    try {
      const before = treeDigest(scenario.runRoot);
      const providerCalls = scenario.fixture.readTrace().length;
      const validatorBytes = readFileSync(scenario.validatorTrace, "utf8");
      const inspected = await inspectRun(scenario.fixture.project, scenario.runId, scenario.storage);
      expect(JSON.stringify(inspected.diagnostics)).toMatch(/invalidation|generation|transition/i);
      expect((inspected.artifacts as Array<{ nodeId: string }>).some((artifact) => artifact.nodeId === "docs" || artifact.nodeId === "build")).toBe(false);
      const generations = (inspected.feedbackRouting as { artifactGenerations: Array<{ nodeId: string; status: string }> }).artifactGenerations;
      expect(generations.some((row) => (row.nodeId === "docs" || row.nodeId === "build") && row.status === "accepted")).toBe(false);
      expect(scenario.fixture.readTrace()).toHaveLength(providerCalls);
      expect(readFileSync(scenario.validatorTrace, "utf8")).toBe(validatorBytes);
      expect(treeDigest(scenario.runRoot)).toBe(before);
    } finally {
      await scenario.storage.writeRunFiles(scenario.fixture.project, scenario.runId, { [eventsPath]: original });
    }
  });
}, 20_000);

async function inspectDefaultProviderAbort(label: string, slowInvocation: boolean, expectedLaunchStatus: "not_launched" | "launched"): Promise<void> {
  const fixture = createFeedbackProject("fb-050-" + label);
  const workflow = readProjectJson(fixture.project, ".nodulus/workflows/example.json");
  (workflow.feedbackRouting as Record<string, unknown>).limits = { maxIterations: 3, maxProviderCalls: 20, maxElapsedMs: slowInvocation ? 5000 : 1200 };
  writeJson(fixture.project, ".nodulus/workflows/example.json", workflow);
  const markers = installSlowDefaultCodexFixture(fixture.project, slowInvocation, slowInvocation ? { timeoutMs: 20_000, invocationDelayMs: 15_000 } : {});
  try {
    const result = await runWorkflow({ projectRoot: fixture.project, cwd: fixture.project, workflow: "example", sources: [{ kind: "inline", text: "FB050 uncertainty check" }] }, createDefaultProviderPort(fixture.project));
    expect(result.status).toBe("error");
    const storage = new LocalIntakeStorage();
    const checkpoint = JSON.parse(await storage.readRunFile(fixture.project, result.runId, "run.json")) as { feedbackRouting: { regions: Record<string, { uncertainCalls?: Array<{ launchStatus: string }> }> } };
    expect(checkpoint.feedbackRouting.regions["content-review"].uncertainCalls).toEqual(expect.arrayContaining([expect.objectContaining({ launchStatus: expectedLaunchStatus })]));
    if (slowInvocation) {
      expect(existsSync(path.join(fixture.project, ".nodulus", "provider-invocation-started"))).toBe(true);
      expect(existsSync(path.join(fixture.project, ".nodulus", "provider-invocation-completed"))).toBe(false);
    } else {
      expect(existsSync(markers.started)).toBe(true);
      expect(existsSync(markers.completed)).toBe(false);
    }
    const runRoot = path.join(fixture.project, ".nodulus", "runs", result.runId);
    const before = treeDigest(runRoot);
    const inspected = await inspectRun(fixture.project, result.runId, storage);
    if (slowInvocation) {
      const exported = await exportRunDiagnostic(fixture.project, result.runId, storage);
      const region = (exported.feedbackRouting as { regions: Record<string, Record<string, unknown>> }).regions["content-review"];
      expect((region.budget as Record<string, { reached: boolean }>).elapsedMs.reached).toBe(true);
    }
    const actions = inspected.nextActions as string[];
    if (expectedLaunchStatus === "not_launched") expect(actions).not.toContain("do_not_replay_uncertain_call");
    else expect(actions).toContain("do_not_replay_uncertain_call");
    expect(treeDigest(runRoot)).toBe(before);
  } finally {
    fixture.cleanup();
  }
}

test("FB-050 inspection classifies a real default-provider readiness-abort", async () => {
  await inspectDefaultProviderAbort("readiness-abort", false, "not_launched");
}, 20_000);

test("FB-050 inspection classifies a real default-provider inference-abort", async () => {
  await inspectDefaultProviderAbort("inference-abort", true, "launched");
}, 30_000);
