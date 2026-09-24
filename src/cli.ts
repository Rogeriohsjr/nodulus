import { Command, CommanderError } from "commander";
import { resolve } from "node:path";
import { LocalExecutableDiscovery } from "./adapters/storage/local-executable-discovery.js";
import { LocalProjectFiles } from "./adapters/storage/local-project-files.js";
import { LocalProjectSettings } from "./adapters/storage/local-project-settings.js";
import { runWorkflow, type ProviderPort } from "./application/run-workflow.js";
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
  status: "success" | "needs_input" | "error";
  runId: string | null;
  result: unknown;
};

export type CliDependencies = {
  provider?: ProviderPort;
  readStdin?: () => Promise<string>;
};

const defaultOutput: CliOutput = {
  writeOut: (message) => process.stdout.write(message),
  writeErr: (message) => process.stderr.write(message),
};

export async function runCli(
  argv: string[] = process.argv,
  output: CliOutput = defaultOutput,
  dependencies: CliDependencies = {},
): Promise<number> {
  const jsonRequested = argv.includes("--json");
  const settingsStore = new LocalProjectSettings();
  const program = new Command();
  let commandExitCode = 0;
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

  program
    .command("run")
    .description("Run a workflow and validate its node outcomes")
    .option("--project <path>", "project directory; defaults to nearest project")
    .option("--workflow <id>", "workflow ID; defaults to project settings")
    .option("--request <text>", "inline request text")
    .option("--request-file <path>", "UTF-8 request file path, relative to current directory")
    .option("--request-stdin", "read request text from stdin")
    .option("--references-file <path>", "references manifest path, relative to current directory")
    .option("--json", "write a machine-readable result")
    .action(async (options: {
      project?: string;
      workflow?: string;
      request?: string;
      requestFile?: string;
      requestStdin?: boolean;
      referencesFile?: string;
      json?: boolean;
    }) => {
      const callerCwd = process.cwd();
      const projectRoot = options.project
        ? resolve(options.project)
        : await settingsStore.findNearestProject(callerCwd);
      if (!projectRoot) {
        throw new NodulusError(
          "PROJECT_NOT_FOUND",
          "No .nodulus/settings.json found from the current directory. Pass --project <path> or run from a project folder.",
        );
      }
      const settingsContents = await settingsStore.readSettings(projectRoot);
      const settings = parseProjectSettings(settingsContents);
      const workflow = options.workflow ?? settings.defaultWorkflow;
      const sources = [];
      if (options.request !== undefined) sources.push({ kind: "inline" as const, text: options.request });
      if (options.requestFile !== undefined) sources.push({ kind: "file" as const, path: options.requestFile });
      if (options.requestStdin) {
        const text = dependencies.readStdin ? await dependencies.readStdin() : await readStdin();
        sources.push({ kind: "stdin" as const, text });
      }
      const provider = dependencies.provider ?? {
        invoke: async () => {
          throw new NodulusError("PROVIDER_UNAVAILABLE", "No provider adapter is configured for this application run.");
        },
      };
      const result = await runWorkflow({
        projectRoot,
        cwd: callerCwd,
        workflow,
        sources,
        ...(options.referencesFile ? { referencesFile: options.referencesFile } : {}),
      }, provider);

      if (options.json) {
        writeEnvelope(output.writeOut, {
          schemaVersion: 1,
          status: result.status,
          runId: result.runId,
          result: result.result,
        });
      } else if (result.status === "error") {
        output.writeErr(`Run ${result.runId} failed.\n`);
      } else {
        output.writeOut(`Run ${result.runId}: ${result.status}\n`);
      }
      commandExitCode = result.status === "success" ? 0 : result.status === "needs_input" ? 2 : 1;
    });

  try {
    await program.parseAsync(argv);
    return commandExitCode;
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

async function readStdin(): Promise<string> {
  return new Promise((resolveInput, reject) => {
    let contents = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => { contents += chunk; });
    process.stdin.once("error", reject);
    process.stdin.once("end", () => resolveInput(contents));
  });
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
