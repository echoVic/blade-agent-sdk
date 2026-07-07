export interface PackageLocalRuntimeCapabilityInitializationOptions {
  initializeRuntimeCapabilities(): Promise<void>;
  initializeSubagents(): void;
}

export interface PackageLocalRuntimeCapabilityStartupOperationsOptions {
  registerConfiguredMcpServers(): Promise<void> | void;
  registerCustomTools(): void;
  registerBuiltinTools(): Promise<void> | void;
  initializeSubagents(): void;
  initializeHooks(): void;
}

export interface PackageLocalRuntimeCapabilityStartupOperations {
  initializeRuntimeCapabilities(): Promise<void>;
}

export interface PackageLocalRuntimeCapabilityInitializationOperations {
  ensureInitialized(): Promise<void>;
  markSubagentLocationsDirty(): void;
}

export interface PackageLocalRuntimeCapabilityOperations {
  startup: PackageLocalRuntimeCapabilityStartupOperations;
  initialization: PackageLocalRuntimeCapabilityInitializationOperations;
}

export function createPackageLocalRuntimeCapabilityStartupOperations(
  options: PackageLocalRuntimeCapabilityStartupOperationsOptions,
): PackageLocalRuntimeCapabilityStartupOperations {
  return {
    async initializeRuntimeCapabilities() {
      await options.registerConfiguredMcpServers();
      options.registerCustomTools();
      await options.registerBuiltinTools();
      options.initializeSubagents();
      options.initializeHooks();
    },
  };
}

export function createPackageLocalRuntimeCapabilityOperations(
  options: PackageLocalRuntimeCapabilityStartupOperationsOptions,
): PackageLocalRuntimeCapabilityOperations {
  const startup = createPackageLocalRuntimeCapabilityStartupOperations(options);

  return {
    startup,
    initialization: createPackageLocalRuntimeCapabilityInitializationOperations({
      initializeRuntimeCapabilities: () => startup.initializeRuntimeCapabilities(),
      initializeSubagents: options.initializeSubagents,
    }),
  };
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
