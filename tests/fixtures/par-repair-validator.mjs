import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
const artifact = JSON.parse(stdin);
const stateDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "repair-validator-state");
const prior = readdirSync(stateDirectory).filter((name) => /^validator-\d+\.json$/.test(name)).length;
const record = {
  index: prior + 1,
  pid: process.pid,
  artifact,
};
writeFileSync(path.join(stateDirectory, `validator-${record.index}.json`), JSON.stringify(record), { encoding: "utf8", flag: "wx" });
const valid = typeof artifact?.text === "string" && artifact.text.startsWith("accepted:");
process.stdout.write(JSON.stringify({ valid, errors: valid ? [] : ["fixture validator rejected the artifact text"] }));
