import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const fixturePath = fileURLToPath(import.meta.url);
const [role, suppliedControlDirectory, suppliedNonce] = process.argv.slice(2);
const watchdogMs = 60_000;

function atomicJson(file, value) {
  const temporary = file + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
  renameSync(temporary, file);
}

async function waitForFile(file) {
  const deadline = Date.now() + watchdogMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error("P15 exited-root fixture watchdog expired waiting for " + path.basename(file));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForNonceMarker(file, nonce) {
  await waitForFile(file);
  const marker = JSON.parse(readFileSync(file, "utf8"));
  if (marker.nonce !== nonce) throw new Error("P15 exited-root control nonce mismatch for " + path.basename(file));
}

async function readStdinJson() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return JSON.parse(text);
}

async function runDescendant(controlDirectory, nonce) {
  atomicJson(path.join(controlDirectory, "descendant-started.json"), { pid: process.pid, parentPid: process.ppid, nonce });
  await waitForNonceMarker(path.join(controlDirectory, "release-descendant"), nonce);
  atomicJson(path.join(controlDirectory, "descendant-exited.json"), { pid: process.pid, nonce, exitCode: 0 });
  process.exit(0);
}

async function runRoot(mode, controlDirectory, nonce) {
  atomicJson(path.join(controlDirectory, "root-started.json"), { pid: process.pid, nonce, mode });
  await waitForNonceMarker(path.join(controlDirectory, "allow-descendant"), nonce);
  const descendant = spawn(process.execPath, [fixturePath, "descendant", controlDirectory, nonce], {
    cwd: process.cwd(), detached: true, windowsHide: true, stdio: ["ignore", "inherit", "inherit"],
  });
  if (!descendant.pid || !Number.isSafeInteger(descendant.pid)) throw new Error("P15 exited-root descendant PID was unavailable.");
  descendant.unref();
  await waitForFile(path.join(controlDirectory, "descendant-started.json"));
  const descendantRecord = JSON.parse(readFileSync(path.join(controlDirectory, "descendant-started.json"), "utf8"));
  if (descendantRecord.pid !== descendant.pid || descendantRecord.nonce !== nonce) throw new Error("P15 exited-root descendant identity mismatch.");
  atomicJson(path.join(controlDirectory, "root-ready.json"), { pid: process.pid, descendantPid: descendant.pid, nonce, mode });
  await waitForNonceMarker(path.join(controlDirectory, "release-root"), nonce);
  const output = mode === "provider" ? "provider-ok\n" : JSON.stringify({ valid: true, errors: [] }) + "\n";
  process.stdout.write(output, () => process.exit(0));
}

async function main() {
  if (role === "descendant") {
    if (!suppliedControlDirectory || !suppliedNonce) throw new Error("P15 exited-root descendant arguments are incomplete.");
    await runDescendant(suppliedControlDirectory, suppliedNonce);
    return;
  }
  if (role === "provider-root") {
    if (!suppliedControlDirectory || !suppliedNonce) throw new Error("P15 exited-root provider arguments are incomplete.");
    await runRoot("provider", suppliedControlDirectory, suppliedNonce);
    return;
  }
  if (role === undefined) {
    const control = JSON.parse(readFileSync(path.join(process.cwd(), ".nodulus", "fixtures", "exited-root-control.json"), "utf8"));
    if (typeof control.nonce !== "string" || typeof control.controlDirectory !== "string") throw new Error("P15 exited-root validator control is invalid.");
    const artifact = await readStdinJson();
    if (artifact.text !== "P15 validator fixture input") throw new Error("P15 exited-root validator input mismatch.");
    await runRoot("validator", control.controlDirectory, control.nonce);
    return;
  }
  throw new Error("Unexpected P15 exited-root fixture role.");
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : "P15 exited-root fixture failed") + "\n");
  process.exit(65);
});
