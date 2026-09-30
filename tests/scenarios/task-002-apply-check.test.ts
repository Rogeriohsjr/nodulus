import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { applyFile, runCheck } from "../../scripts/task-workflow/io.mjs";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

test.each(["valid", "stale", "escape", "fence", "unlisted"])("APPLY-001 %s uses actual file and receipt", mode => {
  const root = mkdtempSync(path.join(tmpdir(), "Nodulus apply ü "));
  writeFileSync(path.join(root, "source.ts"), "old");
  try {
    const request = { root, allowedPaths: ["source.ts"], expectedHash: mode === "stale" ? hash("stale") : hash("old"), change: { path: mode === "escape" ? "../outside.ts" : mode === "unlisted" ? "other.ts" : "source.ts", content: mode === "fence" ? "```ts\nnew\n```" : "new" }, receiptDirectory: path.join(root, ".receipts") };
    const result = applyFile(request);
    expect(result.applied).toBe(mode === "valid");
    expect(readFileSync(path.join(root, "source.ts"), "utf8")).toBe(mode === "valid" ? "new" : "old");
    expect(JSON.parse(readFileSync(result.receiptPath, "utf8")).applied).toBe(mode === "valid");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each([0, 7])("APPLY-002 fixed real check exit %s determines acceptance", exitCode => {
  const root = mkdtempSync(path.join(tmpdir(), "Nodulus check ü "));
  writeFileSync(path.join(root, "check.cjs"), `console.log("real-check"); process.exit(${exitCode});`);
  try {
    const result = runCheck(root, { id: "fixed", executable: process.execPath, args: ["check.cjs"] });
    expect(result.passed).toBe(exitCode === 0);
    expect(result.exitCode).toBe(exitCode);
    expect(result.stdout).toContain("real-check");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
