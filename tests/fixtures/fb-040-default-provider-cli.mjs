import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-cli 0.144.4\n");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  const started = path.join(process.cwd(), ".nodulus", "readiness-probe-started");
  const completed = path.join(process.cwd(), ".nodulus", "readiness-probe-completed");
  mkdirSync(path.dirname(started), { recursive: true });
  if (!existsSync(started)) {
    writeFileSync(started, "started\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 3500));
    writeFileSync(completed, "completed\n", "utf8");
  }
  process.stdout.write("Logged in\n");
  process.exit(0);
}
if (args[0] === "exec") {
  const slowInvocation = path.join(process.cwd(), ".nodulus", "slow-provider-invocation");
  if (existsSync(slowInvocation)) {
    const started = path.join(process.cwd(), ".nodulus", "provider-invocation-started");
    const completed = path.join(process.cwd(), ".nodulus", "provider-invocation-completed");
    writeFileSync(started, "started\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 3500));
    writeFileSync(completed, "completed\n", "utf8");
  }
  const outputIndex = args.indexOf("--output-last-message");
  if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error("Codex fixture did not receive an output path");
  const outcome = { status: "success", artifacts: [{ name: "prepared", contract: "prepared.v1", data: { text: "prepared by local CLI fixture" } }] };
  writeFileSync(args[outputIndex + 1], JSON.stringify({ response: JSON.stringify(outcome) }), "utf8");
  process.exit(0);
}
process.stderr.write("Unexpected Codex fixture arguments: " + args.join(" ") + "\n");
process.exit(64);
