export interface PackageLocalRuntimeCapabilityInitializationOptions {
  initializeRuntimeCapabilities(): Promise<void>;
  initializeSubagents(): void;
}

export interface PackageLocalRuntimeCapabilityInitializationOperations {
  ensureInitialized(): Promise<void>;
  markSubagentLocationsDirty(): void;
}

export function createPackageLocalRuntimeCapabilityInitializationOperations(
  options: PackageLocalRuntimeCapabilityInitializationOptions,
): PackageLocalRuntimeCapabilityInitializationOperations {
  let runtimeCapabilitiesInitialization: Promise<void> | undefined;
  let runtimeCapabilitiesInitialized = false;
  let subagentLocationsNeedRefresh = false;

  return {
    async ensureInitialized() {
      runtimeCapabilitiesInitialization ??= options.initializeRuntimeCapabilities()
        .then(() => {
          runtimeCapabilitiesInitialized = true;
        })
        .catch((error: unknown) => {
          runtimeCapabilitiesInitialization = undefined;
          runtimeCapabilitiesInitialized = false;
          throw error;
        });
      await runtimeCapabilitiesInitialization;

      if (subagentLocationsNeedRefresh) {
        subagentLocationsNeedRefresh = false;
        options.initializeSubagents();
      }
    },
    markSubagentLocationsDirty() {
      if (runtimeCapabilitiesInitialized || runtimeCapabilitiesInitialization) {
        subagentLocationsNeedRefresh = true;
      }
    },
  };
}
