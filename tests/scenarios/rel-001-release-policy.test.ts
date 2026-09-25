import { analyzeCommits } from "@semantic-release/commit-analyzer";
import crossSpawn from "cross-spawn";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const releaseConfig = JSON.parse(readFileSync(path.join(root, ".releaserc.json"), "utf8")) as {
  plugins: Array<string | [string, Record<string, unknown>]>;
};
const analyzerConfig = releaseConfig.plugins.find((plugin): plugin is [string, Record<string, unknown>] =>
  Array.isArray(plugin) && plugin[0] === "@semantic-release/commit-analyzer",
);
if (!analyzerConfig) throw new Error("semantic-release commit analyzer must be configured");

async function releaseType(...messages: string[]): Promise<string | undefined> {
  const [pluginName, options] = analyzerConfig;
  expect(pluginName).toBe("@semantic-release/commit-analyzer");
  return analyzeCommits(options, {
    commits: messages.map((message, index) => ({ hash: `commit-${index + 1}`, message })),
    logger: { log() {} },
  } as never);
}

test.each([
  "docs: clarify the local install",
  "chore: update repository guidance",
  "test: add release policy coverage",
  "ci: update the matrix workflow",
  "refactor: simplify local settings",
  "Update README with local setup instructions",
])("REL-001 assigns at least patch to every ordinary commit: %s", async (message) => {
  await expect(releaseType(message), message).resolves.toBe("patch");
});

test("REL-001 keeps a conventional feature bump", async () => {
  await expect(releaseType("feat: add workflow validation")).resolves.toBe("minor");
});

test.each([
  "fix!: reject ambiguous workflow mappings",
  "fix: reject ambiguous workflow mappings\n\nBREAKING CHANGE: ambiguous mappings now fail",
])("REL-001 treats supported breaking metadata as major: %s", async (message) => {
  await expect(releaseType(message)).resolves.toBe("major");
});

test("REL-001 selects the highest bump across documentation and feature commits", async () => {
  await expect(releaseType("docs: clarify install", "feat: add validation")).resolves.toBe("minor");
});

test("REL-001 selects a breaking bump when documentation and breaking commits are mixed", async () => {
  await expect(releaseType("docs: clarify install", "fix!: reject invalid mappings\n\nBREAKING CHANGE: mapping errors are now fatal"))
    .resolves.toBe("major");
});

test("REL-003 returns no bump when semantic-release has no unreleased commits to analyze", async () => {
  await expect(releaseType()).resolves.toBeNull();
});

test("REL-003 dry-run releases a docs-only commit once and sees no release after the new tag", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "nodulus-release-policy-"));
  const repository = path.join(scratch, "fixture repository");
  const remote = path.join(scratch, "fixture remote.git");
  mkdirSync(repository, { recursive: true });
  try {
    git(repository, ["init", "-b", "main"]);
    git(repository, ["config", "user.name", "Nodulus release test"]);
    git(repository, ["config", "user.email", "release-test@example.invalid"]);
    git(scratch, ["init", "--bare", remote]);
    git(scratch, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
    git(repository, ["remote", "add", "origin", remote]);

    const localReleaseConfig = {
      ...releaseConfig,
      repositoryUrl: pathToFileURL(remote).href,
      plugins: releaseConfig.plugins.filter((plugin) =>
        plugin === "@semantic-release/release-notes-generator" ||
        (Array.isArray(plugin) && ["@semantic-release/commit-analyzer", "@semantic-release/release-notes-generator"].includes(plugin[0] as string))),
    };
    writeFileSync(path.join(repository, ".releaserc.json"), `${JSON.stringify(localReleaseConfig, null, 2)}\n`, "utf8");
    writeFileSync(path.join(repository, "package.json"), `${JSON.stringify({ name: "nodulus-release-fixture", version: "1.0.0", private: false }, null, 2)}\n`, "utf8");
    git(repository, ["add", "."]);
    git(repository, ["commit", "-m", "chore: prepare release fixture"]);
    git(repository, ["tag", "v1.0.0"]);
    git(repository, ["push", "-u", "origin", "main", "--tags"]);

    writeFileSync(path.join(repository, "README.md"), "Release fixture documentation.\n", "utf8");
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-m", "docs: update fixture documentation"]);
    git(repository, ["push", "origin", "main"]);

    const firstDryRun = semanticReleaseDryRun(repository);
    expect(firstDryRun.status, `${String(firstDryRun.stdout)}\n${String(firstDryRun.stderr)}`).toBe(0);
    expect(firstDryRun.stdout).toMatch(/next release version is 1\.0\.1/i);

    git(repository, ["tag", "v1.0.1"]);
    git(repository, ["push", "origin", "v1.0.1"]);
    const repeatedDryRun = semanticReleaseDryRun(repository);
    expect(repeatedDryRun.status, `${String(repeatedDryRun.stdout)}\n${String(repeatedDryRun.stderr)}`).toBe(0);
    expect(repeatedDryRun.stdout).toMatch(/no relevant changes|no new version is released/i);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);

function git(cwd: string, args: string[]): void {
  const result = crossSpawn.sync("git", args, { cwd, encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
}

function semanticReleaseDryRun(cwd: string): ReturnType<typeof crossSpawn.sync> {
  const executable = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "semantic-release.cmd" : "semantic-release");
  const fixtureEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GITHUB_")));
  return crossSpawn.sync(executable, ["--dry-run", "--no-ci"], { cwd, env: fixtureEnv, encoding: "utf8", timeout: 60_000, windowsHide: true });
}
