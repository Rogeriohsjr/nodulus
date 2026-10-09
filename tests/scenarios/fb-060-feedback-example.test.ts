import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { runFeedbackExample } from "../../examples/feedback-routing/run.mjs";

function createProject(label: string): string {
  return mkdtempSync(path.join(os.tmpdir(), "nodulus-fb-060-" + label + "-"));
}

function filesUnder(directory: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!existsSync(directory)) return result;
  const visit = (relative: string): void => {
    for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else result.set(child.replaceAll("\\", "/"), createHash("sha256").update(readFileSync(path.join(directory, child))).digest("hex"));
    }
  };
  visit("");
  return result;
}

function attemptNames(projectRoot: string, runId: string, nodeId: string): string[] {
  return readdirSync(path.join(projectRoot, ".nodulus", "runs", runId, "nodes", nodeId))
    .filter((entry) => /^attempt-\d+$/.test(entry))
    .sort();
}

function readRun(projectRoot: string, runId: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(projectRoot, ".nodulus", "runs", runId, "run.json"), "utf8"));
}

test("FB-060 routes a correction, preserves its prefix, and writes the accepted report", async () => {
  const projectRoot = createProject("correction");
  let prefixBefore = new Map<string, string>();
  try {
    const result = await runFeedbackExample({
      projectRoot,
      text: "  Cafe\u0301\n\n世界 👋  ",
      async onProviderCall(invocation: { runId: string; nodeId: string }) {
        const prefix = path.join(projectRoot, ".nodulus", "runs", invocation.runId, "nodes", "prepare", "attempt-001");
        if (invocation.nodeId === "review" && prefixBefore.size === 0) prefixBefore = filesUnder(prefix);
        if (invocation.nodeId === "normalize" && prefixBefore.size > 0) expect(filesUnder(prefix)).toEqual(prefixBefore);
      },
    });
    expect(result.status).toBe("success");
    expect(result.trace).toEqual(["prepare", "normalize", "review", "normalize", "review", "report"]);
    expect(result.report).toBe("Café 世界 👋");
    expect(result.trace.filter((nodeId) => nodeId === "prepare")).toHaveLength(1);
    expect(attemptNames(projectRoot, result.runId, "normalize")).toEqual(["attempt-001", "attempt-002"]);
    expect(attemptNames(projectRoot, result.runId, "review")).toEqual(["attempt-001", "attempt-002"]);
    const run = readRun(projectRoot, result.runId);
    const generations = run.feedbackRouting.regions.normalization.generationHistory;
    const normalizeGenerations = generations.filter((entry: { nodeId: string }) => entry.nodeId === "normalize");
    expect(normalizeGenerations).toHaveLength(2);
    expect(normalizeGenerations[0].generationId).not.toBe(normalizeGenerations[1].generationId);
    expect(normalizeGenerations[0].attemptPath).toBe("nodes/normalize/attempt-001/result.json");
    expect(normalizeGenerations[1].attemptPath).toBe("nodes/normalize/attempt-002/result.json");
    expect(normalizeGenerations.map((entry: { status: string }) => entry.status)).toEqual(["invalidated", "accepted"]);
    for (const generation of normalizeGenerations) {
      const manifest = path.join(projectRoot, ".nodulus", "runs", result.runId, "feedback", "normalization", "generations", generation.generationId + ".json");
      expect(JSON.parse(readFileSync(manifest, "utf8"))).toMatchObject({ generationId: generation.generationId, nodeId: "normalize", attemptPath: generation.attemptPath, sha256: expect.any(String) });
    }
    expect(prefixBefore.size).toBeGreaterThan(0);
    const trace = readFileSync(path.join(projectRoot, ".nodulus", "feedback-example-trace.jsonl"), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const reviews = trace.filter((entry) => entry.nodeId === "review");
    expect(reviews[1].inputs.artifactReferences[0].generationId).not.toBe(reviews[0].inputs.artifactReferences[0].generationId);
    expect(reviews[1].inputs.artifactReferences[0].sha256).not.toBe(reviews[0].inputs.artifactReferences[0].sha256);
    const reportResult = JSON.parse(readFileSync(path.join(projectRoot, ".nodulus", "runs", result.runId, "nodes", "report", "attempt-001", "result.json"), "utf8"));
    expect(reportResult.artifacts[0].data).toBe("Café 世界 👋");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test.each([
  ["Already NFC text", "Already NFC text"],
  ["", ""],
  ["世界 👋", "世界 👋"],
  [" \t\n ", ""],
])("FB-060 accepts or normalizes simple caller text %j", async (text, expected) => {
  const projectRoot = createProject("simple-text");
  try {
    const result = await runFeedbackExample({ projectRoot, text });
    expect(result.status).toBe("success");
    expect(result.report).toBe(expected);
    expect(result.trace).toEqual(expected === text
      ? ["prepare", "normalize", "review", "report"]
      : ["prepare", "normalize", "review", "normalize", "review", "report"]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test.each(["first\nsecond", "first\tsecond"])("FB-060 routes isolated whitespace %j through normalization", async (text) => {
  const projectRoot = createProject("line-break");
  try {
    const result = await runFeedbackExample({ projectRoot, text });
    expect(result.status).toBe("success");
    expect(result.report).toBe("first second");
    expect(result.trace).toEqual(["prepare", "normalize", "review", "normalize", "review", "report"]);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("FB-060 stops at the provider-call cap before its fourth region call or report", async () => {
  const projectRoot = createProject("call-cap");
  try {
    const result = await runFeedbackExample({ projectRoot, text: "  needs correction  ", maxProviderCalls: 3 });
    expect(result.status).toBe("error");
    expect(result.result).toMatchObject({ error: { code: "FEEDBACK_LIMIT_EXCEEDED" } });
    expect(result.trace).toEqual(["prepare", "normalize", "review", "normalize"]);
    const savedFiles: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(absolute); else savedFiles.push(path.relative(path.join(projectRoot, ".nodulus", "runs", result.runId), absolute));
      }
    };
    visit(path.join(projectRoot, ".nodulus", "runs", result.runId));
    expect(savedFiles.some((file) => file.startsWith(path.join("nodes", "report") + path.sep))).toBe(false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("FB-060 refuses to overwrite an existing project settings file", async () => {
  const projectRoot = createProject("existing-settings");
  try {
    const settingsDirectory = path.join(projectRoot, ".nodulus");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(settingsDirectory, { recursive: true });
    const settingsPath = path.join(settingsDirectory, "settings.json");
    writeFileSync(settingsPath, "{\"keep\":true}", "utf8");
    await expect(runFeedbackExample({ projectRoot })).rejects.toThrow("existing .nodulus/settings.json was not overwritten");
    expect(readFileSync(settingsPath, "utf8")).toBe("{\"keep\":true}");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("FB-060 refuses a partial Nodulus project before replacing its saved nodes", async () => {
  const projectRoot = createProject("partial-project");
  try {
    const nodeDirectory = path.join(projectRoot, ".nodulus", "nodes");
    mkdirSync(nodeDirectory, { recursive: true });
    const markerPath = path.join(nodeDirectory, "normalize.json");
    writeFileSync(markerPath, "{\"preserve\":\"partial-project-marker\"}", "utf8");
    const before = filesUnder(path.join(projectRoot, ".nodulus"));
    let providerCalls = 0;

    await expect(runFeedbackExample({ projectRoot, async onProviderCall() { providerCalls += 1; } }))
      .rejects.toThrow(/empty project directory/i);

    expect(providerCalls).toBe(0);
    expect(filesUnder(path.join(projectRoot, ".nodulus"))).toEqual(before);
    expect(readFileSync(markerPath, "utf8")).toBe("{\"preserve\":\"partial-project-marker\"}");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("FB-060 creates a requested project directory that does not exist yet", async () => {
  const parent = createProject("new-project-parent");
  const projectRoot = path.join(parent, "new-project");
  try {
    const result = await runFeedbackExample({ projectRoot, text: "Canonical text" });
    expect(result.status).toBe("success");
    expect(result.projectRoot).toBe(projectRoot);
    expect(existsSync(path.join(projectRoot, ".nodulus", "settings.json"))).toBe(true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
