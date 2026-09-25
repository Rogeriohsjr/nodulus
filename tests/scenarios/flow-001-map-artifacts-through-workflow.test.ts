import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runWorkflow } from "../../src/application/run-workflow.js";
import type { ProviderInvocation } from "../../src/application/run-workflow.js";
import { createInitializedProject } from "../support/intake-project.js";
import { configureSequenceProject, readProjectJson, sequenceNodes, sequenceRunRequest, sequenceSuccess, setNodeInput, setNodeInputs, writeJson } from "../support/workflow-sequence.js";

test("FLOW-001 resolves only declared inputs and persists each accepted handoff before the next node", async () => {
  const project = createInitializedProject("flow-001");
  const invocations: ProviderInvocation[] = [];
  configureSequenceProject(project);
  const outputs = [
    sequenceSuccess("analysis result", "findings", "finding.v1"),
    sequenceSuccess("implementation result", "implementation", "implementation.v1"),
    sequenceSuccess("review result", "review", "review.v1"),
  ];
  const expectedInputs = [
    { request: "Analyze the source and deliver a review." },
    { findings: { text: "analysis result" } },
    { implementation: { text: "implementation result" } },
  ];
  try {
    const result = await runWorkflow(sequenceRunRequest(project), {
      async invoke(invocation) {
        const index = invocations.length;
        invocations.push(invocation);
        expect(invocation.nodeId).toBe(sequenceNodes[index]);
        expect(invocation.inputs).toEqual(expectedInputs[index]);
        expect(invocation.providerProfile).toMatchObject({ model: "captured-model", timeoutMs: 5000 });
        expect(Object.keys(invocation.inputs ?? {})).toEqual(Object.keys(expectedInputs[index]));
        expect(invocation.prompt).toContain(`Instructions for ${sequenceNodes[index]}.`);
        for (const otherNode of sequenceNodes.filter((nodeId) => nodeId !== sequenceNodes[index])) {
          expect(invocation.prompt).not.toContain(`Instructions for ${otherNode}.`);
        }
        if (index > 0) expect(invocation.prompt).not.toContain("Analyze the source and deliver a review.");
        const expectedField = Object.keys(expectedInputs[index])[0];
        const expectedValue = expectedInputs[index][expectedField];
        expect(invocation.prompt).toContain(expectedField);
        expect(invocation.prompt).toContain(typeof expectedValue === "string" ? expectedValue : expectedValue.text);
        for (const otherValue of ["analysis result", "implementation result", "review result"].filter((value) => value !== (typeof expectedValue === "string" ? expectedValue : expectedValue.text))) {
          expect(invocation.prompt).not.toContain(otherValue);
        }
        if (index > 0) {
          const runDirectory = path.join(project, ".nodulus", "runs", invocation.runId);
          const state = JSON.parse(readFileSync(path.join(runDirectory, "run.json"), "utf8"));
          expect(state.completedNodes).toContain(sequenceNodes[index - 1]);
          const previousArtifact = index === 1 ? "findings" : "implementation";
          expect(existsSync(path.join(runDirectory, "nodes", sequenceNodes[index - 1], "artifacts", `${previousArtifact}.json`))).toBe(true);
        }
        return outputs[index];
      },
    });

    expect(result.status).toBe("success");
    expect(invocations.map((item) => item.nodeId)).toEqual([...sequenceNodes]);
    expect(result.result).toMatchObject({ artifacts: [{ name: "review", contract: "review.v1", data: { text: "review result" } }] });
    const runDirectory = path.join(project, ".nodulus", "runs", result.runId);
    for (const node of sequenceNodes) {
      expect(existsSync(path.join(runDirectory, "nodes", node, "artifacts"))).toBe(true);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("FLOW-001 does not inject caller or predecessor data into an undeclared node input", async () => {
  const project = createInitializedProject("flow-001-empty-inputs");
  configureSequenceProject(project);
  setNodeInputs(project, "review", {});
  const invocations: ProviderInvocation[] = [];
  const outputs = [
    sequenceSuccess("analysis result", "findings", "finding.v1"),
    sequenceSuccess("implementation result", "implementation", "implementation.v1"),
    sequenceSuccess("review result", "review", "review.v1"),
  ];
  try {
    const result = await runWorkflow(sequenceRunRequest(project), {
      async invoke(invocation) {
        invocations.push(invocation);
        return outputs[invocations.length - 1];
      },
    });

    expect(result.status).toBe("success");
    const reviewInvocation = invocations[2];
    expect(reviewInvocation.inputs).toEqual({});
    expect(reviewInvocation.prompt).toContain("Instructions for review.");
    expect(reviewInvocation.prompt).not.toContain("Analyze the source and deliver a review.");
    expect(reviewInvocation.prompt).not.toContain("analysis result");
    expect(reviewInvocation.prompt).not.toContain("implementation result");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("FLOW-001 resolves dotted output names against prior declarations", async () => {
  const project = createInitializedProject("flow-001-dotted-output");
  configureSequenceProject(project);
  const analyze = readProjectJson(project, ".nodulus/nodes/analyze.json");
  analyze.expectedOutputs[0].name = "findings.v1";
  writeJson(project, ".nodulus/nodes/analyze.json", analyze);
  setNodeInput(project, "build", "findings", { from: "analyze.findings.v1", contract: "finding.v1" });
  const invocations: string[] = [];
  const outputs = [
    sequenceSuccess("analysis result", "findings.v1", "finding.v1"),
    sequenceSuccess("implementation result", "implementation", "implementation.v1"),
    sequenceSuccess("review result", "review", "review.v1"),
  ];
  try {
    const result = await runWorkflow(sequenceRunRequest(project), {
      async invoke(invocation) {
        invocations.push(invocation.nodeId);
        return outputs[invocations.length - 1];
      },
    });
    expect(result.status).toBe("success");
    expect(invocations).toEqual([...sequenceNodes]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
