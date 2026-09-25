import { NodulusError } from "./shared/nodulus-error.js";

export type ProviderProfile = {
  enabled: boolean;
  executable: string;
  [metadata: string]: unknown;
};

export type ProjectSettings = {
  schemaVersion: 1;
  defaultWorkflow: string;
  providerProfiles: Record<string, ProviderProfile>;
  [setting: string]: unknown;
};

export function parseProjectSettings(contents: string): ProjectSettings {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new NodulusError("INVALID_SETTINGS_JSON", `Could not parse .nodulus/settings.json: ${detail}`);
  }

  if (!isRecord(value)) {
    throw new NodulusError("INVALID_SETTINGS", ".nodulus/settings.json must contain a JSON object.");
  }
  if (value.schemaVersion !== 1) {
    throw new NodulusError("INVALID_SETTINGS", ".nodulus/settings.json must set schemaVersion to 1.");
  }
  if (typeof value.defaultWorkflow !== "string" || value.defaultWorkflow.trim() === "") {
    throw new NodulusError("INVALID_SETTINGS", ".nodulus/settings.json must include a non-empty defaultWorkflow string.");
  }
  if (!isRecord(value.providerProfiles)) {
    throw new NodulusError("INVALID_SETTINGS", ".nodulus/settings.json providerProfiles must be an object keyed by profile name.");
  }

  const providerProfiles = Object.create(null) as Record<string, ProviderProfile>;
  for (const [name, candidate] of Object.entries(value.providerProfiles)) {
    if (name.trim() === "" || !isRecord(candidate)) {
      throw new NodulusError("INVALID_SETTINGS", `providerProfiles.${name || "<empty>"} must be a profile object.`);
    }
    if (typeof candidate.enabled !== "boolean") {
      throw new NodulusError("INVALID_SETTINGS", `providerProfiles.${name}.enabled must be a boolean.`);
    }
    if (typeof candidate.executable !== "string" || candidate.executable.trim() === "") {
      throw new NodulusError("INVALID_SETTINGS", `providerProfiles.${name}.executable must be a non-empty path or command name.`);
    }
    providerProfiles[name] = candidate as ProviderProfile;
  }

  return { ...value, providerProfiles } as ProjectSettings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
