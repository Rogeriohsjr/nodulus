import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runCli } from "../../src/cli.js";
import { cleanupProviderProject, createProviderScenario, readProviderCalls, runDefaultProviderCli, type FixtureProviderKind } from "../support/provider-adapter-scenarios.js";

const providers: FixtureProviderKind[] = ["codex", "cursor"];

test.each(providers)("PROV-002 reports %s authentication probe failures without launching an inference", async (kind) => {
  const { project, logPath, probePath } = await createProviderScenario(kind, "auth-failure");
  try {
    const result = await runDefaultProviderCli(project, "Check provider auth");
    expect(result.code).toBe(1);
    expect(result.envelope.status).toBe("error");
    expect(JSON.stringify(result.envelope.result)).toMatch(/auth|login|status/i);
    expect(readProviderCalls(logPath)).toHaveLength(0);
    const probes = readFileSync(probePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(probes.some((probe) => kind === "codex"
      ? probe.argv[0] === "login" && probe.argv[1] === "status"
      : probe.argv[0] === "status" && probe.argv.includes("--format") && probe.argv.includes("json"))).toBe(true);
  } finally {
    cleanupProviderProject(project);
  }
});

test("PROV-002 rejects Cursor's successful unauthenticated status response before inference", async () => {
  const { project, logPath, probePath } = await createProviderScenario("cursor", "auth-json-unauthenticated");
  try {
    const result = await runDefaultProviderCli(project, "Do not infer without Cursor authentication");
    expect(result.code).toBe(1);
    expect(result.envelope.status).toBe("error");
    expect(JSON.stringify(result.envelope.result)).toMatch(/auth|login|status/i);
    expect(readProviderCalls(logPath)).toHaveLength(0);
    const probes = readFileSync(probePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(probes.some((probe) => probe.argv[0] === "status" && probe.argv.includes("--format") && probe.argv.includes("json"))).toBe(true);
  } finally {
    cleanupProviderProject(project);
  }
});

test.each(providers)("PROV-002 rejects an unsupported or unrecognized %s version before inference", async (kind) => {
  const { project, logPath, probePath } = await createProviderScenario(kind, "unsupported-version");
  try {
    const result = await runDefaultProviderCli(project, "Check provider version");
    expect(result.code).toBe(1);
    expect(result.envelope.status).toBe("error");
    expect(JSON.stringify(result.envelope.result)).toMatch(/version.*(unsupported|unrecognized|unavailable)|(unsupported|unrecognized|unavailable).*version/i);
    expect(readProviderCalls(logPath)).toHaveLength(0);
    const probes = readFileSync(probePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(probes.some((probe) => probe.argv[0] === "--version")).toBe(true);
  } finally {
    cleanupProviderProject(project);
  }
});

test("PROV-002 doctor reports disabled profiles and missing provider executables without invoking them", async () => {
  const { project, logPath } = await createProviderScenario("codex");
  try {
    const settingsPath = path.join(project, ".nodulus", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    settings.providerProfiles.fixture.enabled = false;
    const missing = path.join(project, "missing executable & % ü.cmd");
    settings.providerProfiles.missing = { kind: "cursor", enabled: true, executable: missing };
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

    let stdout = "";
    const exitCode = await runCli(
      ["node", "nodulus", "doctor", "--json", "--project", project],
      { writeOut: (text) => { stdout += text; }, writeErr: () => undefined },
      { cwd: project },
    );
    const envelope = JSON.parse(stdout);
    expect(exitCode).toBe(0);
    expect(envelope.result.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ profile: "fixture", status: "disabled" }),
      expect.objectContaining({ profile: "missing", status: "unavailable" }),
    ]));
    expect(existsSync(missing)).toBe(false);
    expect(readProviderCalls(logPath)).toHaveLength(0);
  } finally {
    cleanupProviderProject(project);
  }
});

test("PROV-002 default CLI requires explicit provider kind", async () => {
  const { project, logPath } = await createProviderScenario("codex");
  try {
    const settingsPath = path.join(project, ".nodulus", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    delete settings.providerProfiles.fixture.kind;
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    const result = await runDefaultProviderCli(project, "Kind must be explicit");
    expect(result.code).toBe(1);
    expect(JSON.stringify(result.envelope.result)).toMatch(/kind.*codex.*cursor|provider kind/i);
    expect(readProviderCalls(logPath)).toHaveLength(0);
  } finally {
    cleanupProviderProject(project);
  }
});

test("PROV-002 injected generic providers remain supported without a concrete provider kind", async () => {
  const { project, logPath } = await createProviderScenario("codex");
  try {
    const settingsPath = path.join(project, ".nodulus", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    delete settings.providerProfiles.fixture.kind;
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    let stdout = "";
    const injectedCode = await runCli(
      ["node", "nodulus", "run", "--project", project, "--request", "Injected generic boundary", "--json"],
      { writeOut: (text) => { stdout += text; }, writeErr: () => undefined },
      { cwd: project, provider: { async invoke() { return JSON.stringify({ status: "success", artifacts: [{ name: "example", contract: "example.v1", data: { message: "injected" } }] }); } } },
    );
    expect(injectedCode).toBe(0);
    expect(JSON.parse(stdout).status).toBe("success");
    expect(readProviderCalls(logPath)).toHaveLength(0);
  } finally {
    cleanupProviderProject(project);
  }
});
