import type { ProjectFiles } from "./ports/project-files.js";

const exampleFiles = [
  {
    path: ".nodulus/settings.json",
    contents: `${JSON.stringify(
      {
        schemaVersion: 1,
        defaultWorkflow: "example",
        providerProfiles: {},
      },
      null,
      2,
    )}\n`,
  },
  {
    path: ".nodulus/workflows/example.json",
    contents: `${JSON.stringify(
      {
        schemaVersion: 1,
        id: "example",
        nodes: ["example"],
      },
      null,
      2,
    )}\n`,
  },
  {
    path: ".nodulus/nodes/example.json",
    contents: `${JSON.stringify(
      {
        schemaVersion: 1,
        id: "example",
        providerProfile: "unconfigured",
        instructions: [".nodulus/instructions/example.md"],
        inputs: {},
        expectedOutputs: [{ name: "example", contract: "example.v1" }],
      },
      null,
      2,
    )}\n`,
  },
  {
    path: ".nodulus/instructions/example.md",
    contents: "# Example workflow\n\nThis starter has no provider profile configured. Configure one before running the example.\n\nRead the request and return one `example` artifact with a non-empty `message` string.\n",
  },
  {
    path: ".nodulus/contracts/example.v1.schema.json",
    contents: `${JSON.stringify(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "example.v1",
        title: "Example output",
        type: "object",
        properties: {
          message: { type: "string", minLength: 1 },
        },
        required: ["message"],
        additionalProperties: false,
      },
      null,
      2,
    )}\n`,
  },
];

export async function initializeProject(files: ProjectFiles): Promise<void> {
  for (const file of exampleFiles) {
    await files.createFileIfMissing(file.path, file.contents);
  }
  await files.ensureLine(".gitignore", ".nodulus/runs/");
}
