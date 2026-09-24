import { Command, CommanderError } from "commander";
import { resolve } from "node:path";
import { LocalExecutableDiscovery } from "./adapters/storage/local-executable-discovery.js";
import { LocalProjectFiles } from "./adapters/storage/local-project-files.js";
import { LocalProjectSettings } from "./adapters/storage/local-project-settings.js";
import { inspectProject } from "./core/doctor-project.js";
import { initializeProject } from "./core/initialize-project.js";
import { NodulusError } from "./core/shared/nodulus-error.js";
import { parseProjectSettings } from "./core/project-settings.js";

type CliOutput = {
  writeOut: (message: string) => void;
  writeErr: (message: string) => void;
};

type CliEnvelope = {
  schemaVersion: 1;
  status: "success" | "error";
  runId: null;
  result: unknown;
};

const defaultOutput: CliOutput = {
  writeOut: (message) => process.stdout.write(message),
  writeErr: (message) => process.stderr.write(message),
};

export async function runCli(argv: string[] = process.argv, output: CliOutput = defaultOutput): Promise<number> {
  const jsonRequested = argv.includes("--json");
  const settingsStore = new LocalProjectSettings();
  const program = new Command();
  program
    .name("nodulus")
    .description("Build and run validated workflows")
    .exitOverride()
    .configureOutput({
      writeOut: output.writeOut,
      writeErr: output.writeErr,
      outputError: () => {},
    });

  program
    .command("init")
    .description("Create a project with starter settings, workflow, node, instructions, and contracts")
    .option("--project <path>", "target project directory (defaults to the current directory)")
    .action(async (options: { project?: string }) => {
      const projectRoot = resolve(options.project ?? process.cwd());
      await initializeProject(new LocalProjectFiles(projectRoot));
    });

  program
    .command("doctor")
    .description("Check project settings and provider executable availability")
    .option("--project <path>", "target project directory; defaults to nearest project")
    .option("--json", "write a machine-readable result")
    .action(async (options: { project?: string; json?: boolean }) => {
      const projectRoot = options.project
        ? resolve(options.project)
        : await settingsStore.findNearestProject(process.cwd());
      if (!projectRoot) {
        throw new NodulusError(
          "PROJECT_NOT_FOUND",
          "No .nodulus/settings.json found from the current directory. Pass --project <path> or run from a project folder.",
        );
      }

      let contents: string;
      try {
        contents = await settingsStore.readSettings(projectRoot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new NodulusError("PROJECT_NOT_FOUND", message);
      }

      const settings = parseProjectSettings(contents);
      const result = await inspectProject(settings, projectRoot, new LocalExecutableDiscovery());
      if (options.json) {
        writeEnvelope(output.writeOut, { schemaVersion: 1, status: "success", runId: null, result });
      } else if (result.message) {
        output.writeOut(`${result.message}\n`);
      } else {
        for (const provider of result.providers) {
          output.writeOut(`${provider.profile}: ${provider.status}\n`);
        }
      }
    });

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") return 0;
    const diagnostic = normalizeCliError(error);
    if (jsonRequested) {
      writeEnvelope(output.writeOut, {
        schemaVersion: 1,
        status: "error",
        runId: null,
        result: { code: diagnostic.code, message: diagnostic.message },
      });
    } else {
      output.writeErr(`${diagnostic.message}\n`);
    }
    return 1;
  }
}

function normalizeCliError(error: unknown): { code: string; message: string } {
  if (error instanceof NodulusError) return { code: error.code, message: error.message };
  if (error instanceof CommanderError) {
    return { code: "USAGE_ERROR", message: error.message.replace(/^error:\s*/i, "") };
  }
  return {
    code: "APPLICATION_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}

function writeEnvelope(writeOut: (message: string) => void, envelope: CliEnvelope): void {
  writeOut(`${JSON.stringify(envelope)}\n`);
}
