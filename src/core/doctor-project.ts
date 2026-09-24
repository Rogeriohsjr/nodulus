import type { ExecutableDiscovery } from "./ports/project-settings.js";
import type { ProjectSettings } from "./project-settings.js";

export type ProviderStatus = "available" | "disabled" | "unavailable";

export type DoctorResult = {
  providers: Array<{ profile: string; status: ProviderStatus }>;
  message?: string;
};

export async function inspectProject(
  settings: ProjectSettings,
  projectRoot: string,
  executables: ExecutableDiscovery,
): Promise<DoctorResult> {
  const providers: DoctorResult["providers"] = [];
  for (const [profile, configuration] of Object.entries(settings.providerProfiles)) {
    const status: ProviderStatus = !configuration.enabled
      ? "disabled"
      : (await executables.isAvailable(configuration.executable, projectRoot))
        ? "available"
        : "unavailable";
    providers.push({ profile, status });
  }

  return providers.length === 0
    ? { providers, message: "No provider profiles are configured." }
    : { providers };
}
