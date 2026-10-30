import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [configPath, ...args] = process.argv.slice(2);
if (!configPath) throw new Error("P15B1b fixture requires its project control file.");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const eventsPath = path.resolve(config.eventsPath);
const fixtureDirectory = path.dirname(eventsPath);
const releasePath = path.resolve(config.releasePath);

function record(operation, stage, detail = {}) {
  const event = { operation, stage, pid: process.pid, at: Date.now(), ...detail };
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
  if (stage === "started") {
    const marker = path.join(fixtureDirectory, `${operation}-${detail.ordinal ?? 1}-started.json`);
    const temporary = `${marker}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(event), "utf8");
    renameSync(temporary, marker);
  }
  return event;
}

async function holdUntilReleaseOrLifetime() {
  const deadline = Date.now() + config.fixtureLifetimeMs;
  while (Date.now() < deadline) {
    if (existsSync(releasePath)) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

async function holdForRepairReleaseOrLifetime() {
  const deadline = Date.now() + config.fixtureLifetimeMs;
  while (Date.now() < deadline) {
    if (existsSync(releasePath)) return "cleanup";
    if (existsSync(path.resolve(config.repairOutputReleasePath))) return "output";
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return "expired";
}

if (args[0] === "--version") {
  record("version", "started");
  process.stdout.write(config.kind === "opencode" ? "opencode 1.18.32\n" : "codex 0.144.4\n");
  record("version", "finished");
  process.exit(0);
}

if (config.kind === "codex" && args[0] === "login" && args[1] === "status") {
  const prior = existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.operation === "auth" && event.stage === "started").length
    : 0;
  const ordinal = prior + 1;
  record("auth", "started", { ordinal });
  if (ordinal === config.heldAuthOrdinal) {
    const expired = await holdUntilReleaseOrLifetime();
    record("auth", "finished", { ordinal, released: !expired });
    if (!expired) process.exit(1);
    process.exit(73);
  }
  record("auth", "finished", { ordinal });
  process.exit(0);
}

if (config.kind === "opencode" && args[0] === "models" && args[1] === "ollama") {
  record("models", "started");
  process.stdout.write(`${config.model}\n`);
  record("models", "finished");
  process.exit(0);
}

if (config.kind === "opencode" && args[0] === "run") {
  const agentIndex = args.indexOf("--agent");
  const agent = agentIndex >= 0 ? args[agentIndex + 1] : "missing";
  const sessionIndex = args.indexOf("--session");
  const session = sessionIndex >= 0 ? args[sessionIndex + 1] : null;
  record(agent === "nodulus-response" ? "repair" : "build", "started", { agent, session });
  if (agent === "nodulus-response") {
    const release = await holdForRepairReleaseOrLifetime();
    if (release !== "output") {
      record("repair", "finished", { agent, session, released: release === "cleanup" });
      process.exit(release === "cleanup" ? 1 : 73);
    }
    const prefix = Buffer.from("P15B1b actual OpenCode repair output beyond the process runner capture limit\n", "utf8");
    const chunk = Buffer.alloc(1024 * 1024, 0x78);
    process.stdout.write(prefix);
    process.stdout.write(chunk);
    process.stdout.write(chunk);
    process.stdout.write(chunk);
    await new Promise((resolve) => process.stdout.write("\nend\n", resolve));
    const expired = await holdUntilReleaseOrLifetime();
    record("repair", "finished", { agent, session, released: !expired });
    process.exit(expired ? 73 : 0);
  }

  const messageID = "p15b1b-build-message";
  const response = JSON.stringify({ status: "success", artifacts: [{ name: "report", contract: "report.v1", data: { text: 17 } }] });
  process.stdout.write(`${JSON.stringify({ type: "text", part: { messageID, sessionID: "p15b1b-session", text: response } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "step_finish", part: { messageID, sessionID: "p15b1b-session", reason: "stop" } })}\n`);
  record("build", "finished", { agent, session: "p15b1b-session" });
  process.exit(0);
}

record("unexpected", "started", { argv: args });
process.stderr.write(`Unexpected P15B1b fixture command: ${pathToFileURL(configPath).pathname} ${args.join(" ")}`);
process.exit(97);
