import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkflow } from "@rogeriohsjr/nodulus";

const exampleDirectory = path.dirname(fileURLToPath(import.meta.url));

async function copyTree(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else await copyFile(from, to);
  }
}

function runChild(script, input, cwd, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, input.tracePath], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(result);
    };
    const abort = () => child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGTERM"), Math.max(1, timeoutMs));
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; if (Buffer.byteLength(stdout) > 1024 * 1024) child.kill("SIGTERM"); });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; if (Buffer.byteLength(stderr) > 1024 * 1024) child.kill("SIGTERM"); });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => code === 0
      ? finish(undefined, stdout)
      : finish(new Error(stderr || "Local provider fixture exited " + code)));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.end(JSON.stringify(input));
  });
}

/** Run the shipped local example using Nodulus' exported workflow API. */
export async function runFeedbackExample(options = {}) {
  const sourceText = options.text ?? "  Cafe\u0301\n\n世界 👋  ";
  const projectRoot = options.projectRoot ?? await mkdtemp(path.join(os.tmpdir(), "nodulus-feedback-example-"));
  const tracePath = path.join(projectRoot, ".nodulus", "feedback-example-trace.jsonl");
  const nodulus = path.join(projectRoot, ".nodulus");
  try {
    await stat(path.join(nodulus, "settings.json"));
    throw new Error("The example expects an empty project directory; existing .nodulus/settings.json was not overwritten.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let existingEntries = [];
  try {
    existingEntries = await readdir(projectRoot);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existingEntries.length > 0) {
    throw new Error("The example expects a new or empty project directory; existing project files were not overwritten.");
  }
  await copyTree(path.join(exampleDirectory, ".nodulus"), nodulus);
  const settingsPath = path.join(nodulus, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  settings.providerProfiles["local-fixture"].executable = process.execPath;
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  if (options.maxProviderCalls !== undefined) {
    const workflowPath = path.join(nodulus, "workflows", "normalize-review.json");
    const workflow = JSON.parse(await readFile(workflowPath, "utf8"));
    workflow.feedbackRouting.limits.maxProviderCalls = options.maxProviderCalls;
    await writeFile(workflowPath, JSON.stringify(workflow, null, 2) + "\n");
  }
  await unlink(tracePath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await mkdir(path.dirname(tracePath), { recursive: true });
  const fixturePath = path.join(exampleDirectory, "provider-fixture.mjs");
  const result = await runWorkflow({
    projectRoot,
    cwd: projectRoot,
    workflow: "normalize-review",
    sources: [{ kind: "inline", text: "Normalize caller-provided text." }],
    callerInputs: { sourceText },
  }, {
    async invoke(invocation) {
      const timeoutMs = Number(invocation.providerProfile.timeoutMs) || 5000;
      await options.onProviderCall?.(invocation);
      return runChild(fixturePath, { ...invocation, tracePath }, projectRoot, invocation.signal, timeoutMs);
    },
  });
  const trace = (await readFile(tracePath, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  let report;
  if (result.status === "success") {
    const attemptResult = JSON.parse(await readFile(path.join(nodulus, "runs", result.runId, "nodes", "report", "attempt-001", "result.json"), "utf8"));
    report = attemptResult.artifacts.find((artifact) => artifact.name === "report")?.data;
  }
  return { ...result, trace: trace.map(({ nodeId }) => nodeId), report, projectRoot };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  try {
    const result = await runFeedbackExample({
      ...(option("--project") === undefined ? {} : { projectRoot: path.resolve(option("--project")) }),
      ...(option("--text") === undefined ? {} : { text: option("--text") }),
      ...(option("--max-provider-calls") === undefined ? {} : { maxProviderCalls: Number(option("--max-provider-calls")) }),
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result.status !== "success") process.exitCode = 1;
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}
