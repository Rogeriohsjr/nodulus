import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createTempProject, runProductionCli } from "../support/production-cli.js";

type DoctorEnvelope = {
  schemaVersion: number;
  status: string;
  runId: string | null;
  result: { providers: Array<{ profile: string; status: string }>; message?: string };
};

function readDoctorResult(stdout: string): DoctorEnvelope {
  expect(stdout.trim()).not.toBe("");
  return JSON.parse(stdout) as DoctorEnvelope;
}

function writeSettings(project: string, providerProfiles: Record<string, unknown>): void {
  const settingsPath = path.join(project, ".nodulus", "settings.json");
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    `${JSON.stringify({ schemaVersion: 1, defaultWorkflow: "example", providerProfiles }, null, 2)}\n`,
    "utf8",
  );
}

test("INIT-003 discovers the project from nested cwd and reports no configured provider profiles", () => {
  const project = createTempProject("init-003-empty");
  const nestedCwd = path.join(project, "nested", "caller");

  try {
    mkdirSync(nestedCwd, { recursive: true });
    const initialized = runProductionCli(["init", "--project", project]);
    expect(initialized.error).toBeUndefined();
    expect(initialized.status, initialized.stderr).toBe(0);
    const result = runProductionCli(["doctor", "--json"], { cwd: nestedCwd });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const envelope = readDoctorResult(result.stdout);
    expect(envelope).toMatchObject({ schemaVersion: 1, status: "success", runId: null });
    expect(envelope.result.providers).toEqual([]);
    expect(envelope.result.message).toMatch(/no provider profiles (?:are )?configured/i);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("INIT-003 discovers available executables without calling them", () => {
  const project = createTempProject("init-003-probes");
  const caller = createTempProject("init-003-caller");
  const fixturePath = path.join(project, process.platform === "win32" ? "provider-probe.cmd" : "provider-probe.sh");
  const invocationMarker = path.join(project, "provider-was-called.txt");
  const textFilePath = path.join(project, "notes.txt");
  const fixture = process.platform === "win32"
    ? `@echo off\r\necho invoked> "${invocationMarker}"\r\nexit /b 0\r\n`
    : `#!/bin/sh\nprintf '%s\\n' invoked >> '${invocationMarker.replace(/'/g, "'\\''")}'\n`;

  try {
    writeFileSync(fixturePath, fixture, "utf8");
    writeFileSync(textFilePath, "This is a regular text file, not an executable.\n", "utf8");
    if (process.platform !== "win32") chmodSync(fixturePath, 0o755);
    if (process.platform !== "win32") chmodSync(textFilePath, 0o644);

    const fixtureCheck = process.platform === "win32"
      ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", fixturePath], { encoding: "utf8", timeout: 10_000 })
      : spawnSync(fixturePath, [], { encoding: "utf8", timeout: 10_000 });
    expect(fixtureCheck.error).toBeUndefined();
    expect(fixtureCheck.status, fixtureCheck.stderr).toBe(0);
    expect(existsSync(invocationMarker)).toBe(true);
    unlinkSync(invocationMarker);

    writeSettings(project, {
      available: {
        enabled: true,
        executable: fixturePath,
      },
      disabled: {
        enabled: false,
        executable: fixturePath,
      },
      missing: {
        enabled: true,
        executable: path.join(project, "provider-does-not-exist.exe"),
      },
      text: {
        enabled: true,
        executable: textFilePath,
      },
    });

    const result = runProductionCli(["doctor", "--json", "--project", project], { cwd: caller });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const envelope = readDoctorResult(result.stdout);
    expect(envelope).toMatchObject({ schemaVersion: 1, status: "success", runId: null });
    expect(envelope.result.providers).toHaveLength(4);
    expect(
      envelope.result.providers
        .map(({ profile, status }) => ({ profile, status }))
        .sort((left, right) => left.profile.localeCompare(right.profile)),
    ).toEqual([
      { profile: "available", status: "available" },
      { profile: "disabled", status: "disabled" },
      { profile: "missing", status: "unavailable" },
      { profile: "text", status: "unavailable" },
    ]);
    expect(existsSync(invocationMarker)).toBe(false);
    expect(result.stdout).not.toMatch(/model|credential|secret/i);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(caller, { recursive: true, force: true });
  }
});
